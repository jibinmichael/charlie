// emails/dash-gate.test.mjs — the enforcement layer for the no-dash rule: never ship an em OR en dash.
//
// Three gates must strip the same characters: `esc()` (HTML bodies), `cleanSubject()` (headers) and
// `lintMessage` (lib/convo-lint.mjs, the v2 send gate). The copy fed to these templates is partly
// model-written (`strength` comes from the dossier's proof points; `changedText` from
// applyEmailChange), and the lifecycle templates do not go through the lint, so a dash the model emits
// can only be stopped here at render. On the lint-gated v2 path an unstripped dash would make the lint
// reject the message and cost the person the grounded onboarding question.
//
// These tests pin the character class, not the prose. A prompt can ask the model for no dashes; only
// this layer can guarantee it.

import { describe, it, expect } from "vitest";
import * as kit from "../email-kit.mjs";
import { esc, cleanSubject, deDash, renderPrefsUpdated, renderWelcome, renderInterroTurn, renderHiringReport } from "../email-kit.mjs";
import { lintMessage } from "../lib/convo-lint.mjs";

const EM = "—"; // U+2014
const EN = "–"; // U+2013
const DASHES = [["em", EM], ["en", EN]];

describe("esc — strips BOTH dashes (the gap that shipped an en dash to real users)", () => {
  it.each(DASHES)("converts a spaced %s dash to a comma", (_n, d) => {
    expect(esc(`owned payments ${d} end to end`)).toBe("owned payments, end to end");
  });

  it.each(DASHES)("converts an UNSPACED %s dash too (models write it closed-up)", (_n, d) => {
    // The live eval's real specimen was `different—maybe`, with no surrounding spaces.
    expect(esc(`different${d}maybe`)).toBe("different, maybe");
  });

  it.each(DASHES)("leaves no %s dash anywhere in the output", (_n, d) => {
    expect(esc(`a ${d} b${d}c ${d} d`)).not.toMatch(/[—–]/);
  });

  it("still escapes HTML (the dash strip did not displace esc's real job)", () => {
    expect(esc('<b>&"')).toBe("&lt;b&gt;&amp;&quot;");
  });

  it("leaves an ordinary hyphen alone (a hyphen is not a dash — never over-strip)", () => {
    expect(esc("full-time, end-to-end")).toBe("full-time, end-to-end");
  });
});

// RANGES SURVIVE. An en dash is the NATURAL range character, so a naive strip would turn "2020–2024"
// into "2020, 2024" (a tenure into a list) and "grew ARR 20–30%" into "20, 30%". Restating a metric is
// the one thing this product must never do to someone's facts. The sweep below checks that NO dash
// survives, and a mangled range has no dash left in it: "no dash" and "still true" are different
// properties, and these cases pin the second one.
describe("deDash — a numeric range stays a range (never restate a person's facts)", () => {
  it.each([
    ["2020–2024", "2020-2024", "en-dash tenure (the natural range character)"],
    ["2020—2024", "2020-2024", "em-dash tenure"],
    ["20–30%", "20-30%", "a metric range"],
    ["grew ARR 20–30%", "grew ARR 20-30%", "a metric range in prose"],
    ["50–100 employees", "50-100 employees", "a headcount range"],
    ["2020 – 2024", "2020-2024", "a spaced range"],
  ])("%s -> %s (%s)", (input, expected) => {
    expect(deDash(input)).toBe(expected);
    expect(esc(input)).toBe(expected); // esc must inherit it, not re-implement it
    expect(cleanSubject(input)).toBe(expected);
  });

  it("the carve-out runs FIRST — order is load-bearing, not incidental", () => {
    // If the prose strip ran first it would eat the dash and leave "2020, 2024"; the range would be
    // unrecoverable by the time the numeric rule looked at it.
    expect(deDash("2020–2024")).not.toContain(", ");
  });

  it("still kills a prose dash sitting next to a range (the carve-out is narrow, not a loophole)", () => {
    expect(deDash("at Acme 2020–2024 – I owned payments")).toBe("at Acme 2020-2024, I owned payments");
  });

  it("a non-numeric range still becomes a comma (matches resume-pdf.tsx; prose dashes are the AI tell)", () => {
    expect(deDash("Series A–B")).toBe("Series A, B");
  });

  // KNOWN LIMIT, pinned deliberately so it is a decision and not a surprise. The carve-out needs a
  // digit on BOTH sides, so a unit/currency-suffixed range still commas out. This matches
  // resume-pdf.tsx's rule exactly, and widening it here alone would put the two out of sync.
  // Acceptable because every PERSON-fact range is covered above (tenure "2020–2024", metric "20–30%")
  // — this case is a COMPANY fact (funding), not a claim about the person, and
  // prompts/company-research.mjs already forbids it from being a range at the source.
  // If a real send ever shows "$10M, $20M", widen BOTH this and resume-pdf.tsx together.
  it("KNOWN LIMIT: a currency-suffixed range still commas out (company fact, not a person fact)", () => {
    expect(deDash("$10M–$20M")).toBe("$10M, $20M");
  });

  it("no range survives with an em/en dash still in it", () => {
    for (const s of ["2020–2024", "20–30%", "$10M–$20M"]) expect(deDash(s)).not.toMatch(/[—–]/);
  });
});

// Dashes reach the reader through real templates, so pin it there too, not just on the helper.
describe("a range survives rendering intact, in html AND text", () => {
  it("renderPrefsUpdated keeps a tenure range (model-written changedText)", () => {
    const m = renderPrefsUpdated({ email: "a@b.com", changedText: "at Acme 2020–2024" });
    expect(m.html).toContain("2020-2024");
    expect(m.text).toContain("2020-2024");
    expect(m.html).not.toContain("2020, 2024");
    expect(m.text).not.toContain("2020, 2024");
  });

  it("renderWelcome keeps a metric range (strength comes from the dossier)", () => {
    const m = renderWelcome({ email: "a@b.com", name: "Maya", strength: "grew ARR 20–30%" });
    expect(m.html).toContain("20-30%");
    expect(m.text).toContain("20-30%");
  });

  it("renderInterroTurn keeps a range in a generated question", () => {
    const m = renderInterroTurn({ email: "a@b.com", name: "Maya", first: true, question: "you were there 2020–2024, is staff the aim" });
    expect(m.html).toContain("2020-2024");
    expect(m.text).toContain("2020-2024");
  });
});

describe("cleanSubject — same class as esc (subjects bypass esc entirely)", () => {
  it.each(DASHES)("strips a %s dash from a subject line", (_n, d) => {
    expect(cleanSubject(`Got it ${d} that's in`)).toBe("Got it, that's in");
  });
});

// The three gates must agree. If one widens or narrows alone, a dash slips through whichever surface
// that gate owns: esc → HTML bodies, cleanSubject → headers, lintMessage → the v2 send gate.
describe("the three dash gates agree", () => {
  it.each(DASHES)("a %s dash is caught by esc, cleanSubject, AND lintMessage", (_n, d) => {
    expect(esc(`a ${d} b`)).not.toMatch(/[—–]/);
    expect(cleanSubject(`a ${d} b`)).not.toMatch(/[—–]/);
    const r = lintMessage({ subject: "Got it", text: `you owned payments${d}end to end. what next? no rush.` });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("em-dash");
  });
});

// Model-written copy (`changedText`, `strength`) reaching a real inbox.
describe("no lifecycle template ships a dash from model-written copy", () => {
  const dirty = (d) => `owned payments${d}end to end`;

  it.each(DASHES)("renderPrefsUpdated (changedText, %s dash) — SHIPPED BEFORE", (_n, d) => {
    const m = renderPrefsUpdated({ email: "a@b.com", changedText: dirty(d) });
    expect(m.html).not.toMatch(/[—–]/);
    expect(m.text).not.toMatch(/[—–]/);
    expect(cleanSubject(m.subject)).not.toMatch(/[—–]/);
  });

  it.each(DASHES)("renderWelcome (strength, %s dash) — SHIPPED BEFORE", (_n, d) => {
    const m = renderWelcome({ email: "a@b.com", name: "Maya", strength: dirty(d) });
    expect(m.html).not.toMatch(/[—–]/);
    expect(m.text).not.toMatch(/[—–]/);
  });

  it.each(DASHES)("renderInterroTurn (generated question, %s dash) — html AND text", (_n, d) => {
    const m = renderInterroTurn({ email: "a@b.com", name: "Maya", first: true, strength: dirty(d), question: `are you aiming at staff${d}or lead` });
    expect(m.html).not.toMatch(/[—–]/);
    expect(m.text).not.toMatch(/[—–]/);
  });

  // rolePhrase/regionHook deliberately skip esc() (regionHook carries the rust-bold markup). Both are
  // hardcoded in announce-hiring.mjs, so this is latent, not live — pinned so it stays that way.
  it.each(DASHES)("renderHiringReport (un-esc'd rolePhrase + regionHook, %s dash)", (_n, d) => {
    const m = renderHiringReport({ email: "a@b.com", name: "Maya", rolePhrase: `in design${d}mostly`, regionHook: `<b>the door${d}barely open</b>`, reality: dirty(d), chartLabel: dirty(d) });
    expect(m.html).not.toMatch(/[—–]/);
    expect(m.text).not.toMatch(/[—–]/);
  });

  it("regionHook's intentional markup still renders as HTML (de-dashing must not escape it)", () => {
    const m = renderHiringReport({ email: "a@b.com", name: "Maya", regionHook: "<b>the remote door is narrow:</b> only 4 in 100" });
    expect(m.html).toContain("<b>the remote door is narrow:</b>"); // tags survive, not printed as text
    expect(m.html).not.toContain("&lt;b&gt;");
  });
});

// The sweep over every exported template. A per-template list goes stale the moment someone adds a
// template; this fails on the NEXT one automatically.
describe("NO exported lifecycle template ships a dash, from any copy field (sweep)", () => {
  const names = Object.keys(kit).filter((k) => /^render/.test(k) && typeof kit[k] === "function");

  it("finds every render* export (guard against the sweep silently covering nothing)", () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it.each(DASHES)("no template leaks a %s dash through any known copy field", (_n, d) => {
    const dirty = `alpha${d}beta`;
    // Spray the dirty value through every plausible copy field; templates ignore what they don't take.
    const args = { email: "a@b.com", name: "Maya", strength: dirty, changedText: dirty, question: dirty,
                   rolePhrase: dirty, reality: dirty, regionHook: dirty, chartLabel: dirty, ask: dirty, note: dirty };
    const leaks = [];
    for (const n of names) {
      let m;
      try { m = kit[n](args); } catch { continue; } // a template needing a different shape isn't a leak
      if (!m || typeof m !== "object") continue;
      for (const part of ["html", "text", "subject"]) {
        if (typeof m[part] === "string" && /[—–]/.test(m[part])) leaks.push(`${n}.${part}`);
      }
    }
    expect(leaks, `templates shipping a dash: ${leaks.join(", ")}`).toEqual([]);
  });
});

// On the v2 path the dash is cleaned at render, so the warm grounded question survives and still
// clears the lint.
describe("a dashed question now survives the v2 lint instead of being downgraded", () => {
  it.each(DASHES)("the real eval specimen with a %s dash clears the lint", (_n, d) => {
    const m = renderInterroTurn({
      email: "a@b.com",
      name: "Maya",
      first: true,
      question: `or are you thinking something different${d}maybe design systems full-time`,
    });
    const r = lintMessage({ subject: m.subject, text: m.text });
    expect(r.ok, JSON.stringify(r.violations)).toBe(true);
  });
});
