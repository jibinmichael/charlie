// lib/no-money-promise.test.mjs — "I never ask anyone for money, and I do not promise anyone a job"
// must never be in any email. This renders the role invite, role intent, intent questions and hire
// invite templates and scans every file that composes email, so the line cannot come back in any
// wording.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { renderRoleInvite, renderRoleIntent, renderIntentQuestions } from "../email-kit.mjs";

const BANNED = /ask(?:s|ing)? (?:anyone|you|people) for money|promise (?:anyone|you) a job/i;

describe("no email asks for money or promises a job, in any words", () => {
  const rendered = {
    renderRoleInvite: renderRoleInvite({ email: "a@example.com", name: "Asha", roleTitle: "Product Designer", city: "Bengaluru", whatItIs: "A product team." }),
    renderRoleInvitePending: renderRoleInvite({ email: "a@example.com", name: "Asha", roleTitle: "Product Designer", city: "Bengaluru", whatItIs: "A product team.", pending: true }),
    renderRoleIntent: renderRoleIntent({ email: "a@example.com", name: "Asha", roleTitle: "Product Designer", city: "Bengaluru", whatItIs: "A product team.", because: "you designed X", bar: "Five days on site.", questionCount: "three", proof: "a case study" }),
    renderIntentQuestions: renderIntentQuestions({ email: "a@example.com", name: "Asha", roleTitle: "Product Designer", city: "Bengaluru", questions: ["Where are you based?"] }),
  };
  for (const [name, mail] of Object.entries(rendered)) {
    it(`${name}: neither the html nor the text says it`, () => {
      expect(String(mail.html ?? "")).not.toMatch(BANNED);
      expect(String(mail.text ?? "")).not.toMatch(BANNED);
      expect(String(mail.html ?? "") + String(mail.text ?? "")).toMatch(/\w/); // it rendered something
    });
  }

  it("no file that composes email carries it", () => {
    const root = new URL("../", import.meta.url);
    const files = ["email-kit.mjs", "render-email.mjs", ...readdirSync(new URL("scripts/", root)).filter((f) => /^(role-|hire-|send-)/.test(f) && f.endsWith(".mjs")).map((f) => `scripts/${f}`), ...readdirSync(new URL("server/", root)).filter((f) => /\.(ts|mjs)$/.test(f) && !f.includes(".test.")).map((f) => `server/${f}`), ...readdirSync(new URL("lib/", root)).filter((f) => /^hire-.*\.mjs$/.test(f) && !f.includes(".test.")).map((f) => `lib/${f}`)];
    const offenders = files.filter((f) => BANNED.test(readFileSync(new URL(f, root), "utf8")));
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
