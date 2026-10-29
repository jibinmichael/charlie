// lib/role-invite-reply.test.mjs — the yes/no/unclear reader for "reply yes or no" invitations.
//
// The invitation asks "reply yes or no", and almost every mail client quotes the message being
// replied to. So the copy that contains the words "yes" and "no" travels back inside the answer.
//
// The first assertion in here is the REGRESSION: it shows the naive reading, a search over the raw
// body, calling a refusal a yes. That is not a hypothetical. It is what any straightforward
// implementation of "did they say yes" does, and it would put somebody who declined in front of a
// paying client.

import { describe, it, expect } from "vitest";
import { classifyInviteReply } from "./role-invite-reply.mjs";

/** The tail every reply carries: our own words, quoted back. */
const QUOTED = [
  "",
  "On Mon, 25 Aug 2026 at 09:14, Charlie <charlie@example.com> wrote:",
  "> So, one question: would you like me to put you forward? Reply yes or no.",
  "> That is the whole ask, and one word is a complete answer.",
  "> I never ask anyone for money, and I do not promise anyone a job.",
].join("\n");

describe("classifyInviteReply", () => {
  it("does not read our own quoted 'yes' as their answer", () => {
    const body = `No thanks, I am not looking right now.${QUOTED}`;

    // THE OLD BEHAVIOUR, shown failing. A search over the whole body finds "yes" in our quoted copy.
    expect(/yes/i.test(body)).toBe(true);

    // The actual answer.
    expect(classifyInviteReply(body, "her@example.com").answer).toBe("no");
  });

  it("reads a one word yes", () => {
    expect(classifyInviteReply(`Yes${QUOTED}`, "him@example.com").answer).toBe("yes");
    expect(classifyInviteReply(`yes please!${QUOTED}`, "him@example.com").answer).toBe("yes");
  });

  it("reads a one word no", () => {
    expect(classifyInviteReply(`No${QUOTED}`, "them@example.com").answer).toBe("no");
    expect(classifyInviteReply(`Not interested, thanks.${QUOTED}`, "them@example.com").answer).toBe("no");
  });

  it("sends a qualified yes to a human rather than filing it as a yes", () => {
    // This person has not agreed to an on-site job in Bengaluru, and filing them as a yes would put
    // them in front of a client on terms they never accepted.
    const r = classifyInviteReply(`Yes, but only if it is remote.${QUOTED}`, "a@b.com");
    expect(r.answer).toBe("unclear");
  });

  it("sends anything it cannot read to a human, never to a default", () => {
    expect(classifyInviteReply(`Could you tell me the salary band first?${QUOTED}`, "a@b.com").answer).toBe("unclear");
    expect(classifyInviteReply(``, "a@b.com").answer).toBe("unclear");
    expect(classifyInviteReply(null, "a@b.com").answer).toBe("unclear");
  });

  it("keeps their own earlier mail, which is theirs, not ours", () => {
    // People chase. A reply on top of their OWN earlier message must not be cut at that quote.
    const body = [
      "Yes, still keen.",
      "",
      "On Fri, 22 Aug 2026 at 10:00, Priya <priya@example.com> wrote:",
      "> Following up on my application from last week.",
    ].join("\n");
    const r = classifyInviteReply(body, "priya@example.com");
    expect(r.answer).toBe("yes");
  });
});

// ── the reply a person actually receives ────────────────────────────────────────────────────────
//
// The classifier being right is only half of it. The other half is that /inbound uses it BEFORE
// falling through to renderAskAnswerAck, which tells the reader "I am taking the shape of your
// background to the hiring side". Sent to somebody who replied "no", that is a broken promise: the
// invitation said "no is the right answer and it costs you nothing".
//
// A registry entry in ASK_TEMPLATES without this branch would recognise the answer and still mishandle
// it. So the ordering is read from the source and asserted, the way lib/ask-registry.test.mjs asserts the registry itself.

import { readFileSync } from "node:fs";
import { renderInviteAnswer } from "../email-kit.mjs";
import { ASK_TEMPLATES } from "./open-ask.mjs";

describe("a reply to role-invite is answered by its own branch", () => {
  const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

  it("is registered as an ask, or replies are read as preference updates", () => {
    expect(ASK_TEMPLATES).toContain("role-invite");
  });

  it("handles role-invite BEFORE the generic ack, and returns", () => {
    const branch = SRC.indexOf(`ask.template === "role-invite"`);
    const generic = SRC.indexOf("renderAskAnswerAck({ email: from");
    expect(branch, "the role-invite branch is gone: every replier now gets the generic ack").toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(-1);
    expect(branch, "the generic ack now runs first, so a 'no' is told their background is going to the hiring side").toBeLessThan(generic);
    // It must be terminal. Without the return, the generic ack is sent on top of the right one.
    expect(SRC.slice(branch, generic)).toMatch(/\n\s*return;\n/);
  });

  it("never tells somebody who declined that their background is being taken anywhere", () => {
    const no = renderInviteAnswer({ email: "a@b.com", name: "Priya", answer: "no" });
    for (const half of [no.text, no.html]) {
      expect(half).not.toMatch(/hiring side/i);
      expect(half).not.toMatch(/come back to you with what I hear/i);
    }
    expect(no.text).toMatch(/Nothing moves/i);
  });

  it("does not promise the person who said yes anything the client has not decided", () => {
    const yes = renderInviteAnswer({ email: "a@b.com", name: "Priya", answer: "yes" });
    for (const half of [yes.text, yes.html]) {
      expect(half).not.toMatch(/shortlist|interview|you will hear from them|guarantee/i);
    }
    expect(yes.text).toMatch(/They decide, not me/i);
  });

  it("an unrecognised answer value falls to unclear rather than picking one for them", () => {
    expect(renderInviteAnswer({ email: "a@b.com", answer: "maybe" }).subject).toBe(renderInviteAnswer({ email: "a@b.com", answer: "unclear" }).subject);
  });
});

// ── a greeting before the answer ────────────────────────────────────────────────────────────────
//
// Reading "Hi," as the answer would file an unambiguous yes as unclear.
describe("a greeting is not an answer", () => {
  it("reads the yes under the hello", () => {
    const real = "Hi,\n\nYes, please go ahead and put me forward.\n\nThanks,\nSam\n\n>";
    expect(classifyInviteReply(real, "sam@example.com").answer).toBe("yes");
  });

  it("reads a no under a hello too", () => {
    expect(classifyInviteReply("Hello Charlie,\n\nNo thanks, not right now.", "a@b.com").answer).toBe("no");
  });

  it("still refuses to guess when the greeting is all there is", () => {
    expect(classifyInviteReply("Hi Charlie,", "a@b.com").answer).toBe("unclear");
  });

  it("does not swallow a real answer that merely starts with thanks", () => {
    // "Thanks" alone is a greeting line; "Thanks, yes please" is an answer and must not be skipped.
    expect(classifyInviteReply("Thanks, yes please.", "a@b.com").answer).toBe("yes");
  });
});
