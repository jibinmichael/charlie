// representations.test.mjs — the representations migration: what happened after a person was put in
// front of a company. A re-run cannot inflate the counts, and no row claims an outcome nobody knew.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const migration = () => {
  const f = readdirSync(`${ROOT}supabase/migrations`).find((n) => /representations\.sql$/.test(n));
  expect(f, "the representations migration must exist").toBeTruthy();
  return readFileSync(`${ROOT}supabase/migrations/${f}`, "utf8");
};

describe("the migration", () => {
  it("keys one row per person per role, so a re-run cannot double the denominator", () => {
    expect(migration()).toMatch(/unique\s*\(\s*candidate_email\s*,\s*company\s*,\s*role_title\s*\)/i);
  });

  it("lets every response field be null, because 'we have not heard' is a real state", () => {
    const sql = migration();
    for (const col of ["company_responded_at", "company_response", "interview_at", "outcome_at"]) {
      expect(sql).toMatch(new RegExp(`${col}\\s+\\w+`));
      // not null on any of these would force a lie at insert time
      expect(sql).not.toMatch(new RegExp(`${col}\\s+[\\w ]*not null`, "i"));
    }
  });

  it("defaults a new row to awaiting rather than to an outcome", () => {
    expect(migration()).toMatch(/outcome\s+text\s+not null\s+default\s+'awaiting'/i);
  });

  it("indexes the silence: represented, never responded", () => {
    expect(migration()).toMatch(/where\s+company_responded_at\s+is\s+null/i);
  });

  it("does not touch talent_pool or candidates", () => {
    const sql = migration();
    expect(sql).not.toMatch(/alter table[^;]*talent_pool/i);
    expect(sql).not.toMatch(/alter table[^;]*candidates/i);
    expect(sql).not.toMatch(/\bdrop\b/i);
  });
});
