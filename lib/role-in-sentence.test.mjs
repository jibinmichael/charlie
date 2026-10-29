// lib/role-in-sentence.test.mjs — a role title inside an email sentence keeps its acronyms.
// Lowercasing the whole title would write "a senior j2ee developer role" into a subject line.
import { describe, it, expect } from "vitest";
import { roleInSentence, renderRoleIntent, renderIntentQuestions } from "../email-kit.mjs";

describe("roleInSentence", () => {
  it("lowercases ordinary words and keeps acronyms and multi-capital names", () => {
    expect(roleInSentence("Senior J2EE Developer")).toBe("senior J2EE developer");
    expect(roleInSentence("AI Product Manager")).toBe("AI product manager");
    expect(roleInSentence("Associate Product Manager - Hardware")).toBe("associate product manager - hardware");
    expect(roleInSentence("Account Executive")).toBe("account executive");
    expect(roleInSentence("iOS Engineer")).toBe("iOS engineer");
  });

  it("the role emails carry it in the subject and the body", () => {
    const m = renderRoleIntent({ email: "a@example.com", name: "Asha", roleTitle: "Senior J2EE Developer", city: "Bengaluru", whatItIs: "A role.", because: "you built X", bar: "Java", questionCount: "four", proof: "their own work" });
    expect(m.subject).toMatch(/senior J2EE developer role/);
    expect(m.text).not.toMatch(/j2ee/);
    const q = renderIntentQuestions({ email: "a@example.com", name: "Asha", roleTitle: "Senior J2EE Developer", city: "Bengaluru", questions: ["One?"] });
    expect(q.text).toMatch(/the senior J2EE developer role/);
  });
});
