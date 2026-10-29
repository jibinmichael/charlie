// server/outreach.ts — the outreach inbox API: a hand-run role mandate's emails, both ways, one
// thread per person, with who they are. Read by the hiring workspace's Inbox.
//
// A SEPARATE ROUTER ON PURPOSE. This inbox's data is the legacy tables (sent_emails, inbound_messages,
// talent_pool), because that is where the role-intent and role-invite mail lives.
//
// DARK BY DEFAULT: behind HIRING_WORKSPACE, the same flag as the workspace it serves, read at call
// time. ONE SECRET: the VOICE_DASHBOARD_SECRET Bearer, as server/agents.ts.
//
// READ ONLY. Nothing here writes a row or sends anything (lib/hire-outreach.mjs, lib/hire-outreach-lifecycle.mjs).
// @ts-ignore — express ships no types here, same as charlie-remote.ts
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
// @ts-ignore — plain ESM JS
import { store } from "../charlie-store.mjs";
// @ts-ignore — plain ESM JS
import { loadOutreach, OUTREACH_MANDATES } from "../lib/hire-outreach.mjs";
// @ts-ignore — plain ESM JS
import { outreachRecipients, outreachInbound, listAttachments, fetchAttachment, readCv } from "../lib/outreach-files.mjs";
// @ts-ignore — plain ESM JS
import { withLifecycle } from "../lib/hire-outreach-lifecycle.mjs";
// @ts-ignore — plain ESM JS
import { syncOutreachPursuits } from "../lib/hire-pursuit-sync.mjs";
// @ts-ignore — plain ESM JS
import { pingHeartbeat } from "../lib/heartbeat.mjs";
// @ts-ignore — plain ESM JS
import { captureError } from "../lib/sentry-node.mjs";

type Request = any; type Response = any; type Router = any;

/** The workspace flag, read at call time; the same rule as server/agents.ts hireEnabled, kept here so this
 *  router stands alone. */
function hireEnabled(): boolean {
  return /^(on|1|true|yes)$/i.test(String(process.env.HIRING_WORKSPACE || "").trim());
}

function bearerOk(req: Request): "ok" | "unconfigured" | "bad" {
  const secret = String(process.env.VOICE_DASHBOARD_SECRET || "").trim();
  if (!secret) return "unconfigured";
  const m = /^Bearer\s+(.+)$/.exec(String(req.headers.authorization || ""));
  if (!m) return "bad";
  const a = Buffer.from(m[1].trim()), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "bad";
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>, log: (m: string) => void) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (e: any) {
    // The detail stays in our log under an id; the browser gets the id only, never internal error text.
    const id = randomUUID().slice(0, 8);
    log(`[outreach-api] ${id} ${req.method} ${req.path}: ${e?.message || e}`);
    if (!res.headersSent) res.status(500).json({ error: "Something went wrong", id });
  }
};

/** @param db the Supabase client (a fake under test) */
export function outreachRouter({ db = null as any, log = (m: string) => console.error(m), now = () => Date.now(), fetchImpl = undefined as any }: { db?: any; log?: (m: string) => void; now?: () => number; fetchImpl?: any } = {}): Router {
  const r = express.Router();
  const client = () => db || store();
  // The read-capable Resend key, the same one /inbound uses to fetch attachments (.env.example).
  const readKey = () => process.env.RESEND_READ_KEY || process.env.RESEND_API_KEY || "";
  const files = () => ({ key: readKey(), log, ...(fetchImpl ? { fetchImpl } : {}) });
  /** A filename safe for a Content-Disposition header. */
  const safeName = (n: string) => String(n || "file").replace(/[^\w.\- ()]+/g, "_").slice(0, 120);

  r.use("/outreach/api", (req: Request, res: Response, next: any) => {
    if (!hireEnabled()) return res.status(404).json({ error: "not found" });
    const v = bearerOk(req);
    if (v === "unconfigured") return res.status(503).json({ error: "no dashboard secret configured" });
    if (v === "bad") return res.status(401).json({ error: "unauthorized" });
    next();
  });

  r.get("/outreach/api/mandates", wrap(async (_req, res) => {
    res.json({ mandates: Object.entries(OUTREACH_MANDATES).map(([key, m]: [string, any]) => ({ key, role: m.role, city: m.city })) });
  }, log));

  r.get("/outreach/api/mandates/:key", wrap(async (req, res) => {
    const key = String(req.params.key || "");
    if (!Object.hasOwn(OUTREACH_MANDATES, key)) return res.status(404).json({ error: "no such mandate" });
    const m = (OUTREACH_MANDATES as any)[key];
    const at = now();
    // each thread carries where it stands in the candidate lifecycle (shadow, read only; lib/hire-outreach-lifecycle.mjs)
    res.json({ key, role: m.role, city: m.city, threads: await withLifecycle(client(), await loadOutreach(client(), key, at), key, at) });
  }, log));

  // The CV text a person gave us. Only outreach recipients; only the extracted text exists.
  r.get("/outreach/api/cv/:email", wrap(async (req, res) => {
    const email = String(req.params.email || "").toLowerCase();
    if (!(await outreachRecipients(client())).has(email)) return res.status(404).json({ error: "no such person" });
    const text = await readCv(client(), email);
    if (text == null) return res.status(404).json({ error: "no CV on file" });
    res.setHeader("content-disposition", `attachment; filename="${safeName(email.split("@")[0] + " CV (text).txt")}"`);
    res.type("text/plain; charset=utf-8").send(text);
  }, log));

  // The attachments on one of their emails, read live from Resend. [] when there are none or Resend
  // no longer has the email.
  r.get("/outreach/api/messages/:emailId/attachments", wrap(async (req, res) => {
    const emailId = String(req.params.emailId || "");
    if (!(await outreachInbound(client(), emailId))) return res.status(404).json({ error: "no such message" });
    res.json({ attachments: (await listAttachments(emailId, files())) ?? [] });
  }, log));

  r.get("/outreach/api/messages/:emailId/attachments/:attId", wrap(async (req, res) => {
    const emailId = String(req.params.emailId || ""), attId = String(req.params.attId || "");
    if (!(await outreachInbound(client(), emailId))) return res.status(404).json({ error: "no such message" });
    const f = await fetchAttachment(emailId, attId, files());
    if (!f) return res.status(404).json({ error: "the attachment is no longer available" });
    res.setHeader("content-disposition", `attachment; filename="${safeName(f.filename)}"`);
    res.type(f.contentType).send(f.bytes);
  }, log));

  return r;
}

/**
 * The pursuit sync (lib/hire-pursuit-sync.mjs), run by charlie-remote.ts every 15 minutes: keeps the saved
 * lifecycle in step with the outreach emails. A no-op while HIRING_WORKSPACE is off. Pings
 * HEARTBEAT_URL_PURSUIT_SYNC on a clean pass and its /fail when any person could not be saved, so a
 * silent drift is an alert, not a green tick.
 */
let syncing = false; // one sync at a time: a slow run is never overlapped by the next tick
export async function runPursuitSync({ db = null as any, log = (m: string) => console.error(m) }: { db?: any; log?: (m: string) => void } = {}) {
  if (!hireEnabled()) return null;
  if (syncing) { log("[pursuit-sync] the previous run is still going; skipped this tick"); return null; }
  syncing = true;
  try {
    const r = await syncOutreachPursuits(db || store(), { log });
    const totals = Object.values(r.mandates).reduce((a: any, n: any) => { for (const k of Object.keys(n)) a[k] = (a[k] || 0) + n[k]; return a; }, {} as any);
    log(`[pursuit-sync] ${JSON.stringify(totals)} skipped=${r.skipped.join(",") || "none"}`);
    const clean = !(totals.failed || totals.conflicts || totals.unmapped);
    await pingHeartbeat("pursuit_sync", clean ? {} : { fail: true });
    return r;
  } catch (e: any) {
    log(`[pursuit-sync] failed: ${e?.message || e}`);
    captureError(e, { kind: "pursuit-sync" });
    await pingHeartbeat("pursuit_sync", { fail: true });
    return null;
  } finally {
    syncing = false;
  }
}
