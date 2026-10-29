// pool-table.test.mjs — the mechanical guards on moving the job pool from one blob to rows.
//
// The pool can be a single storage object near the Supabase Free plan's 50 MB per-file ceiling, with
// no way to read ONE posting. The job_pool migration turns it into rows.
//
// The failure this file prevents is quiet. If `POOL_COLUMNS` and the migration's column list drift
// apart, or the scanner gains a field that neither knows about, the round-trip DROPS it: `poolRow`
// writes null, the read returns null, and the matcher scores a posting whose location or
// compensation has silently vanished. Nothing throws; the pool just gets quietly worse.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { POOL_COLUMNS, POOL_ROW_CHUNK, poolWriteVerdict, getPoolJob, reviveJobRow } from "./charlie-store.mjs";
import { JOB_KEY_FIELDS, matchCacheKey } from "./lib/match-cache-key.mjs";

const MIGRATION = "supabase/migrations/20260801000000_job_pool.sql";
const sql = readFileSync(MIGRATION, "utf8");

// Column names out of the `create table … ( … )` body, read from the real file rather than restated.
function migrationColumns(text) {
  const body = text.slice(text.indexOf("create table"), text.indexOf(");"));
  const out = [];
  for (const line of body.split("\n").slice(1)) {
    const m = /^\s{2}([a-z_]+)\s+(text|timestamptz|jsonb|boolean|integer)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

describe("job_pool column parity", () => {
  it("reads a real column list out of the migration (the parser itself must work)", () => {
    // If this ever returns [] the two assertions below would pass vacuously and guard nothing.
    expect(migrationColumns(sql).length).toBeGreaterThan(10);
  });

  it("writes exactly the columns the migration declares — no more, no fewer", () => {
    // Extra column in POOL_COLUMNS -> every upsert 400s and the mirror silently never populates.
    // Missing column -> that field is dropped on the round-trip, silently, forever.
    expect([...POOL_COLUMNS].sort()).toEqual([...migrationColumns(sql)].sort());
  });

  it("carries every field the matcher's cache key reads", () => {
    // JOB_KEY_FIELDS is what defines a posting's identity to the scorer (lib/match-cache-key.mjs). A
    // field in there but not in the table means the table's copy of a job keys DIFFERENTLY from the
    // blob's — the verdict cache would miss on every pair the moment POOL_TABLE flips, and the whole
    // day's matching would silently re-score at full price.
    const missing = JOB_KEY_FIELDS.filter((f) => !POOL_COLUMNS.includes(f));
    expect(missing).toEqual([]);
  });

  it("keeps the scanner's own timestamps, which JOB_KEY_FIELDS deliberately excludes", () => {
    // first_seen/last_seen are NOT in the cache key (they are re-stamped every run and carry no fit
    // signal) but they ARE load-bearing here: last_seen is what the prune deletes on, so losing it
    // would leave every departed role in the pool forever.
    expect(POOL_COLUMNS).toContain("first_seen");
    expect(POOL_COLUMNS).toContain("last_seen");
    expect(JOB_KEY_FIELDS).not.toContain("last_seen");
  });
});

describe("job_pool write chunking", () => {
  // A posting is capped at 2,500 chars of description (charlie-store saveJobPool) plus title, company,
  // location, apply_url and the rest — call it ~3 KB of JSON at the cap.
  const WORST_CASE_ROW_BYTES = 3_000;

  it("keeps one upsert payload inside a sane PostgREST body budget", () => {
    // Not a URL budget like the verdict cache's read chunk — an upsert rides in the BODY. The failure
    // mode is still the same shape: too large, every write 4xx's, the caller swallows it (the blob is
    // already written), and the table quietly stays empty while looking healthy.
    expect(POOL_ROW_CHUNK * WORST_CASE_ROW_BYTES).toBeLessThan(1_000_000);
  });

  it("chunks the real pool into a workable number of requests", () => {
    // Tens of thousands of postings. If this ever needs thousands of round-trips the mirror is the wrong shape.
    expect(Math.ceil(16_197 / POOL_ROW_CHUNK)).toBeLessThan(100);
  });
});

describe("job_pool migration safety", () => {
  it("is idempotent, so a re-apply cannot destroy the table", () => {
    expect(sql).toMatch(/create table if not exists public\.job_pool/);
    for (const idx of ["company", "source", "posted_at", "last_seen"]) {
      expect(sql).toMatch(new RegExp(`create index if not exists job_pool_${idx}_idx`));
    }
  });

  it("enables RLS and grants no anon policy", () => {
    // Service-role bypasses RLS; anon/authenticated must get nothing. The site ships NEXT_PUBLIC_* only.
    expect(sql).toMatch(/alter table public\.job_pool enable row level security/);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("never drops or alters anything (migrations are append-only)", () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|index)\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+\S+\s+drop\b/i);
  });

  it("indexes the id as a primary key — the single-row read this whole migration exists for", () => {
    expect(sql).toMatch(/id\s+text\s+primary key/);
  });
});

// poolWriteVerdict — is a failed blob upload survivable?
//
// A pool of tens of thousands of ~3 KB postings exceeds the 50 MB per-file ceiling on the Supabase
// Free plan. That upload fails, saveJobPool throws, engine:run's &&-chain short-circuits, and the
// container reports Completed having sent nothing. This is the policy that makes it recoverable.
describe("poolWriteVerdict", () => {
  it("does not interfere when the blob wrote", () => {
    expect(poolWriteVerdict({ blobOk: true, mirroredRows: 0, tableReadsOn: false })).toBe("ok");
    expect(poolWriteVerdict({ blobOk: true, mirroredRows: 41397, tableReadsOn: true })).toBe("ok");
  });

  it("survives the 124 MB blob failure when the rows are durable and reads point at them", () => {
    expect(poolWriteVerdict({ blobOk: false, mirroredRows: 41397, tableReadsOn: true })).toBe("degraded");
  });

  it("still throws when the rows exist but nothing reads them", () => {
    // A populated table nobody reads is not a pool. Carrying on here would match against a stale blob
    // and call it a success.
    expect(poolWriteVerdict({ blobOk: false, mirroredRows: 41397, tableReadsOn: false })).toBe("fail");
  });

  it("still throws when reads point at an EMPTY table — the worst case, not the safe one", () => {
    // POOL_TABLE=on over zero rows would let the run continue and quietly match against nothing:
    // a silent zero dressed as a success.
    expect(poolWriteVerdict({ blobOk: false, mirroredRows: 0, tableReadsOn: true })).toBe("fail");
  });

  it("fails closed on a malformed row count instead of guessing", () => {
    for (const rows of [undefined, null, NaN, -1, "lots"]) {
      expect(poolWriteVerdict({ blobOk: false, mirroredRows: rows, tableReadsOn: true })).toBe("fail");
    }
  });

  it("requires the flag to be genuinely true, not merely truthy", () => {
    // poolTableOn() returns a boolean; anything else reaching here means a caller passed a raw env
    // string, and "off" is truthy. Fail closed rather than read "off" as on.
    expect(poolWriteVerdict({ blobOk: false, mirroredRows: 10, tableReadsOn: "off" })).toBe("fail");
  });
});

// ── the single-posting read (getPoolJob) ─────────────────────────────────────
//
// A caller wanting ONE posting (the gift-a-role fit check at check@ and the /j role page) must not
// download the whole pool and `.find()` over it per click. These assertions cover both halves: that
// the fallback chain is correct, and that the two routes actually go through it.
describe("getPoolJob", () => {
  const ROW = { id: "abc", title: "Staff Designer", company: "Acme", description: "real JD" };

  it("returns the table row without ever touching the blob", async () => {
    let blobReads = 0;
    const job = await getPoolJob("abc", { byId: async () => ROW, all: async () => { blobReads++; return []; } });
    expect(job).toEqual(ROW);
    // The point of the whole migration. If this ever regresses, the fast path is decorative.
    expect(blobReads).toBe(0);
  });

  it("falls back to the blob when the table cannot answer", async () => {
    // An un-applied migration, an empty table, or an id the mirror has not caught up to yet all land
    // here. The worst case must be exactly the old behaviour, never an error and never a null.
    const job = await getPoolJob("abc", { byId: async () => null, all: async () => [{ id: "zzz" }, ROW] });
    expect(job).toEqual(ROW);
  });

  it("falls back to the blob when the table THROWS, rather than propagating", async () => {
    const job = await getPoolJob("abc", { byId: async () => { throw new Error("relation does not exist"); }, all: async () => [ROW] });
    expect(job).toEqual(ROW);
  });

  it("returns null — never throws — when both reads fail", async () => {
    // These two routes are fail-open by contract: the fit-check falls through to the pasted JD and the
    // /j page renders with a minimal role. An exception here would 500 a page instead.
    const job = await getPoolJob("abc", { byId: async () => { throw new Error("down"); }, all: async () => { throw new Error("also down"); } });
    expect(job).toBeNull();
  });

  it("matches ids across the string/number boundary the blob and the table disagree on", async () => {
    // Eightfold and Amazon ids arrive as numbers; the table column is text. A strict === would miss.
    expect(await getPoolJob(123, { byId: async () => null, all: async () => [{ id: "123", title: "t" }] })).toEqual({ id: "123", title: "t" });
  });

  it("does not scan for a falsy id", async () => {
    let calls = 0;
    expect(await getPoolJob(null, { byId: async () => { calls++; return ROW; }, all: async () => { calls++; return [ROW]; } })).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("the server resolves one posting by id, not by scanning the pool", () => {
  // A source-level guard, in the drip-removal.test.mjs idiom. The unit tests above prove getPoolJob
  // behaves; only this proves the two routes were actually repointed at it. Written against the real
  // file so it fails the moment someone reintroduces the full-pool scan.
  const server = readFileSync("server/charlie-remote.ts", "utf8");

  it("never loads the whole pool to find a single job", () => {
    const scans = server.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /loadJobPool\s*\(/.test(line) && /\.find\s*\(/.test(line));
    expect(scans.map((s) => `${s.n}: ${s.line.trim().slice(0, 80)}`)).toEqual([]);
  });

  it("routes both single-posting lookups through getPoolJob", () => {
    // The gift-a-role fit check (check@) and the /j role page. Both take a job id out of a signed
    // token, so both are per-click.
    expect(server.match(/getPoolJob\(/g)?.length).toBe(2);
  });
});

// ── round-trip VALUE fidelity, not just column-name parity ────────────────────────────────────
// The guards above assert the column NAMES match. They never asserted that a value survives the
// trip: the migration declares `remote text` and `compensation text`, so Postgres hands back the
// boolean `true` as the STRING "true" and the compensation object as serialized JSON.
//
// That is not cosmetic. Consumers test `remote` with STRICT equality (`job?.remote === true` in
// quality-gate.mjs, `job.remote === false` in select-jobs.mjs), and "true" === true is false. So
// POOL_TABLE=on would make every explicitly-remote posting read as NOT remote, and quality-gate drops
// a blank-location posting unless it is flagged remote: remote roles would silently vanish.
//
// The revive is deliberately NARROW, because both fields are UNIONS in the real pool:
//   remote:       null · boolean · string  (e.g. "hybrid")
//   compensation: null · object  · string  (e.g. "18-20 GBP")
// Coercing every string would destroy genuine values. Only the two exact boolean literals and
// text that actually parses as JSON are revived.
describe("job_pool round-trip preserves VALUES, not just column names", () => {
  it('revives the boolean `remote` Postgres returns as text', () => {
    expect(reviveJobRow({ remote: "true" }).remote).toBe(true);
    expect(reviveJobRow({ remote: "false" }).remote).toBe(false);
  });

  it('leaves a genuine `remote` STRING alone — 452 postings say "hybrid", not a boolean', () => {
    expect(reviveJobRow({ remote: "hybrid" }).remote).toBe("hybrid");
    expect(reviveJobRow({ remote: "onsite" }).remote).toBe("onsite");
    expect(reviveJobRow({ remote: null }).remote).toBeNull();
  });

  it("revives a serialized compensation object", () => {
    const comp = { compensationTierSummary: null, scrapeableCompensationSalarySummary: "x" };
    expect(reviveJobRow({ compensation: JSON.stringify(comp) }).compensation).toEqual(comp);
  });

  it('leaves a genuine compensation STRING alone — 837 postings read like "18-20 GBP"', () => {
    expect(reviveJobRow({ compensation: "18-20 GBP" }).compensation).toBe("18-20 GBP");
    expect(reviveJobRow({ compensation: null }).compensation).toBeNull();
  });

  it("keeps the string when text merely looks like JSON but does not parse", () => {
    expect(reviveJobRow({ compensation: "{not json" }).compensation).toBe("{not json");
  });

  // The whole point: the cache key must be identical whether the pool came from the blob or the rows,
  // or flipping POOL_TABLE re-scores the pool at full price on top of dropping the remote roles.
  it("produces the same matchCacheKey from a blob job and its revived row", () => {
    const blobJob = { id: "j1", title: "Engineer", description: "d", remote: true, compensation: { min: 1 } };
    const row = { id: "j1", title: "Engineer", description: "d", remote: "true", compensation: JSON.stringify({ min: 1 }) };
    const key = (job) => matchCacheKey({ model: "m", maxTokens: 1, matcherText: "r", dossierText: "d", job });
    expect(key(reviveJobRow(row))).toBe(key(blobJob));
    expect(key(row)).not.toBe(key(blobJob)); // proves the regression: the RAW row keys differently
  });

  it("tolerates a null or non-object row without throwing", () => {
    expect(reviveJobRow(null)).toBeNull();
    expect(reviveJobRow(undefined)).toBeUndefined();
  });
});
