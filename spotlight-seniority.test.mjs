// spotlight-seniority.test.mjs — the market briefing's spotlight must never point at a role the person
// is materially UNDER, under the words "if I could point you at one thing today, this is it".
//
// Example: a person with ~2 professional years must not see an 8-years role spotlighted on day one.
//
// knockouts() K2b needs reqs.min_years, which extractMinYears cannot read out of most postings. And the
// seniority-gap hard stop lives in quality-gate.mjs, which market-report.mjs and market-briefing.mjs do
// not import. So rankStandoutByFit uses the seniority signal from its own coverage verdicts
// (cov.seniorityLevel) via seniorityChasm.
import { describe, it, expect, vi } from "vitest";
import { seniorityChasm } from "./quality-gate.mjs";
import { buildMarketReport } from "./market-report.mjs";
import { renderMarketReport } from "./render-market-report.mjs";

// The ranker's coverage passes are the only model call in this path; stub them so the test is
// deterministic and free. Keyed by job id so each fixture role gets its own verdict.
const COV = new Map();
vi.mock("./fit-coverage.mjs", () => ({
  computeCoverage: async ({ jobTitle }) => COV.get(jobTitle) ?? { thin: true, reason: "jd" },
}));
// STANDOUT_FIT is OPT-IN: the fit-ranked spotlight scores roles against a person outside the weekly
// run, so a new signup does not pay for it by default. These tests are about what the ranker DOES when
// it is switched on, so they switch it on. The default itself is pinned by the first case below, which is the part that protects
// the money.
process.env.STANDOUT_FIT = "on";
const { rankStandoutByFit } = await import("./market-briefing.mjs");

describe("STANDOUT_FIT is opt-in — a new signup costs nothing to welcome", () => {
  const shortlist = [{ id: "a", title: "A" }, { id: "b", title: "B" }];

  for (const [label, val] of [["unset", undefined], ["empty", ""], ["off", "off"], ["a typo", "yes please"]]) {
    it(`returns null without calling the model when the flag is ${label}`, async () => {
      const prev = process.env.STANDOUT_FIT;
      if (val === undefined) delete process.env.STANDOUT_FIT; else process.env.STANDOUT_FIT = val;
      let calls = 0;
      COV.set("A", (calls++, cov(90, "at", 0.9))); // if the ranker runs, it reads COV; it must not
      try {
        // No dossier work, no coverage pass: the ranker refuses before it can spend anything.
        expect(await rankStandoutByFit({ headline: "x" }, shortlist, () => {})).toBeNull();
      } finally { process.env.STANDOUT_FIT = prev; }
    });
  }

  it("and turns on for the exact word, so the switch still works", async () => {
    const prev = process.env.STANDOUT_FIT;
    process.env.STANDOUT_FIT = "on";
    try {
      expect(await rankStandoutByFit({ headline: "x" }, shortlist, () => {})).not.toBeNull();
    } finally { process.env.STANDOUT_FIT = prev; }
  });
});

// A coverage verdict shaped exactly like fit-coverage.mjs returns one.
const cov = (composite, seniorityLevel, seniority) => ({
  thin: false, composite, seniorityLevel, lane: "tune",
  subscores: { mustHave: 0.5, skills: 0.5, seniority, domain: 0.5, parseable: 1 },
  coverage: [{ req: "Distributed systems at scale", status: "unknown", evidence: null }],
});

describe("seniorityChasm — one definition of 'aimed well above this person', shared by both gates", () => {
  it("true when the fit pass says UNDER and the seniority subscore is deep", () => {
    expect(seniorityChasm(cov(88, "under", 0.2))).toBe(true);
    expect(seniorityChasm(cov(88, "under", 0.34))).toBe(true); // the floor itself is inside the band
  });

  it("false on a one-level stretch — a normal reach still gets spotlighted", () => {
    expect(seniorityChasm(cov(88, "under", 0.5))).toBe(false);
    expect(seniorityChasm(cov(88, "under", 0.35))).toBe(false);
  });

  it("false when the person is AT or OVER the level, however low the subscore reads", () => {
    expect(seniorityChasm(cov(82, "at", 0.1))).toBe(false);
    expect(seniorityChasm(cov(82, "over", 0.1))).toBe(false);
  });

  it("has NO opinion on a thin, missing or unscoreable verdict (fail open, never a guessed chasm)", () => {
    expect(seniorityChasm(null)).toBe(false);
    expect(seniorityChasm(undefined)).toBe(false);
    expect(seniorityChasm({ thin: true, reason: "dossier" })).toBe(false);
    expect(seniorityChasm({ thin: false, seniorityLevel: "under", subscores: { seniority: 0.1 } })).toBe(false); // no composite
    expect(seniorityChasm(cov(88, "under", undefined))).toBe(false); // no subscore to read
  });
});

describe("rankStandoutByFit — the best-fitting role does not win if the person cannot clear its level", () => {
  const job = (id, company, title) => ({
    id, company, title, location: "Remote, India", remote: true,
    description: "We are hiring. ".repeat(40), apply_url: `https://example.test/${id}`,
    posted_at: "2026-07-28T00:00:00Z", // identical dates, so freshness cannot decide this
  });
  const chasm = job("chasm", "Way Above Co", "Staff Engineer, 8+ years");
  const reachable = job("ok", "Reachable Co", "Full stack developer");
  const dossier = { name: "Test Person", professional_years: 2.25, headline: "Full stack developer (MERN)" };

  it("skips the chasm role even though it holds the HIGHEST composite, and keeps the lower-fit one", async () => {
    COV.clear();
    COV.set(chasm.title, cov(90, "under", 0.2));      // best fit on paper, unreachable on level
    COV.set(reachable.title, cov(60, "at", 0.8));
    const out = await rankStandoutByFit(dossier, [chasm, reachable], () => {});
    expect(out.job).toBe(reachable);
    expect(out.job).not.toBe(chasm);
  });

  it("still returns EVERY coverage result — `items` is the gap chart's substrate, never filtered", async () => {
    COV.clear();
    COV.set(chasm.title, cov(90, "under", 0.2));
    COV.set(reachable.title, cov(60, "at", 0.8));
    const out = await rankStandoutByFit(dossier, [chasm, reachable], () => {});
    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.job)).toEqual([chasm, reachable]);
    expect(out.items.every((i) => i.cov && !i.cov.thin)).toBe(true);
  });

  it("returns no pick at all when EVERY shortlisted role is a chasm (rather than the least-bad one)", async () => {
    COV.clear();
    COV.set(chasm.title, cov(90, "under", 0.2));
    COV.set(reachable.title, cov(70, "under", 0.1));
    const out = await rankStandoutByFit(dossier, [chasm, reachable], () => {});
    expect(out.job).toBeNull();
    expect(out.items).toHaveLength(2); // the chart still has its rows
  });
});

// THE BASE-PICK HOLE, and the part a naive fix misses. standoutJob is chosen by relevance/comp/location
// BEFORE any coverage exists. When the ranker returns no pick (nothing scoreable, every role a chasm, or
// STANDOUT_FIT=off), that unchecked relevance pick is what ships — so the ranker's own skip cannot
// protect a pick the ranker never made.
describe("buildMarketReport — the FINAL spotlight is checked, not just the ranker's pick", () => {
  const dossier = {
    name: "Test Person", professional_years: 2.25,
    headline: "Full stack developer (MERN) with 2.5+ years",
    proof_points: ["shipped a React app"], strengths: ["javascript"],
    preferences: { home_place: "Bengaluru, India", remote: "remote", role: "Full stack developer" },
  };
  const job = (id, company, title) => ({
    id, company, title, location: "Remote, India", remote: true,
    description: "We want a full stack developer. ".repeat(40),
    apply_url: `https://example.test/${id}`, posted_at: "2026-07-28T00:00:00Z",
  });
  const pool = [
    job("a", "Alpha Co", "Full stack developer"),
    job("b", "Beta Co", "Senior full stack developer"),
    job("c", "Gamma Co", "Full stack developer, platform"),
  ];
  const build = (opts) => buildMarketReport("t@e.st", { candidateOverride: { email: "t@e.st", dossier }, poolOverride: pool, ...opts });
  const idOf = (s, list) => (list.find((j) => j.company === s.company && j.title === s.title) || {}).id;

  it("drops the spotlight when the ranker picked nothing and the base pick itself is a chasm", async () => {
    const base = await build({});
    expect(base.standout).toBeTruthy(); // the unchecked relevance pick exists
    const r = await build({
      // job:null is exactly what the ranker returns when no role survived the level check.
      rankStandout: (sl) => ({ job: null, items: sl.map((j) => ({ job: j, cov: cov(55, "under", 0.15) })) }),
    });
    expect(r.standout).toBeNull();
  });

  it("keeps the spotlight when the base pick's own verdict is reachable", async () => {
    const base = await build({});
    const r = await build({
      rankStandout: (sl) => ({ job: null, items: sl.map((j) => ({ job: j, cov: cov(55, "at", 0.7) })) }),
    });
    expect(r.standout?.company).toBe(base.standout.company);
  });

  it("leaves the pick alone when NO verdict covers it — no signal is not a verdict", async () => {
    const base = await build({});
    const r = await build({
      // Coverage for a role that is not the one relevance picked: nothing to read about the spotlight.
      rankStandout: (sl) => ({
        job: null,
        items: sl.filter((j) => j.id !== idOf(base.standout, pool)).map((j) => ({ job: j, cov: cov(55, "under", 0.15) })),
      }),
    });
    expect(r.standout?.company).toBe(base.standout.company);
  });

  it("drops it when the RANKER's own pick is a chasm too (both doors, one predicate)", async () => {
    const r = await build({
      rankStandout: (sl) => ({ job: sl[1], items: sl.map((j) => ({ job: j, cov: cov(75, "under", 0.2) })) }),
    });
    expect(r.standout).toBeNull();
  });
});

describe("renderMarketReport — a briefing with no spotlight still renders, minus that block", () => {
  // Shaped like the live report object (mirrors the fixture in market-briefing.test.mjs).
  const report = (standout) => ({
    meta: { email: "u@x.com", name: null, headline: null, region: "india", poolTotal: 100 },
    funnel: { scanned: 13860, inField: 120, addressable: 57, unreachable: 30, companies: 40 },
    seniority: { exec: 2, director: 3, principalStaff: 5, senior: 20, ic: 20, apm: 7 },
    barTier: "ic", barLabel: "Mid-level", atOrAboveBar: 5,
    geo: { remote: 12, cities: [{ city: "Bengaluru", n: 10 }], other: 6, total: 32 },
    gravity: [{ key: "platform", label: "Platform & APIs", flow: "platform and API", live: 12 }],
    marketAsk: [],
    comp: { total: 57, disclosed: 20, floor: 1200000, floorCcy: "INR", clearFloor: 1 },
    standout,
    evidence: { proof: [], caseDomains: [] },
    domains: [
      { key: "platform", label: "Platform & APIs", flow: "platform and API", evidenced: true, live: 12, examples: [{ company: "Acme", title: "Dev" }] },
      { key: "ai", label: "AI & GenAI", flow: "AI and GenAI", evidenced: true, live: 8, examples: [{ company: "Beta", title: "Dev" }] },
    ],
    topCompanies: [{ company: "Acme", n: 9 }, { company: "Beta", n: 6 }, { company: "Gamma", n: 4 }],
    tierLabels: { exec: "VP / Head of", director: "Director", principalStaff: "Principal / Staff", senior: "Senior / Lead", ic: "Mid-level", apm: "Entry / Associate" },
  });
  const withStandout = { company: "Acme", title: "Full stack developer", location: "Remote", comp: { currency: "INR", min: 1200000, max: 1800000 }, tier: "ic", apply_url: "https://x.com/a" };

  it("renders without throwing and omits the spotlight block", () => {
    const { html, subject } = renderMarketReport(report(null), { email: "u@x.com" });
    expect(html).toBeTruthy();
    expect(subject).toBeTruthy();
    expect(html).not.toContain("Take a look");            // the spotlight's button is the block's tell
    expect(html).not.toContain("I will tell you why in a second"); // the line that promises it
  });

  it("and still renders the block when there IS a spotlight (no collateral loss)", () => {
    const { html } = renderMarketReport(report(withStandout), { email: "u@x.com" });
    expect(html).toContain("Take a look");
  });
});
