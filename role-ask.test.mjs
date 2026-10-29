// role-ask.test.mjs — the one grounded question, and the fit meter's unconditional removal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { askFor, isGroundedIn } from "./lib/role-ask.mjs";
import { roleAskMode, roleAskCohort, roleAskFor, ROLE_ASK_MODES } from "./lib/role-ask-flag.mjs";
import { renderEmail, SCREEN_LABEL } from "./render-email.mjs";

const ENV = ["ROLE_ASK", "ROLE_ASK_COHORT"];
const clear = () => ENV.forEach((k) => delete process.env[k]);
beforeEach(clear); afterEach(clear);

// Matcher text in the shape match_verdicts caches it.
const REAL_WARN = "On-call and incident response not mentioned in dossier";
const REAL_FLAG = "Resume shows personal projects and training, but no stated production deployments, on-call rotations, or incident postmortems—core to SRE work.";

describe("askFor asks only when there is a real unknown", () => {
  it("asks from a warn chip, quoting it verbatim", () => {
    const a = askFor({ chips: [{ kind: "warn", text: REAL_WARN }] });
    expect(a.source).toBe("chip");
    expect(a.span).toBe(REAL_WARN);
    expect(a.question).toContain(REAL_WARN);      // the specific half is the matcher's own words
    expect(isGroundedIn(a.question, { chips: [{ kind: "warn", text: REAL_WARN }] })).toBe(true);
  });

  it("falls back to the flag when there is no warn chip", () => {
    const a = askFor({ flag: REAL_FLAG, chips: [{ kind: "good", text: "strong tooling match" }] });
    expect(a.source).toBe("flag");
    expect(REAL_FLAG).toContain(a.span);           // a verbatim span, never a paraphrase
  });

  it("NO QUESTION when there is no meaningful uncertainty", () => {
    expect(askFor({ chips: [{ kind: "good", text: "everything lines up" }] })).toBe(null);
    expect(askFor({})).toBe(null);
    expect(askFor(null)).toBe(null);
    expect(askFor({ flag: "" })).toBe(null);
    expect(askFor({ flag: "short" })).toBe(null);
  });

  it("NEVER asks about a named dealbreaker — that is a known mismatch, not an unknown", () => {
    expect(askFor({ dealbreaker_hit: true, flag: REAL_FLAG, chips: [{ kind: "warn", text: REAL_WARN }] })).toBe(null);
  });

  it("NEVER asks a person to answer for the EMPLOYER's omission", () => {
    for (const f of [
      "Compensation is not posted; confirm it meets your INR 30 LPA floor",
      "The posting does not state remote eligibility or compensation",
      "Posting offers no compensation, remote/hybrid policy, or team size detail",
    ]) expect(askFor({ flag: f })).toBe(null);
  });

  it("NEVER asks about something already CONCLUDED", () => {
    expect(askFor({ flag: "Disqualifying experience gap: role mandates minimum 3 years full-time" })).toBe(null);
    expect(askFor({ flag: "The candidate clearly lacks any backend experience whatsoever" })).toBe(null);
  });

  it("CANNOT introduce an unsupported claim — every question is stem + a verbatim span", () => {
    const m = { chips: [{ kind: "warn", text: REAL_WARN }] };
    const a = askFor(m);
    const contributed = a.question.replace(a.span, "");
    // the only words this module adds contain no claim about the person
    expect(contributed).toBe("One thing I want to check: . Have you done this before? One line is plenty.");
    expect(contributed).not.toMatch(/you (lack|do not|don't|have no|are not)/i);
  });

  it("is PURE and DETERMINISTIC — same input, same output, no I/O", () => {
    const m = { chips: [{ kind: "warn", text: REAL_WARN }], flag: REAL_FLAG };
    expect(askFor(m)).toEqual(askFor(m));
    const src = readFileSync(new URL("./lib/role-ask.mjs", import.meta.url), "utf8");
    for (const f of [/await /, /import .*(store|anthropic|fetch)/i, /Math\.random/, /Date\.now/, /process\.env/])
      expect(src).not.toMatch(f);
  });
});

describe("the ROLE_ASK flag", () => {
  it("defaults to off, and every malformed value is off", () => {
    expect(roleAskMode()).toBe("off");
    for (const v of ["", " ", "true", "1", "yes", "ON!", "enabled"]) { process.env.ROLE_ASK = v; expect(roleAskMode()).toBe("off"); }
    expect(ROLE_ASK_MODES).toEqual(["off", "shadow", "on"]);
  });

  it("an EMPTY cohort is NOBODY, even on `on`", () => {
    process.env.ROLE_ASK = "on";
    for (const c of [undefined, "", " , , "]) {
      if (c === undefined) delete process.env.ROLE_ASK_COHORT; else process.env.ROLE_ASK_COHORT = c;
      expect(roleAskCohort().size).toBe(0);
      expect(roleAskFor("anyone@anywhere.com")).toBe("off");
    }
  });

  it("is per-person and case-insensitive", () => {
    process.env.ROLE_ASK = "on"; process.env.ROLE_ASK_COHORT = " Listed@X.COM ";
    expect(roleAskFor("listed@x.com")).toBe("on");
    expect(roleAskFor("other@x.com")).toBe("off");
    expect(roleAskFor("")).toBe("off");
  });

  it("shadow is a distinct state from on", () => {
    process.env.ROLE_ASK_COHORT = "a@b.com";
    process.env.ROLE_ASK = "shadow"; expect(roleAskFor("a@b.com")).toBe("shadow");
    process.env.ROLE_ASK = "on"; expect(roleAskFor("a@b.com")).toBe("on");
  });
});

describe("neither the rationale nor the read renders any more", () => {
  // The requirements read and the fit meter are not rendered in the email. The logic behind them still
  // runs: why_you is composed, grounding-verified, nulled by citeOrDrop when uncitable, and persisted;
  // cov is computed, gates send-vs-digest, and drives fitLane.
  const withReadout = {
    fields: { role_title: "Software Engineer", company: "Salesforce", job_summary: "A role.", why_you: "You have shipped exactly this." },
    cov: {
      thin: false, composite: 61, lane: "tune", reason: "you clear the core asks",
      coverage: [{ req: "Python", status: "met", evidence: "three years of it" }],
      screen: { level: "L", domain: "D", recent: "R" }, topMove: "lead with X",
    },
    jobDescription: "We need a senior engineer with Python. ".repeat(40),
    email: "x@example.com", findId: "x@example.com:job-1", unsubUrl: "https://e/u",
  };

  it("no Why you heading and no rationale text, even when a rationale exists", () => {
    const html = renderEmail(withReadout);
    expect(html).not.toContain("Why you");
    expect(html).not.toContain("You have shipped exactly this.");
  });

  it("no requirements read, and no heading for it", () => {
    const html = renderEmail(withReadout);
    expect(html).not.toContain(SCREEN_LABEL);
    expect(html).not.toContain("Right there");
  });

  it("the rest of the email still renders", () => {
    const html = renderEmail(withReadout);
    expect(html).toContain("The job");
    expect(html).toContain("Salesforce");
    expect(html).toContain("Your angle on this one");
  });
});

describe("the rendered email", () => {
  const base = {
    // why_you is present because most real sends carry it, and the "Why you" heading only renders
    // when there is a rationale under it.
    fields: { role_title: "R", company: "C", job_summary: "A summary long enough to be real.", facts: [], why_you: "You have done this exact work before." },
    cov: { thin: false, composite: 69, screen: { level: "L", domain: "D", recent: "R" },
           coverage: [{ req: "x", status: "met", evidence: "e" }], topMove: "lead with X" },
    jobDescription: "x".repeat(1200), applyUrl: "https://e.invalid/a", unsubUrl: "https://e.invalid/u",
    email: "a@b.com", findId: "a@b.com:1", label: "Today's pick",
  };

  it("THE FIT METER IS GONE, independently of ROLE_ASK", () => {
    for (const tier of ["worth a look", "a real fit", "the closest yet"]) {
      expect(renderEmail(base)).not.toContain(tier);
      expect(renderEmail({ ...base, askLine: "One thing I want to check: x. Have you done this before?" })).not.toContain(tier);
    }
    // The meter, the old label and the vacuous "Nothing here disqualifies you" line never render;
    // the job and the advice carry the email. Pinned so none can come back by accident.
    expect(renderEmail(base)).not.toContain("Why you");
    expect(renderEmail(base)).not.toContain("Opportunity Match");
    expect(renderEmail(base)).not.toContain("Nothing here disqualifies you");
  });

  it("no score of any kind replaces it", () => {
    const html = renderEmail(base);
    expect(html).not.toMatch(/\b\d{1,3}\s*(%|\/\s*100)\b/);
    expect(html).not.toMatch(/&#10047;/);                       // the florette glyph is gone
  });

  it("shadow/off render NO question; on renders it", () => {
    expect(renderEmail({ ...base, askLine: null })).not.toContain("One thing I want to check");
    const q = askFor({ chips: [{ kind: "warn", text: REAL_WARN }] }).question;
    expect(renderEmail({ ...base, askLine: q })).toContain(REAL_WARN);
  });

  it("everything else in the template survives", () => {
    const html = renderEmail({ ...base, askLine: "One thing I want to check: x. Have you done this before?" });
    for (const s of ["The job", "Your angle on this one"])
      expect(html.toLowerCase()).toContain(s.toLowerCase());
    expect(html).toMatch(/Today's pick/);
  });
});

describe("the wiring is confined and the reply path still falls through", () => {
  const sched = readFileSync(new URL("./scheduler.mjs", import.meta.url), "utf8");
  const inbound = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");

  it("scheduler computes the question from `match`, never from a model", () => {
    expect(sched).toMatch(/const ask = askMode === "off" \? null : askFor\(match\)/);
    expect(sched).toMatch(/askLine: askMode === "on" && ask \? ask\.question : null/);
  });

  it("the question is persisted with the send", () => {
    expect(sched).toMatch(/_ask: ask \? \{ \.\.\.ask, mode: askMode \} : null/);
  });

  it("inbound records the signal AND falls through to the grounded writeback", () => {
    const i = inbound.indexOf("role_question_answered");
    expect(i).toBeGreaterThan(-1);
    expect(inbound.slice(i, i + 600)).toMatch(/fall through to the grounded writeback/);
    // it must sit BEFORE the generic applyEmailChange routing, like the depth-question block
    expect(i).toBeLessThan(inbound.indexOf("about your last few roles"));
  });

  it("no matching logic was touched", () => {
    for (const f of ["lib/fit-decision.mjs", "lib/send-rule.mjs", "match-batch.mjs", "select-jobs.mjs", "quality-gate.mjs", "matcher.md"])
      expect(readFileSync(new URL(`./${f}`, import.meta.url), "utf8").includes("role-ask")).toBe(false);
  });
});
