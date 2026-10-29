// game-plan.test.mjs — the "game plan" beat: grounded derivation, fail-closed
// eligibility, quote-safe approve detection, the honest modify path (no correction-lie), and the
// template's voice contract (Avenir + Sanchez, no em dash, no leaked mechanism). Pure surfaces only —
// no network, no model. The one path that touches Supabase/Anthropic (applyPrefsOnly) is exercised
// with injected deps so the honesty guarantee is proven mechanically, not asserted in prose.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { planParams, planPositioning, planEligible, planSaysApprove } from "./game-plan.mjs";
import { renderGamePlan } from "./render-plan.mjs";
import { applyPrefsOnly } from "./email-onboard.mjs";

const EM_DASH = /[—–]/; // the em/en dashes the voice contract forbids anywhere user-facing
const MECHANISM = /\b(dossier|build|status|screening|record)\b/i; // never expose the mechanism

// A complete, in-market dossier (missingFields === [] : role, seniority, pay, location, name all present).
const complete = {
  name: "Sam Rivera",
  headline: "Product designer, 8 years in fintech",
  proof_points: [{ claim: "Shipped a payments flow used by 2M users", source: "resume" }],
  preferences: { role: "Product Designer", seniority: "senior", comp_floor: 10000000, comp_currency: "INR", remote: "remote", dealbreakers: ["agencies", "on-site only"] },
};

describe("planParams — grounded, only what the person actually stated", () => {
  it("renders each stated parameter, formatted", () => {
    const p = planParams(complete);
    expect(p.roles).toBe("Product Designer");
    expect(p.level).toBe("senior");
    expect(p.location).toBe("remote");
    expect(p.pay).toBe("₹1 Cr");
    expect(p.avoid).toBe("agencies, on-site only");
  });
  it("omits a parameter the person never gave (never guesses/pads)", () => {
    const p = planParams({ preferences: { role: "PM" } });
    expect(p.roles).toBe("PM");
    expect(p.level).toBeUndefined();
    expect(p.location).toBeUndefined();
    expect(p.pay).toBeUndefined();
    expect(p.avoid).toBeUndefined();
  });
  it("drops a pay floor when the currency is unknown (never asserts ₹/$)", () => {
    const p = planParams({ preferences: { comp_floor: 4000000 } }); // no comp_currency
    expect(p.pay).toBeUndefined();
  });
  it("drops a wrong-magnitude floor rather than render ₹0L", () => {
    expect(planParams({ preferences: { comp_floor: 50, comp_currency: "INR" } }).pay).toBeUndefined();
    expect(planParams({ preferences: { comp_floor: 200, comp_currency: "USD" } }).pay).toBeUndefined();
  });
  it("formats USD in K", () => {
    expect(planParams({ preferences: { comp_floor: 150000, comp_currency: "USD" } }).pay).toBe("$150K");
  });
});

describe("planPositioning — a grounded sentence or nothing", () => {
  it("leads with a verified proof point, verbatim, terminated", () => {
    expect(planPositioning(complete)).toBe("Shipped a payments flow used by 2M users.");
  });
  it("falls back to the headline when there is no proof point", () => {
    expect(planPositioning({ headline: "Backend engineer, 5 years" })).toBe("Backend engineer, 5 years.");
  });
  it("returns empty when there is nothing grounded to point to", () => {
    expect(planPositioning({ preferences: {} })).toBe("");
  });
});

describe("planEligible — fail closed: only when we can actually STATE a plan", () => {
  it("true for a complete, in-market profile", () => {
    expect(planEligible(complete)).toBe(true);
  });
  it("false when a search parameter is missing (can't say where we're looking with a hole)", () => {
    const noPay = { ...complete, preferences: { ...complete.preferences, comp_floor: null } };
    expect(planEligible(noPay)).toBe(false);
  });
  it("false for a person whose grounded home is outside India + US", () => {
    const foreign = { ...complete, preferences: { ...complete.preferences, home_place: "Berlin, Germany", remote: "Berlin" } };
    // homeRegion reads location signals; a clear foreign city yields "other" -> no plan.
    expect(planEligible(foreign)).toBe(false);
  });
  it("false for null/garbage input", () => {
    expect(planEligible(null)).toBe(false);
    expect(planEligible({})).toBe(false);
  });
});

describe("planSaysApprove — quote-safe, conservative", () => {
  it("accepts short standalone affirmations", () => {
    for (const s of ["approve", "Approve", "yes", "yep", "sounds good", "looks good", "go ahead", "let's do it", "perfect", "ok"]) {
      expect(planSaysApprove(s)).toBe(true);
    }
  });
  it("accepts an affirmation with trailing punctuation / a thumbs-up", () => {
    expect(planSaysApprove("approve!")).toBe(true);
    expect(planSaysApprove("yes 👍")).toBe(true);
  });
  it("is NOT fooled by the quoted plan email (which literally says 'Reply approve')", () => {
    const quoted = `Not quite.\n\nOn Sun, Charlie wrote:\n> Reply "approve" and I'll get to work.`;
    expect(planSaysApprove(quoted)).toBe(false);
  });
  it("treats a stated change as NOT an approval", () => {
    expect(planSaysApprove("approve but make it remote only and staff level")).toBe(false);
    expect(planSaysApprove("actually I want staff roles")).toBe(false);
  });
});

describe("renderGamePlan — grounded + voice contract", () => {
  const { subject, html, text } = renderGamePlan({ name: "Sam", positioning: planPositioning(complete), params: planParams(complete), email: "sam@example.com" });
  it("uses Avenir (body) and Sanchez (headings)", () => {
    expect(html).toContain("Avenir");
    expect(html).toContain("Sanchez");
  });
  it("has no em dashes anywhere (subject, html, text)", () => {
    expect(EM_DASH.test(subject)).toBe(false);
    expect(EM_DASH.test(html)).toBe(false);
    expect(EM_DASH.test(text)).toBe(false);
  });
  it("never leaks the mechanism", () => {
    expect(MECHANISM.test(html)).toBe(false);
  });
  it("renders only grounded params, and none the person never gave", () => {
    expect(html).toContain("Product Designer");
    expect(html).toContain("₹1 Cr");
    expect(html).toContain("agencies, on-site only");
    expect(html).not.toContain("Company stage"); // a field the person never stated is absent
  });
  // The plan must NOT carry an approve invitation: approving would be a no-op (the day-2 role is
  // already scheduled), so the ask would imply a contingency that does not exist.
  it("never asks anyone to reply 'approve' (the ask was a no-op)", () => {
    expect(html.toLowerCase()).not.toContain("approve");
    expect(text.toLowerCase()).not.toContain("approve");
  });
  it("still hands over the wheel with the modify invitation, which IS wired", () => {
    expect(html).toContain("Tell me what to change");
    expect(text).toContain("Tell me what to change");
  });
  it("the modify re-send shows the adjustment note", () => {
    const upd = renderGamePlan({ name: "Sam", positioning: "", params: planParams(complete), email: "sam@example.com", note: "I adjusted where I'm looking." });
    expect(upd.html).toContain("I adjusted where I'm looking.");
    expect(EM_DASH.test(upd.html)).toBe(false);
  });
});

describe("renderGamePlan opener — titlecased greeting + no lowercase fragment (regression)", () => {
  // Real dossiers store strengths/proofs lowercase, and resume headers are often ALL CAPS. A naive
  // opener mashes the two into "Hi PRIYA, designed lumora's ..." (shouting name + subject-less fragment).
  const positioning = "designed lumora's invoicing flow for small shops, described as the team's first self-serve launch";
  const { html, text } = renderGamePlan({ name: "PRIYA", positioning, params: planParams(complete), email: "j@example.com" });
  it("titlecases a shouty ALL-CAPS first name in the greeting", () => {
    expect(text).toContain("Hi Priya");
    expect(text).not.toContain("PRIYA");
    expect(html).not.toContain("PRIYA");
  });
  it("never mashes the greeting onto a lowercase positioning ('Hi Name, designed ...')", () => {
    const FRAGMENT = /Hi [A-Za-z]+, [a-z]/; // greeting comma immediately followed by a lowercase word
    expect(FRAGMENT.test(text)).toBe(false);
    expect(FRAGMENT.test(html)).toBe(false);
  });
  it("leaves an already-cased name exactly as written (no over-normalizing)", () => {
    expect(renderGamePlan({ name: "Sam", positioning: "", params: {}, email: "s@example.com" }).text).toContain("Hi Sam");
    expect(renderGamePlan({ name: "McDonald", positioning: "", params: {}, email: "m@example.com" }).text).toContain("Hi McDonald");
  });
});

describe("the approve confirmation is gone, and a bare 'ok' is acknowledged silently", () => {
  // There is no separate "plan approved" email (it would only re-render the table the person just
  // read). The affirmation guard stays, because it keeps a stray one-word "ok" out of the preference
  // writeback.
  it("render-plan.mjs no longer exports a confirmation template", () => {
    expect(readFileSync(new URL("./render-plan.mjs", import.meta.url), "utf8")).not.toMatch(/export function renderPlanApproved/);
  });
  it("the server sends nothing on a bare affirmation", () => {
    const src = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");
    const branch = src.slice(src.indexOf('planOutcome?.kind === "acknowledged"'), src.indexOf('planOutcome?.kind === "modified"'));
    expect(branch).not.toMatch(/await send\(/);
    expect(branch).toMatch(/return;/);
  });
});

describe("applyPrefsOnly — the HONEST modify path (regression: no correction-lie, gaps untouched)", () => {
  it("writes only stated search params and NEVER appends a note-to-self to gaps", async () => {
    const dossier = { preferences: { role: "PM" }, gaps: ["a pre-existing gap"], strengths: ["x"], status: "active" };
    let saved = null;
    const r = await applyPrefsOnly("sam@example.com", "make it senior and remote only", {
      getDossier: async () => dossier,
      extractPrefs: async () => ({ seniority: "senior", remote: "remote" }),
      saveDossier: async (_e, d) => { saved = d; },
    });
    expect(r.changed.sort()).toEqual(["remote", "seniority"]);
    // applyEmailChange would push "correction flagged ..." into gaps and report "the fix you
    // flagged". applyPrefsOnly must do NEITHER.
    expect(saved.gaps).toEqual(["a pre-existing gap"]);
    expect(r.changed).not.toContain("the fix you flagged");
    expect(r.changed).not.toContain("what you shared about your work");
    expect(saved.preferences).toMatchObject({ role: "PM", seniority: "senior", remote: "remote" });
  });
  it("reports nothing changed when the reply states no parameter (caller then falls through)", async () => {
    const dossier = { preferences: { role: "PM" }, gaps: [], status: "active" };
    const r = await applyPrefsOnly("sam@example.com", "thanks!", {
      getDossier: async () => dossier,
      extractPrefs: async () => ({}),
      saveDossier: async () => { throw new Error("should not save when nothing changed"); },
    });
    expect(r.changed).toEqual([]);
  });
});
