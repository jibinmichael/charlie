// verdict-cache-chunk.test.mjs — the mechanical guard on the match verdict cache's read chunk size.
//
// getVerdicts() reads with a PostgREST `.in("cache_key", chunk)` filter, which rides in the GET query
// STRING, not the body. Cache keys are sha-256 hex (64 chars), so the chunk size is a URL-length
// budget, not a row budget. Too large a chunk (500 keys ≈ 32 KB) makes every read fail with "Bad
// Request"; the caller fails OPEN, so the cache silently never serves a hit. With zero reuse every
// pair re-scores at full price, the run's estimate can cross MAX_RUN_COST_USD, match-batch throws,
// and the `engine:run` &&-chain sends nothing — while looking exactly like a cold cache.
//
// Against the production gateway, 200 keys work and 250 return Bad Request, so the budget below sits
// under the smallest size proven to work, not at the cliff.

import { describe, it, expect } from "vitest";
import { VERDICT_CHUNK } from "./charlie-store.mjs";
import { matchCacheKey } from "./lib/match-cache-key.mjs";

// The real key length, derived from the real key function — never assumed.
const KEY_LEN = matchCacheKey({
  model: "claude-haiku-4-5", maxTokens: 1024, matcherText: "rubric", dossierText: "dossier",
  job: { id: "greenhouse:acme:1", title: "Engineer" }, constrained: true,
}).length;

// Worst-case bytes one chunk contributes to the `in.(…)` filter: each key plus its comma.
const filterBytes = (n) => n * (KEY_LEN + 1);

// 12 KB: comfortably under the 13 KB (200-key) chunk proven to work against prod, leaving room for
// the rest of the URL (host, path, select, the scored_at filter) inside the gateway's limit.
const MAX_IN_FILTER_BYTES = 12_000;

describe("match verdict cache read chunking", () => {
  it("uses sha-256 hex keys, so chunk size is a URL budget", () => {
    expect(KEY_LEN).toBe(64);
  });

  it("keeps one read chunk under the proven-safe URL filter budget", () => {
    expect(filterBytes(VERDICT_CHUNK)).toBeLessThan(MAX_IN_FILTER_BYTES);
  });

  // A chunk at the known failure size must exceed the budget, so raising the chunk back toward it
  // fires the assertion above.
  it("rejects a 500-key chunk, which silently fails every cache read", () => {
    expect(filterBytes(500)).toBeGreaterThan(MAX_IN_FILTER_BYTES);
    expect(filterBytes(250)).toBeGreaterThan(MAX_IN_FILTER_BYTES); // the known failure point
  });
});
