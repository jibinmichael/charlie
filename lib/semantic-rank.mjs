// lib/semantic-rank.mjs — the async glue for the SEMANTIC pre-filter rank.
//
// selectForUser is a pure sync function; the async work (loading job vectors, embedding the person)
// lives here so callers (match-batch = daily email, match-one = chat/first-role) stay thin. Everything
// is FAIL-OPEN: any miss returns null/empty and the caller falls back to the lexical ranking.
//
// Opt-in: semanticRankOn() is true only when VOYAGE_SEMANTIC=on AND a Voyage key is configured. So the
// code ships dark — merged and safe — and lights up only when the flag is deliberately flipped.

import { embedTexts, semanticEnabled, unpackInt8Vectors } from "./voyage.mjs";
import { loadJobEmbeddings } from "../charlie-store.mjs";
import { personBlob } from "../select-jobs.mjs";

/** Semantic ranking is active only when explicitly flagged AND a key is present. */
export const semanticRankOn = () => process.env.VOYAGE_SEMANTIC === "on" && semanticEnabled();

// Process-cached pool vectors (short TTL) so the per-request server path doesn't re-download the blob
// every chat turn. The daily engine loads once per run anyway. Fail-open → empty map on any error.
let _cache = null;
const TTL_MS = Number(process.env.VOYAGE_VEC_TTL_MS || 600000);
export async function loadPoolVectors() {
  const now = Date.now();
  if (_cache && now - _cache.at < TTL_MS) return _cache.map;
  try {
    const map = unpackInt8Vectors(await loadJobEmbeddings());
    _cache = { at: now, map };
    return map;
  } catch (e) {
    console.log(`[semantic] pool-vector load failed: ${e?.message} (falling back to lexical)`);
    return new Map();
  }
}

/** Embed ONE person's grounded blob → their query vector, or null (fail-open). */
export async function buildPersonVec(dossier) {
  try {
    const out = await embedTexts([personBlob(dossier)], { inputType: "query" });
    return out && out[0] ? out[0] : null;
  } catch (e) {
    console.log(`[semantic] person-vector build failed: ${e?.message} (falling back to lexical)`);
    return null;
  }
}
