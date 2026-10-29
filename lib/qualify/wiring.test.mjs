// lib/qualify/wiring.test.mjs — who Qualify & Submit asks the scorer about, and what it keeps. In memory; no network.
import { describe, it, expect, afterEach } from "vitest";
import { candidateIdFor, experienceGate, ownEvidence, scoringCandidate, scoringRole, qualifyDeps, EVALUATIONS_PER_PASS } from "./wiring.mjs";

/** A small stand-in for the Supabase client: rows per table, eq filters, update in place. */
function fakeDb(tables) {
  const writes = [];
  return {
    writes,
    storage: { from: () => ({}) },
    from(table) {
      const q = { filters: [], patch: null, limit: Infinity };
      const rows = () => (tables[table] || []).filter((r) => q.filters.every(([k, v]) => r[k] === v)).slice(0, q.limit);
      const run = () => {
        if (q.patch) { const hit = rows(); hit.forEach((r) => Object.assign(r, q.patch)); writes.push({ table, patch: q.patch }); return { data: hit, error: null }; }
        return { data: rows().map((r) => structuredClone(r)), error: null };
      };
      const b = {
        select: () => b, order: () => b, limit: (n) => ((q.limit = n), b),
        eq: (k, v) => (q.filters.push([k, v]), b),
        update: (patch) => ((q.patch = patch), b),
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: null }; },
        single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: null }; },
        then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
      };
      return b;
    },
  };
}

const saved = process.env.CANDIDATE_SCORER;
afterEach(() => { if (saved === undefined) delete process.env.CANDIDATE_SCORER; else process.env.CANDIDATE_SCORER = saved; });

describe("the pieces", () => {
  it("a pool person's id is a stable uuid from their address, whatever its case", () => {
    expect(candidateIdFor("Asha@X.com")).toBe(candidateIdFor("asha@x.com"));
    expect(candidateIdFor("asha@x.com")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(candidateIdFor("asha@x.com")).not.toBe(candidateIdFor("bina@x.com"));
  });

  it("the experience check is the role's own band against the years on record; unknown years are asked, never assumed", () => {
    expect(experienceGate(null, 1)).toEqual({ eligibility_status: "NO_CONSTRAINTS" });
    expect(experienceGate({ min: 2, max: 4 }, 3).eligibility_status).toBe("ELIGIBLE");
    expect(experienceGate({ min: 2, max: 4 }, 6).eligibility_status).toBe("INELIGIBLE");
    expect(experienceGate({ min: 2, max: null }, 12).eligibility_status).toBe("ELIGIBLE");
    expect(experienceGate({ min: 2, max: 4 }, null).eligibility_status).toBe("NEEDS_VERIFICATION");
  });

  it("their own words only: filed answers and the CV's paragraphs, never the bookkeeping keys", () => {
    const ev = ownEvidence({ answers: { consent: "Yes", "must:c1": "I resolved billing tickets for 2 years", _after: [{ words: "x" }], cv: null }, cv_text: "Short\n\nSupport engineer at Acme, resolving billing tickets and writing Zendesk macros." });
    expect(ev).toEqual([
      { id: "answer:consent", quote: "Yes" },
      { id: "answer:must:c1", quote: "I resolved billing tickets for 2 years" },
      { id: "cv:1", quote: "Support engineer at Acme, resolving billing tickets and writing Zendesk macros." },
    ]);
  });

  it("the scorer is given the role's own fields and the person's record, nothing else", () => {
    const role = scoringRole({ id: "job-1", title: "Support", client: "Northwind Labs" }, { external_id: "77", source: "pieworks", location: "Ajmer", criteria: [{ kind: "must_have", label: "Zendesk" }], experience: { min: 2, max: 4 }, payload: { id: 77 } });
    expect(role).toEqual({ id: "job-1", external_id: "77", source: "pieworks", title: "Support", client: "Northwind Labs", location: "Ajmer", must_haves: ["Zendesk"], experience: { min: 2, max: 4 }, payload: { id: 77 } });
    expect(scoringCandidate({ email: " A@x.com ", total_years: null, comp_expected: 9 })).not.toHaveProperty("comp_expected");
  });
});

describe("ensureEvaluated", () => {
  const pool = (i, over = {}) => ({ email: `p${i}@x.com`, full_name: `Person ${i}`, total_years: 3, consent_pool: true, seeking_status: null, ...over });
  const world = (people) => fakeDb({ hire_jobs: [{ id: "job-1", title: "Support", client: "Northwind Labs", last_search: null }], talent_pool: people, hire_connections: [] });

  it("scores consenting, looking people once per role, scorer and brief, and keeps the answers on the job", async () => {
    process.env.CANDIDATE_SCORER = "none";
    const db = world([pool(1), pool(2, { seeking_status: "not_looking" }), pool(3, { consent_pool: false })]);
    const deps = qualifyDeps(db, { log: () => {} });
    const job = { id: "job-1", title: "Support", client: "Northwind Labs" };
    const spec = { id: "role:abc", criteria: [], experience: null };
    const first = await deps.ensureEvaluated({ job, spec });
    expect(first.checked).toBe(1);
    expect([...first]).toEqual([expect.objectContaining({ candidate_id: candidateIdFor("p1@x.com"), fit: "strong", score: null, scorer: "none", person: expect.objectContaining({ email: "p1@x.com" }) })]);
    const again = await deps.ensureEvaluated({ job, spec });
    expect(again.checked).toBe(0);
    expect(again).toHaveLength(1);
    // a new brief (the role changed on the source) scores everyone again
    expect((await deps.ensureEvaluated({ job, spec: { ...spec, id: "role:def" } })).checked).toBe(1);
  });

  it("bounds the scorer's work per pass", async () => {
    process.env.CANDIDATE_SCORER = "none";
    const db = world(Array.from({ length: EVALUATIONS_PER_PASS + 5 }, (_, i) => pool(i + 1)));
    const deps = qualifyDeps(db, { log: () => {} });
    expect((await deps.ensureEvaluated({ job: { id: "job-1", title: "Support", client: "S" }, spec: { id: "role:x", criteria: [] } })).checked).toBe(EVALUATIONS_PER_PASS);
  });
});
