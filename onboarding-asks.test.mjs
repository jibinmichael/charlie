// onboarding-asks.test.mjs — the onboarding gap ask must fit the person it is sent to.
//
// 1. LEVEL. `preferences.mode` is null for most users BY DESIGN (dossier.md tells the build to leave
// it null unless the signal is unambiguous). Gating the mode ask on its ABSENCE would ask "are you
// after an internship, your first full-time role, or a move?" of nearly everyone, including a
// 17-year product leader. A level assumption made from a missing field, contradicted by the person's
// own words, is a grounding failure, so the ask is phrased by the grounded classifier `levelOf`.
//
// 2. PUNCTUATION. Every template concatenates `${ask} Just reply, that's the whole reply.`, so an ask
// with no terminal punctuation renders as "...or a move from where you are now Just reply, ...".

import { describe, it, expect } from "vitest";
import { nextGap, askText } from "./email-onboard.mjs";
import { levelOf } from "./market-report.mjs";

// Only `mode` unset, so nextGap always resolves to the mode ask and we are testing IT.
const who = (prefs = {}, extra = {}) => ({
  headline: "Builds things",
  // seniority is a level-NEUTRAL filler ("open" matches no SELF_* pattern in levelOf): it satisfies
  // the seniority gap so `mode` is the gap under test, without deciding the level itself.
  preferences: { role: "Engineer", seniority: "open", remote: "remote", comp_floor: 10, dealbreakers: ["crypto"], motivation: "scope", mode: null, ...prefs },
  ...extra,
});

const askFor = (d) => {
  const g = nextGap(d);
  // Guard against a vacuous pass: if a DIFFERENT gap fires, a `not.toMatch(/internship/)`
  // assertion succeeds for the wrong reason.
  if (!g || g.key !== "mode") throw new Error(`fixture error: expected the mode gap, got "${g ? g.key : "none"}"`);
  return g.ask;
};

describe("the mode ask is level-aware — nobody is asked about an internship their own words contradict", () => {
  // Realistic specimens of senior people whose mode is unset.
  it("a 19-year operations leader is NOT asked about an internship", () => {
    const oakhaven = who({ role: "Operations leader" }, { headline: "Operations leader with 19+ years in hospital logistics and procurement" });
    expect(levelOf(oakhaven)).not.toBe("apm");
    expect(askFor(oakhaven)).not.toMatch(/internship/i);
    expect(askFor(oakhaven)).toMatch(/actively looking/i);
  });

  it("an 11-year hydrology survey lead is NOT asked about an internship", () => {
    const rivenmoor = who({ role: "Field hydrologist / Survey lead" }, { headline: "Hydrologist describing roughly 11 years in river and floodplain surveys" });
    expect(askFor(rivenmoor)).not.toMatch(/internship/i);
  });

  it("a 12-year senior geotechnical engineer and a 14-year senior actuary are NOT asked about an internship", () => {
    for (const h of ["Senior geotechnical engineer with 12 years in tunnelling projects", "Senior actuarial analyst with 14+ years pricing commercial property risk"]) {
      expect(askFor(who({}, { headline: h }))).not.toMatch(/internship/i);
    }
  });

  it("a director and a staff engineer are NOT asked about an internship", () => {
    expect(askFor(who({ seniority: "Director", role: "Director of Engineering" }))).not.toMatch(/internship/i);
    expect(askFor(who({ role: "Staff Engineer" }))).not.toMatch(/internship/i);
  });

  it("20 years of grounded professional_years alone is enough to suppress it", () => {
    expect(askFor(who({}, { headline: "Builds web apps", professional_years: 20 }))).not.toMatch(/internship/i);
  });
});

describe("the mode ask still reaches the people it was written for", () => {
  it("an intern, a fresher and an entry-level candidate DO get the internship wording", () => {
    for (const p of [{ seniority: "intern", role: "AI Developer Intern" }, { seniority: "Fresher", role: "Software developer" }, { seniority: "entry-level", role: "digital Marketing" }]) {
      expect(askFor(who(p))).toMatch(/internship/i);
    }
  });

  it("a current student with professional_years 0 gets the internship wording", () => {
    const student = who({}, { headline: "Third-year CS undergraduate", professional_years: 0 });
    expect(levelOf(student)).toBe("apm");
    expect(askFor(student)).toMatch(/internship/i);
  });

  it("a MID-level person (3 grounded years) does NOT get the internship wording", () => {
    const mid = who({}, { headline: "Builds web apps", professional_years: 3 });
    expect(levelOf(mid)).toBe("ic"); // mid, not entry — EARLY_LEVELS is apm only, on purpose
    expect(askFor(mid)).not.toMatch(/internship/i);
    expect(askFor(mid)).toMatch(/actively looking/i);
  });

  it("the question is always asked — only the WORDING changes, because the knockout gate needs the field", () => {
    for (const d of [who({ seniority: "intern" }), who({ seniority: "Director" })]) {
      expect(nextGap(d).key).toBe("mode");
      expect(askFor(d).length).toBeGreaterThan(10);
    }
  });
});

describe("every ask is a complete sentence — it is concatenated with 'Just reply' in the templates", () => {
  // The templates render `${ask} Just reply, that's the whole reply.` An ask with no terminal
  // punctuation runs straight into the next sentence. This walks EVERY ask, at every level, so a
  // newly added one cannot regress it. Prose is not enforcement; this is.
  const LEVEL_FIXTURES = [
    who({ seniority: "intern" }),
    who({ seniority: "Director" }),
    who({}, { headline: "Builds web apps", professional_years: 20 }),
  ];

  it("nextGap's ask always ends in terminal punctuation, whichever gap is next, at any level", () => {
    // Empty prefs -> walk the ladder by filling each key in turn, so every ask gets exercised.
    const KEYS = [
      ["role", "Engineer"], ["seniority", "senior"], ["mode", "active_switch"],
      ["remote", "remote"], ["comp_floor", 10], ["dealbreakers", ["crypto"]], ["motivation", "scope"],
    ];
    for (const base of LEVEL_FIXTURES) {
      const prefs = { role: null, seniority: null, mode: null, remote: null, comp_floor: null, dealbreakers: [], motivation: null };
      const d = { ...base, preferences: { ...prefs } };
      let seen = 0;
      for (const [k, v] of KEYS) {
        const g = nextGap(d);
        if (!g) break;
        expect(typeof g.ask, `ask for "${g.key}" must be a resolved string, never a function`).toBe("string");
        expect(g.ask, `ask for "${g.key}" must end in . ? or !`).toMatch(/[.?!]$/);
        seen++;
        d.preferences[k] = v;
      }
      expect(seen).toBeGreaterThanOrEqual(7); // every ask in the ladder was exercised
    }
  });

  it("reads as two sentences when the template concatenates it", () => {
    const rendered = `One quick thing before I go deep: ${askFor(who({ seniority: "Director" }))} Just reply, that's the whole reply.`;
    expect(rendered).not.toMatch(/now Just reply/); // the exact reported run-on
    expect(rendered).toMatch(/[.?!] Just reply/);
  });
});

describe("nextGap never leaks an unresolved function into a template", () => {
  it("returns a string ask even for the level-aware gap", () => {
    const g = nextGap(who({ seniority: "Director" }));
    expect(typeof g.ask).toBe("string");
    expect(g.ask).not.toMatch(/=>/);
  });

  it("askText tolerates a missing or malformed gap rather than throwing", () => {
    expect(askText(null, who())).toBe("");
    expect(askText({}, who())).toBe("");
    expect(askText({ ask: "plain." }, null)).toBe("plain.");
  });

  it("the level-aware ask does not throw on a null or empty dossier", () => {
    expect(() => nextGap(null)).not.toThrow();
    expect(() => nextGap({})).not.toThrow();
    expect(typeof nextGap({}).ask).toBe("string");
  });
});
