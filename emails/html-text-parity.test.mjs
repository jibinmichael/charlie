// emails/html-text-parity.test.mjs — the HTML and the text halves must say the same thing.
//
// While the two halves can differ, every review of one of them is a review of a mail nobody
// receives: a paragraph removed from the text but left in the HTML still ships, to the half people
// actually read. So this compares them. Not word for word — the text half legitimately drops link
// markup, buttons and layout — but no SENTENCE may exist in one and not the other.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as kit from "../email-kit.mjs";
import * as F from "./fixtures.mjs";

/**
 * The BODY PARAGRAPHS of the HTML, which is where prose lives.
 *
 * Deliberately not "all visible text". The preheader, the eyebrow label, the headline and the
 * unsubscribe are structural — they are meant to differ between the two halves, and comparing them
 * produces noise that trains everyone to ignore this test. A <p> is where a sentence about a person
 * goes.
 */
const paragraphs = (html) =>
  [...String(html || "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(([, inner]) =>
      inner
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&#39;|&rsquo;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

// Stripping an inline tag leaves a space before the punctuation that followed it: `<b>story</b>,`
// becomes "story ,". That is an artefact of this test, not a difference between the two halves, so it
// is normalised away on both sides before anything is compared. Same for a possessive: a bolded
// company name renders `<b>Globex</b>'s` and strips to "globex 's".
const norm = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[’]/g, "'")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+('s\b)/g, "$1")
    .trim()
    .toLowerCase();

/** Sentences long enough to be a claim rather than a label or a button. */
const sentences = (s) =>
  norm(s)
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.split(" ").length >= 8);

// Rendered with real fixtures, so this checks the mails as they actually go out.
const CASES = [
  ["renderBreakingSilence (ask)", () => kit.renderBreakingSilence(F.BREAKING_SILENCE_ASK)],
  ["renderBreakingSilence (nothing needed)", () => kit.renderBreakingSilence(F.BREAKING_SILENCE_NO_ASK)],
  ["renderDecisionAsk", () => kit.renderDecisionAsk(F.DECISION_ASK)],
  ["renderCvRequest", () => kit.renderCvRequest(F.CV_REQUEST)],
  ["renderCheckinNoted", () => kit.renderCheckinNoted(F.CHECKIN_NOTED)],
  ["renderAnyCalls", () => kit.renderAnyCalls(F.ANY_CALLS)],
  ["renderAnyCalls (asking the stage)", () => kit.renderAnyCalls(F.ANY_CALLS_STAGE)],
  ["renderClientStatus", () => kit.renderClientStatus(F.CLIENT_STATUS)],
  ["renderClientStatus (they replied)", () => kit.renderClientStatus(F.CLIENT_STATUS_REPLIED)],
  ["renderClientReplyAck (to the board)", () => kit.renderClientReplyAck(F.CLIENT_REPLY_ACK)],
  ["renderClientReplyAck (record only)", () => kit.renderClientReplyAck(F.CLIENT_REPLY_ACK_RECORD)],
  ["renderClientReplyAck (nothing filed)", () => kit.renderClientReplyAck(F.CLIENT_REPLY_ACK_NONE)],
  // renderRoleInvite hand-writes its html and text separately, and its `years` line differs between
  // the two branches, so both are rendered here: the divergence this file exists for is exactly the
  // kind a conditional paragraph introduces.
  ["renderRoleInvite", () => kit.renderRoleInvite(F.ROLE_INVITE)],
  ["renderRoleInvite (no name, no years)", () => kit.renderRoleInvite(F.ROLE_INVITE_BARE)],
  ["renderInviteAnswer (yes)", () => kit.renderInviteAnswer(F.INVITE_ANSWER_YES)],
  ["renderInviteAnswer (no)", () => kit.renderInviteAnswer(F.INVITE_ANSWER_NO)],
  ["renderInviteAnswer (unclear)", () => kit.renderInviteAnswer(F.INVITE_ANSWER_UNCLEAR)],
  ["renderRoleIntent", () => kit.renderRoleIntent(F.ROLE_INTENT)],
  ["renderRoleIntent (no name, no facts)", () => kit.renderRoleIntent(F.ROLE_INTENT_BARE)],
  ["renderIntentAnswer", () => kit.renderIntentAnswer(F.INTENT_ANSWER)],
  ["renderIntentQuestions", () => kit.renderIntentQuestions(F.INTENT_QUESTIONS)],
  ["renderIntentQuestions (one question, no name)", () => kit.renderIntentQuestions(F.INTENT_QUESTIONS_BARE)],
  ["renderQuestionsAnswer", () => kit.renderQuestionsAnswer(F.QUESTIONS_ANSWER)],
  ["renderRoleHold", () => kit.renderRoleHold(F.ROLE_HOLD)],
  ["renderRoleHold (no name)", () => kit.renderRoleHold(F.ROLE_HOLD_BARE)],
  ["renderHoldAnswer", () => kit.renderHoldAnswer(F.HOLD_ANSWER)],
];


// ── the shared footer ───────────────────────────────────────────────────────────────────────────
//
// The per-template cases below only cover templates that have a fixture. `charlieBlock` is appended
// to many templates at once, so the mechanism gets its own assertion, read from the source, which
// holds for every template that calls it, including ones without a fixture yet.
describe("the shared footer carries no prose", () => {
  const SRC = readFileSync(new URL("../email-kit.mjs", import.meta.url), "utf8");

  it("charlieBlock emits no paragraph", () => {
    const i = SRC.indexOf("const charlieBlock = () =>");
    expect(i, "charlieBlock is gone or renamed — this guard is now checking nothing").toBeGreaterThan(-1);
    const body = SRC.slice(i, SRC.indexOf("\n\n", i));
    // `p(...)` and `lead(...)` are the prose helpers. A footer appended to every mail must not use
    // them: whatever it says, it says to everybody, in the HTML only, forever.
    expect(body, `charlieBlock now contains prose:\n${body}`).not.toMatch(/\bp\(|\blead\(/);
  });
});

describe("no sentence may reach the HTML that never reaches the text", () => {
  for (const [name, render] of CASES) {
    it(name, () => {
      const m = render();
      const inText = norm(m.text);
      // Every prose paragraph in the HTML must have its sentences carried by the text half.
      const onlyInHtml = paragraphs(m.html)
        .flatMap((para) => sentences(para))
        .filter((s) => !inText.includes(s.replace(/[.!?]$/, "")));
      expect(
        onlyInHtml,
        `${name}: these sentences are in the HTML people read and NOT in the text that gets reviewed:\n  - ${onlyInHtml.join("\n  - ")}`,
      ).toEqual([]);
    });
  }
});

describe("the removed paragraph stays removed", () => {
  it("no template carries the what-charlie-is copy any more", () => {
    // It explained the product to people who had already used it.
    for (const [name, render] of CASES) {
      const m = render();
      expect(`${m.html} ${m.text}`, name).not.toMatch(/Most hiring reads a resume|it is what I sell/i);
    }
  });
});
