// say-name.test.mjs — the greeting must not shout somebody's name or look like nobody read it.

import { describe, it, expect } from "vitest";
import { sayName } from "./say-name.mjs";

describe("names typed in one case throughout", () => {
  it("stops the greeting shouting", () => {
    expect(sayName("PRIYA")).toBe("Priya");
    expect(sayName("ARJUN KUMAR MEHTA")).toBe("Arjun Kumar Mehta");
  });

  it("stops it looking like nobody looked", () => {
    expect(sayName("farhan ali")).toBe("Farhan Ali");
    expect(sayName("meera")).toBe("Meera");
  });
});

describe("names it must not touch", () => {
  // The whole risk of a helper like this is that it "corrects" names that were already right.
  it("leaves a mixed-case name exactly as the person wrote it", () => {
    for (const n of ["McDonald", "de Souza", "van der Berg", "O'Brien", "DeShawn", "LaKeisha"]) {
      expect(sayName(n)).toBe(n);
    }
  });

  it("keeps initials as initials", () => {
    expect(sayName("JP Nair")).toBe("JP Nair");
    expect(sayName("K V Raman")).toBe("K V Raman");
  });

  it("survives nothing at all", () => {
    expect(sayName("")).toBe("");
    expect(sayName(null)).toBe("");
    expect(sayName(undefined)).toBe("");
  });
});

// The rule is per NAME, not per token, and this is why.
describe("the rule is per name, not per token", () => {
  it("does not capitalise particles inside an already mixed-case name", () => {
    // A per-token rule sees "van" and "der" as lower case in isolation and title-cases both.
    expect(sayName("van der Berg")).toBe("van der Berg");
    expect(sayName("Ludwig van Beethoven")).toBe("Ludwig van Beethoven");
  });

  it("still normalises a name with no case information in it at all", () => {
    expect(sayName("ARJUN KUMAR MEHTA")).toBe("Arjun Kumar Mehta");
    expect(sayName("farhan ali")).toBe("Farhan Ali");
  });

  it("keeps initials upper when the whole name was shouted", () => {
    expect(sayName("JP NAIR")).toBe("JP Nair");
  });
});
