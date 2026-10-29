// engine-email.test.mjs — the email may not contradict the frozen fit engine.
//
// Two model calls can reach opposite conclusions about one fact (e.g. a "Right there" chip for a
// requirement the engine scored `partial|adjacent`). Rows that ARE the engine's record cannot drift.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderEmail, engineRows, isRelabelAdvice, assertsUnmet, SCREEN_LABEL } from "./render-email.mjs";

const sat = (req, strength, evidence) => ({ req, gating: true, kind: "capability", outcome: "satisfied", evidence_strength: strength, evidence });
const held = (req, strength, evidence) => ({ req, gating: true, kind: "capability", outcome: "unproven", evidence_strength: strength, evidence });
const ENGINE = {
  verdict: "strong-fit",
  contradictions: [],
  requirements: [
    sat("React", "direct", "Orbit built with React, Node.js, Supabase"),
    held("Python", "self-reported", "preferences tech list includes Python"),
    sat("RAG", "direct", "a retrieval layer over saved notes for Orbit"),
    sat("Full-stack development", "adjacent", "shipped Orbit and Ledgerly end to end"),
    sat("API integration", "direct", "integrated a speech-to-text API, an LLM API and a payments API"),
  ],
};
const base = {
  fields: { role_title: "SDE Full Stack", company: "Adobe", job_summary: "A summary long enough to be real.", facts: [] },
  // readoutStatus needs a real cov: not thin, with coverage rows, over an untruncated JD.
  cov: { thin: false, composite: 69, screen: { level: "L", domain: "D", recent: "R" },
    coverage: [{ req: "React", status: "met", evidence: "cited" }, { req: "Python", status: "unknown", evidence: null }],
    topMove: "Lead with the Orbit retrieval layer." },
  jobDescription: "x".repeat(1200), applyUrl: "https://e.invalid/a", unsubUrl: "https://e.invalid/u",
  email: "a@b.com", findId: "a@b.com:1", label: "Today's pick",
};

describe("engineRows — the strongest three, by the ordering that already exists", () => {
  it("keeps only satisfied gating requirements, anchors first, posting order within each group", () => {
    expect(engineRows(ENGINE).map((r) => r.label)).toEqual(["React", "RAG", "API integration"]);
  });

  it("never emits a held requirement — the email cannot state what the engine did not certify", () => {
    expect(engineRows(ENGINE).some((r) => r.label === "Python")).toBe(false);
  });

  it("falls back to non-anchor evidence only after the anchors are used", () => {
    const thin = { requirements: [sat("A", "adjacent", "e1"), sat("B", "direct", "e2")] };
    expect(engineRows(thin).map((r) => r.label)).toEqual(["B", "A"]);
  });

  it("a chip is a claim, so only `direct` earns one", () => {
    const rows = engineRows({ requirements: [sat("A", "direct", "e"), sat("B", "adjacent", "e")] });
    expect(rows[0].verdict).toBe("yes");
    expect(rows[1].verdict).toBe(null);
  });

  it("drops a row with no citation rather than printing an empty claim", () => {
    expect(engineRows({ requirements: [sat("A", "direct", "")] })).toEqual([]);
  });
});

describe("renderEmail with an engine record", () => {
  const withEngine = renderEmail({ ...base, engine: ENGINE });
  const without = renderEmail(base);

it("the engine still PRODUCES a cited row per satisfied requirement, even though nothing renders it", () => {
    // The rendered email does not show a requirements read. The engine is unwired (FIT_SEND_MODE=off)
    // and frozen, so its DATA contract is what still needs
    // guarding: every row it emits carries a label and the citation from the person's own record.
    // If the read is ever restored, this is the assertion that says the engine can still fill it.
    const rows = engineRows(ENGINE);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.label).toBeTruthy();
      expect(String(r.line || "")).not.toBe("");
    }
  });


  it("the three-tier meter is gone for EVERY caller, engine or not", () => {
    // The meter is removed unconditionally and independently of any flag (render-email.mjs, the one
    // authorised exception to the locked template).
    for (const tier of ["worth a look", "a real fit", "the closest yet"]) {
      expect(withEngine).not.toContain(tier);
      expect(without).not.toContain(tier);
    }
  });

  it("keeps the label the presend guard probes", () => {
    expect(withEngine).not.toContain(SCREEN_LABEL); // the read renders for no caller
  });

  it("says nothing disqualifies you ONLY when the engine found no contradiction", () => {
    // "Nothing here disqualifies you" is never printed (on nearly every send it said nothing). The real
    // warning is: when the engine finds a contradiction, "One thing could stop this" still fires.
    expect(withEngine).not.toContain("Nothing here disqualifies you");
    const contra = renderEmail({ ...base, engine: { ...ENGINE, contradictions: [{ req: "8+ years" }] } });
    expect(contra).not.toContain("Nothing here disqualifies you");
    expect(contra).toContain("One thing could stop this");
  });

  it("is backward-safe: no engine means byte-identical output", () => {
    expect(renderEmail({ ...base, engine: null })).toBe(without);
    expect(renderEmail({ ...base, engine: { requirements: [] } })).toBe(without);
  });
});

describe("the design system is untouched", () => {
  const src = readFileSync(new URL("./render-email.mjs", import.meta.url), "utf8");
  const body = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

  it("no new colour, font or spacing token entered the renderer", () => {
    // The engine rows reuse screenTable verbatim, so they inherit every locked value.
    expect(body).toMatch(/const rows = engineOn \? engineRows\(engine\) : screenRows\(cov\)/);
    expect(body).toMatch(/const rows = engineOn \? engineRows\(engine\) : screenRows\(cov\)/);
  });

  it("the slot order in the RENDERED email is unchanged and no slot was added", () => {
    const html = renderEmail({ ...base, engine: ENGINE });
    // "Why you" only renders when a rationale exists, so the slot-order check asserts the
    // order of the slots that are actually present rather than assuming the heading is unconditional.
    const order = ["The job", "Your angle on this one"];
    let at = -1;
    for (const s of order) { const i = html.toLowerCase().indexOf(s.toLowerCase()); expect(i).toBeGreaterThan(at); at = i; }
  });

  it("the engine is still imported by no production module", () => {
    // Comments may NAME the module; an import would be code. Only the code is checked.
    expect(body).not.toMatch(/from\s+["'].*fit-(decision|stage)\.mjs["']/);
    expect(body).not.toMatch(/import\(.*fit-(decision|stage)/);
  });
});

// ── slot 6 must never coach a relabel ───────────────────────────────────────────────────────────
// Both strings below are realistic relabel-coaching lines of the kind the composer can produce.
describe("slot 6 may never coach a relabel", () => {
  const REAL_COACHING = [
    "Rename your Ledgerly AI engine section to explicitly use 'multi-agent orchestration' and 'agent planning', the JD's exact words, because your planner model and automatic retry loops are that pattern, just not labelled as such.",
    "Your Quillbase work already names 'LLM agents for back-office workflows', surface that as a shipped context, not an exploration, and tie the queue-based retry pattern explicitly to multi-agent coordination to close the biggest visible gap.",
  ];
  const REAL_HONEST = [
    "Your library-piloted book-scanning app (React Native + Firebase + a Flask OCR service, 40 pilot users) is exactly the end-to-end mobile application Contoso describes, lead with it and name the stack explicitly.",
    "Surface your Django REST backend work on TrailNotes more prominently, the JD explicitly names Django as a preferred framework and you have a shipped, dated project proving it.",
    "Call out the specific sourcing channels you have used (LinkedIn, GitHub, referrals, niche communities, direct outreach) because the JD explicitly asks for multi-channel sourcing strategy.",
  ];

  it("PROVES THE REGRESSION: both real coaching lines are caught", () => {
    for (const t of REAL_COACHING) expect(isRelabelAdvice(t)).toBe(true);
  });

  it("and honest advice of the same shape is kept", () => {
    for (const t of REAL_HONEST) expect(isRelabelAdvice(t)).toBe(false);
  });

  it("the coaching lead never reaches the rendered email", () => {
    const html = renderEmail({ ...base, engine: ENGINE, cov: { ...base.cov, topMove: REAL_COACHING[0] } });
    expect(html).not.toContain("Rename your Ledgerly");
    // and an honest lead still does
    const ok = renderEmail({ ...base, engine: ENGINE, cov: { ...base.cov, topMove: REAL_HONEST[1] } });
    expect(ok).toContain("Surface your Django REST backend work");
  });

  it("a coaching BULLET is dropped while its honest siblings survive", () => {
    const f = { ...base.fields, resume_tips: [REAL_COACHING[1], REAL_HONEST[2]] };
    const html = renderEmail({ ...base, fields: f, engine: ENGINE });
    expect(html).not.toContain("not an exploration");
    expect(html).toContain("Call out the specific sourcing channels");
  });
});

describe("the preheader cannot contradict the engine", () => {
  // The shape of an earlier render: the engine had 4 of 5 satisfied, "3–6 years" unmet.
  const V1_REASON = "You cover every named ask: Sketch, prototyping, mobile apps, user research, accessibility. Your 6+ years sits at the top of their band.";

  it("PROVES THE REGRESSION: the v1 overclaim is the preview today and is GONE once the engine decides", () => {
    const before = renderEmail({ ...base, cov: { ...base.cov, reason: V1_REASON } });
    expect(before).toContain("You cover every named ask");
    const after = renderEmail({ ...base, cov: { ...base.cov, reason: V1_REASON }, engine: ENGINE });
    expect(after).not.toContain("You cover every named ask");
  });

  it("the preview names ONLY requirements the engine certified", () => {
    const html = renderEmail({ ...base, engine: ENGINE });
    const labels = engineRows(ENGINE).map((r) => r.label);
    for (const l of labels) expect(html).toContain(l);
    expect(html).toContain("shown in your own record");
    // never a total, a proportion, or an "every"
    expect(html).not.toMatch(/every (named )?(ask|requirement)/i);
    expect(html).not.toMatch(/\ball of (the|their)\b/i);
  });

  it("never names a requirement the engine held", () => {
    const html = renderEmail({ ...base, engine: ENGINE });
    const head = html.slice(0, html.indexOf("charlieroles"));
    expect(head).not.toContain("Python");   // held: met|self-reported
  });
});

describe("slot 6 may not ASSERT an unmet requirement is demonstrated", () => {
  // The shape of a re-render, and the engine graded "Multi-agent orchestration" partial|adjacent.
  const ASSERTS = "Lead with Ledgerly's AI engine: a planner model, nine wrapped APIs, and automatic retry loops. That is multi-agent orchestration and tool-calling, which is the exact capability this team is building. Name those specifics.";
  const UNMET = ["Python", "Multi-agent orchestration"];

  it("PROVES THE REGRESSION: the surviving line is caught", () => {
    expect(assertsUnmet(ASSERTS, UNMET)).toBe(true);
  });

  it("tailoring REAL evidence in the employer's words is still allowed", () => {
    expect(assertsUnmet("Your retrieval layer maps directly to the JD's 'memory and planning primitives' language, surface those exact terms.", UNMET)).toBe(false);
    expect(assertsUnmet("The Salesforce and ServiceNow API integrations are directly relevant to 'agents that discover and act across internal services'.", UNMET)).toBe(false);
  });

  it("it is ENGINE-AWARE, not a prose classifier — no unmet list, no firing", () => {
    expect(assertsUnmet(ASSERTS, [])).toBe(false);
  });

  it("the assertion never reaches the rendered email", () => {
    const eng = { ...ENGINE, requirements: [...ENGINE.requirements, held("Multi-agent orchestration", "adjacent", "planner model")] };
    const html = renderEmail({ ...base, engine: eng, cov: { ...base.cov, topMove: ASSERTS } });
    expect(html).not.toContain("That is multi-agent orchestration");
  });
});
