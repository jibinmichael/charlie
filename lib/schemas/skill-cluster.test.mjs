// lib/schemas/skill-cluster.test.mjs — the skill-merge rule. A model told that a qualifier is part of
// the skill can still fold "procurement workflow design" into "workflow design", so the rule is
// arithmetic here and cannot drift.
import { describe, it, expect } from "vitest";
import { mayFold, coerceClusters } from "./skill-cluster.mjs";

describe("mayFold", () => {
  it("allows a morphological variant", () => {
    expect(mayFold("product roadmap", "product roadmapping")).toBe(true);
    expect(mayFold("workflow optimization", "workflow optimisation")).toBe(true);
    expect(mayFold("data visualization", "data visualisation")).toBe(true);
  });

  it("allows glue words to differ", () => {
    expect(mayFold("data analytics", "data & analytics")).toBe(true);
    expect(mayFold("product roadmap", "product and roadmap")).toBe(true);
  });

  it("refuses a merge that strips a technology qualifier", () => {
    expect(mayFold("product management", "ai product management")).toBe(false);
    expect(mayFold("product design", "ai product design")).toBe(false);
    expect(mayFold("product development", "llm product development")).toBe(false);
  });

  it("refuses a merge that strips a market or domain qualifier", () => {
    expect(mayFold("product design", "b2b product design")).toBe(false);
    expect(mayFold("workflow design", "procurement workflow design")).toBe(false);
    expect(mayFold("workflow automation", "n8n workflow automation")).toBe(false);
    expect(mayFold("data pipeline", "etl/data pipeline")).toBe(false);
  });

  it("refuses a merge where the CANONICAL adds the qualifier", () => {
    // the asymmetric hole: the canonical adding a word is an upgrade, not a merge
    expect(mayFold("net revenue retention", "revenue retention")).toBe(false);
    expect(mayFold("customer retention", "retention")).toBe(false);
    expect(mayFold("windows server administration", "windows administration")).toBe(false);
    expect(mayFold("ai agent architecture", "agent architecture")).toBe(false);
    expect(mayFold("customer success management", "customer success")).toBe(false);
  });

  it("refuses an empty or unusable pair", () => {
    expect(mayFold("", "product design")).toBe(false);
    expect(mayFold("product design", "")).toBe(false);
  });
});

describe("coerceClusters enforces it", () => {
  const offered = new Set(["product management", "ai product management", "product roadmap", "product roadmapping"]);

  it("drops the qualifier member and keeps the real variant", () => {
    const r = coerceClusters({ groups: [
      { canonical: "product management", members: ["product management", "ai product management"] },
      { canonical: "product roadmap", members: ["product roadmap", "product roadmapping"] },
    ] }, offered);
    // the first group loses its only other member and so is no longer a group
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].canonical).toBe("product roadmap");
    expect(r.dropped).toBe(1);
  });

  it("still refuses a canonical name that was never offered", () => {
    const r = coerceClusters({ groups: [{ canonical: "invented skill", members: ["invented skill", "product roadmap"] }] }, offered);
    expect(r.groups).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});
