// greeting-name.test.mjs — the greeting name (lib/say-name.mjs). The first token of the raw name field
// shouts at one person, mumbles at another, and greets a third by a single letter.
import { describe, it, expect } from "vitest";
import { sayName, greetingName } from "./say-name.mjs";
import { renderRoleMatch } from "../email-kit.mjs";

// the naive approach: esc(name.trim().split(/\s+/)[0])
const oldWay = (n) => String(n || "").trim().split(/\s+/)[0] || "";

describe("greetingName", () => {
  it("fixes the case the naive greeting shouted or mumbled", () => {
    expect(oldWay("ANANYA RAO")).toBe("ANANYA");
    expect(greetingName("ANANYA RAO")).toBe("Ananya");
    expect(oldWay("rohan das")).toBe("rohan");
    expect(greetingName("rohan das")).toBe("Rohan");
  });

  it("refuses a lone initial rather than greeting a letter", () => {
    expect(oldWay("K V Arun")).toBe("K");        // "K," in the first line of the mail
    expect(greetingName("K V Arun")).toBe("");
    expect(oldWay("S RT M ORAN")).toBe("S");
    expect(greetingName("S RT M ORAN")).toBe("");
  });

  it("leaves a name the person case-styled themselves alone", () => {
    expect(greetingName("Leela Menon C.P")).toBe("Leela");
    expect(greetingName("de Souza Marta")).toBe("de");  // sayName does not touch mixed case
    expect(greetingName("Vikram")).toBe("Vikram");
  });

  it("has no opinion when there is no name", () => {
    expect(greetingName("")).toBe("");
    expect(greetingName(null)).toBe("");
  });
});

describe("the role email uses it", () => {
  const job = { title: "Senior Product Designer", company: "Dispatch", apply_url: "https://x.test/1", location: "Remote" };
  const base = { email: "a@b.test", quote: "I rebuilt the billing flow", why: "You have done this work.", job };

  it("greets with a sayable name", () => {
    expect(renderRoleMatch({ ...base, name: "rohan das" }).html).toContain("Rohan,");
  });

  it("falls back to 'Hi.' rather than greeting an initial", () => {
    const html = renderRoleMatch({ ...base, name: "S RT M ORAN" }).html;
    expect(html).toContain("Hi.");
    expect(html).not.toContain("S RT M");
  });
});
