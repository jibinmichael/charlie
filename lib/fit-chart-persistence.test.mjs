// fit-chart-persistence.test.mjs — the fit chart must not vanish for reasons that aren't about the person.
//
// Two properties of the same section of the same email:
//
//   1. PERSISTED. `cov` is the most expensive thing a run produces (a Sonnet call in fit-coverage.mjs).
//      `finds` has no column for it and fit-coverage.mjs has no cache, so the scheduler stores it on
//      the find as `composed._cov`; otherwise any later re-render loses the chart.
//
//   2. AN ERROR IS NOT A VAGUE POSTING. A failed coverage call returns reason "error", never the
//      `{thin:true, reason:"jd"}` used for "this posting is too short to score". Otherwise a transient
//      API blip silently deletes the chart and is indistinguishable from the employer writing a thin JD.
//
// THE FLOOR: the chart still hides when coverage is genuinely un-scoreable — a profile too sparse to
// judge or a posting that states no requirements. Rendering it anyway would mean inventing which
// requirements the person meets, which this product will not do. A thin coverage must NEVER render a
// chart.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readoutStatus } from "../render-email.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

describe("the expensive coverage is persisted, so a re-render keeps the chart", () => {
  it("the scheduler stores _cov on the find alongside the composed copy", () => {
    // Without this, a re-rendered email loses its chart.
    const s = read("scheduler.mjs");
    // Asserts the INTENT (fields spread + _cov persisted), not the exact object literal: the send write
    // must carry the composer fields AND the coverage; extra keys beside them (e.g. `_decision`) are fine.
    expect(s).toMatch(/composed: \{ \.\.\.fields,[^}]*_cov: cov \?\? null/);
  });

  it("_cov is namespaced so nothing mistakes it for a composer field", () => {
    // `composed` is read by digest.mjs (digest_reason), the renderer (named fields) and hasFitContent.
    // A leading underscore says "not the composer's" to a human; the tests below say it to the code.
    expect(read("scheduler.mjs")).toMatch(/_cov/);
  });

  it("a stored THIN coverage still hides the chart — no fabricated readout", () => {
    // The floor. If the stored coverage was un-scoreable, re-rendering must not invent one.
    expect(readoutStatus({ thin: true, reason: "jd" }, "short jd")).toBe("hidden:cov_thin");
    expect(readoutStatus({ thin: true, reason: "error" }, "short jd")).toBe("hidden:cov_thin");
    expect(readoutStatus(null, "short jd")).toBe("hidden:cov_thin");
    // and a real one still shows
    expect(readoutStatus({ thin: false, coverage: [{ req: "React", status: "met" }], composite: 72 }, "a jd")).toBe("shown");
  });

  it("an older find (no _cov) degrades to prose rather than erroring", () => {
    // Older finds lack _cov. Destructuring an absent key must be harmless.
    const { _cov: storedCov, ...fields } = { subject: "s", why_you: "w" };
    const cov = storedCov && storedCov.thin === false ? storedCov : { thin: true };
    expect(storedCov).toBeUndefined();
    expect(readoutStatus(cov, "jd")).toBe("hidden:cov_thin");
    expect(fields).toEqual({ subject: "s", why_you: "w" }); // the copy is untouched
  });
});

describe("an errored coverage call is never mistaken for a vague posting", () => {
  const fit = () => read("fit-coverage.mjs");

  it("retries once before giving up", () => {
    // One transient blip must not be enough to delete the chart from someone's email.
    const s = fit();
    expect(s).toMatch(/for \(let attempt = 1; attempt <= 2; attempt\+\+\)/);
    expect(s).toMatch(/if \(attempt === 1\) await new Promise/);
  });

  it("returns reason 'error', not 'jd', when the call itself failed", () => {
    const s = fit();
    expect(s).toMatch(/return \{ thin: true, reason: "error", error: e\.message \}/);
    // the catch must not return the posting-too-short value
    const cat = s.match(/\} catch \(e\) \{[\s\S]*?return \{ thin: true[^\n]*\n/);
    expect(cat[0]).not.toMatch(/reason: "jd"/);
  });

  it("keeps the un-scoreable REASONS distinct, because their fixes are opposite", () => {
    // dossier -> gateRole DROPS the role (we cannot judge fit; the completeness nudge takes over)
    // jd      -> the employer wrote too little; the matcher bar carries the send
    // error   -> OUR failure; same fate as jd so the user is not punished, but counted and alarmed
    const s = fit();
    for (const r of ['reason: "dossier"', 'reason: "jd"', 'reason: "error"']) expect(s).toContain(r);
  });

  it("'error' does not change the send fate — only the visibility", () => {
    // quality-gate 2c drops only on "dossier". If "error" ever started dropping, an API blip would
    // silently stop sending roles instead of silently dropping a chart.
    const qg = read("quality-gate.mjs");
    expect(qg).toMatch(/cov\?\.thin && cov\.reason === "dossier"/);
    expect(qg).not.toMatch(/cov\.reason === "error"/);
  });

  it("no send path swallows a coverage failure into an anonymous thin", () => {
    // A bare `.catch(() => ({ thin: true }))` is a thin with no reason, which the census below cannot
    // attribute and a human cannot debug.
    for (const f of ["scheduler.mjs", "first-role.mjs", "match-one.mjs"]) {
      const s = read(f);
      expect(s, `${f} must not swallow coverage into an anonymous thin`).not.toMatch(/\.catch\(\(\) => \(\{ thin: true \}\)\)/);
      expect(s, `${f} must name the reason`).toMatch(/\.catch\(\(e\) => \(\{ thin: true, reason: "error"/);
    }
  });
});

describe("the chart's render rate is a number, not a hunch", () => {
  const s = () => read("scheduler.mjs");

  it("counts why the readout did or did not render, by reason", () => {
    expect(s()).toMatch(/const readoutCensus = \{\}/);
    expect(s()).toMatch(/readoutCensus\[cov\?\.thin \? `\$\{fitStatus\}:\$\{cov\.reason \|\| "unspecified"\}` : fitStatus\]/);
  });

  it("puts it in the KPI snapshot, so it is a trend and not one log line", () => {
    // A platform log vanishes when its retention window rolls.
    expect(s()).toMatch(/fit_readout: readoutCensus/);
    expect(s()).toMatch(/coverage_errors: coverageErrors/);
  });

  it("alarms on a coverage ERROR, because that one is ours to fix", () => {
    const cap = s().match(/captureError\([^;]*kind: "coverage_error"[^;]*\);/);
    expect(cap).not.toBeNull();
    expect(cap[0]).toMatch(/without its fit chart/);
  });

  it("names the reason in the email-trust line too", () => {
    expect(s()).toMatch(/fit=\$\{fitStatus\}\$\{cov\?\.thin && cov\.reason \? `\(\$\{cov\.reason\}\)` : ""\}/);
  });
});
