// select-jobs.test.mjs — guards the deterministic pre-filter, and specifically the RELEVANCE
// pre-rank added so the per-user cap keeps a person's most-relevant roles, not merely the freshest.
//
// Why this exists: sorting survivors by (famScore, freshness) and truncating at the cap would make
// the matcher see the N *newest* roles, not the N *best*, so a genuinely-best role could sit below
// the cut line and never be scored. The pre-filter ranks by deterministic relevance first. These
// tests pin: (1) relevanceScore orders by target-title + grounded-vocabulary overlap; (2) a highly
// relevant but OLD role beats a generic but FRESH one and survives the cap; (3) the FILTERS and the
// return shape hold; (4) odd dossier shapes never throw.

import { describe, it, expect, afterEach } from "vitest";
import { selectForUser, relevanceScore, userSignals, jobFamilies, personBlob } from "./select-jobs.mjs";

afterEach(() => { delete process.env.VOYAGE_SEM_WEIGHT; delete process.env.EDGE_ENGINE; });

// A US person so geo/eligibility gates trivially pass (region "us" never blocks eligibility, and a
// named US place is reachable) — keeps these tests focused on RANKING, not on the geo logic.
const usDesigner = {
  headline: "Product designer",
  preferences: { role: "Product Designer", comp_currency: "USD", location: "San Francisco" },
  strengths: ["Designing complex indoor wayfinding, map navigation and AI workflows"],
};

const job = (id, title, description, posted_at) => ({
  id, title, company: `Co-${id}`, location: "San Francisco, CA", remote: true, description, posted_at,
});

describe("relevanceScore", () => {
  const sig = userSignals(usDesigner);

  it("ranks a target-title + grounded-vocabulary match above a generic same-family role", () => {
    const relevant = job("a", "Product Designer, Indoor Maps", "indoor wayfinding navigation workflows", "2021-01-01");
    const generic = job("b", "Product Designer", "we make software", "2026-07-01");
    expect(relevanceScore(relevant, sig)).toBeGreaterThan(relevanceScore(generic, sig));
  });

  it("scores an off-vocabulary role in the same family lowest of the three", () => {
    const relevant = job("a", "Product Designer, Indoor Maps", "indoor wayfinding navigation workflows", "2021-01-01");
    const generic = job("b", "Product Designer", "we make software", "2026-07-01");
    const weak = job("c", "Design Contractor", "short gig", "2026-07-01");
    expect(relevanceScore(weak, sig)).toBeLessThan(relevanceScore(generic, sig));
    expect(relevanceScore(weak, sig)).toBeLessThan(relevanceScore(relevant, sig));
  });

  it("never throws on missing job text", () => {
    expect(() => relevanceScore({}, sig)).not.toThrow();
    expect(relevanceScore({}, sig)).toBe(0);
  });
});

describe("selectForUser ranking (the cap keeps the best, not the freshest)", () => {
  it("keeps a highly-relevant OLD role over a generic FRESH one when the cap truncates", () => {
    const relevant = job("relevant", "Product Designer, Indoor Maps", "indoor wayfinding navigation ai workflows", "2020-01-01"); // oldest
    const freshGeneric = job("fresh1", "Product Designer", "generic team", "2026-07-15"); // newest
    const freshGeneric2 = job("fresh2", "Design Lead", "generic team", "2026-07-14");
    const { jobs } = selectForUser(usDesigner, [freshGeneric, freshGeneric2, relevant], 2);
    const ids = jobs.map((j) => j.id);
    // A pure freshness sort would keep the two fresh generic roles and cut `relevant` (oldest).
    // Under relevance, `relevant` must survive the cap of 2.
    expect(ids).toContain("relevant");
    expect(ids.length).toBe(2);
  });

  it("returns ALL survivors (order only) when under the cap — nothing dropped by ranking", () => {
    const a = job("a", "Product Designer", "x", "2026-01-01");
    const b = job("b", "Senior Product Designer", "y", "2026-02-01");
    const { jobs, stats } = selectForUser(usDesigner, [a, b], 150);
    expect(jobs.map((j) => j.id).sort()).toEqual(["a", "b"]);
    expect(stats.kept).toBe(2);
  });
});

describe("selectForUser filters unchanged (regression)", () => {
  it("still drops an out-of-family role", () => {
    const design = job("d", "Product Designer", "x", "2026-01-01");
    const offFamily = job("m", "Account Executive", "sales quota", "2026-07-01");
    const { jobs } = selectForUser(usDesigner, [design, offFamily], 150);
    const ids = jobs.map((j) => j.id);
    expect(ids).toContain("d");
    expect(ids).not.toContain("m");
  });

  it("preserves the return shape (jobs + stats fields)", () => {
    const { jobs, stats } = selectForUser(usDesigner, [job("d", "Product Designer", "x", "2026-01-01")], 150);
    expect(Array.isArray(jobs)).toBe(true);
    expect(stats).toMatchObject({ in: 1, kept: 1, taken: 1, region: "us" });
    expect(Array.isArray(stats.families)).toBe(true);
  });
});

describe("semantic blend (Phase B, opt-in)", () => {
  it("personBlob leads with the grounded target + strengths, bounded", () => {
    const blob = personBlob(usDesigner);
    expect(blob).toMatch(/Product Designer/);
    expect(blob).toMatch(/wayfinding/i); // from strengths — the differentiator
    expect(blob.length).toBeLessThanOrEqual(4000);
  });

  it("reorders toward the vector-closest role, overriding lexical", () => {
    const strongLexical = job("lex", "Product Designer, Indoor Maps", "indoor wayfinding navigation", "2026-01-01");
    const weakLexical = job("sem", "Design Contractor", "short gig", "2026-01-01");
    const jobVecs = new Map([["lex", [0, 1]], ["sem", [1, 0]]]);
    const personVec = [1, 0]; // cosine-closest to "sem"
    process.env.VOYAGE_SEM_WEIGHT = "0.9"; // pin: semantic dominates, independent of the default
    // lexical alone picks the strong-lexical role...
    expect(selectForUser(usDesigner, [strongLexical, weakLexical], 1).jobs[0].id).toBe("lex");
    // ...semantic blend picks the vector-closest one.
    const out = selectForUser(usDesigner, [strongLexical, weakLexical], 1, { semantic: true, personVec, jobVecs });
    expect(out.jobs[0].id).toBe("sem");
    expect(out.stats.semantic).toBe(true);
  });

  it("a job with no vector falls back to lexical for that job (never throws)", () => {
    const a = job("a", "Product Designer", "x", "2026-01-01");
    const b = job("b", "Product Designer", "y", "2026-01-01");
    const jobVecs = new Map([["a", [1, 0]]]); // b has no vector
    const out = selectForUser(usDesigner, [a, b], 2, { semantic: true, personVec: [1, 0], jobVecs });
    expect(out.jobs.length).toBe(2);
    expect(out.stats.semantic).toBe(true);
  });

  it("opts without semantic:true (or missing vectors) stays on the lexical path", () => {
    const out = selectForUser(usDesigner, [job("a", "Product Designer", "x", "2026-01-01")], 1, { personVec: [1, 0], jobVecs: new Map() });
    expect(out.stats.semantic).toBe(false);
  });
});

describe("Edge Engine lean (Phase 1, dark behind EDGE_ENGINE)", () => {
  const withEdge = (confidence) => ({
    ...usDesigner,
    edge: { combo: "architecture + product design", strong_in: ["venue mapping tooling", "transit hub signage UX"], confidence },
  });

  it("EDGE_ENGINE=on + high-confidence edge leans the vector toward the strong_in domains", () => {
    process.env.EDGE_ENGINE = "on";
    expect(personBlob(withEdge("high"))).toMatch(/signage/i); // a strong_in domain not otherwise in the blob
  });

  it("dark: EDGE_ENGINE off leaves the blob byte-identical (no strong_in leaned in)", () => {
    delete process.env.EDGE_ENGINE;
    expect(personBlob(withEdge("high"))).not.toMatch(/signage/i);
    expect(personBlob(withEdge("high"))).toBe(personBlob(usDesigner)); // unchanged from the pre-edge blob
  });

  it("a non-high-confidence edge is never leaned on, even with the flag on", () => {
    process.env.EDGE_ENGINE = "on";
    expect(personBlob(withEdge("medium"))).not.toMatch(/signage/i);
    expect(personBlob(withEdge("low"))).not.toMatch(/signage/i);
  });
});

describe("robustness", () => {
  it("userSignals tolerates strengths as objects and missing fields", () => {
    expect(() => userSignals({ preferences: {}, strengths: [{ text: "wayfinding UX" }, { point: "data viz" }] })).not.toThrow();
    expect(() => userSignals({})).not.toThrow();
    expect(() => userSignals(null)).not.toThrow();
  });

  it("relevanceScore itself orders by overlap even for a niche target (function-level)", () => {
    const niche = { headline: "Prompt engineer", preferences: { role: "Prompt engineer", comp_currency: "USD", location: "Austin" }, strengths: ["LLM evaluation and prompt tuning"] };
    const sig = userSignals(niche);
    const onTopic = job("p", "Prompt Engineer", "LLM evaluation prompt tuning", "2020-01-01");
    const offTopic = job("o", "Prompt Coordinator", "front desk", "2026-07-01");
    expect(relevanceScore(onTopic, sig)).toBeGreaterThan(relevanceScore(offTopic, sig));
  });

  it("selectForUser does NOT re-rank an UNCLASSIFIED target — falls back to freshness (no regression)", () => {
    // "chief happiness officer" maps to no family. The guard keeps the status-quo freshness order so
    // a weak/absent relevance signal can never reorder (and possibly worsen) an unclassified user.
    const unclassified = { headline: "Chief Happiness Officer", preferences: { role: "Chief Happiness Officer", comp_currency: "USD", location: "Austin" } };
    expect(userSignals(unclassified).families.size).toBe(0); // precondition: genuinely unclassified
    const older = job("older", "Chief Happiness Officer", "great vocabulary match happiness", "2020-01-01");
    const newer = job("newer", "Office Manager", "unrelated", "2026-07-01");
    // With no family, family gate is skipped so BOTH pass; order must be freshness (newer first).
    const { jobs } = selectForUser(unclassified, [older, newer], 1);
    expect(jobs.map((j) => j.id)).toEqual(["newer"]); // freshest wins
  });

  it("jobFamilies stays exported and stable", () => {
    expect(jobFamilies("Senior Product Designer")).toContain("design");
  });
});

// ── RETRIEVAL MODE — the family regex as a GATE vs a RANKING signal ──────────────────────────────
//
// For a person with a clearly-stated target the family gate costs almost nothing, but for one whose
// career SPANS buckets it can delete most of their best semantic matches before any model scores
// them: an enterprise-IT program manager with hands-on Oracle/Salesforce, bucketed
// `product/operations` from the headline, would never see an Oracle or Salesforce role.
// `spanningCareer` below is that shape, as a fixture.
//
// The contract these pin: OFF applies the gate as-is, SHADOW measures without changing anything,
// ENFORCE widens ONLY rule 1 — every other rule (the person's remote preference, their dealbreakers,
// seniority sanity) still gates in every mode, because those are consent, not vocabulary.
describe("retrieval mode (family regex: gate vs ranking signal)", () => {
  afterEach(() => { delete process.env.RETRIEVAL_MODE; });

  const spanningCareer = {
    headline: "Enterprise IT program and product management professional with over 13 years in supply chain",
    // US-located like the fixtures above, so geo/eligibility trivially pass and these tests isolate
    // the FAMILY gate rather than re-testing the geo logic.
    preferences: { role: null, tech: ["Oracle Fusion Cloud", "Salesforce", "SQL", "Java"], comp_currency: "USD", location: "San Francisco" },
    strengths: ["Techno-functional consulting bridging business needs and technical delivery"],
  };
  // The career, in a family (engineering) the headline never names.
  const oracleRole = job("oracle", "Senior Consultant - Oracle Fusion Technical", "oracle fusion cloud sql java enterprise", "2026-07-20");
  const inFamilyRole = job("pm", "Technical Project Manager", "program delivery", "2026-07-20");

  it("OFF (default): the cross-functional role is deleted before the matcher — today's behaviour", () => {
    const { jobs, stats } = selectForUser(spanningCareer, [oracleRole, inFamilyRole], 50);
    expect(jobs.map((j) => j.id)).not.toContain("oracle");
    expect(jobs.map((j) => j.id)).toContain("pm");
    expect(stats.retrieval).toBe("off");
  });

  it("ENFORCE: the same role survives and can compete for a slot", () => {
    process.env.RETRIEVAL_MODE = "enforce";
    const { jobs, stats } = selectForUser(spanningCareer, [oracleRole, inFamilyRole], 50);
    expect(jobs.map((j) => j.id)).toContain("oracle");
    expect(jobs.map((j) => j.id)).toContain("pm"); // widening ADDS, it never removes
    expect(stats.retrieval).toBe("enforce");
  });

  it("SHADOW: returns exactly what OFF returns, and reports what the gate costs", () => {
    const off = selectForUser(spanningCareer, [oracleRole, inFamilyRole], 50);
    process.env.RETRIEVAL_MODE = "shadow";
    const shadow = selectForUser(spanningCareer, [oracleRole, inFamilyRole], 50);
    expect(shadow.jobs.map((j) => j.id)).toEqual(off.jobs.map((j) => j.id)); // ZERO behaviour change
    expect(shadow.stats.widenedGain).toBeGreaterThan(0);                     // but it measured the cost
    expect(shadow.stats.eligible).toBeGreaterThan(shadow.stats.kept);
  });

  it("ENFORCE still honours the person's OWN stated preferences — remote, dealbreakers, seniority", () => {
    process.env.RETRIEVAL_MODE = "enforce";
    const wantsRemote = { ...spanningCareer, preferences: { ...spanningCareer.preferences, remote: "remote only", dealbreakers: ["crypto"] } };
    const onsite = { ...job("onsite", "Senior Oracle Engineer", "oracle", "2026-07-20"), remote: false, location: "San Francisco, CA (onsite only)" };
    const crypto = job("crypto", "Oracle Engineer, crypto", "oracle", "2026-07-20");
    const ok = job("ok", "Senior Oracle Engineer", "oracle", "2026-07-20");
    const ids = selectForUser(wantsRemote, [onsite, crypto, ok], 50).jobs.map((j) => j.id);
    expect(ids).not.toContain("onsite"); // their remote preference still gates
    expect(ids).not.toContain("crypto"); // their dealbreaker still gates
    expect(ids).toContain("ok");
  });

  it("ENFORCE still drops an intern role for a senior person (the never-an-internship floor)", () => {
    process.env.RETRIEVAL_MODE = "enforce";
    const senior = { headline: "Staff engineer", preferences: { role: "Staff Engineer", comp_currency: "USD", location: "San Francisco" } };
    const intern = job("intern", "Software Engineering Intern", "learn with us", "2026-07-20");
    const real = job("real", "Staff Software Engineer", "build systems", "2026-07-20");
    const ids = selectForUser(senior, [intern, real], 50).jobs.map((j) => j.id);
    expect(ids).not.toContain("intern");
    expect(ids).toContain("real");
  });

  it("an unclassified target is unaffected in every mode (no families = the gate was already off)", () => {
    const noTarget = { headline: "builder", preferences: { comp_currency: "USD", location: "San Francisco" } };
    const a = job("a", "Anything At All", "x", "2026-07-20");
    const off = selectForUser(noTarget, [a], 50).jobs.map((j) => j.id);
    process.env.RETRIEVAL_MODE = "enforce";
    expect(selectForUser(noTarget, [a], 50).jobs.map((j) => j.id)).toEqual(off);
  });
  it("ENFORCE does NOT widen a person who STATED their target — their words still gate", () => {
    // Demoting the gate for people who stated a target hurts them: "Founder's Office / Chief of Staff"
    // draws "Staff Software Engineer" to #1; "AI Growth & Voice" draws "HR Analytics Specialist" and
    // "Principal Recruiter". The vector matches adjacent
    // vocabulary and outranks the role they actually asked for. A stated target is consent, like
    // remote and dealbreakers, so it keeps gating. Widening is only for a target Charlie GUESSED.
    process.env.RETRIEVAL_MODE = "enforce";
    const stated = {
      headline: "Operator",
      preferences: { role: "Founder's Office / Chief of Staff", comp_currency: "USD", location: "San Francisco" },
    };
    const asked = job("asked", "Chief of Staff", "founders office operations", "2026-07-20");
    const adjacent = job("adjacent", "Staff Software Engineer", "build systems", "2026-07-20");
    const ids = selectForUser(stated, [asked, adjacent], 50).jobs.map((j) => j.id);
    expect(ids).toContain("asked");
    expect(ids).not.toContain("adjacent"); // their stated target still gates
  });
});

// ── global-remote recovery ──────────────────────────────────────────────────────────────────────
// The drop this recovers is decided by `companyHiresIndia`, a fact about whether the EMPLOYER has any
// India posting, not evidence about THIS role, and it drops most remote roles for India users before
// the model sees them. Recovery does not declare them reachable; it lets them compete so the send
// gate's Tier-2 verifier (quality-gate.mjs) can read the JD and decide.
describe("B7 recovery — a company-level guess must not be the last word on a role", () => {
  afterEach(() => { delete process.env.B7_REMOTE_RECOVERY; delete process.env.REMOTE_ACCESS_TIER2; });

  // An India-based person who wants remote. tagCompanyReach is NOT called, so companyHiresIndia is
  // undefined on every job — and `!== false` keeps them reachable. Setting it false is what puts a
  // role in the recoverable branch, which is exactly the shape the pre-filter sees in production.
  const indiaPerson = {
    headline: "Product designer",
    preferences: { role: "Product Designer", remote: "remote", location: "Bengaluru, India", home_place: "Bengaluru, India" },
  };
  const bareRemote = (id) => ({
    id, title: "Product Designer", company: `Co-${id}`, location: "Remote", remote: true,
    companyHiresIndia: false, // the weak signal that drops it without recovery
    description: "Design work. No region, timezone or work-authorization requirement stated anywhere.",
    posted_at: new Date().toISOString(), apply_url: `https://x/${id}`,
  });
  const pick = () => selectForUser(indiaPerson, [bareRemote("r1"), bareRemote("r2")]).jobs.map((j) => j.id);

  it("drops the role today (flag unset) — the behaviour this recovers", () => {
    expect(pick()).toEqual([]);
  });

  it("still drops in shadow — shadow COUNTS, it must never change what is selected", () => {
    process.env.B7_REMOTE_RECOVERY = "shadow";
    expect(pick()).toEqual([]);
  });

  it("RECOVERS the role when armed (B7=on and Tier 2 on)", () => {
    process.env.B7_REMOTE_RECOVERY = "on";
    process.env.REMOTE_ACCESS_TIER2 = "on";
    expect(pick().sort()).toEqual(["r1", "r2"]);
  });

  // THE SAFETY GUARD. Recovering with no verifier downstream would hand an India user a remote role
  // that nothing ever checked — trading a wrong drop for a wrong send, and a wrong send is the one
  // this product cannot take back. Recovery must refuse to arm itself.
  it("REFUSES to recover when Tier 2 is off — a wrong send is worse than a wrong drop", () => {
    process.env.B7_REMOTE_RECOVERY = "on";
    process.env.REMOTE_ACCESS_TIER2 = "off";
    expect(pick()).toEqual([]);
  });
  it("REFUSES to recover when Tier 2 is only in shadow (it logs, it does not drop)", () => {
    process.env.B7_REMOTE_RECOVERY = "on";
    process.env.REMOTE_ACCESS_TIER2 = "shadow";
    expect(pick()).toEqual([]);
  });

  it("recovers ONLY that branch — a role in a genuinely foreign place still drops", () => {
    process.env.B7_REMOTE_RECOVERY = "on";
    process.env.REMOTE_ACCESS_TIER2 = "on";
    const foreign = { ...bareRemote("f1"), location: "Berlin, Germany", remote: false };
    expect(selectForUser(indiaPerson, [foreign]).jobs.map((j) => j.id)).toEqual([]);
  });
});
