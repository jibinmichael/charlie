// seeking-reply.test.mjs — what comes back when we send somebody a role, and the one error this must
// never make.
//
// The asymmetry that decides every close call: wrongly recording "open" means we keep mailing
// somebody who asked us to stop. Wrongly recording nothing means a human reads one extra email.

import { describe, it, expect } from "vitest";
import { readSeekingReply, seekingUntil } from "./seeking-reply.mjs";

const QUOTED = [
  "", "On Thu, 28 Aug 2026 at 09:14, Charlie <charlie@example.com> wrote:",
  "> Shall I mark you open to roles for the next 30 days? Reply \"open\".",
  "> Already have an offer? Tell me that too.",
].join("\n");

describe("the four signals", () => {
  it("reads open", () => {
    expect(readSeekingReply(`open${QUOTED}`, "a@b.com").open).toBe(true);
    expect(readSeekingReply(`Yes please, keep them coming.${QUOTED}`, "a@b.com").open).toBe(true);
  });

  it("reads a stop", () => {
    for (const s of ["not looking right now", "please stop sending these", "take me off the list", "I'm no longer looking"])
      expect(readSeekingReply(`${s}${QUOTED}`, "a@b.com").stop, s).toBe(true);
  });

  it("reads an offer", () => {
    expect(readSeekingReply(`I have an offer already, so timing matters.${QUOTED}`, "a@b.com").offer).toBe(true);
    expect(readSeekingReply(`I've accepted something last week.${QUOTED}`, "a@b.com").offer).toBe(true);
  });

  it("reads several at once, because one message carries several facts", () => {
    const r = readSeekingReply(`Open, and I have an offer in hand. This one's wrong fit though, too junior.${QUOTED}`, "a@b.com");
    expect(r.open).toBe(true);
    expect(r.offer).toBe(true);
    expect(r.wrongRole).toBe(true);
  });
});

describe("the error it must never make", () => {
  it("a stop beats an open in the same message", () => {
    const r = readSeekingReply(`Yes I got it, but please stop sending these.${QUOTED}`, "a@b.com");
    expect(r.stop).toBe(true);
    expect(r.open).toBe(false);
  });

  it("never reads our own quoted question as their answer", () => {
    // Our copy contains the word "open". A naive search finds it and marks them open.
    const body = `Not looking right now, thanks.${QUOTED}`;
    expect(/open/i.test(body)).toBe(true);      // a naive read would find it
    const r = readSeekingReply(body, "a@b.com");
    expect(r.open).toBe(false);
    expect(r.stop).toBe(true);
  });

  it("a greeting is not an answer, and the answer under it is found", () => {
    expect(readSeekingReply(`Hi Charlie,\n\nopen please.${QUOTED}`, "a@b.com").open).toBe(true);
    expect(readSeekingReply(`Hi Charlie,${QUOTED}`, "a@b.com").needsHuman).toBe(true);
  });

  it("anything unreadable sets nothing and goes to a human", () => {
    for (const s of ["What's the salary?", "Who is the client?", "", "hmm"]) {
      const r = readSeekingReply(`${s}${QUOTED}`, "a@b.com");
      expect(r.signals.length, s).toBe(0);
      expect(r.needsHuman, s).toBe(true);
    }
  });
});

describe("the expiry", () => {
  it("is 30 days out, and the caller supplies today", () => {
    expect(seekingUntil("2026-08-28")).toBe("2026-09-27");
  });
  it("refuses a date it cannot read rather than guessing one", () => {
    expect(seekingUntil("not a date")).toBeNull();
  });
});
