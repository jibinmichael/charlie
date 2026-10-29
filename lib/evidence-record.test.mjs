// evidence-record.test.mjs — a person's reply about their own work reaches their record.
//
// The failure this guards against is silent: /inbound receives the reply, answers the person, and
// never writes to their record, while every step reports success. These tests pin the properties that
// prevent it, not the happy path.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isEvidenceReply, answerKey, MIN_CHARS, EVIDENCE_SUBJECTS, isCheckinReply } from "./evidence-record.mjs";

describe("which replies are a person describing their own work", () => {
  it("recognises every ask that has actually been sent", () => {
    // Each of these is a live ask subject line; missing any one leaves its replies unfiled.
    for (const s of [
      "Re: Send me the evidence",
      "Re: A few things I am missing about you",
      "Re: You're in, and one thing would help",
    ]) expect(isEvidenceReply(s), s).toBe(true);
  });

  it("ignores conversations that are not about their work", () => {
    for (const s of [
      "Re: Your update: the company is Acme",
      "Re: Has Acme been in touch?",
      "Why I want to Join Charlie",
      "Re: Got it, noted",
      "",
    ]) expect(isEvidenceReply(s), s).toBe(false);
  });

  it("is case- and prefix-insensitive, because mail clients are not consistent", () => {
    expect(isEvidenceReply("RE: SEND ME THE EVIDENCE")).toBe(true);
    expect(isEvidenceReply("Fwd: send me the evidence")).toBe(true);
  });
});

describe("the key a reply is filed under", () => {
  const r = { at: "2026-08-17", subject: "Re: Send me the evidence" };

  it("names the date and the question, so a reader knows what was asked", () => {
    expect(answerKey(r)).toBe("Sent to Charlie 2026-08-17 — asked: Send me the evidence");
  });

  it("gives a second same-day reply its own key", () => {
    // Otherwise a longer second answer is counted as already filed and dropped.
    expect(answerKey(r, 1)).not.toBe(answerKey(r, 0));
    expect(answerKey(r, 1)).toMatch(/\(2\)$/);
  });

  it("leaves the first reply unsuffixed, so re-running files nothing twice", () => {
    expect(answerKey(r, 0)).not.toMatch(/\(\d\)$/);
  });
});

describe("the floor on what counts as an answer", () => {
  it("is high enough to exclude an acknowledgement", () => {
    expect(MIN_CHARS).toBeGreaterThanOrEqual(50);
    expect("Thanks!".length).toBeLessThan(MIN_CHARS);
    expect("Got it, will send later.".length).toBeLessThan(MIN_CHARS);
  });

  it("is low enough to keep a short but real answer", () => {
    // A link plus a line is a complete answer to "send me one piece of work".
    const short = "Link to my work: https://portfolio.example.com/ — the fintech onboarding flow is mine end to end.";
    expect(short.length).toBeGreaterThanOrEqual(MIN_CHARS);
  });
});

describe("the subject pattern itself", () => {
  it("is a shared constant, so /inbound and the reconciliation cannot disagree", () => {
    // Two copies of this regex would let one path miss a subject the other catches.
    expect(EVIDENCE_SUBJECTS).toBeInstanceOf(RegExp);
    expect(EVIDENCE_SUBJECTS.flags).toContain("i");
  });
});

// Every template that ASKS a person for their work must have its subject in EVIDENCE_SUBJECTS, or
// the replies arrive and are never filed, and the reconciliation cannot see it because it reads the
// same pattern. Tying the matcher to the templates is the only version of this that cannot drift.
describe("every ask template's own subject is recognised", () => {
  it("matches the subject each ask actually sends", async () => {
    const kit = await import("../email-kit.mjs");
    const F = await import("../emails/fixtures.mjs");
    const asks = [
      ["renderBreakingSilence", () => kit.renderBreakingSilence(F.BREAKING_SILENCE_ASK)],
      ["renderEvidenceAsk", () => kit.renderEvidenceAsk({ email: "a@b.com", name: "Maya", evidence: "One piece of work you are proud of." })],
      ["renderRepresentPoolAsk", () => kit.renderRepresentPoolAsk({ email: "a@b.com", name: "Maya", missing: ["pay"] })],
    ];
    for (const [name, render] of asks) {
      const { subject } = render();
      expect(isEvidenceReply(`Re: ${subject}`), `${name} sends "${subject}" and nothing files its replies`).toBe(true);
    }
  });
});

// The client-status loop, and why its two halves must stay in this order.
//
// A reply falling through to renderAck would offer the reader a pay-floor change and promise them
// roles — neither true of somebody who applied to one role through a form.
//
// The terminal branch in charlie-remote.ts is what makes the reply address safe. Pointing replyTo
// back at a person WITHOUT removing that branch is harmless; removing the branch while replyTo still
// points at Charlie sends the untrue letter to every applicant who writes back. Prose cannot enforce
// an ordering, so this reads the files.
describe("replies to a client-status mail have somewhere to land", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("/inbound still has the terminal branch that makes that safe", () => {
    const src = read("../server/charlie-remote.ts");
    expect(src, "the client-status branch is gone — replies now fall through to renderAck").toMatch(/if \(isClientStatusReply\(subject\)\)/);
    // It must RETURN. Falling through is the whole defect.
    const i = src.indexOf("if (isClientStatusReply(subject))");
    const branch = src.slice(i, i + 3000);
    expect(branch.slice(0, branch.indexOf("\n    // REMOVED")), "the branch no longer returns, so renderAck runs after it").toMatch(/\n      return;/);
  });
});

// The subject renderAnyCalls actually sends must be recognised by the branch that answers it.
//
// A matcher and the template it matches live in two places. Rendering the real template and asserting
// against the real matcher is the only version that cannot drift.
describe("an answer to \"has anyone been in touch?\" is recognised", () => {
  it("matches the subject renderAnyCalls sends, for every company", async () => {
    const kit = await import("../email-kit.mjs");
    for (const company of ["Acme", "Globex", "Initech Inc", "Umbrella"]) {
      const { subject } = kit.renderAnyCalls({ email: "a@b.com", name: "Maya", company, roleTitle: "Engineer", askStage: true });
      expect(isCheckinReply(`Re: ${subject}`), `"${subject}" is sent and nothing answers its replies`).toBe(true);
    }
  });

  it("does not swallow the other conversations", () => {
    for (const s of [
      "Re: Your Globex application is with the hiring team",
      "Re: Breaking the silence",
      "Re: Got it, thank you",
    ]) expect(isCheckinReply(s), s).toBe(false);
  });
});
