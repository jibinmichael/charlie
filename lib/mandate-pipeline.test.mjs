// mandate-pipeline.test.mjs — regression tests for the mandate scoring pipeline.
//
// Each case pins a failure a passing run would not show: pedigree reaching the model, a model that
// does not know the date, a reply that drops a criterion, markdown that Notion renders literally.

import { describe, it, expect } from "vitest";
import { MANDATES, pedigreeQuestions, MONEY_RE, MONEY_COLUMNS, SHARE_CONSENT_QUESTION, maxScore } from "./mandates.mjs";
import { buildMandateScoreMessages } from "../prompts/mandate-score.mjs";
import { mandateScoreSchema } from "./schemas/mandate-score.mjs";
import { markdownToBlocks } from "./notion.mjs";

const M = MANDATES.initech;
const keys = M.criteria.map((c) => c.key);

describe("pedigree never reaches the model", () => {
  it("marks the pedigree facts on every mandate", () => {
    // Each mandate demands pedigree and the rubric forbids it from moving a score. The resolution is
    // to withhold it structurally, so at least one fact per mandate must be flagged.
    for (const m of Object.values(MANDATES)) {
      expect(pedigreeQuestions(m).length, `${m.key} has no pedigree fact flagged`).toBeGreaterThan(0);
    }
    expect(pedigreeQuestions(MANDATES.initech)).toContain("Where did you study?");
    expect(pedigreeQuestions(MANDATES.northwind)).toContain("What is your degree in?");
  });

  it("keeps university, years and compensation out of the assembled prompt", () => {
    // The prompt also tells the model to ignore pedigree, but prose is not enforcement: a fact the
    // model cannot see cannot leak into a judgement.
    const answers = {
      "Which frameworks have you shipped production code in?": "Vue and React",
      "Where did you study?": "Anna University",
      "Total years of professional experience": "9",
      "Expected annual CTC in INR": "4500000",
    };
    const withheld = new Set([...pedigreeQuestions(M), ...Object.keys(answers).filter((q) => MONEY_RE.test(q))]);
    const kept = Object.fromEntries(Object.entries(answers).filter(([q]) => !withheld.has(q)));
    const content = buildMandateScoreMessages({ mandate: M, name: "A", answers: kept, today: "2026-08-22" })[0].content;

    expect(content).toContain("frameworks have you shipped");
    expect(content).not.toContain("Anna University");
    expect(content).not.toContain("4500000");
  });
});

describe("the model is told what day it is", () => {
  // Without today's date the model reads a recent past date as a "future end date" and doubts the
  // applicant's honesty, so it must never be asked to reason about dates without one.
  it("refuses to build a request without today's date", () => {
    expect(() => buildMandateScoreMessages({ mandate: M, name: "A", answers: {} }))
      .toThrow(/today.*required/i);
  });

  it("states today's date in the request", () => {
    const content = buildMandateScoreMessages({ mandate: M, name: "A", answers: {}, today: "2026-08-22" })[0].content;
    expect(content).toContain("Today is 2026-08-22");
  });
});

describe("model output is validated before it can describe a person", () => {
  const Schema = mandateScoreSchema(keys);
  const good = {
    criteria: keys.map((key) => ({ key, level: "some", evidence: "e", source: "application", confidence: "high" })),
    discrepancies: [],
    strongest_evidence: "s", evidence_gaps: "g", why: "w",
  };

  it("accepts a complete reply", () => {
    expect(Schema.safeParse(good).success).toBe(true);
  });

  it("rejects a criterion the mandate never defined", () => {
    const bad = { ...good, criteria: [...good.criteria, { key: "invented", level: "strong", evidence: "e", source: "application", confidence: "high" }] };
    expect(Schema.safeParse(bad).success).toBe(false);
  });

  it("rejects a reply that silently drops a criterion", () => {
    // A missing criterion is not a shorter answer: the rollup would score it zero and nobody would
    // see that a dimension went unreviewed.
    const bad = { ...good, criteria: good.criteria.slice(1) };
    const res = Schema.safeParse(bad);
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error.issues)).toMatch(/missing criterion/);
  });

  it("rejects a level that is not one of the four", () => {
    // "unverifiable" implies a link was fetched. On these mandates nothing is fetched, so claiming a
    // failed verification would be a lie.
    const bad = { ...good, criteria: good.criteria.map((c, i) => (i ? c : { ...c, level: "unverifiable" })) };
    expect(Schema.safeParse(bad).success).toBe(false);
  });
});

describe("scoring arithmetic is in code, not in the model", () => {
  it("computes each mandate's maximum from its own weights", () => {
    expect(maxScore(MANDATES.northwind)).toBe(36);
    expect(maxScore(MANDATES.globex)).toBe(39);
    expect(maxScore(MANDATES.initech)).toBe(36);
  });

  it("gives every criterion a weight and a tier", () => {
    for (const m of Object.values(MANDATES)) {
      for (const c of m.criteria) {
        expect(c.weight, `${m.key}.${c.key}`).toBeGreaterThan(0);
        expect(["must-have", "good-to-have", "how-they-work"]).toContain(c.tier);
        expect(c.looks_like.length, `${m.key}.${c.key} has no evidence description`).toBeGreaterThan(30);
      }
    }
  });
});

describe("consent and board wiring", () => {
  it("keeps one consent question, and it is the employer-sharing one", () => {
    // The talent-pool question is a different consent and must never be mistaken for this one.
    expect(SHARE_CONSENT_QUESTION).toMatch(/share your Charlie profile with the employer/i);
    expect(SHARE_CONSENT_QUESTION).not.toMatch(/talent pool/i);
  });

  it("gives every mandate its own board", () => {
    const ids = Object.values(MANDATES).map((m) => m.databaseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of Object.values(MANDATES)) expect(m.databaseId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("names the compensation columns beside the mandates", () => {
    // The loader depends on these exact names; a rename would fail rows silently.
    expect(MONEY_COLUMNS.current).toMatch(/as entered/);
    expect(MONEY_COLUMNS.expected).toMatch(/as entered/);
  });

  it("gives every recorded fact a board column", () => {
    for (const m of Object.values(MANDATES)) {
      for (const f of m.facts) expect(f.column, `${m.key}.${f.key} has no column`).toBeTruthy();
    }
  });
});

describe("markdown reaches Notion as Notion meant it", () => {
  it("turns italics into an annotation rather than literal asterisks", () => {
    // Notion escapes a stray asterisk instead of dropping it, so an unhandled *(good to have)* was
    // reaching readers as \*(good to have)\*.
    const [b] = markdownToBlocks("Cloud *(good to have)* here");
    const parts = b.paragraph.rich_text;
    expect(parts.some((p) => p.annotations.italic && p.text.content === "(good to have)")).toBe(true);
    expect(parts.map((p) => p.text.content).join("")).not.toContain("*");
  });

  it("builds a table without its separator row", () => {
    const [t] = markdownToBlocks("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(t.type).toBe("table");
    expect(t.table.table_width).toBe(2);
    expect(t.table.children).toHaveLength(2); // header + one row, never the |---|---| line
  });

  it("keeps an escaped pipe inside a cell", () => {
    const [t] = markdownToBlocks("| A | B |\n|---|---|\n| one \\| two | 2 |");
    expect(t.table.children[1].table_row.cells[0][0].text.content).toBe("one | two");
  });

  it("splits text longer than Notion's per-object limit instead of truncating it", () => {
    const [b] = markdownToBlocks("x".repeat(4500));
    const joined = b.paragraph.rich_text.map((r) => r.text.content).join("");
    expect(joined).toHaveLength(4500);
    expect(b.paragraph.rich_text.every((r) => r.text.content.length <= 2000)).toBe(true);
  });
});

describe("the candidate ask can only say something true", () => {
  it("gives every must-have a candidate-facing phrasing", () => {
    // `looks_like` is reviewer prose — "rather than that they were near it" reads as a slight when
    // the person it describes reads it back. Only `ask` may reach an email, so every must-have needs
    // one or that criterion can never be asked about.
    for (const m of Object.values(MANDATES)) {
      for (const c of m.criteria.filter((x) => x.tier === "must-have")) {
        expect(c.ask, `${m.key}.${c.key} has no candidate-facing ask`).toBeTruthy();
        expect(c.ask.length, `${m.key}.${c.key} ask is too short to answer`).toBeGreaterThan(25);
      }
    }
  });

  it("keeps judgement language out of the candidate-facing phrasing", () => {
    // The reviewer needs to know what does NOT count. The candidate does not, and reading it hurts.
    for (const m of Object.values(MANDATES)) {
      for (const c of m.criteria) {
        if (!c.ask) continue;
        expect(c.ask, `${m.key}.${c.key}`).not.toMatch(/rather than|not just|merely|fail|weak|lack|bare keyword|does not establish/i);
      }
    }
  });

  it("asks in the second person, so it reads as a question to them", () => {
    for (const m of Object.values(MANDATES)) {
      for (const c of m.criteria.filter((x) => x.ask)) {
        expect(c.ask, `${m.key}.${c.key} is written about them, not to them`).toMatch(/\byou\b|\byour\b/i);
      }
    }
  });
});
