// lib/gap-chart.test.mjs — the gap chart stops guessing what a person is good at from string prefixes.
//
// The keyword chart's `covers()` (market-report.mjs) compares the first FOUR characters of two words
// and calls that a skill test. A stopword list (TOPIC_STOP) retires one wrong word at a time; it
// cannot retire the mechanism. The first test below shows a QA AUTOMATION engineer told "Automotive"
// is one of their proven strengths, because "autom" === "autom". No stoplist entry prevents this,
// because "automotive" is a real domain word that belongs on a real automotive engineer's chart.
//
// So the tests are written against the mechanism, not individual symptoms.
import { describe, it, expect } from "vitest";
import { topicsFor } from "../market-report.mjs";
import { pooledRequirements, clusterRequirements, coverageDomains, chartPlan, capabilityRow } from "./gap-chart.mjs";

// ── the keyword chart's defect, characterized ────────────────────────────────────────────────────
describe("the defect being replaced: four characters decide what you are good at", () => {
  // ⚠️ CHARACTERIZATION ONLY. It pins the keyword chart's behaviour, which the rest of the file
  // replaces, and it will start failing the day `covers()` is deleted — which is the point at which
  // someone should read this file rather than delete the assertion.
  it("calls a QA automation engineer's strength 'Automotive'", () => {
    const dossier = {
      headline: "QA automation engineer",
      proof_points: ["built test automation"],
      strengths: ["test automation"],
      preferences: { role: "QA Automation Engineer" },
    };
    const j = (company, title) => ({ company, title, location: "Remote", description: "x".repeat(400) });
    const rep = (n, c, t) => Array.from({ length: n }, () => j(c, t));
    // The last two groups are not decoration: TOPIC_MAX_SHARE drops any word in more than 60% of the
    // reachable set, so a market that is ONLY automotive filters the row out before covers() is
    // consulted. A real reachable set is mixed, and that is when the collision reaches the reader.
    const jobs = [
      ...rep(3, "Bosch", "QA Engineer, Automotive Systems"),
      ...rep(3, "Continental", "Test Engineer, Automotive Software"),
      ...rep(3, "Zf", "Validation Engineer, Automotive"),
      ...rep(3, "Acme", "QA Engineer, Payments"),
      ...rep(3, "Beta", "QA Engineer, Fintech"),
    ];
    const pool = [...jobs, ...rep(60, "Misc", "Account Executive"), ...rep(60, "Other", "Chef")];
    const auto = topicsFor(jobs, dossier, pool).find((r) => /automotive/i.test(r.label));
    expect(auto, "the automotive row should exist at all").toBeTruthy();
    expect(auto.evidenced, "'autom' === 'autom', so the chart claims he has automotive experience").toBe(true);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
const post = (company, title, coverage) => ({
  job: { company, title },
  cov: { thin: false, composite: 60, coverage },
});
const req = (r, status, evidence = null) => ({ req: r, status, evidence });

// A deterministic stand-in for Voyage. Requirements sharing a `tag` (the leading token in these
// fixtures) get identical vectors, so cosine is exactly 1; everything else is orthogonal. This keeps
// the clustering assertions about the ALGORITHM rather than about an embedding model's opinions.
const TAGS = ["payments", "multipm", "enterprise", "growth", "security"];
const fakeEmbed = async (texts) =>
  texts.map((t) => {
    const i = TAGS.findIndex((tag) => t.toLowerCase().includes(tag));
    const v = new Array(TAGS.length + 1).fill(0);
    v[i === -1 ? TAGS.length : i] = 1;
    return v;
  });

describe("coverageDomains — a strength is a cited `met`, never a string that looks alike", () => {
  it("the automotive collision is structurally impossible: nothing compares the person's words to the label", async () => {
    // The same person, the same word. Under the keyword chart "automation" covers "automotive". Here
    // the label is the POSTING's requirement and `evidenced` reads only the coverage verdict, so the
    // person's own vocabulary never touches the decision.
    const items = [
      post("Bosch", "QA Engineer", [req("Automotive systems validation", "unknown")]),
      post("Continental", "Test Engineer", [req("Automotive systems validation", "unknown")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    const auto = rows.find((r) => /automotive/i.test(r.label));
    expect(auto).toBeTruthy();
    expect(auto.evidenced, "no cited `met`, so it is a gap no matter what the person's résumé rhymes with").toBe(false);
  });

  it("credits a semantic match the prefix cannot see, because the coverage pass cited it", async () => {
    // "payments" and "fintech" share no prefix, so the keyword chart can only ever call fintech a gap
    // for a payments person. A grounded `met` with a quote makes it a strength here.
    const items = [
      post("Razorpay", "PM", [req("Fintech product experience", "met", "led payments at Razorpay for 4 years")]),
      post("Cred", "PM", [req("Fintech product experience", "met", "led payments at Razorpay for 4 years")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows[0].evidenced).toBe(true);
    expect(rows[0].evidence).toMatch(/Razorpay/);
  });

  it("drops a `met` that carries no evidence quote — cite or drop", async () => {
    // A claim about the person with no receipt. It must not appear as a strength.
    const items = [
      post("A Co", "PM", [req("Enterprise SaaS", "met", null)]),
      post("B Co", "PM", [req("Enterprise SaaS", "met", null)]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows.find((r) => /enterprise/i.test(r.label)).evidenced).toBe(false);
  });

  it("keeps an `unknown` gap even though it has no quote about the person", async () => {
    // The mirror of the rule above, and the reason cite-or-drop is applied to person-CLAIMS rather
    // than to rows: "you are quiet on this" asserts nothing about them. Dropping these would delete
    // every genuine gap and leave a chart that can only flatter.
    const items = [
      post("A Co", "PM", [req("Security clearance", "unknown")]),
      post("B Co", "PM", [req("Security clearance", "unknown")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenced).toBe(false);
    expect(rows[0].evidence).toBe(null);
  });

  it("never promotes `partial` to a strength, but keeps its quote for the gap row", async () => {
    const items = [
      post("A Co", "PM", [req("Multipm org leadership", "partial", "eighteen months coordinating two PMs at an agency")]),
      post("B Co", "PM", [req("Multipm org leadership", "partial", "eighteen months coordinating two PMs at an agency")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows[0].evidenced).toBe(false);
    expect(rows[0].evidence).toMatch(/eighteen months/);
  });

  it("errs toward covered: one cited `met` outweighs an `unknown` elsewhere", async () => {
    // market-report.mjs states the reason and it is inherited deliberately — a false "you are
    // quiet on this" tells a person their own core skill is missing, which is the worse failure.
    const items = [
      post("A Co", "PM", [req("Payments platforms", "met", "shipped UPI rails at Razorpay")]),
      post("B Co", "PM", [req("Payments platforms", "unknown")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows[0].evidenced).toBe(true);
  });

  it("ignores a requirement only ONE employer names — the Auth0 rule, restated", async () => {
    // "Auth0" is a product Okta sells, appearing only in Okta's own postings; it is not a gap the
    // reader should be told to write about. Two independent employers, not two postings.
    const items = [
      post("Okta", "PM A", [req("Auth0 administration", "unknown")]),
      post("Okta", "PM B", [req("Auth0 administration", "unknown")]),
      post("Okta", "PM C", [req("Auth0 administration", "unknown")]),
    ];
    expect(await coverageDomains(items, { embed: fakeEmbed })).toBe(null);
  });

  it("counts postings, not repeats, and reports the employers that asked", async () => {
    const items = [
      post("Stripe", "PM", [req("Payments platforms", "unknown")]),
      post("Adyen", "PM", [req("Payments platforms", "unknown")]),
      post("Razorpay", "PM", [req("Payments platforms", "unknown")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows[0].live).toBe(3);
    expect(rows[0].examples.map((e) => e.company).sort()).toEqual(["Adyen", "Razorpay", "Stripe"]);
  });

  it("labels the row in a posting's own words, never a rewrite", async () => {
    // No taxonomy: the shortest real phrasing wins because the chart cell is narrow, and it is still
    // a string some employer actually wrote.
    const items = [
      post("A Co", "PM", [req("Payments experience at scale in a regulated market", "unknown")]),
      post("B Co", "PM", [req("Payments platforms", "unknown")]),
    ];
    const rows = await coverageDomains(items, { embed: fakeEmbed });
    expect(rows[0].label).toBe("Payments platforms");
  });
});

describe("clustering fails open — a bad merge is a duplicate row, never an invented one", () => {
  const twoPhrasings = [
    post("A Co", "PM", [req("5+ years managing PMs", "unknown")]),
    post("B Co", "PM", [req("Experience leading product teams", "unknown")]),
  ];

  it("merges two phrasings of one requirement when the embedder agrees", async () => {
    const sameVector = async (texts) => texts.map(() => [1, 0, 0]);
    const rows = await coverageDomains(twoPhrasings, { embed: sameVector });
    expect(rows).toHaveLength(1);
    expect(rows[0].live).toBe(2);
  });

  it("still produces a chart when embeddings are unavailable", async () => {
    // No VOYAGE_API_KEY returns null. Lexical overlap takes over: these two phrasings share no content
    // words, so they do NOT merge, each is then a single-employer row, and the chart is empty rather
    // than wrong. Degraded, never fabricated.
    const rows = await coverageDomains(twoPhrasings, { embed: async () => null });
    expect(rows).toBe(null);
  });

  it("survives an embedder that throws", async () => {
    const rows = await coverageDomains(
      [
        post("A Co", "PM", [req("Payments platforms", "unknown")]),
        post("B Co", "PM", [req("Payments platforms", "unknown")]),
      ],
      { embed: async () => { throw new Error("voyage down"); } },
    );
    expect(rows).toHaveLength(1); // identical strings merge lexically without any vector at all
  });

  it("does not merge two requirements that are not alike", async () => {
    const rows = await coverageDomains(
      [
        post("A Co", "PM", [req("Payments platforms", "unknown"), req("Security clearance", "unknown")]),
        post("B Co", "PM", [req("Payments platforms", "unknown"), req("Security clearance", "unknown")]),
      ],
      { embed: fakeEmbed },
    );
    expect(rows).toHaveLength(2);
  });
});

describe("fail-open: nothing to say leaves today's chart alone", () => {
  it("returns null for no items, thin coverage, or an errored pass", async () => {
    expect(await coverageDomains([], { embed: fakeEmbed })).toBe(null);
    expect(await coverageDomains(null, { embed: fakeEmbed })).toBe(null);
    expect(await coverageDomains([{ job: { company: "A" }, cov: { thin: true, reason: "jd" } }], { embed: fakeEmbed })).toBe(null);
    expect(await coverageDomains([{ job: { company: "A" }, cov: null }], { embed: fakeEmbed })).toBe(null);
  });

  it("skips a posting with no employer rather than counting it toward the two-employer rule", () => {
    const rows = pooledRequirements([post("", "PM", [req("Payments platforms", "unknown")])]);
    expect(rows).toEqual([]);
  });

  it("clusters a single row without calling the embedder at all", async () => {
    let called = false;
    const spy = async (t) => { called = true; return t.map(() => [1]); };
    expect(await clusterRequirements([{ req: "one", status: "unknown", evidence: null, company: "A", title: "t" }], { embed: spy })).toHaveLength(1);
    expect(called).toBe(false);
  });
});

// ── chartPlan: the log and the email must answer the same question ───────────
// The log and the email must not apply different rules (chartSides' minAsk can hide gaps the email
// draws, and the email can draw nothing at all). Both tests below fail if they split again.
describe("chartPlan — one definition of what the email draws", () => {
  const rows = [
    { label: "payments", evidenced: true, live: 9 },
    { label: "platform", evidenced: false, live: 2 },
    { label: "agentic", evidenced: false, live: 1 },
  ];

  it("counts every live>0 gap, including ones a noise floor would have hidden", () => {
    const p = chartPlan(rows);
    expect(p.shown).toBe(true);
    expect(p.strengths.map((r) => r.label)).toEqual(["payments"]);
    // chartSides(rows, {minAsk:3}) reports ZERO gaps here. The email draws both.
    expect(p.gaps.map((r) => r.label)).toEqual(["platform", "agentic"]);
  });

  it("says NO CHART when the email would draw none, with the reason", () => {
    const p = chartPlan(rows.slice(0, 2));
    expect(p.shown).toBe(false);
    expect(p.strengths).toEqual([]);
    expect(p.gaps).toEqual([]);
    expect(p.reason).toMatch(/2 row\(s\) with live>0, needs 3/);
  });

  it("drops live=0 rows before counting — they are not drawn", () => {
    const p = chartPlan([...rows, { label: "ghost", evidenced: false, live: 0 }]);
    expect(p.rows.some((r) => r.label === "ghost")).toBe(false);
    expect(p.shown).toBe(true);
  });

  it("sorts each side by live, descending", () => {
    const p = chartPlan([
      { label: "a", evidenced: true, live: 1 },
      { label: "b", evidenced: true, live: 5 },
      { label: "c", evidenced: false, live: 3 },
      { label: "d", evidenced: false, live: 7 },
    ]);
    expect(p.strengths.map((r) => r.label)).toEqual(["b", "a"]);
    expect(p.gaps.map((r) => r.label)).toEqual(["d", "c"]);
  });

  it("never throws on junk, and junk means no chart", () => {
    for (const j of [null, undefined, [], "nope", [{}], [{ live: null }]]) {
      expect(() => chartPlan(j)).not.toThrow();
      expect(chartPlan(j).shown).toBe(false);
    }
  });
});

// ── capabilityRow: eligibility is not capability ─────────────────────────────
// The DROP and KEEP lists are the shapes the coverage chart actually produces.
//
// Without this filter:
//   a senior product designer  -> strengths: "Remote work", "4+ years experience", "Side projects"
//   a QA automation engineer   -> ZERO strengths, gaps: "8+ years experience", "Jira"
// The second would silence the briefing entirely (eligibility needs two proven domains).
describe("capabilityRow — drop what another gate already owns", () => {
  const drops = [
    ["4+ years experience", "years"],
    ["8+ years experience", "years"],
    ["10+ years PM", "years"],
    ["3-5 years of experience", "years"],
    ["minimum 2 years experience", "years"],
    ["Senior PM level", "level"],
    ["staff-level ownership", "level"],
    ["Remote work", "location"],
    ["Hybrid", "location"],
    ["fully remote", "location"],
    ["Willing to relocate", "location"],
    ["Work authorization in the US", "authorization"],
    ["Bachelor's degree in Computer Science", "education"],
  ];
  it.each(drops)("drops %s as %s", (req, why) => {
    const r = capabilityRow(req);
    expect(r.keep, req).toBe(false);
    expect(r.why).toBe(why);
  });

  // The whole risk of this filter is over-reach. A false "you are quiet on this" tells a person their
  // own core skill is missing — rule 4's asymmetry — so the patterns are anchored, and these prove it.
  const keeps = [
    "CI pipelines",
    "GTM ownership",
    "LLM/AI-native experience",          // says "experience", carries no year count
    "SMB/SME domain",
    "Adoption/retention/revenue impact",
    "experience managing remote engineering teams", // "remote" mid-sentence is a real capability
    "Enterprise SaaS",
    "5+ years managing PMs",             // a REAL capability that opens with a year count
    "Security clearance",                // eligibility, but no other gate judges it, so it is a fair gap
    "Design systems at scale",
    "Jira administration and workflow design",     // a tool used substantively is not boilerplate
    "Degrees of freedom in robotics control",      // starts with "Degree"-ish but is not a credential
  ];
  it.each(keeps)("keeps %s", (req) => {
    expect(capabilityRow(req).keep, req).toBe(true);
  });

  it("treats empty and junk as nothing to chart, without throwing", () => {
    for (const j of ["", "   ", null, undefined, 42, {}])
      expect(() => capabilityRow(j)).not.toThrow();
    expect(capabilityRow("").keep).toBe(false);
  });
});

describe("pooledRequirements applies the filter", () => {
  const item = (company, reqs) => ({
    job: { company, title: "Product Designer" },
    cov: { thin: false, coverage: reqs.map((req) => ({ req, status: "met", evidence: "cited" })) },
  });

  it("keeps the capabilities and removes the eligibility rows", () => {
    const rows = pooledRequirements([item("Acme", ["Remote work", "4+ years experience", "Design systems"])]);
    expect(rows.map((r) => r.req)).toEqual(["Design systems"]);
  });

  it("can legitimately empty the pool — silence beats 'your strength is Remote work'", () => {
    const rows = pooledRequirements([item("Acme", ["Remote work", "8+ years experience", "Senior PM level"])]);
    expect(rows).toEqual([]);
  });
});
