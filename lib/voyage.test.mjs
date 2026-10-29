// lib/voyage.test.mjs — guards the Voyage embeddings client + cosine util, and above all the
// FAIL-OPEN contract: no key, an HTTP error, a schema mismatch, or a blank input must degrade to
// "no vector" (caller uses lexical), never throw and never poison the batch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { embedTexts, cosineSim, semanticEnabled, packInt8Vectors, unpackInt8Vectors } from "./voyage.mjs";
import { VoyageEmbeddings } from "./schemas/voyage-embeddings.mjs";

const okFetch = (rows) => async () => ({ ok: true, status: 200, json: async () => ({ data: rows, model: "voyage-3.5-lite" }) });
const errRes = (status) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) });

beforeEach(() => { process.env.VOYAGE_RETRY_BASE_MS = "1"; }); // keep backoff instant in tests
afterEach(() => { delete process.env.VOYAGE_API_KEY; delete process.env.VOYAGE_RETRY_BASE_MS; });

describe("cosineSim", () => {
  it("is 1 for identical, 0 for orthogonal, -1 for opposite", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSim([1, 2], [-1, -2])).toBeCloseTo(-1);
  });
  it("returns 0 (never throws) for missing/empty/mismatched vectors", () => {
    expect(cosineSim(null, [1])).toBe(0);
    expect(cosineSim([], [])).toBe(0);
    expect(cosineSim([1, 2], [1])).toBe(0);
    expect(cosineSim([0, 0], [0, 0])).toBe(0);
  });
});

describe("embedTexts fail-open", () => {
  it("returns null when no API key is set (semantic disabled)", async () => {
    expect(semanticEnabled()).toBe(false);
    expect(await embedTexts(["hello"])).toBeNull();
  });
  it("returns null for empty input", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    expect(await embedTexts([])).toBeNull();
  });
  it("returns all-null (not a throw) on an HTTP error", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const out = await embedTexts(["a", "b"], { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    expect(out).toEqual([null, null]);
  });
  it("returns all-null on a schema-mismatched response (logged + skipped)", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const out = await embedTexts(["a"], { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: "not-an-array", index: 0 }] }) }) });
    expect(out).toEqual([null]);
  });
});

describe("embedTexts retry-with-backoff", () => {
  it("retries a 429 and then succeeds", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    let calls = 0;
    const fetchImpl = async () => { calls++; return calls === 1 ? errRes(429) : { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2], index: 0 }] }) }; };
    expect(await embedTexts(["a"], { fetchImpl })).toEqual([[1, 2]]);
    expect(calls).toBe(2);
  });
  it("does NOT retry a non-retryable 401 (auth won't fix itself)", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    let calls = 0;
    const fetchImpl = async () => { calls++; return errRes(401); };
    expect(await embedTexts(["a"], { fetchImpl })).toEqual([null]);
    expect(calls).toBe(1);
  });
});

describe("embedTexts success path", () => {
  it("returns vectors aligned to the input order", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const out = await embedTexts(["a", "b"], { fetchImpl: okFetch([{ embedding: [1, 2, 3], index: 0 }, { embedding: [4, 5, 6], index: 1 }]) });
    expect(out).toEqual([[1, 2, 3], [4, 5, 6]]);
  });
  it("skips blank inputs (null in place) but embeds the rest, preserving positions", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    // inputs sent = ["a","b"] (the blank is dropped); Voyage indexes them 0,1 → map back to global 0,2
    const out = await embedTexts(["a", "   ", "b"], { fetchImpl: okFetch([{ embedding: [1], index: 0 }, { embedding: [2], index: 1 }]) });
    expect(out).toEqual([[1], null, [2]]);
  });
});

describe("packInt8Vectors / unpackInt8Vectors", () => {
  it("round-trips signed int8 vectors keyed by id", () => {
    const entries = [
      { id: "gh:acme:1", vec: [1, -2, 127, -128, 0] },
      { id: "lever:beta:9", vec: [-1, 2, -127, 100, -50] },
    ];
    const map = unpackInt8Vectors(packInt8Vectors(5, entries));
    expect(map.get("gh:acme:1")).toEqual([1, -2, 127, -128, 0]);
    expect(map.get("lever:beta:9")).toEqual([-1, 2, -127, 100, -50]);
    expect(map.size).toBe(2);
  });
  it("pads short vectors and preserves cosine ~1 after a round-trip", () => {
    const v = [10, -20, 30, -40];
    const map = unpackInt8Vectors(packInt8Vectors(4, [{ id: "x", vec: v }]));
    expect(cosineSim(map.get("x"), v)).toBeCloseTo(1);
  });
  it("returns an empty map for null/garbage input (never throws)", () => {
    expect(unpackInt8Vectors(null).size).toBe(0);
    expect(unpackInt8Vectors({ dim: 3 }).size).toBe(0);
  });
});

describe("VoyageEmbeddings schema", () => {
  it("accepts a well-formed response and rejects a malformed one", () => {
    expect(VoyageEmbeddings.safeParse({ data: [{ embedding: [1, 2], index: 0 }] }).success).toBe(true);
    expect(VoyageEmbeddings.safeParse({ data: [] }).success).toBe(false); // must have >=1
    expect(VoyageEmbeddings.safeParse({ data: [{ embedding: [], index: 0 }] }).success).toBe(false); // vector must be non-empty
  });
});
