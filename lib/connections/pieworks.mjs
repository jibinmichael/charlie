// lib/connections/pieworks.mjs — client for the Pieworks partner API (the Qualify & Submit agent's connection).
//
//   listActiveRoles   GET  {base}/open/activeRoles?pageNum&pageSize   (Authorization: <key>)
//   submitReferral    POST {base}/recruitment2/open/submitReferral/<roleId>   multipart: candidate (JSON) + cv (PDF)
//   markInterested    POST {base}/recruitment2/open/submitReferral/<roleId>   multipart: shortlist (JSON) only
//   verifyWebhookSignature   X-Pieworks-Signature on the 2call webhook
//
// RULES IT KEEPS
// - Configuration only from env (PIEWORKS_API_BASE, PIEWORKS_API_KEY, PIEWORKS_REFERRAL_CODE); any unset = refused.
// - Tests never reach a live host: under Vitest any host other than *.test / localhost is refused before a request.
// - Every reply is parsed (lib/schemas/pieworks.mjs). A role that does not parse is reported by id and skipped.
// - A candidate is validated BEFORE anything is sent: a payload with a gap cannot be built.
// - The API documents the justification field under two spellings ("justification" and "justifications"), so both
//   keys carry the same text.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PieworksRole, PieworksRolesPage, PieworksSubmitReply, PieworksCandidate, PieworksShortlistUpdate } from "../schemas/pieworks.mjs";

/** Hosts a test may point the client at; every other host is treated as live and refused under test. */
const TEST_HOST = /(^|\.)(test|localhost)$|^127\.0\.0\.1$/i;
const underTest = () => Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

/** The connection's settings from env, or why it cannot run. Pure over the given env. */
export function pieworksConfig(env = process.env) {
  const base = String(env.PIEWORKS_API_BASE || "").trim().replace(/\/+$/, "");
  const key = String(env.PIEWORKS_API_KEY || "").trim();
  const referralCode = String(env.PIEWORKS_REFERRAL_CODE || "").trim();
  const missing = [!base && "PIEWORKS_API_BASE", !key && "PIEWORKS_API_KEY", !referralCode && "PIEWORKS_REFERRAL_CODE"].filter(Boolean);
  if (missing.length) return { ok: false, reason: `not configured: ${missing.join(", ")} unset` };
  let host;
  try { host = new URL(base).hostname; } catch { return { ok: false, reason: "PIEWORKS_API_BASE is not a URL" }; }
  return { ok: true, base, key, referralCode, host };
}

function guard(cfg) {
  if (!cfg?.ok) throw new Error(`Pieworks ${cfg?.reason || "not configured"}`);
  if (underTest() && !TEST_HOST.test(cfg.host)) throw new Error("refused: a test tried to reach the real Pieworks host");
}

/**
 * Every active role, page by page. One role that fails its schema is skipped and reported; a page that fails its
 * envelope stops the read (better no roles than a half-read list that looks complete).
 * @returns {Promise<{ roles: object[], skipped: Array<{id: unknown, issue: string}>, total: number }>}
 */
export async function listActiveRoles({ cfg = pieworksConfig(), fetchImpl = fetch, pageSize = 50, maxPages = 100 } = {}) {
  guard(cfg);
  const roles = [], skipped = [];
  let total = null;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${cfg.base}/open/activeRoles?pageNum=${page}&pageSize=${pageSize}`;
    const res = await fetchImpl(url, { method: "GET", headers: { Authorization: cfg.key, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Pieworks activeRoles page ${page}: HTTP ${res.status}`);
    const env = PieworksRolesPage.safeParse(await res.json());
    if (!env.success) throw new Error(`Pieworks activeRoles page ${page}: ${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 3).join("; ")}`);
    if (env.data.result !== 200) throw new Error(`Pieworks activeRoles page ${page}: result ${env.data.result} ${env.data.message || ""}`.trim());
    total = env.data.dataObject?.totalRows ?? total;
    const items = env.data.dataArray || [];
    for (const raw of items) {
      const r = PieworksRole.safeParse(raw);
      if (r.success) roles.push(r.data);
      else skipped.push({ id: raw && typeof raw === "object" ? raw.id : null, issue: r.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    if (!items.length || (total != null && roles.length + skipped.length >= total)) break;
  }
  // the total is what Pieworks SAYS it has; when it does not say, it stays unknown (role sync then closes nothing)
  return { roles, skipped, total };
}

/**
 * Submit one referred candidate with their CV. Validates first; sends nothing on a gap.
 * @returns {Promise<{ status: "sent"|"duplicate"|"refused", result: number, message: string|null }>}
 *   duplicate = Pieworks already has this person for this role (their 300 "already discovered").
 *   Throws on transport or envelope failure (the caller logs a failed attempt).
 */
/** A submit never hangs past this, so the stuck-submission recovery never meets a live one. */
export const SUBMIT_TIMEOUT_MS = 60_000;

export async function submitReferral({ cfg = pieworksConfig(), fetchImpl = fetch, roleId, candidate, cv }) {
  guard(cfg);
  if (!Number.isInteger(Number(roleId)) || Number(roleId) <= 0) throw new Error("submitReferral needs the Pieworks role id");
  const parsed = PieworksCandidate.safeParse({ ...candidate, referralCode: cfg.referralCode });
  if (!parsed.success) throw new Error(`the candidate is not complete: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
  if (!cv?.bytes?.length || !/\.pdf$/i.test(String(cv.filename || ""))) throw new Error("submitReferral needs the CV as a PDF");
  const body = new FormData();
  const part = { ...parsed.data, justifications: parsed.data.justification };
  body.append("candidate", new Blob([JSON.stringify(part)], { type: "application/json" }));
  body.append("cv", new Blob([cv.bytes], { type: "application/pdf" }), cv.filename);
  const res = await fetchImpl(`${cfg.base}/recruitment2/open/submitReferral/${Number(roleId)}`, { method: "POST", headers: { Accept: "application/json" }, body, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pieworks submitReferral: HTTP ${res.status}`);
  const reply = PieworksSubmitReply.safeParse(await res.json());
  if (!reply.success) throw new Error("Pieworks submitReferral: the reply did not match its schema");
  const { result, message = null } = reply.data;
  if (result === 200) return { status: "sent", result, message };
  if (/already\s+discovered/i.test(String(message || ""))) return { status: "duplicate", result, message };
  return { status: "refused", result, message };
}

/**
 * Move one shortlisted person from 2call to interested. Only the shortlist part is sent, never a CV and never a
 * candidate part. The only status this can send is interested (the schema allows nothing else).
 * @returns {Promise<{ ok: boolean, result: number, message: string|null }>} ok only on Pieworks' result 200.
 *   Throws on transport or envelope failure (the caller counts an attempt and tries again later).
 */
export async function markInterested({ cfg = pieworksConfig(), fetchImpl = fetch, requirementId, shortlistId }) {
  guard(cfg);
  if (!Number.isInteger(Number(requirementId)) || Number(requirementId) <= 0) throw new Error("markInterested needs the Pieworks requirement id");
  const part = PieworksShortlistUpdate.parse({ id: Number(shortlistId), status: { id: 2, name: "interested" } });
  const body = new FormData();
  body.append("shortlist", new Blob([JSON.stringify(part)], { type: "application/json" }));
  const res = await fetchImpl(`${cfg.base}/recruitment2/open/submitReferral/${Number(requirementId)}`, { method: "POST", headers: { Accept: "application/json" }, body, signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Pieworks markInterested: HTTP ${res.status}`);
  const reply = PieworksSubmitReply.safeParse(await res.json());
  if (!reply.success) throw new Error("Pieworks markInterested: the reply did not match its schema");
  const { result, message = null } = reply.data;
  return { ok: result === 200, result, message };
}

/** How old a signed webhook may be: the API rejects a t older than 5 minutes. */
export const WEBHOOK_MAX_AGE_S = 300;

/**
 * The 2call webhook's signature: header `t=<unix>,v1=<hex>`, v1 = HMAC-SHA256(secret, `${t}.${rawBody}`).
 * Fails closed: no secret, no header, a malformed header, a stale or future t, or a mismatch is false. Pure.
 */
export function verifyWebhookSignature({ secret, header, rawBody, nowS = Math.floor(Date.now() / 1000) }) {
  if (!secret || !header || rawBody == null) return false;
  const parts = Object.fromEntries(String(header).split(",").map((kv) => kv.trim().split("=")).filter((a) => a.length === 2));
  const t = Number(parts.t);
  const v1 = String(parts.v1 || "");
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false;
  if (Math.abs(nowS - t) > WEBHOOK_MAX_AGE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody)}`).digest();
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
