// leverage.test.mjs — where a person is MEMORABLE, not merely qualified.
//
// Everyone who applies meets the requirements; that is what makes them requirements. The bonus
// ("nice to have") list is the only place a candidate stands out, so it is kept from the posting.
//
// The weight of these tests is on SILENCE and on GROUNDING. A wrongly-claimed "you have done this" is
// worse than an invented deficiency, because the person will believe it about themselves and repeat
// it in an interview.
import { describe, it, expect } from "vitest";
import { parseBonuses, matchedBonuses, leverageFor, leverageLine, buildRarityIndex, rarityPct } from "./lib/leverage.mjs";

const person = {
  headline: "React developer",
  strengths: ["React", "cross-platform mobile"],
  proof_points: [{ claim: "built REST API integrations with token auth at a bank" }],
  preferences: { tech: ["JavaScript"] },
};

describe("parseBonuses", () => {
  it("keeps SHORT tech names — Go, QA and UX are real bonuses", () => {
    // A 3-char floor would silently drop every one of them.
    expect(parseBonuses("Nice to have: Go; QA; Kubernetes")).toEqual(["Go", "QA", "Kubernetes"]);
  });

  it("drops a LONE character, which is a bullet marker far more often than a skill", () => {
    // R and C lose out. That is the right side to err on: a fake bonus is a claim about what an
    // employer wants, invented by us.
    expect(parseBonuses("Nice to have: Go; R; -")).toEqual(["Go"]);
  });

  it("splits bullets, semicolons and comma-separated lines, dropping the heading", () => {
    expect(parseBonuses("Nice to have: Kubernetes; Terraform; Go")).toEqual(["Kubernetes", "Terraform", "Go"]);
    expect(parseBonuses("Bonus points: Rust, Elixir, a public portfolio")).toHaveLength(3);
  });

  it("returns nothing for an empty or junk section", () => {
    for (const bad of ["", null, undefined, "   ", 42]) expect(parseBonuses(bad)).toEqual([]);
  });
});

describe("a bonus matches ONLY on the person's own evidence", () => {
  it("matches a bonus they can actually point at", () => {
    const m = matchedBonuses(person, "Nice to have: REST API experience; Rust");
    expect(m).toHaveLength(1);
    expect(m[0].item).toContain("REST API");
  });

  it("folds plurals, because 'REST APIs' and 'REST API' are the same thing", () => {
    expect(matchedBonuses(person, "Nice to have: Experience using REST APIs")).toHaveLength(1);
  });

  it("requires EVERY token, so a half-match is never printed as a whole one", () => {
    // They have Kubernetes nowhere; "Kubernetes and React" must not match on React alone.
    expect(matchedBonuses(person, "Nice to have: Kubernetes and React")).toEqual([]);
  });

  it("claims NOTHING for a person with no record", () => {
    for (const empty of [{}, null, undefined, { strengths: "not an array" }]) {
      expect(matchedBonuses(empty, "Nice to have: React")).toEqual([]);
    }
  });

  it("never matches on words the job supplies rather than the person", () => {
    // "experience", "strong", "working" appear in almost every posting. If they counted, every person
    // would "have" every bonus.
    expect(matchedBonuses({ headline: "experience working strong team" }, "Nice to have: strong experience working in a team")).toEqual([]);
  });
});

describe("the line that reaches a person", () => {
  it("states counts and their own words, and nothing else", () => {
    const l = leverageLine(person, { nice_to_have: "Nice to have: fintech; REST API experience; Rust" });
    expect(l.text).toBe("They listed 3 bonuses. You have done one of them: REST API experience.");
  });

  it("carries NO percentage — rarity measures spelling, not scarcity", () => {
    // Spelling variants of one concept (restful/rest/api/apis, kubernetes/k8s) differ in frequency by
    // more than an order of magnitude. "Only 0.09% of postings ask for REST"
    // would be false about the market and true only about the word — and a person would repeat it in
    // an interview.
    const idx = buildRarityIndex([{ nice_to_have: "Nice to have: REST API experience" }]);
    const l = leverageLine(person, { nice_to_have: "Nice to have: REST API experience" }, idx);
    expect(l.text).not.toMatch(/%|percent|rare|only \d/i);
  });

  it("is SILENT when nothing matches, rather than reporting a score against them", () => {
    // "You evidence 0 of 6" is a verdict on someone, not information.
    expect(leverageLine(person, { nice_to_have: "Nice to have: Rust; Elixir" })).toBeNull();
    expect(leverageLine(person, { nice_to_have: "" })).toBeNull();
    expect(leverageLine({}, { nice_to_have: "Nice to have: React" })).toBeNull();
  });

  it("caps how many it lists, so the line stays a line", () => {
    const many = { ...person, strengths: ["Go", "Rust", "Kotlin", "Swift", "Scala"] };
    const l = leverageLine(many, { nice_to_have: "Nice to have: Go; Rust; Kotlin; Swift; Scala" });
    expect(l.text.split(";").length).toBeLessThanOrEqual(3);
  });
});

describe("the rarity index is measured but walled off", () => {
  it("counts bonus lists, not the whole pool", () => {
    const idx = buildRarityIndex([{ nice_to_have: "Nice to have: Go" }, { description: "no bonus" }, { nice_to_have: "Bonus: Go, Rust" }]);
    expect(idx.docs).toBe(2);
    expect(rarityPct("go", idx)).toBe(100);
  });

  it("returns null for a term never seen, rather than claiming 0%", () => {
    expect(rarityPct("cobol", buildRarityIndex([{ nice_to_have: "Nice to have: Go" }]))).toBeNull();
    expect(rarityPct("go", { docs: 0, df: {} })).toBeNull();
  });

  it("leverageFor still exposes it for measurement, so the wall is a CHOICE not an accident", () => {
    const idx = buildRarityIndex([{ nice_to_have: "Nice to have: REST API experience" }]);
    expect(leverageFor(person, { nice_to_have: "Nice to have: REST API experience" }, idx).rarestPct).toBeGreaterThan(0);
  });
});
