// market-report.test.mjs — the market read: comp currency, the person's own level, derived topics,
// geo merging, the spotlight pick and the gap chart.
//
// Comp currency: a US market read must speak USD, not rupees. An `rs` token without a leading word
// boundary matches the tail of ordinary English (offers, years, peers, hours), so a dollar posting
// whose blurb says "offers" could be mislabelled INR and render $200K as ₹2L. These cases pin that.
import { describe, it, expect } from "vitest";
import { parseComp, observedRange, levelOf, topicsFor, buildMarketReport } from "./market-report.mjs";

describe("parseComp — currency is grounded in the posting, never leaked from an English word", () => {
  it("a US string containing 'offers' is USD, not INR", () => {
    const c = parseComp("This role offers a base salary of $200,000 - $300,000 USD");
    expect(c.currency).toBe("USD");
    expect(c.min).toBe(200000);
    expect(c.max).toBe(300000);
  });

  it("US strings with other -rs words (years, peers, hours) stay USD", () => {
    expect(parseComp("$200K-$300K. The strongest offers reach $500K").currency).toBe("USD");
    expect(parseComp("Estimated pay $164,000-$246,000 based on years of experience").currency).toBe("USD");
    expect(parseComp("Our peers earn $220,000+").currency).toBe("USD");
    expect(parseComp("$40/hr for the first few hours of onboarding, then $60/hr").currency).toBe("USD");
  });

  it("genuine rupee forms still resolve to INR", () => {
    expect(parseComp("Rs. 70,00,000 - 1,00,00,000").currency).toBe("INR");
    expect(parseComp("INR 20,00,000 - 30,00,000").currency).toBe("INR");
    expect(parseComp("₹18,00,000 - ₹24,00,000").currency).toBe("INR");
  });

  it("a plain $ range with no words is USD", () => {
    expect(parseComp("$180,000 base").currency).toBe("USD");
  });
});

describe("observedRange — the band's currency follows the disclosed roles, so a US pool reads in USD", () => {
  const usRole = (min, max, blurb) => ({ comp: parseComp(`${blurb} $${min} - $${max}`) });

  it("a US-market disclosed set yields a USD band (not a rupee one)", () => {
    const rows = [
      usRole(200000, 300000, "This role offers"),           // 'offers' — the trap word
      usRole(220000, 320000, "Compensation for our peers:"), // 'peers'
      usRole(240000, 500000, "The strongest offers reach"),  // 'offers' again, top of band
    ];
    const band = observedRange(rows);
    expect(band).not.toBeNull();
    expect(band.currency).toBe("USD");
    expect(band.top).toBe(500000); // the true ceiling, rendered as $500K — never ₹5L
  });
});

// ── levelOf — the person's own rung ─────────────────────────────────────────────────────────────
// A classifier with only UP branches that defaults to "senior" makes `ic` and `apm` unreachable, and
// tells an intern "At Senior / Lead, the room above you is thin." Every rung must be reachable from
// the person's own words. The dossiers are fictional but realistically shaped.
describe("levelOf — a person is never told a level their own words contradict", () => {
  const who = (preferences, extra = {}) => ({ preferences, headline: "", ...extra });

  it("an intern is entry-level, not Senior / Lead", () => {
    expect(levelOf(who({ seniority: "intern", role: "AI Developer Intern (Gen AI)" }))).toBe("apm");
    expect(levelOf(who({ seniority: "internship", role: "Software Engineering Internship" }))).toBe("apm");
  });

  it("a fresher / entry-level / junior / early-career person is entry-level", () => {
    expect(levelOf(who({ seniority: "Fresher", role: "Software developer" }))).toBe("apm");
    expect(levelOf(who({ seniority: "entry-level", role: "digital Marketing" }))).toBe("apm");
    expect(levelOf(who({ seniority: "entry-level or fresher", role: "AI Engineer, SDE" }))).toBe("apm");
    expect(levelOf(who({ seniority: "junior", role: null }))).toBe("apm");
    expect(levelOf(who({ seniority: "early career", role: "UI/UX Designer, Product Designer" }))).toBe("apm");
  });

  it("a student headline reads as entry-level even with no stated seniority", () => {
    const student = who({ seniority: null, role: null }, {
      headline: "Third-year CS student and full-stack developer shipping LLM side projects",
      professional_years: 0,
    });
    expect(levelOf(student)).toBe("apm");
  });

  it("the UP branches are unchanged — a real VP, director and staff engineer keep their rung", () => {
    expect(levelOf(who({ seniority: null, role: "Chief Product Officer, VP of Product" }))).toBe("exec");
    expect(levelOf(who({ seniority: "Director", role: "Director of Engineering" }))).toBe("director");
    expect(levelOf(who({ seniority: null, role: "Staff Engineer" }))).toBe("principalStaff");
  });

  it("a senior individual contributor outside product still reads senior (no over-correction)", () => {
    const qa = who({ seniority: "Senior", role: "Senior Quality Assurance engineer" }, {
      headline: "Senior test analyst for parcel tracking and warehouse scanning apps",
    });
    expect(levelOf(qa)).toBe("senior");
    const testLead = who({ seniority: null, role: "Field hydrologist / Survey lead" }, {
      headline: "Hydrologist with roughly 11 years in river and floodplain surveys",
    });
    expect(levelOf(testLead)).toBe("senior");
  });

  it("a C-suite WORD in an ordinary title does not make someone an exec", () => {
    // "Chief of Staff" is not the C-suite, and an Account Executive is a sales IC; matching `chief` or
    // `executive` bare promotes both. "Chief of Staff" must not fall into Principal/Staff either —
    // assert the LANDING rung, not just "not exec", or a second misfire hides behind the first.
    const chiefOfStaff = who({ seniority: null, role: "Founder's Office / Chief of Staff" }, {
      headline: "Electrical engineering graduate with strategy and operations internships",
    });
    expect(levelOf(chiefOfStaff)).toBe("apm"); // a recent graduate, per their own headline
    const ae = who({ seniority: null, role: "Account Executive" }, { headline: "SaaS sales, 4 years closing mid-market" });
    expect(levelOf(ae)).toBe("ic");
    // the genuine Staff-engineer rung is untouched by the "of staff" guard
    expect(levelOf(who({ seniority: null, role: "Staff Software Engineer" }))).toBe("principalStaff");
  });

  it("with no level stated anywhere, the GROUNDED professional_years decides", () => {
    const noWords = (professional_years) => who({ seniority: null, role: null }, { headline: "Builds web apps", professional_years });
    expect(levelOf(noWords(0))).toBe("apm");
    expect(levelOf(noWords(1))).toBe("apm");
    expect(levelOf(noWords(3))).toBe("ic");
    expect(levelOf(noWords(7))).toBe("senior");
  });

  it("years alone never buy a rung above senior, and unknown years never default UP", () => {
    const veteran = who({ seniority: null, role: null }, { headline: "Builds web apps", professional_years: 20 });
    expect(levelOf(veteran)).toBe("senior"); // NOT principalStaff/director/exec — that would upgrade them
    const unknown = who({ seniority: null, role: null }, { headline: "Builds web apps" });
    expect(levelOf(unknown)).toBe("ic"); // the honest middle, never a default "senior"
  });

  it("falls back to the years the person states in their OWN words", () => {
    // Most dossiers lack the structured professional_years, so without reading stated years a 16-year
    // fleet operations manager and a 14-year water-treatment compliance officer would both sit at "Mid-level".
    const said = (headline) => who({ seniority: null, role: null }, { headline });
    expect(levelOf(said("Fleet and cold-chain operations professional with 16+ years across ports and depots"))).toBe("senior");
    expect(levelOf(said("Municipal water treatment and compliance professional with over 14 years"))).toBe("senior");
    expect(levelOf(said("Soil testing lab technician with about 1.5 years in field sampling"))).toBe("apm");
    expect(levelOf(said("Product designer shipping consumer fintech"))).toBe("ic"); // no number stated
  });

  it("the structured professional_years outranks a number in the prose", () => {
    const d = who({ seniority: null, role: null }, { headline: "Engineer with 12 years of hobby projects", professional_years: 1 });
    expect(levelOf(d)).toBe("apm"); // the grounded dated-employment field wins
  });

  it("fails soft on a null / empty dossier instead of throwing", () => {
    expect(levelOf(null)).toBe("ic");
    expect(levelOf({})).toBe("ic");
  });
});

// ── topicsFor — the read is DERIVED per person, not scored against a fixed taxonomy ──────────────
// Fixed buckets written for one track (e.g. product management) make a QA engineer's "spikes" come out
// as Platform/APIs and Gen-AI. These assert the derived property: same code, different track,
// genuinely different words, all drawn from real text.
describe("topicsFor — the vocabulary comes from the person and their market, not a list", () => {
  const j = (title, company = "Co") => ({ title, company, location: "Remote", description: "" });
  // A background pool so common structure words ("engineer", "software") have a high global share and
  // are filtered by lift, exactly as they are against the live pool.
  const BACKDROP = Array.from({ length: 100 }, (_, i) => j(`Software Engineer ${i}`, `Bg${i}`));
  const dossier = (role, headline, strengths = []) => ({ headline, strengths, preferences: { role } });

  // Realistic markets: the term under test is frequent but NOT near-universal. A pool where almost
  // every title says "Designer" correctly yields nothing — in that market the word separates nobody —
  // so a fixture like that would test the filter, not the read.
  const QA_JOBS = [
    j("QA Automation Engineer"), j("Senior QA Automation Engineer"), j("Test Automation Engineer"),
    j("Manual Testing Engineer"), j("QA Engineer, Accessibility"), j("Automation Consultant"),
    j("Software Engineer"), j("Software Engineer II"), j("Backend Developer"), j("Product Manager"),
  ];
  const DESIGN_JOBS = [
    j("Product Designer"), j("Senior Product Designer"), j("UX Designer"), j("UI/UX Designer"),
    j("UX Researcher"), j("Visual Designer"), j("Motion Designer"), j("Graphic Designer"),
    j("Design Systems Lead"), j("Software Engineer"), j("Software Engineer II"),
    j("Backend Software Engineer"), j("Data Analyst"), j("Product Manager"),
    j("Marketing Manager"), j("Sales Executive"),
  ];

  it("a QA engineer's own words surface QA words, never a product taxonomy", () => {
    const rows = topicsFor(QA_JOBS, dossier("Senior QA Automation Engineer", "QA analyst with test automation experience"), [...BACKDROP, ...QA_JOBS]);
    const yours = rows.filter((r) => r.evidenced).map((r) => r.key);
    expect(yours).toContain("automation");
    expect(yours.some((k) => k === "qa" || k === "test")).toBe(true);
    // fixed-taxonomy bucket names: none of them can appear unless the person's real titles say so
    const all = rows.map((r) => r.key);
    expect(all).not.toContain("fintech");
    expect(all).not.toContain("commerce");
    expect(all).not.toContain("growth");
  });

  it("the SAME code on a designer yields design words — no shared rows with the QA read", () => {
    const qa = topicsFor(QA_JOBS, dossier("Senior QA Automation Engineer", "QA analyst with test automation"), [...BACKDROP, ...QA_JOBS]);
    const design = topicsFor(DESIGN_JOBS, dossier("Product Designer", "Product designer, B2B SaaS"), [...BACKDROP, ...DESIGN_JOBS]);
    const dYours = design.filter((r) => r.evidenced).map((r) => r.key);
    expect(dYours).toContain("designer");
    const overlap = qa.map((r) => r.key).filter((k) => design.map((x) => x.key).includes(k));
    expect(overlap).toEqual([]); // two tracks, no shared vocabulary — the point of deriving it
  });

  it("a word common across the whole market is not offered as anyone's topic (lift)", () => {
    // "software" is in the person's titles AND in most of the pool -> low lift -> never a row.
    const rows = topicsFor(QA_JOBS, dossier("QA Engineer", "QA"), [...BACKDROP, ...QA_JOBS]);
    expect(rows.map((r) => r.key)).not.toContain("software");
  });

  it("a person is never told their own core word is a gap (engineer covers engineering)", () => {
    const jobs = [
      j("Data Engineering Lead"), j("Analytics Engineering Manager"), j("Data Engineering Specialist"),
      j("Platform Engineering Lead"), j("Engineering Manager"),
      j("Data Analyst"), j("Data Scientist"), j("Backend Developer"), j("Product Manager"), j("QA Engineer"),
    ];
    const rows = topicsFor(jobs, dossier("Data Engineer", "Data engineer, pipelines"), [...BACKDROP, ...jobs]);
    const engineering = rows.find((r) => r.key === "engineering");
    expect(engineering).toBeDefined();          // it must actually be on the chart...
    expect(engineering.evidenced).toBe(true);   // ...on THEIR side, covered by "engineer"
  });

  it("a level word is never a topic — the ladder chart already covers those", () => {
    const jobs = [
      j("Senior Automation Engineer"), j("Principal Automation Engineer"), j("Senior Automation Tester"),
      j("Lead Automation Engineer"), j("Automation Consultant"),
      j("Senior Data Analyst"), j("Principal Data Scientist"), j("Lead Product Manager"),
      j("Senior Backend Developer"), j("Staff Frontend Developer"),
    ];
    const rows = topicsFor(jobs, dossier("Automation Engineer", "automation"), [...BACKDROP, ...jobs]);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("automation"); // the topic survives...
    for (const level of ["senior", "principal", "lead", "staff"]) expect(keys).not.toContain(level); // ...the rungs do not
  });

  it("the label uses the market's own most-common spelling, not a stray ALL-CAPS title", () => {
    const jobs = [
      j("Backend Developer"), j("Backend Developer II"), j("Backend Engineer"),
      j("BACKEND DEVELOPER"), j("Backend Platform Developer"),
      j("Frontend Developer"), j("Mobile Developer"), j("Data Analyst"), j("Product Manager"), j("QA Engineer"),
    ];
    const rows = topicsFor(jobs, dossier("Backend Developer", "backend"), [...BACKDROP, ...jobs]);
    const backend = rows.find((r) => r.key === "backend");
    expect(backend).toBeDefined();
    expect(backend.label).toBe("Backend"); // never "BACKEND" (sentence case, never shouting)
  });

  it("returns nothing rather than guessing when there is no market to read", () => {
    expect(topicsFor([], dossier("QA Engineer", "QA"), BACKDROP)).toEqual([]);
    expect(topicsFor(null, dossier("QA Engineer", "QA"), BACKDROP)).toEqual([]);
  });
});

// ── the ladder rungs name a LEVEL, never a job family ─────────────────────────────────────────────
describe("tier labels — track-agnostic, so a non-PM is not shown a 'Product Manager' rung", () => {
  // A tiny pool + a candidate override: buildMarketReport's test seams mean no network, no store.
  const job = (title, i) => ({
    id: `j${i}`, company: `Co${i}`, title, location: "Bengaluru, Karnataka, India",
    remote: false, description: "Testing, automation and release quality for a payments platform.",
    apply_url: `https://x.test/${i}`,
  });
  const POOL = [
    job("Quality Engineer", 1), job("Senior QA Engineer", 2), job("Staff QA Engineer", 3),
    job("QA Intern", 4), job("Director of Quality", 5), job("Test Analyst", 6),
  ];
  const QA = {
    email: "qa@example.test",
    dossier: {
      name: null,
      headline: "Senior QA engineer covering regression automation and accessibility audits for insurance apps",
      narrative: "Regression automation, accessibility audits and release sign-off across insurance claims apps.",
      proof_points: [], case_studies: [], strengths: [], gaps: [],
      preferences: { seniority: "Senior", role: "Senior Quality Assurance engineer", home_place: "Bengaluru, India" },
    },
  };

  it("no rung is labelled with a job family — 'Product Manager' and 'CPO' are gone", async () => {
    const r = await buildMarketReport(QA.email, { candidateOverride: QA, poolOverride: POOL });
    const labels = Object.values(r.tierLabels);
    expect(labels).not.toContain("Product Manager");
    expect(labels.join(" ")).not.toMatch(/CPO|Head of Product/);
    expect(labels).toContain("Mid-level");
    expect(labels).toContain("Entry / Associate");
  });

  // "Bangalore 17" and "Bengaluru 11" as two bars is one city split in half, which under-counts the
  // person's real top location and flatters remote by comparison.
  it("one city spelled two ways is one bar, labelled the way the market mostly writes it", async () => {
    const at = (loc, i) => ({ ...job("QA Automation Engineer", i), location: loc });
    const POOL_CITIES = [
      at("Bangalore, Karnataka, India", 1), at("Bangalore, India", 2), at("Bangalore", 3),
      at("Bengaluru, Karnataka, India", 4), at("Bengaluru, India", 5),
      at("Pune, Maharashtra, India", 6),
    ];
    const r = await buildMarketReport(QA.email, { candidateOverride: QA, poolOverride: POOL_CITIES });
    const names = r.geo.cities.map((c) => c.city);
    expect(names).not.toContain("Bengaluru");        // merged away, not shown twice
    expect(r.geo.cities[0]).toEqual({ city: "Bangalore", n: 5 }); // 3 + 2, labelled by the majority spelling
    expect(r.geo.cities.find((c) => c.city === "Pune")?.n).toBe(1);
  });

  it("a country-prefixed location is the same city as its plain twin, and a country is not a city", async () => {
    const at = (loc, i) => ({ ...job("QA Automation Engineer", i), location: loc });
    const POOL_US = [
      at("San Francisco, CA", 1), at("San Francisco", 2),
      at("US - San Francisco", 3), at("US - San Francisco", 4),
      at("United States", 5), at("New York, NY", 6),
    ];
    const US = { ...QA, dossier: { ...QA.dossier, preferences: { ...QA.dossier.preferences, home_place: "San Francisco, CA" } } };
    const r = await buildMarketReport(US.email, { candidateOverride: US, poolOverride: POOL_US });
    expect(r.geo.cities.find((c) => c.city === "San Francisco")?.n).toBe(4); // 2 plain + 2 country-prefixed
    expect(r.geo.cities.map((c) => c.city)).not.toContain("US - San Francisco");
    expect(r.geo.cities.map((c) => c.city)).not.toContain("United States"); // a country is not a city
  });

  // Two claims that must hold for entry-level readers, not just senior ones.
  it("the pay band is scoped to the reader's own rung, never the whole market", async () => {
    const paid = (title, i, pay) => ({ ...job(title, i), compensation: pay });
    // Senior roles OUTNUMBER entry ones, so an "at or above your line" band lands on senior pay for a
    // person standing at the bottom.
    const POOL_PAY = [
      paid("Senior QA Engineer", 1, "INR 50,00,000 - 60,00,000"),
      paid("Senior QA Automation Engineer", 2, "INR 55,00,000 - 65,00,000"),
      paid("Senior Test Engineer", 3, "INR 58,00,000 - 70,00,000"),
      paid("Principal QA Engineer", 4, "INR 60,00,000 - 75,00,000"),
      paid("Principal Test Architect", 5, "INR 62,00,000 - 80,00,000"),
      paid("Senior QA Lead", 6, "INR 65,00,000 - 85,00,000"),
      paid("QA Intern", 7, "INR 3,00,000 - 5,00,000"),
      paid("Junior QA Engineer", 8, "INR 4,00,000 - 6,00,000"),
      paid("Graduate QA Trainee", 9, "INR 3,50,000 - 5,50,000"),
      paid("QA Analyst", 10, "INR 6,00,000 - 9,00,000"),
    ];
    const intern = { email: "i@example.test", dossier: { ...QA.dossier, headline: "Final-year student with QA internship experience", preferences: { seniority: "intern", role: "QA Intern", home_place: "Bengaluru, India" } } };
    const r = await buildMarketReport(intern.email, { candidateOverride: intern, poolOverride: POOL_PAY });
    expect(r.barTier).toBe("apm");
    expect(r.comp.observed).not.toBeNull();
    expect(r.comp.observed.hi).toBeLessThan(2000000); // entry pay, never the ₹60L+ senior band
  });

  it("the spotlight is the most RELEVANT role that clears the floor, not the most senior", async () => {
    const paid = (title, i, pay) => ({ ...job(title, i), compensation: pay });
    // A recruiting job that reads as design ("Product & Design") must not outrank every actual design
    // role just because "Director" sits higher on the ladder. All of these clear the floor.
    const POOL_REL = [
      paid("Product Designer", 1, "INR 30,00,000 - 40,00,000"),
      paid("Senior Product Designer", 2, "INR 32,00,000 - 42,00,000"),
      paid("Associate Director, Talent Acquisition (Product & Design)", 3, "INR 35,00,000 - 45,00,000"),
      paid("UX Designer", 4, "INR 28,00,000 - 38,00,000"),
    ];
    const designer = {
      email: "d@example.test",
      dossier: {
        name: null, headline: "Product designer with 5 years in B2B SaaS",
        narrative: "Product design", proof_points: [], case_studies: [], strengths: [], gaps: [],
        preferences: { seniority: "Senior", role: "Product Designer", home_place: "Bengaluru, India", comp_floor: 2000000, comp_currency: "INR" },
      },
    };
    const r = await buildMarketReport(designer.email, { candidateOverride: designer, poolOverride: POOL_REL });
    expect(r.standout).not.toBeNull();
    expect(r.standout.title).not.toMatch(/Talent Acquisition/); // never a recruiting job for a designer
    expect(r.standout.title).toMatch(/Designer/);
  });

  it("the wedge's employer note comes from the field that actually exists", async () => {
    // The wedge's employer clause reads employers[].domain (the field company-context writes), not a
    // field nothing populates.
    const j2 = (title, i) => ({ ...job(title, i), title });
    // The backdrop is a DIFFERENT family, so selectForUser drops it from this person's reachable set while
    // it still counts toward the pool-wide share. Without it, jobs === pool, every lift is 1.0 and no term
    // clears the bar — the fixture would test nothing.
    const POOL_W = [
      j2("QA Automation Engineer", 1), j2("QA Automation Engineer", 2), j2("Senior QA Engineer", 3),
      j2("Accessibility Test Engineer", 4), j2("Accessibility QA Analyst", 5), j2("Accessibility Specialist", 6),
      j2("Accessibility Engineer", 7), j2("QA Engineer", 8), j2("Test Engineer", 9), j2("QA Analyst", 10),
      ...Array.from({ length: 40 }, (_, i) => j2(`Marketing Manager ${i}`, 100 + i)),
    ];
    const withEmployer = {
      ...QA,
      dossier: {
        ...QA.dossier,
        headline: "QA engineer with automation experience in insurance claims",
        employers: [{ name: "Lumora", domain: "claims-processing software" }],
      },
    };
    const r = await buildMarketReport(withEmployer.email, { candidateOverride: withEmployer, poolOverride: POOL_W });
    expect(r.wedge).not.toBeNull();
    expect(r.wedge.employer).toBe("Lumora");
    expect(r.wedge.employerNote).toBe("claims-processing software");
  });

  it("a senior QA engineer is anchored at Senior / Lead, not handed a product ladder", async () => {
    const r = await buildMarketReport(QA.email, { candidateOverride: QA, poolOverride: POOL });
    expect(r.barTier).toBe("senior");
    expect(r.barLabel).toBe("Senior / Lead");
  });
});

// ── the spotlight must be the role they can CLEAR, not merely the most relevant ──────────────────
// Relevance alone can spotlight a role the person covers 29/100 of while a 61/100 role goes unmentioned,
// under the words "if I could point you at one thing today, this is it".
//
// The ranker is injected, so these tests need no model and no network. What they pin down is the
// CONTRACT: it may reorder the guarded shortlist and nothing else.
describe("buildMarketReport — injected standout ranker", () => {
  const dossier = {
    name: "Test Person", professional_years: 11,
    headline: "Product leader with 11 years in SaaS",
    proof_points: ["shipped a platform"], strengths: ["product strategy"],
    preferences: { home_place: "New York, United States", remote: "remote", role: "Product Manager" },
  };
  const job = (id, company, title, location, remote = true) => ({
    id, company, title, location, remote, description: "We want a product manager. ".repeat(40),
    apply_url: `https://example.test/${id}`, posted_at: "2026-07-20T00:00:00Z",
  });
  const pool = [
    job("a", "Relevant Co", "Product Manager", "Remote, United States"),
    job("b", "BetterFit Co", "Senior Product Manager", "Remote, United States"),
    job("c", "Third Co", "Product Manager, Growth", "New York, United States"),
  ];
  const build = (opts) => buildMarketReport("t@e.st", { candidateOverride: { email: "t@e.st", dossier }, poolOverride: pool, ...opts });

  it("without a ranker the pick is unchanged — the default path stays deterministic and free", async () => {
    const a = await build({});
    const b = await build({});
    expect(a.standout?.company).toBe(b.standout?.company);
  });

  it("a ranker CAN move the spotlight off the relevance pick", async () => {
    const base = await build({});
    // Pick any shortlisted role that is NOT what relevance chose, so the assertion proves a MOVE
    // rather than depending on which fixture happens to rank first.
    let offered = null;
    const moved = await build({
      rankStandout: (sl) => { offered = sl.find((j) => j.company !== base.standout?.company) || null; return offered; },
    });
    expect(offered, "the shortlist must hold more than one candidate").toBeTruthy();
    expect(moved.standout?.company).toBe(offered.company);
    expect(moved.standout?.company).not.toBe(base.standout?.company);
  });

  it("a ranker CANNOT introduce a role that failed the location guard", async () => {
    const smuggled = job("x", "Wrong City Co", "Product Manager", "Hyderabad, India", false);
    const r = await build({ rankStandout: () => smuggled });
    expect(r.standout?.company).not.toBe("Wrong City Co");
  });

  it("a ranker that throws, stalls or returns junk leaves the original pick", async () => {
    const base = await build({});
    for (const bad of [() => { throw new Error("boom"); }, () => null, () => undefined, () => "nope", () => ({})]) {
      const r = await build({ rankStandout: bad });
      expect(r.standout?.company).toBe(base.standout?.company);
    }
  });

  // ── GAP_CHART: the coverage chart is dark by default ─────────────────────────────────────────
  // With the flag off nobody's email changes; turning it on is a separate, reversible decision. These
  // assertions enforce that.
  describe("GAP_CHART", () => {
    // A ranker that hands back both the pick and the coverage behind it, the shape market-briefing.mjs
    // returns. The requirement strings are deliberately nothing like any title word in the pool, so
    // a chart built from them is unmistakably NOT the keyword chart.
    const withCoverage = (sl) => ({
      job: sl[0],
      items: sl.map((j) => ({
        job: j,
        cov: {
          thin: false, composite: 60,
          coverage: [
            { req: "Regulated payments infrastructure", status: "met", evidence: "shipped a platform" },
            { req: "Multi-team org leadership", status: "unknown", evidence: null },
          ],
        },
      })),
    });

    it("defaults to keyword, so merging changes nobody's email", async () => {
      delete process.env.GAP_CHART;
      const plain = await build({});
      const withCov = await build({ rankStandout: withCoverage });
      // Same rows as a run that never computed coverage at all.
      expect(withCov.domains).toEqual(plain.domains);
      expect(withCov.domains.some((d) => /payments infrastructure/i.test(d.label))).toBe(false);
    });

    it("renders the coverage chart only when explicitly switched on", async () => {
      process.env.GAP_CHART = "coverage";
      try {
        const r = await build({ rankStandout: withCoverage });
        expect(r.domains.map((d) => d.label).sort()).toEqual(["Multi-team org leadership", "Regulated payments infrastructure"]);
        // and the two sides are derived from the coverage verdicts, not from string similarity
        expect(r.gravity.map((d) => d.label)).toEqual(["Regulated payments infrastructure"]);
        expect(r.marketAsk.map((d) => d.label)).toEqual(["Multi-team org leadership"]);
        expect(r.gravity[0].evidence).toBe("shipped a platform");
      } finally { delete process.env.GAP_CHART; }
    });

    it("keeps the strengths side possible — a coverage chart is not a gaps-only chart", async () => {
      // Whether the email keeps a "your strengths" side is a product decision; it must not change by
      // accident, so this pins that a cited `met` reaches gravity.
      process.env.GAP_CHART = "coverage";
      try {
        const r = await build({ rankStandout: withCoverage });
        expect(r.gravity.length).toBeGreaterThan(0);
      } finally { delete process.env.GAP_CHART; }
    });

    it("falls open to the keyword chart when the coverage rows are too thin to speak from", async () => {
      // One employer asking is not a market signal, so the coverage chart declines to exist. The
      // briefing must keep today's chart rather than lose its chart — this is the
      // fail-closed-becomes-fail-to-zero family, and the whole section silently vanishing is the
      // failure mode.
      process.env.GAP_CHART = "coverage";
      try {
        const plain = await build({});
        const r = await build({
          rankStandout: (sl) => ({ job: sl[0], items: [{ job: sl[0], cov: { thin: true, reason: "jd" } }] }),
        });
        expect(r.domains).toEqual(plain.domains);
      } finally { delete process.env.GAP_CHART; }
    });

    it("still accepts a ranker that returns a bare job — the original contract is unbroken", async () => {
      process.env.GAP_CHART = "coverage";
      try {
        const base = await build({});
        let offered = null;
        const r = await build({ rankStandout: (sl) => { offered = sl.find((j) => j.company !== base.standout?.company); return offered; } });
        expect(r.standout?.company).toBe(offered.company);
        expect(r.domains).toEqual(base.domains); // no coverage handed back -> keyword chart
      } finally { delete process.env.GAP_CHART; }
    });
  });
});

// ── the gap chart must name capabilities, not job-title words or employers ──────────────────────
// Title words make bad capabilities: "Management" (the second word of "Product Management", in every
// PM posting), "Owner" (from "Product Owner", a synonym for the reader's own job), or "Auth0" (one
// employer's product name lifted from a title). Said in Charlie's voice ("the one hole is Owner"), that
// reads as a keyword pitch, which is the exact accusation the product exists to refute.
describe("topicsFor — no job-title words, no single-company jargon", () => {
  const dossier = { headline: "Product leader", proof_points: ["shipped"], strengths: ["strategy"], preferences: { role: "Product Manager" } };
  const j = (company, title) => ({ company, title, location: "Remote", description: "x".repeat(400) });
  const rep = (n, company, title) => Array.from({ length: n }, () => j(company, title));
  // Mirrors the real shape: a genuine capability recurs across employers, a company's own product name
  // does not. "Auth0" only ever appears in Okta's postings, which is precisely why it is not a signal.
  const jobs = [
    ...rep(2, "Instacart", "Senior Product Manager, Retailer Platform"),
    ...rep(2, "Shopify", "Product Manager, Merchant Platform"),
    ...rep(2, "Stripe", "Senior Product Manager, Payments Platform"),
    ...rep(2, "GitLab", "Senior Manager, Product Management: Agentic Delivery"),
    ...rep(2, "Cohere", "Director of Product, Agentic Systems"),
    ...rep(2, "Harvey", "Principal Product Manager, Agentic Workflows"),
    ...rep(4, "Okta", "Principal Group Product Manager, B2B (Auth0)"),
    ...rep(4, "Simplii", "Director, Product Owner - Process Optimization"),
  ];
  const pool = [...jobs, ...rep(40, "Misc Co", "Software Engineer"), ...rep(40, "Other Co", "Account Executive")];
  const labels = () => topicsFor(jobs, dossier, pool).map((t) => String(t.label).toLowerCase());

  it("drops the words a job TITLE is built from", () => {
    for (const w of ["management", "manager", "owner", "product"]) expect(labels(), w).not.toContain(w);
  });

  it("drops a word confined to ONE employer — Auth0 is Okta's product, not a skill", () => {
    expect(labels()).not.toContain("auth0");
  });

  it("keeps a capability that recurs across employers", () => {
    const l = labels();
    expect(l).toContain("platform"); // Instacart + Shopify + Stripe
    expect(l).toContain("agentic");  // GitLab + Cohere + Harvey
  });
});
