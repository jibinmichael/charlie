// emails/welcome-thin.test.mjs — the thin-dossier honesty gate must change the welcome.
//
// isThinDossier() feeds `thin` into renderWelcome (server/charlie-remote.ts). A person with a skeletal
// resume must not be told "I've read your background, and I know what to look for". The snapshot suite
// renders the welcome with only ONE value of `thin`, so it cannot see whether the parameter is read:
// these tests assert the output CHANGES with it.

import { describe, it, expect } from "vitest";
import { renderWelcome } from "../email-kit.mjs";
import { isThinDossier } from "../email-onboard.mjs";

const base = { email: "sam@example.com", name: "Sam" };
const thin = (o = {}) => renderWelcome({ ...base, thin: true, ...o });
const rich = (o = {}) => renderWelcome({ ...base, thin: false, ...o });

describe("renderWelcome — the thin variant is genuinely different", () => {
  it("thin and rich differ in html, text AND subject (the exact bug that shipped)", () => {
    const t = thin({ strength: "shipped the checkout redesign" });
    const r = rich({ strength: "shipped the checkout redesign" });
    expect(t.html).not.toBe(r.html);
    expect(t.text).not.toBe(r.text);
    expect(t.subject).not.toBe(r.subject);
  });

  // The engine runs on an operator-started schedule, so no variant may name a delivery time
  // ("within minutes") the engine cannot hit.
  it("NEITHER variant promises a role 'within minutes' (the engine runs weekly)", () => {
    for (const [label, m] of [["thin", thin()], ["rich", rich()]]) {
      expect(m.html, `${label} html`).not.toMatch(/within minutes/i);
      expect(m.text, `${label} text`).not.toMatch(/within minutes/i);
      expect(m.html, `${label} preheader`).not.toMatch(/lands the moment one clears your bar/i);
    }
  });

  it("the rich variant still says WHEN, so the honest wait is stated and not silent", () => {
    const r = rich();
    expect(r.html).toMatch(/every Monday/i);
    expect(r.text).toMatch(/every Monday/i);
  });

  it("the thin variant names the same cadence without promising a result", () => {
    const t = thin();
    expect(t.text).toMatch(/every Monday/i);
    expect(t.text).not.toMatch(/you'll hear from me/i); // no outcome promised on a thin profile
  });

  it("the thin variant never claims to know what to look for", () => {
    const t = thin();
    expect(t.html).not.toMatch(/I know what to look for/i);
    expect(t.text).not.toMatch(/I know what to look for/i);
  });

  it("the thin variant says so honestly, without blaming the person", () => {
    const t = thin();
    expect(t.text).toMatch(/thinner than I'd like/i);
    // Never punitive: the shortfall is Charlie's picture, not the person's worth.
    expect(t.text).not.toMatch(/\b(you (didn'?t|failed|should have)|incomplete|insufficient|not enough about you)\b/i);
  });

  it("the thin variant does not lead with a strength it should not lean on", () => {
    // A thin dossier has < 2 proof points by definition; leading with one over-weights it.
    const t = thin({ strength: "shipped the checkout redesign" });
    expect(t.html).not.toMatch(/earns a second read/i);
  });

  it("both variants stay on the email design contract", () => {
    for (const m of [thin(), rich({ strength: "built the payments flow" })]) {
      expect(m.html).not.toMatch(/—/);            // no em dashes in email copy
      expect(m.text).not.toMatch(/—/);
      expect(m.html).toContain("/unsubscribe?");  // one-click unsubscribe present
      expect(m.html).toContain("Sanchez");
    }
  });

  it("the ask still rides on the thin variant (a thin profile is exactly when we need the reply)", () => {
    const t = thin({ ask: "remote, a city, or either?" });
    expect(t.html).toMatch(/remote, a city, or either\?/);
  });
});

// The gate is only real if the thing computing `thin` agrees with the thing rendering it.
describe("isThinDossier — the signal feeding the gate", () => {
  const proof = (claim) => ({ claim, evidence: claim, source: "resume" });

  it("a skeletal dossier is thin", () => {
    expect(isThinDossier({ proof_points: [], preferences: {} })).toBe(true);
    expect(isThinDossier(null)).toBe(true);
    expect(isThinDossier({})).toBe(true);
  });

  it("a resume with real proof points AND an aim is not thin", () => {
    expect(isThinDossier({
      proof_points: [proof("built the payments flow"), proof("shipped checkout redesign")],
      headline: "Senior Engineer",
      preferences: { remote: "remote, India" },
    })).toBe(false);
  });

  it("proof points alone are not enough — with no role or region we cannot aim", () => {
    expect(isThinDossier({
      proof_points: [proof("built the payments flow"), proof("shipped checkout redesign")],
      preferences: {},
    })).toBe(true);
  });

  it("an aim alone is not enough — with no evidence we have nothing to match on", () => {
    expect(isThinDossier({ proof_points: [], headline: "Senior Engineer", preferences: { remote: "remote" } })).toBe(true);
  });
});
