// claim-context.test.mjs — the claim-context check (lib/claim-context.mjs) produces a QUESTION, and
// these tests stop it becoming a verdict: a claim that is unusual for the kind of company it was made
// at is worth asking about, never grounds to reject.

import { describe, it, expect } from "vitest";
import { claimContextFlags } from "./claim-context.mjs";

const at = (companyType, text, companyName = "Acme") => claimContextFlags({ companyType, companyName, text });

describe("it flags the unusual pairing", () => {
  it("an A/B test claimed at an agency", () => {
    const f = at("agency", "I ran a closed A/B test on the live app and lifted checkout conversion 12%.");
    expect(f).toHaveLength(1);
    expect(f[0].why).toMatch(/production access/);
  });

  it("roadmap ownership claimed at a services company", () => {
    expect(at("services", "I owned the product roadmap for the platform.")).toHaveLength(1);
  });

  it("quotes the person verbatim, so a human sees what triggered it", () => {
    const f = at("agency", "Across the engagement I ran an A/B test on their checkout, which was novel for us.");
    expect(f[0].claim).toContain("A/B test");
  });
});

describe("it stays silent when it should", () => {
  it("the same claim at a product company is not remarkable", () => {
    expect(at("product", "I ran a closed A/B test on the live app.")).toHaveLength(0);
    expect(at("startup", "I owned the product roadmap.")).toHaveLength(0);
    expect(at("enterprise", "I owned the P&L.")).toHaveLength(0);
  });

  it("an unclassified employer is unclassified, not suspicious", () => {
    expect(at(null, "I ran a closed A/B test on the live app.")).toHaveLength(0);
    expect(at("unknown", "I ran a closed A/B test on the live app.")).toHaveLength(0);
  });

  it("no claim means nothing to ask", () => {
    expect(at("agency", "")).toHaveLength(0);
    expect(at("agency", "I designed brand systems for six clients.")).toHaveLength(0);
  });
});

describe("it can never become a verdict", () => {
  it("never says the person is lying, exaggerating or unqualified", () => {
    const f = at("agency", "I ran an A/B test and owned the roadmap and moved retention 20%.");
    for (const x of f) {
      const all = `${x.why} ${x.question}`;
      // WORD BOUNDARIES, because a substring match finds "lie" inside "client-side" and fails against
      // copy that is completely fine. An over-eager check that fails on
      // correct output is the same defect as one that passes bad output.
      expect(all).not.toMatch(/\b(lie|lying|lied|false|exaggerat\w*|fabricat\w*|dishonest|unqualified|reject\w*|weak)\b/i);
    }
  });

  it("always offers the benign reading", () => {
    const f = at("services", "I owned the product roadmap.");
    expect(f[0].question).toMatch(/there is usually a good answer/i);
  });

  it("asks at most two things, because five is an interrogation", () => {
    const many = "I ran an A/B test, owned the roadmap, owned the P&L, improved retention, and shipped to production.";
    expect(at("agency", many).length).toBeLessThanOrEqual(2);
  });
});
