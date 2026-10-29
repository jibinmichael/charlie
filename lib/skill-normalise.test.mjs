// skill-normalise.test.mjs — the rules in lib/skill-normalise.mjs that fold one skill's many spellings.
// They must never fold meaning.
import { describe, it, expect } from "vitest";
import { normaliseSkill, normaliseSkillList, attestedWords } from "./skill-normalise.mjs";

const att = attestedWords([
  "pipeline", "pipelines", "system", "systems", "interview", "interviews", "strategy", "strategies",
  "process", "processes", "kubernetes", "analyses", "devops", "analytics",
]);
const n = (s) => normaliseSkill(s, att);

describe("folds spelling", () => {
  it("collapses the eight spellings of one skill", () => {
    const forms = ["rag", "RAG", "retrieval-augmented generation", "retrieval augmented generation",
                   "retrieval-augmented generation (rag)", "RAG (Retrieval Augmented Generation)"];
    expect(new Set(forms.map(n)).size).toBe(1);
    expect(n(forms[2])).toBe("rag");
  });

  it("strips the words that grade a skill rather than name it", () => {
    expect(n("hands-on experience with Figma")).toBe("figma");
    expect(n("proficiency in Python")).toBe("python");
    expect(n("strong knowledge of SQL")).toBe("sql");
  });

  it("keeps compound names that are one skill", () => {
    expect(n("A/B testing")).toBe("a/b testing");
    expect(n("ab testing")).toBe("a/b testing");
    expect(n("UX/UI design")).toBe("ui/ux design");
    expect(n("CI/CD pipelines")).toBe("ci/cd");
  });

  it("folds a plural only onto a word somebody has written", () => {
    expect(n("rag pipelines")).toBe("rag pipeline");
    expect(n("user interviews")).toBe("user interview");
    // what this rule prevents: a general stemmer produces "kubernete" and "analys"
    expect(n("kubernetes")).toBe("kubernetes");
    expect(n("analyses")).toBe("analyses");
  });

  it("folds nothing when there is no attested vocabulary", () => {
    expect(normaliseSkill("rag pipelines")).toBe("rag pipelines");
  });
});

describe("never folds meaning", () => {
  it("keeps the head of a bracket, not the tool inside it", () => {
    // "wireframing (figma)" is wireframing; reducing it to "figma" deletes the skill
    expect(n("wireframing (figma)")).toBe("wireframing");
    expect(n("prototyping (Figma)")).toBe("prototyping");
    expect(n("accessibility (WCAG 2.1 AA)")).toBe("accessibility");
    // a comma list names tools and those are the searchable part; the string stays whole
    expect(n("CRM (Salesforce, HubSpot)")).toBe("crm (salesforce, hubspot)");
    expect(n("email deliverability (SPF, DKIM, DMARC)")).toBe("email deliverability (spf, dkim, dmarc)");
  });

  it("takes the bracket only when it restates the head as its own acronym", () => {
    expect(n("retrieval-augmented generation (rag)")).toBe("rag");
    expect(n("search engine optimization (seo)")).toBe("seo");
  });

  it("leaves different work apart", () => {
    expect(n("rag evaluation")).not.toBe(n("rag"));
    expect(n("llm fine-tuning")).not.toBe(n("llm evaluation"));
    expect(n("product design")).not.toBe(n("product strategy"));
  });

  it("survives empty and junk input", () => {
    expect(n("")).toBe("");
    expect(n(null)).toBe("");
    expect(n("   ")).toBe("");
  });
});

describe("normaliseSkillList", () => {
  it("gives a person who wrote a skill twice one skill", () => {
    expect(normaliseSkillList(["RAG", "rag pipelines", "Figma", "figma"], att))
      .toEqual(["rag", "rag pipeline", "figma"]);
  });

  it("preserves the order they wrote them in", () => {
    expect(normaliseSkillList(["SQL", "Python"], att)).toEqual(["sql", "python"]);
  });
});
