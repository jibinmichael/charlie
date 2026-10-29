// lib/voyage.mjs — Voyage AI text-embeddings client for the SEMANTIC pre-filter rank.
//
// Two jobs: (1) embed text (job descriptions at scan, a grounded person blob per dossier) into
// vectors; (2) cosineSim to compare a person vector against a job vector. The blended semantic score
// is what lets a rare true combo (e.g. "architecture x UX design") surface a wayfinding role that shares
// no keywords with the person's resume — the thing lexical ranking (select-jobs.mjs) cannot do.
//
// FAIL-OPEN by design: if VOYAGE_API_KEY is unset, embedTexts returns null and the
// pre-filter uses lexical ranking only. Per-batch errors leave those items null (they fall back to
// lexical too). A Voyage outage can never fail the scan or the match — it only removes the semantic
// lift. The response is Zod-validated at the boundary; a malformed batch is logged + skipped.
//
// Env: VOYAGE_API_KEY (required to enable), VOYAGE_MODEL (default voyage-3.5-lite), VOYAGE_DIM
// (default 512).

import { VoyageEmbeddings } from "./schemas/voyage-embeddings.mjs";

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const BATCH = 128; // inputs per request (well within Voyage's per-request limits)
const TIMEOUT_MS = Number(process.env.VOYAGE_TIMEOUT_MS || 20000);

const log = (...a) => console.log("[voyage]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function* chunk(arr, n) {
  for (let i = 0; i < arr.length; i += n) yield [i, arr.slice(i, i + n)];
}

async function postWithTimeout(body, key, fetchImpl) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    return await (fetchImpl || fetch)(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: c.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

// Retry on 429 (rate limit) and 5xx (transient) with exponential backoff, honoring a Retry-After
// header when present. Auth/400 and other 4xx are NOT retried (they won't fix themselves). Embedding
// the whole pool is ~100 batches, so a rate limit WILL be hit occasionally even on the paid tier;
// without this those batches would silently fall back to lexical and leave holes in the vector set.
async function postWithRetry(body, key, fetchImpl) {
  const max = Number(process.env.VOYAGE_MAX_RETRIES || 5);
  const base = Number(process.env.VOYAGE_RETRY_BASE_MS || 500);
  for (let attempt = 0; ; attempt++) {
    const res = await postWithTimeout(body, key, fetchImpl);
    if (res.ok || attempt >= max) return res;
    if (!(res.status === 429 || res.status >= 500)) return res; // non-retryable (auth, 400, …)
    const ra = Number(res.headers?.get?.("retry-after"));
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, base * 2 ** attempt);
    await sleep(waitMs);
  }
}

/**
 * Embed an array of texts. Returns an array aligned to `texts` where each element is the vector
 * (number[]) or null if that item couldn't be embedded (fail-open → caller uses lexical). Returns
 * null for the WHOLE call when semantic is disabled (no API key) or given no input.
 *
 * @param {string[]} texts
 * @param {{ model?: string, dim?: number, inputType?: "document"|"query", fetchImpl?: Function }} [opts]
 * @returns {Promise<(number[]|null)[] | null>}
 */
export async function embedTexts(texts, opts = {}) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null; // fail-open: semantic disabled
  if (!Array.isArray(texts) || texts.length === 0) return null;

  const model = opts.model || process.env.VOYAGE_MODEL || "voyage-3.5-lite";
  const dim = Number(opts.dim || process.env.VOYAGE_DIM || 512);
  const inputType = opts.inputType || "document";
  const out = new Array(texts.length).fill(null);

  for (const [start, part] of chunk(texts, BATCH)) {
    // never send an empty/blank string to the API — mark those null, embed the rest
    const idx = [];
    const inputs = [];
    part.forEach((t, j) => {
      const s = String(t ?? "").trim();
      if (s) { idx.push(start + j); inputs.push(s.slice(0, 32000)); }
    });
    if (inputs.length === 0) continue;
    try {
      const res = await postWithRetry(
        { input: inputs, model, input_type: inputType, output_dimension: dim, output_dtype: "int8" },
        key,
        opts.fetchImpl,
      );
      if (!res.ok) { log(`batch @${start}: HTTP ${res.status} after retries — falling back to lexical for these`); continue; }
      const parsed = VoyageEmbeddings.safeParse(await res.json());
      if (!parsed.success) { log(`batch @${start}: schema mismatch (${parsed.error.issues[0]?.path}) — skipped`); continue; }
      for (const d of parsed.data.data) {
        const target = idx[d.index];
        if (target !== undefined) out[target] = d.embedding;
      }
    } catch (e) {
      log(`batch @${start}: ${e?.name === "AbortError" ? "timeout" : e?.message} — falling back to lexical`);
    }
  }
  return out;
}

/**
 * Cosine similarity of two equal-length numeric vectors. Returns 0 for a missing/empty/mismatched
 * pair (safe: a missing vector contributes no semantic signal rather than throwing).
 */
export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** True if a semantic key is configured (callers may branch on this to skip building person blobs). */
export const semanticEnabled = () => Boolean(process.env.VOYAGE_API_KEY);

// ── compact storage: int8 vectors packed as one base64 blob ──────────────────────────────────
// 13k jobs x 512-dim int8 = ~6.7MB raw (~9MB base64) vs ~20MB as JSON-of-arrays — well under the
// Supabase ~50MB object ceiling and it scales. int8 is Voyage's quantization-aware output, so cosine
// on it is near-lossless. `entries` = [{ id, vec:number[] }]; vec is clamped to `dim` and to int8.
export function packInt8Vectors(dim, entries) {
  const ids = new Array(entries.length);
  const buf = Buffer.alloc(entries.length * dim);
  entries.forEach((e, i) => {
    ids[i] = e.id;
    const vec = e.vec || [];
    for (let k = 0; k < dim; k++) buf[i * dim + k] = (vec[k] ?? 0) & 0xff; // signed int8 -> byte
  });
  return { dim, ids, b64: buf.toString("base64") };
}

/** Inverse of packInt8Vectors → Map<id, number[]> (signed int8 restored). Empty map on bad input. */
export function unpackInt8Vectors(obj) {
  const map = new Map();
  if (!obj?.b64 || !obj?.dim || !Array.isArray(obj.ids)) return map;
  const dim = obj.dim;
  const buf = Buffer.from(obj.b64, "base64");
  obj.ids.forEach((id, i) => {
    const vec = new Array(dim);
    for (let k = 0; k < dim; k++) { const b = buf[i * dim + k]; vec[k] = b > 127 ? b - 256 : b; }
    map.set(id, vec);
  });
  return map;
}
