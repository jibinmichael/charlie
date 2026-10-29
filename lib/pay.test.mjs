// lib/pay.test.mjs — the pay floor Charlie promises to honour.
//
// The promise, verbatim from email-onboard.mjs: "your pay floor, so I never send you anything below it."
// These cases are the enforcement.
import { describe, it, expect, afterEach } from "vitest";
import { parseComp, floorToAbsolute, belowStatedFloor } from "./pay.mjs";
import { gateRole } from "../quality-gate.mjs";

describe("floorToAbsolute — one field, two units", () => {
  // INR floors are stored either in lakhs or in rupees.
  it("reads a lakh-denominated INR floor as lakhs (this is why the promise went unnoticed)", () => {
    expect(floorToAbsolute(15, "INR")).toBe(1500000); // 15 lakh
    expect(floorToAbsolute(18, "INR")).toBe(1800000); // 18 lakh
    expect(floorToAbsolute(30, "INR")).toBe(3000000); // 30 lakh
    expect(floorToAbsolute(7, "INR")).toBe(700000); // the smallest live value
  });
  it("leaves an already-absolute INR floor alone", () => {
    expect(floorToAbsolute(2200000, "INR")).toBe(2200000); // already rupees (22 lakh)
    expect(floorToAbsolute(8000000, "INR")).toBe(8000000); // already rupees
  });
  it("never scales a non-INR floor", () => {
    expect(floorToAbsolute(45000, "USD")).toBe(45000);
    expect(floorToAbsolute(8000, "EUR")).toBe(8000);
  });
  it("refuses an ambiguous currency — one live candidate's is the string \"USD OR INR\"", () => {
    expect(floorToAbsolute(60000, "USD OR INR")).toBeNull();
    expect(floorToAbsolute(60000, "")).toBeNull();
    expect(floorToAbsolute(60000, null)).toBeNull();
  });
  it("refuses a floor that is not a usable number", () => {
    for (const v of [null, undefined, 0, -5, NaN, "15"]) expect(floorToAbsolute(v, "INR")).toBeNull();
  });
});

describe("belowStatedFloor — a disclosed stipend far below the floor", () => {
  // A 15-lakh floor against an internship that DISCLOSES a monthly stipend far below it.
  const person = { comp_floor: 15, comp_currency: "INR" };
  it("catches a 15-lakh floor vs \"INR 18,000.00 - 20,000.00\"", () => {
    const v = belowStatedFloor("INR 18,000.00 - 20,000.00", person);
    expect(v).not.toBeNull();
    expect(v.below).toBe(true);
    expect(v.floor).toBe(1500000);
    expect(v.roleMax).toBe(20000);
  });
  it("does NOT fire on a role that genuinely clears the floor", () => {
    expect(belowStatedFloor("INR 18,00,000 - 24,00,000", person).below).toBe(false);
  });
  it("treats a role paying exactly the floor as acceptable, not below", () => {
    expect(belowStatedFloor("INR 15,00,000", person).below).toBe(false);
  });
  it("judges the TOP of a posted band — a 12-18L range meets a 15L floor", () => {
    expect(belowStatedFloor("INR 12,00,000 - 18,00,000", person).below).toBe(false);
  });
});

describe("belowStatedFloor — fails OPEN, because a false drop is silence", () => {
  const inr = { comp_floor: 15, comp_currency: "INR" };
  it("no opinion when the posting discloses nothing (most postings)", () => {
    for (const c of [null, undefined, "", {}, { compensationTiers: [], compensationTierSummary: null }]) {
      expect(belowStatedFloor(c, inr)).toBeNull();
    }
  });
  it("no opinion when the person never stated a floor", () => {
    expect(belowStatedFloor("INR 3,00,000", {})).toBeNull();
    expect(belowStatedFloor("INR 3,00,000", { comp_floor: null, comp_currency: "INR" })).toBeNull();
  });
  it("NEVER compares rupees to dollars", () => {
    expect(belowStatedFloor("$40,000 - $60,000", inr)).toBeNull();
    expect(belowStatedFloor("INR 3,00,000", { comp_floor: 90000, comp_currency: "USD" })).toBeNull();
  });
  it("no opinion when the currency is unreadable, even with a number present", () => {
    expect(belowStatedFloor("3,00,000 - 5,00,000", inr)).toBeNull();
  });

  // The false-drop this guard exists to avoid: India postings often quote a MONTHLY figure. Comparing
  // 2,00,000/month to a 15-lakh ANNUAL floor would drop a role paying 24 lakh a year.
  it("annualises a monthly posting instead of dropping a role that pays 12x the ask", () => {
    const v = belowStatedFloor("INR 2,00,000 per month", inr);
    expect(v.roleMax).toBe(2400000);
    expect(v.below).toBe(false);
  });
  it("still catches a monthly posting that is genuinely under the floor", () => {
    expect(belowStatedFloor("INR 20,000 per month", inr).below).toBe(true); // 2.4L/yr vs 15L
  });
});

// ── the stop inside the real send gate, not just the helper ──────────────────────────────────────
// "The gate runs" is not "the gate blocks". These drive
// gateRole itself, so a future refactor that imports belowStatedFloor but never reaches it will fail.
describe("gateRole — the pay-floor stop, end to end", () => {
  afterEach(() => { delete process.env.PAY_FLOOR_MODE; });
  const liveFetch = async () => ({ status: 200, json: async () => ({}), text: async () => "" });
  // A 15-lakh floor and a role disclosing a monthly stipend far below it.
  const job = {
    id: "greenhouse:examplecorp:1", company: "Examplecorp", title: "Software Development Intern (Full Stack)",
    location: "Bengaluru, Karnataka, India", apply_url: "https://x/1", description: "work",
    compensation: "INR 18,000.00 - 20,000.00",
  };
  const dossier = { location: "Bengaluru, India", headline: "SDE", preferences: { comp_floor: 15, comp_currency: "INR" } };
  // Scoreable, at-level, above the fit floor — so nothing EARLIER in gateRole can be what dropped it.
  const cov = { thin: false, composite: 70, seniorityLevel: "at", subscores: { seniority: 0.8 } };
  const gate = (j = job, d = dossier) => gateRole({ job: j, dossier: d, matcherScore: 90, fetchImpl: liveFetch, getCov: async () => cov });

  it("DROPS a role that discloses pay below a stated floor", async () => {
    const g = await gate();
    expect(g.outcome).toBe("drop");
    expect(g.reason).toMatch(/below the floor you gave me/i);
  });

  it("a high matcher score does not buy past the floor", async () => {
    const g = await gateRole({ job, dossier, matcherScore: 99, fetchImpl: liveFetch, getCov: async () => cov });
    expect(g.outcome).toBe("drop");
  });

  it("STILL SENDS when the posting discloses no pay — most of the pool, must not go quiet", async () => {
    const g = await gate({ ...job, compensation: null });
    expect(g.outcome).toBe("send");
  });

  it("STILL SENDS when the role clears the floor", async () => {
    const g = await gate({ ...job, compensation: "INR 20,00,000 - 25,00,000" });
    expect(g.outcome).toBe("send");
  });

  it("STILL SENDS when the person never stated a floor", async () => {
    const g = await gate(job, { ...dossier, preferences: {} });
    expect(g.outcome).toBe("send");
  });

  it("PAY_FLOOR_MODE=shadow counts without dropping (kill-switch, no deploy)", async () => {
    process.env.PAY_FLOOR_MODE = "shadow";
    const g = await gate();
    expect(g.outcome).toBe("send");
  });
});

describe("parseComp — the shared compensation parser", () => {
  it("reads a rupee band", () => {
    expect(parseComp("INR 70,00,000.00 - 1,00,00,000.00")).toEqual({ currency: "INR", min: 7000000, max: 10000000 });
  });
  it("expands a USD K suffix", () => {
    expect(parseComp("$164K - $200K")).toEqual({ currency: "USD", min: 164000, max: 200000 });
  });
  it("does not mistake the 'rs' in ordinary English for rupees (the ₹2L-for-$200K trust break)", () => {
    expect(parseComp("$200K, best offers reach $500K").currency).toBe("USD");
  });
  it("returns null rather than guessing", () => {
    for (const c of [null, "", {}, "competitive salary"]) expect(parseComp(c)).toBeNull();
  });
});

// ── Indian pay notation ─────────────────────────────────────────────────────────────────────────
// Indian salary is written "₹70L", "70-90 LPA", "₹1.2 Cr". Read as bare numbers, a ₹70-90 lakh role
// becomes "90 rupees", falls under the person's floor, and is dropped. Because shorthand is how LARGE
// salaries are written, that misreading would preferentially delete the best roles.
describe("parseComp — lakh and crore, the notation most Indian postings use", () => {
  const inr = (s) => parseComp(s);
  it("reads the L suffix as lakhs", () => {
    expect(inr("₹70L - ₹90L")).toEqual({ currency: "INR", min: 7000000, max: 9000000 });
    expect(inr("INR 70L-90L")).toEqual({ currency: "INR", min: 7000000, max: 9000000 });
  });
  it("reads LPA (lakhs per annum), including when only the range's end carries the unit", () => {
    expect(inr("INR 25 LPA")).toEqual({ currency: "INR", min: 2500000, max: 2500000 });
    expect(inr("₹12-18 LPA").max).toBe(1800000);
    expect(inr("₹12-18 LPA").min).toBe(1200000); // the unit applies to the whole range, not just the end
  });
  it("reads the spelled-out forms", () => {
    expect(inr("₹15 lakhs").max).toBe(1500000);
    expect(inr("Rs 15 lakh per annum").max).toBe(1500000);
    expect(inr("₹15 lacs").max).toBe(1500000);
  });
  it("reads crore", () => {
    expect(inr("₹1.2 Cr").max).toBe(12000000);
    expect(inr("₹1 - ₹2 crore").max).toBe(20000000);
  });

  // The half that must NOT regress: everything that already worked.
  it("still reads plain rupee figures unchanged", () => {
    expect(inr("INR 70,00,000.00 - 1,00,00,000.00")).toEqual({ currency: "INR", min: 7000000, max: 10000000 });
    expect(inr("INR 18,000.00 - 20,000.00")).toEqual({ currency: "INR", min: 18000, max: 20000 });
  });
  it("still expands USD K/M and does not apply lakh to dollars", () => {
    expect(inr("$164K - $200K")).toEqual({ currency: "USD", min: 164000, max: 200000 });
    expect(inr("$1.5M").max).toBe(1500000);
  });

  // A bare "L"/"cr" must be a UNIT, not a letter that happens to follow a number.
  it("does not treat an ordinary word starting with L or C as a unit", () => {
    expect(inr("INR 500000 for 10 Lead engineers").max).toBe(500000);
    expect(inr("INR 500000, 5 Crew members").max).toBe(500000);
  });

  // End to end: a lakh-notated band is no longer read as below a lakh floor.
  it("a 70-90 lakh role no longer reads as below a 15-lakh floor", () => {
    const v = belowStatedFloor("₹70L - ₹90L", { comp_floor: 15, comp_currency: "INR" });
    expect(v.roleMax).toBe(9000000);
    expect(v.below).toBe(false);
  });
});

// ── hourly rates: the larger half of the unit problem ────────────────────────────────────────────
// "$50 per hour" is ~$104k a year; compared to an annual floor it reads as fifty dollars and the role
// is dropped for paying too little.
describe("belowStatedFloor — an hourly rate is annualised, not read as a yearly salary", () => {
  const usd = { comp_floor: 90000, comp_currency: "USD" };
  it("annualises a plain hourly string", () => {
    const v = belowStatedFloor("$50.00 per hour", usd);
    expect(v.roleMax).toBe(104000); // 50 x 2080
    expect(v.below).toBe(false);
  });
  it("annualises an hourly rate hidden inside an ATS object (the live shape)", () => {
    const v = belowStatedFloor({ compensationTierSummary: "$50.00 per hour" }, usd);
    expect(v.roleMax).toBe(104000);
    expect(v.below).toBe(false);
  });
  it("still catches an hourly rate that is genuinely under the floor", () => {
    expect(belowStatedFloor("$18.75 per hour", usd).below).toBe(true); // 39k vs 90k
  });
  it("does not annualise a normal yearly figure", () => {
    expect(belowStatedFloor("$164,000 - $200,000", usd).roleMax).toBe(200000);
  });
});

// ── a figure too small to be a year's pay is AMBIGUOUS, not low ──────────────────────────────────
// "INR 26.00 - 35.00" means twenty-six to thirty-five LAKH, written with no unit. parseComp returns 35,
// which is under every floor anyone states, and would drop the role for a person whose ₹30L floor it
// CLEARS. Nothing in a bare number distinguishes twenty-six lakh from twenty-six rupees.
describe("belowStatedFloor — an unbelievable annual figure yields NO OPINION, not a drop", () => {
  const floor30 = { comp_floor: 30, comp_currency: "INR" };   // ₹30 lakh
  it("a bare small INR band that clears the floor is KEPT", () => {
    const v = belowStatedFloor("INR 26.00 - 35.00", floor30);
    expect(v.roleMax).toBe(3500000);   // read as 35 lakh, the same way a stated floor of 30 is
    expect(v.below).toBe(false);       // and it clears her 30 lakh floor, which it always did
  });
  it("reads other bare small INR figures the same way the FLOOR side reads them", () => {
    expect(belowStatedFloor("INR 12 - 18", floor30).roleMax).toBe(1800000);
    expect(belowStatedFloor("INR 12 - 18", floor30).below).toBe(true); // 18L really is under 30L
  });
  it("a bare small figure in a currency with NO lakh convention is unreadable, so no opinion", () => {
    expect(belowStatedFloor("EUR 45.00", { comp_floor: 60000, comp_currency: "EUR" })).toBeNull();
  });
  it("still DROPS a genuinely-below role that is written plainly", () => {
    // ₹40-50 lakh against an ₹80 lakh floor. Plausible figures, correct drop.
    const v = belowStatedFloor("INR 40,00,000.00 - 50,00,000.00", { comp_floor: 8000000, comp_currency: "INR" });
    expect(v.below).toBe(true);
  });
  it("still DROPS a monthly stipend under the floor", () => {
    // ₹18-20k/month is believable as a stipend and unambiguously under a ₹15 lakh floor.
    expect(belowStatedFloor("INR 18,000.00 - 20,000.00", { comp_floor: 15, comp_currency: "INR" }).below).toBe(true);
  });
  it("does not break hourly, which is small BY DESIGN and annualised before this check", () => {
    const v = belowStatedFloor("$50.00 per hour", { comp_floor: 90000, comp_currency: "USD" });
    expect(v.roleMax).toBe(104000);
    expect(v.below).toBe(false);
  });
  it("gives no opinion on a bare small USD figure", () => {
    expect(belowStatedFloor("$45.00", { comp_floor: 90000, comp_currency: "USD" })).toBeNull();
  });
});
