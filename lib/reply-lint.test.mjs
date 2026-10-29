// lib/reply-lint.test.mjs — the pre-send gate for replies.
//
// The test that matters most is the LAST describe block: it runs the lint against renderAck, the
// generic acknowledgement, and shows it failing. If reply-lint cannot catch renderAck, it is
// decoration.

import { describe, it, expect } from "vitest";
import { lintReply, MAX_WORDS, VOICE_TICS } from "./reply-lint.mjs";
import { lintMessage } from "./convo-lint.mjs";
import { replyFor } from "./reply-intent.mjs";
import { INTENTS } from "./schemas/inbound-intent.mjs";
import { renderAck, renderAskAnswerAck } from "../email-kit.mjs";

const person = { email: "someone@example.com", name: "Bram Okonjo" };
const every = () => INTENTS
  .map((intent) => ({ intent, r: replyFor({ intent, quote: "I have 12 years, not 4" }, person) }))
  .filter(({ r }) => r.message);

describe("every reply this module can produce passes its own lint", () => {
  for (const { intent, r } of every()) {
    it(`${intent}`, () => {
      const quote = ["consent_grant", "dispute"].includes(intent) ? "I have 12 years, not 4" : "";
      const out = lintReply({ subject: r.message.subject, text: r.message.text, html: r.message.html, quote });
      expect(out.violations, JSON.stringify(out.violations)).toEqual([]);
      expect(out.ok).toBe(true);
    });
  }
});

describe("the two rule sets are genuinely different, not a rename", () => {
  // If these passed convo-lint too, this whole module would be pointless indirection. They must NOT:
  // convo-lint demands exactly one question mark and a costless-exit phrase in every message, which
  // is precisely the scaffolding this work exists to stop bolting onto answers.
  it("the replies FAIL convo-lint's conversational rules, and that is the point", () => {
    for (const { intent, r } of every()) {
      const conv = lintMessage({ subject: r.message.subject, text: r.message.text });
      expect(conv.ok, `${intent} unexpectedly satisfies convo-lint`).toBe(false);
      const rules = conv.violations.map((v) => v.rule);
      expect(rules.some((x) => x === "question-count" || x === "no-costless-exit")).toBe(true);
    }
  });

  it("but they PASS convo-lint's honesty half, which reply-lint reuses", () => {
    for (const { intent, r } of every()) {
      const universal = lintMessage({ subject: r.message.subject, text: r.message.text, conversational: false });
      expect(universal.ok, `${intent}: ${JSON.stringify(universal.violations)}`).toBe(true);
    }
  });
});

describe("the reply-specific rules each catch their own failure", () => {
  const ok = { subject: "Noted", text: "Hi Bram, noted, and thank you.", html: "<p>Hi Bram, noted.</p>" };

  it("no-headline: a reply carries no h1", () => {
    const out = lintReply({ ...ok, html: `<h1 style="font-size:23px;">Got it.</h1><p>Noted.</p>` });
    expect(out.violations.map((v) => v.rule)).toContain("no-headline");
  });

  it("no-eyebrow: a reply carries no uppercase label", () => {
    const out = lintReply({ ...ok, html: `<p style="text-transform:uppercase;">noted</p><p>Noted.</p>` });
    expect(out.violations.map((v) => v.rule)).toContain("no-eyebrow");
  });

  it("preferences-menu: the settings menu is never an answer", () => {
    const out = lintReply({ ...ok, text: "If you'd like to change the kind of role, your pay floor, or where you want to work, just tell me." });
    expect(out.violations.map((v) => v.rule)).toContain("preferences-menu");
  });

  it("too-long: Charlie's own words are capped", () => {
    const out = lintReply({ ...ok, text: `word `.repeat(MAX_WORDS + 5).trim() });
    expect(out.violations.map((v) => v.rule)).toContain("too-long");
  });

  it("too-long: but the person's own quoted words do not count against it", () => {
    // Somebody who writes carefully must not be the one who gets no answer.
    const quote = `detail `.repeat(MAX_WORDS + 20).trim();
    const out = lintReply({ ...ok, text: `Hi Bram, you have told me "${quote}". Noted.`, quote });
    expect(out.violations.map((v) => v.rule)).not.toContain("too-long");
  });

  it("voice-tic: one rhetorical move is fine, two is a format", () => {
    const one = lintReply({ ...ok, text: "I would rather ask than guess." });
    expect(one.violations.map((v) => v.rule)).not.toContain("voice-tic");
    const two = lintReply({ ...ok, text: "I would rather ask than guess, and I will come back to you." });
    expect(two.violations.map((v) => v.rule)).toContain("voice-tic");
  });

  it("mechanism-word: mechanism words never reach a person", () => {
    // "On your record" is mechanism language; a written rule does not stop it, this check does.
    for (const w of ["your record", "your dossier", "the screening", "your status"]) {
      const out = lintReply({ ...ok, text: `Hi Bram, nothing changed on ${w}.` });
      expect(out.violations.map((v) => v.rule), `"${w}" was allowed through`).toContain("mechanism-word");
    }
  });

  it("mechanism-word: the preheader is checked too, not just the body", () => {
    // The preheader is what shows in the inbox list and is the half a copy review reads last.
    const out = lintReply({ ...ok, preheader: "Nothing changed on your record. A person is checking." });
    expect(out.violations.map((v) => v.rule)).toContain("mechanism-word");
  });

  it("mechanism-word: caught in the HTML alone, which is the runtime path", () => {
    // At runtime a template returns { subject, html, text } and the preheader is buried in the html,
    // so this is the case that actually protects a real send. If only the explicit `preheader`
    // argument were checked, this rule would pass in tests and do nothing in production.
    const leaked = `<div style="display:none;">Nothing changed on your record.</div><p>Noted.</p>`;
    const out = lintReply({ subject: "Noted", text: "Hi Bram, noted.", html: leaked });
    expect(out.violations.map((v) => v.rule)).toContain("mechanism-word");
  });

  it("the honesty blocklist is still enforced through the reused gate", () => {
    const out = lintReply({ ...ok, text: "Last chance, only 2 spots left." });
    expect(out.ok).toBe(false);
    expect(out.violations.map((v) => v.kind)).toContain("honesty");
  });

  it("an em dash is still caught", () => {
    expect(lintReply({ ...ok, text: "Noted, and thank you, that helps." }).ok).toBe(true);
    expect(lintReply({ ...ok, text: "Noted — and thank you." }).violations.map((v) => v.rule)).toContain("em-dash");
  });
});

describe("PROVEN AGAINST THE COPY THAT ACTUALLY SHIPPED", () => {
  // renderAck must never answer a consent grant, a factual dispute or a plain "no". If the lint does
  // not reject it, the lint is not doing anything.
  it("renderAck fails reply-lint, and on the rule that names the defect", () => {
    const m = renderAck({ email: "someone@example.com" });
    const out = lintReply({ subject: m.subject, text: m.text, html: m.html });
    expect(out.ok).toBe(false);
    const rules = out.violations.map((v) => v.rule);
    expect(rules).toContain("preferences-menu");
    expect(rules).toContain("no-headline");
  });

  // A long acknowledgement in answer to a one-word "no".
  it("renderAskAnswerAck fails on length", () => {
    const m = renderAskAnswerAck({ email: "someone@example.com", name: "Bram Okonjo" });
    const out = lintReply({ subject: m.subject, text: m.text, html: m.html });
    expect(out.ok).toBe(false);
    expect(out.violations.map((v) => v.rule)).toContain("too-long");
  });

  it("the tic list was measured against the real file, not invented", () => {
    // Each pattern here was counted in email-kit.mjs. This asserts the list is non-trivial and that
    // the two most repeated constructions are in it.
    const rules = VOICE_TICS.map((t) => t.rule);
    expect(rules).toContain("tic-rather");
    expect(rules).toContain("tic-worth-your-time");
    expect(VOICE_TICS.length).toBeGreaterThanOrEqual(6);
  });
});
