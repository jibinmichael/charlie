// market-briefing.test.mjs — the briefing drip's fail-closed gates + grounding on the template (a USD
// person must never see their floor rendered in ₹, the region line must name THEIR market, and one
// person's career must not be asserted about anyone else).
import { describe, it, expect, afterEach } from "vitest";
import { marketBriefEligible, isExcluded } from "./market-briefing.mjs";
import { renderMarketReport } from "./render-market-report.mjs";

describe("marketBriefEligible — a briefing sends ONLY when there is a real market + proven ground", () => {
  const ok = { funnel: { addressable: 8 }, gravity: [{ key: "automation" }, { key: "testing" }] };
  // A dossier that clears isThinDossier: two claimed proofs + a stated role + a stated region signal.
  // Every case below needs one, because a market report is a claim about a PERSON's market and
  // carries the same evidence bar as any other claim about a person.
  const known = {
    headline: "QA automation engineer",
    proof_points: [{ claim: "Built the regression suite" }, { claim: "Cut release time in half" }],
    preferences: { role: "SDET", remote: true },
  };
  it("true when addressable clears the floor AND two proven topics exist", () => {
    expect(marketBriefEligible(ok, known)).toBe(true);
  });
  it("false on a thin market (too few reachable roles)", () => {
    expect(marketBriefEligible({ funnel: { addressable: 7 }, gravity: [{ key: "x" }, { key: "y" }] }, known)).toBe(false);
  });
  it("false with no proven topic (the coverage chart would be hollow)", () => {
    expect(marketBriefEligible({ funnel: { addressable: 40 }, gravity: [] }, known)).toBe(false);
  });
  it("false on a SINGLE proven topic — one hit is a coincidence, not a read", () => {
    expect(marketBriefEligible({ funnel: { addressable: 40 }, gravity: [{ key: "secure" }] }, known)).toBe(false);
  });
  it("fails closed on a null / partial report", () => {
    expect(marketBriefEligible(null, known)).toBe(false);
    expect(marketBriefEligible(undefined, known)).toBe(false);
    expect(marketBriefEligible({}, known)).toBe(false);
    expect(marketBriefEligible({ funnel: {} }, known)).toBe(false);
  });

  // The welcome email consults isThinDossier and tells a new person "it's thinner than I'd like, I
  // don't have the full picture of you". The briefing must not then arrive with a confident charted
  // read of their market: a perfect market report is not permission to speak about someone we barely
  // know.
  it("false on a PERFECT market when the dossier is too thin to speak about the person", () => {
    expect(marketBriefEligible(ok, { headline: "engineer", proof_points: [], preferences: {} })).toBe(false);
  });
  it("false when there is only ONE proof point — the same bar the welcome email applies", () => {
    expect(marketBriefEligible(ok, { ...known, proof_points: [{ claim: "Built the regression suite" }] })).toBe(false);
  });
  it("false when nothing about the person's target is known (no role, no headline)", () => {
    expect(marketBriefEligible(ok, { ...known, headline: "", preferences: { remote: true } })).toBe(false);
  });
  it("fails CLOSED on a missing dossier — an unknown reader is never briefed", () => {
    expect(marketBriefEligible(ok)).toBe(false);
    expect(marketBriefEligible(ok, null)).toBe(false);
    expect(marketBriefEligible(ok, {})).toBe(false);
  });
});

describe("isExcluded — the hard NEVER-SEND list (an excluded address can never be sent again)", () => {
  afterEach(() => { delete process.env.MARKETBRIEF_EXCLUDE; });
  it("true for an address on MARKETBRIEF_EXCLUDE (case / space insensitive)", () => {
    process.env.MARKETBRIEF_EXCLUDE = " Sant@Example.com , other@x.com ";
    expect(isExcluded("sant@example.com")).toBe(true);
    expect(isExcluded("SANT@example.com")).toBe(true);
    expect(isExcluded("other@x.com")).toBe(true);
  });
  it("false for an address not on the list", () => {
    process.env.MARKETBRIEF_EXCLUDE = "sant@example.com";
    expect(isExcluded("someone@else.com")).toBe(false);
  });
  it("fails closed on an empty address (no address -> never send)", () => {
    expect(isExcluded("")).toBe(true);
    expect(isExcluded(null)).toBe(true);
  });
});

// A complete-enough report to exercise every section; region + currency are the axes under test.
function report({ region, floorCcy, floor, standoutCcy }) {
  return {
    meta: { email: "u@x.com", name: null, headline: null, region, poolTotal: 100 },
    funnel: { scanned: 13860, inField: 120, addressable: 57, unreachable: 30, companies: 40 },
    seniority: { exec: 2, director: 3, principalStaff: 5, senior: 20, ic: 20, apm: 7 },
    barTier: "exec",
    barLabel: "VP / Head of",
    atOrAboveBar: 5,
    // geo is region-agnostic: remote + the person's real top cities (names from the postings).
    geo: /india/i.test(region)
      ? { remote: 12, cities: [{ city: "Bengaluru", n: 10 }, { city: "Pune", n: 4 }], other: 6, total: 32 }
      : { remote: 12, cities: [{ city: "San Francisco", n: 8 }, { city: "New York", n: 6 }], other: 20, total: 46 },
    gravity: [{ key: "platform", label: "Platform & APIs", flow: "platform and API", live: 12 }],
    marketAsk: [],
    comp: { total: 57, disclosed: 20, floor, floorCcy, clearFloor: 1 },
    standout: { company: "Acme", title: "Head of Product", location: "Remote", comp: { currency: standoutCcy, min: standoutCcy === "USD" ? 180000 : 8000000, max: standoutCcy === "USD" ? 220000 : 12000000 }, tier: "exec", apply_url: "https://x.com/a" },
    evidence: { proof: [], caseDomains: [] },
    domains: [
      { key: "platform", label: "Platform & APIs", flow: "platform and API", evidenced: true, live: 12, examples: [{ company: "Acme", title: "PM" }] },
      { key: "ai", label: "AI & GenAI", flow: "AI and GenAI", evidenced: true, live: 8, examples: [{ company: "Beta", title: "PM" }] },
      { key: "fintech", label: "Fintech & Payments", flow: "fintech and payments", evidenced: false, live: 6, examples: [{ company: "Gamma", title: "PM" }] },
    ],
    topCompanies: [{ company: "Acme", n: 9 }, { company: "Beta", n: 6 }, { company: "Gamma", n: 4 }],
    tierLabels: { exec: "VP / Head of", director: "Director", principalStaff: "Principal / Staff", senior: "Senior / Lead", ic: "Mid-level", apm: "Entry / Associate" },
  };
}

describe("render grounding — currency + region trace to THIS person (the regression)", () => {
  it("an INR/India person: floor shown in ₹, region named India", () => {
    const { html } = renderMarketReport(report({ region: "india", floorCcy: "INR", floor: 8000000, standoutCcy: "INR" }), { email: "u@x.com" });
    expect(html).toContain("&#8377;"); // ₹ in the money legend/copy
    expect(html).toContain("India");
  });
  it("a USD/US person: floor shown in $, region named the US, NEVER a ₹ symbol", () => {
    const { html } = renderMarketReport(report({ region: "usa", floorCcy: "USD", floor: 200000, standoutCcy: "USD" }), { email: "u@x.com" });
    expect(html).toContain("$"); // the disclosed-comp floor renders in USD
    expect(html).toContain("the US");
    expect(html).not.toContain("&#8377;"); // a USD floor is never rendered as ₹
    expect(html).not.toContain("India"); // seniority line must not hardcode India for a US person
  });
  it("a person with a floor but NO stated currency: never guesses a ₹ or $ symbol (the legend leak)", () => {
    // comp_floor can be set while comp_currency is null (market-report.mjs sets them independently).
    // A floor with no currency must not be printed as ₹ in the money legend — a false currency claim.
    const { html } = renderMarketReport(report({ region: "usa", floorCcy: null, floor: 200000, standoutCcy: null }), { email: "u@x.com" });
    expect(html).not.toContain("&#8377;"); // no rupee symbol asserted
    expect(html).toContain("200,000");     // the floor is stated as a bare number instead
  });
  it("a sub-lakh / trivial floor is DROPPED, never rendered as 'Clears ₹0L'", () => {
    // comp_floor is sometimes stored in the wrong magnitude (a ~₹40k value), which would render
    // "Clears ₹0L" and treat every role as clearing it. Below the threshold, no floor claim.
    const { html } = renderMarketReport(report({ region: "india", floorCcy: "INR", floor: 40000, standoutCcy: "INR" }), { email: "u@x.com" });
    expect(html).not.toContain("&#8377;0L"); // never the literal "₹0L"
    expect(html).not.toContain("Clears");    // the floor legend item is dropped entirely
    expect(html).toContain("Named a number"); // the money section still renders, just without the floor claim
  });
  it("a meaningful floor is still shown normally (no regression)", () => {
    const { html } = renderMarketReport(report({ region: "india", floorCcy: "INR", floor: 8000000, standoutCcy: "INR" }), { email: "u@x.com" });
    expect(html).toContain("Clears"); // ₹80L floor is real -> still named
  });
  it("geo names the person's REAL cities per region, no hardcoded Bengaluru for a US user", () => {
    const us = renderMarketReport(report({ region: "usa", floorCcy: "USD", floor: 200000, standoutCcy: "USD" }), { email: "u@x.com" }).html;
    expect(us).toContain("San Francisco");
    expect(us).not.toContain("Bengaluru");
    const india = renderMarketReport(report({ region: "india", floorCcy: "INR", floor: 8000000, standoutCcy: "INR" }), { email: "u@x.com" }).html;
    expect(india).toContain("Bengaluru");
  });
  it("never asserts one person's biography about another person", () => {
    const { html } = renderMarketReport(report({ region: "usa", floorCcy: "USD", floor: 200000, standoutCcy: "USD" }), { email: "u@x.com" });
    expect(html).not.toContain("built the platform and ran the Gen-AI work");
    expect(html).not.toContain("your home turf");
  });
});

// The adaptive template: every section keys off the person, never one static letter with numbers swapped
// in.
//
// SCOPE: these hand-set `barTier` on the fixture on purpose — they test the RENDERER's windowing given a
// tier. That is not proof the pipeline produces those tiers; the classifier itself is tested against
// real dossier shapes in market-report.test.mjs -> `levelOf`. Keep both halves.
describe("adaptive template — level-window, gaps-as-information, comp pull, wedge", () => {
  const base = report({ region: "india", floorCcy: "INR", floor: 8000000, standoutCcy: "INR" });

  it("the old static 'You can reach N VP or CPO roles' line is GONE for everyone", () => {
    for (const barTier of ["exec", "senior", "apm"]) {
      const { html } = renderMarketReport({ ...base, barTier, barLabel: base.tierLabels[barTier] }, { email: "u@x.com" });
      expect(html).not.toContain("You can reach");
    }
  });

  it("a JUNIOR is never shown the VP rung (windowed to their reach) + gets the 'room to climb' framing", () => {
    const { html } = renderMarketReport({ ...base, barTier: "apm", barLabel: "Entry / Associate" }, { email: "u@x.com" });
    expect(html).not.toContain("VP / Head of"); // the exec row is windowed out
    expect(html).toContain("the next rung is open"); // encouraging, never "you can't"
    expect(html).not.toContain("you can't");
    expect(html).not.toContain("you cannot reach");
  });

  it("a SENIOR gets the honest 'room above is thin', still windowed (no VP row two rungs up)", () => {
    const { html } = renderMarketReport({ ...base, barTier: "senior", barLabel: "Senior / Lead" }, { email: "u@x.com" });
    expect(html).toContain("the room above you is thin");
    expect(html).not.toContain("VP / Head of"); // senior line: window tops out below exec
    expect(html).toContain("not a verdict on you");
  });

  it("the static global scan total (identical for every user) is NOT rendered — funnel stays per-person", () => {
    const { html } = renderMarketReport(base, { email: "u@x.com" });
    expect(html).not.toContain("13,860"); // the raw pool total is the same for everyone -> static, dropped
    expect(html).toContain("In your field"); // the per-person funnel stages remain
    expect(html).toContain("You can take");
  });

  // THE WHOLE-BOARD SECTION IS DISABLED. Its gap chart compared the first four characters of category
  // names, so the same field split in two ("Software" vs "Development") could be called a GAP while
  // also listed as covered. These cases assert its ABSENCE, so the section cannot come back without
  // someone deleting a test.
  it("the whole-board gap chart does NOT render", () => {
    const { html } = renderMarketReport(base, { email: "u@x.com" });
    expect(html).not.toContain("the whole board");
    expect(html).not.toContain("where the market leans");
    expect(html).not.toContain("worth knowing");
  });

  it("the rest of the briefing still renders — the section was removed, not the email", () => {
    const { html } = renderMarketReport(base, { email: "u@x.com" });
    expect(html.length).toBeGreaterThan(2000);
    expect(html).toMatch(/<html|<table/i);
  });

  it("no floor + an observed band: SHOWS the market's pay and pulls for the person's number", () => {
    const r = { ...base, comp: { total: 51, disclosed: 11, floor: null, floorCcy: null, clearFloor: null, observed: { currency: "INR", lo: 1500000, hi: 2500000, top: 3500000, n: 10 } } };
    const { html } = renderMarketReport(r, { email: "u@x.com" });
    expect(html).toContain("what I can see on pay");
    expect(html).toContain("peek"); // honest about the disclosed-only limit
    expect(html).toContain("tell me the least you would take");
  });

  // A floor stated in a major currency other than the dollar must not fall under the RUPEE bar and be
  // discarded (the letter would say they never named a floor, then quote a rupee band far below it).
  // Both halves are asserted: the floor survives, and the currency mismatch is named.
  describe("a floor in a currency this market does not post in", () => {
    const euroFloor = {
      ...base,
      comp: { total: 51, disclosed: 10, floor: 50000, floorCcy: "EUR", clearFloor: 0,
              observed: { currency: "INR", lo: 1500000, hi: 2500000, top: 3500000, n: 9 } },
    };

    it("never tells someone they have not named a floor when they have", () => {
      const { html } = renderMarketReport(euroFloor, { email: "u@x.com" });
      expect(html).not.toContain("have not named your floor");
      expect(html).toContain("EUR 50,000"); // their number, in their currency, stated back to them
    });

    it("names the mismatch instead of rendering a 0 that reads as rejection", () => {
      const { html } = renderMarketReport(euroFloor, { email: "u@x.com" });
      expect(html).toContain("not going to pretend I can line the two up");
      expect(html).not.toContain("Clears EUR 50,000 (0)"); // the coral legend item is dropped entirely
      expect(html).toContain("rupees");
    });

    it("still shows the real band, and never converts between currencies", () => {
      const { html } = renderMarketReport(euroFloor, { email: "u@x.com" });
      expect(html).toContain("&#8377;15L"); // the posted INR band survives, unconverted
      expect(html).not.toMatch(/&#8377;4[0-9]L\b/); // no rupee-ised version of the EUR floor
    });

    it("a same-currency floor still gets the plain 'clears it' read (no regression)", () => {
      const inrFloor = {
        ...base,
        comp: { total: 51, disclosed: 10, floor: 2000000, floorCcy: "INR", clearFloor: 4,
                observed: { currency: "INR", lo: 1500000, hi: 2500000, top: 3500000, n: 9 } },
      };
      const { html } = renderMarketReport(inrFloor, { email: "u@x.com" });
      expect(html).toContain("Clears");
      expect(html).not.toContain("not going to pretend");
    });

    it("a sub-lakh rupee floor is still discarded as a magnitude error (no regression)", () => {
      const junk = { ...base, comp: { total: 51, disclosed: 10, floor: 40000, floorCcy: "INR", clearFloor: 0 } };
      const { html } = renderMarketReport(junk, { email: "u@x.com" });
      expect(html).not.toContain("Clears");
    });
  });

  it("the subject line is the person's own target, not one literal for everyone", () => {
    const a = renderMarketReport({ ...base, meta: { ...base.meta, role: "Senior Product Manager" } }, { email: "u@x.com" }).subject;
    const b = renderMarketReport({ ...base, meta: { ...base.meta, role: "QA Automation Engineer" } }, { email: "u@x.com" }).subject;
    expect(a).not.toBe(b);
    expect(a).toBe("Your Senior Product Manager market, honestly");
    // their own casing survives — lowercasing the first letter made "AI" into "aI"
    const ai = renderMarketReport({ ...base, meta: { ...base.meta, role: "AI/ML Engineer, Software Engineer, Data Analyst" } }, { email: "u@x.com" }).subject;
    expect(ai).toBe("Your AI/ML Engineer market, honestly"); // first of the list, "AI/ML" left intact
    // no stated target, or one too long to be a subject -> the generic line, never a jammed-in one
    expect(renderMarketReport({ ...base, meta: { ...base.meta, role: null } }, { email: "u@x.com" }).subject).toBe("Can you keep a secret?");
    const longRole = "entry-level in operations and administration and analytics and support";
    expect(renderMarketReport({ ...base, meta: { ...base.meta, role: longRole } }, { email: "u@x.com" }).subject).toBe("Can you keep a secret?");
  });

  // The wedge lived INSIDE the whole-board section, so it is absent with it. Pinned for the same
  // reason: "the market's one big ask you are quiet on is X" is only as true as the chart under it.
  it("the wedge does NOT render while the whole-board section is disabled", () => {
    const r = { ...base, wedge: { employer: "Lumora", tenure: "three years", domain: "Platform & APIs", flow: "platform and API", live: 7, employerNote: "an API business at its core" } };
    const { html } = renderMarketReport(r, { email: "u@x.com" });
    expect(html).not.toContain("you were at Lumora for three years");
    expect(html).not.toContain("one big ask you are quiet on");
  });
});
