// lib/open-ask.test.mjs — a reply to a question we asked must never reach the preference writer.
//
// An ask sent by a hand-run script must leave a record of the question, or /inbound answers a careful reply as
// if it were a preference update. These tests pin the record, and that every uncertain path errs towards a
// human reading the message.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { openAskFor, ASK_TEMPLATES, ASK_WINDOW_DAYS } from "./open-ask.mjs";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const asks = (rows) => ({ recentAsks: async () => rows });

describe("an ask that is still open", () => {
  it("is open when we asked inside the window", async () => {
    const r = await openAskFor("a@b.com", asks([{ template: "studio-ask", sent_at: iso(1) }]));
    expect(r.open).toBe(true);
    expect(r.template).toBe("studio-ask");
  });

  it("is closed when we asked nothing", async () => {
    expect((await openAskFor("a@b.com", asks([]))).open).toBe(false);
  });

  it("reports the most recent ask when there are several", async () => {
    const r = await openAskFor("a@b.com", asks([
      { template: "studio-ask", sent_at: iso(9) },
      { template: "other-ask", sent_at: iso(2) },
    ]));
    expect(r.template).toBe("other-ask");
  });

  it("passes the window to the query rather than filtering after the fact", async () => {
    let since = null;
    await openAskFor("a@b.com", { recentAsks: async (_e, _t, s) => { since = s; return []; } });
    const days = (Date.now() - new Date(since)) / 864e5;
    expect(Math.round(days)).toBe(ASK_WINDOW_DAYS);
  });

  it("lowercases the address before looking it up", async () => {
    let seen = null;
    await openAskFor("  A@B.COM ", { recentAsks: async (e) => { seen = e; return []; } });
    expect(seen).toBe("a@b.com");
  });
});

describe("every uncertain path errs towards a human", () => {
  it("treats a lookup failure as an open ask", async () => {
    const r = await openAskFor("a@b.com", { recentAsks: async () => { throw new Error("db down"); } });
    expect(r.open).toBe(true);
    expect(r.reason).toMatch(/failed/);
  });

  it("treats a missing dependency as an open ask", async () => {
    // The impossible case, handled on purpose: a missing dep returning "no open ask" is exactly the
    // state that produced the wrong reply, so it must not be reachable by accident.
    expect((await openAskFor("a@b.com", {})).open).toBe(true);
    expect((await openAskFor("a@b.com", undefined)).open).toBe(true);
  });

  it("does not treat an empty address as an open ask", async () => {
    expect((await openAskFor("", asks([]))).open).toBe(false);
  });
});

describe("the handler is wired to it", () => {
  const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

  it("checks for an open ask BEFORE the question guard and the preference writer", () => {
    const ask = SRC.indexOf("openAskFor(from");
    const question = SRC.indexOf("looksLikeQuestion(ownWords)");
    const writer = SRC.indexOf("applyEmailChange(from");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(question); // an answer is an answer whether or not it is phrased as one
    expect(ask).toBeLessThan(writer);
  });

  it("returns without writing preferences when an ask is open", () => {
    const block = SRC.slice(SRC.indexOf("openAskFor(from"), SRC.indexOf("looksLikeQuestion(ownWords)"));
    expect(block).toContain("renderAskAnswerAck");
    expect(block).toContain("return;");
    expect(block).not.toContain("applyEmailChange("); // the call, not the comment naming it
  });

  it("forwards the answer to a person, because the answer is the point of asking", () => {
    const block = SRC.slice(SRC.indexOf("openAskFor(from"), SRC.indexOf("looksLikeQuestion(ownWords)"));
    expect(block).toMatch(/ALERT_EMAIL|ALERT_TO\(\)/);
  });

  it("fails closed if the check itself throws", () => {
    const block = SRC.slice(SRC.indexOf("openAskFor(from"), SRC.indexOf("looksLikeQuestion(ownWords)"));
    expect(block).toMatch(/catch[\s\S]*(ALERT_EMAIL|ALERT_TO\(\))[\s\S]*return;/);
  });
});

describe("the ask templates", () => {
  it("lists the one that has actually been sent", () => {
    expect(ASK_TEMPLATES).toContain("studio-ask");
  });

});
