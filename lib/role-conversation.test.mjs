// role-conversation.test.mjs — follow-up questions about a role, run against the real functions.
// Each must be answered from the role in play rather than with the generic "a person will answer
// this" fallback.
//
// These test CONTINUITY, not whether one sentence reads well: each case sets up a prior turn and then
// checks that the next message is understood in its light.

import { describe, it, expect } from "vitest";
import { roleInPlay } from "./role-in-play.mjs";
import { answerAboutRole, askedBefore } from "./role-answer.mjs";
import { looksLikeQuestion } from "./inbound-question.mjs";

const EMAIL = "priya@example.com";

/** A role we actually emailed them, with pay and working arrangement UNKNOWN — the common case. */
const ROLE = {
  title: "Senior Android Engineer", company: "Acme Systems", location: "Nagpur",
  remote: null, compensation: null, apply_url: "https://example.com/apply",
};
/** The same role where the listing did publish both. */
const ROLE_FULL = { ...ROLE, remote: "On-site", compensation: "INR 21,00,000 - 27,00,000" };

/** Deps for roleInPlay: one role send, one lifecycle send that must be ignored. */
const deps = (job = ROLE) => ({
  roleSends: async () => [
    { email: EMAIL, dedupe_key: "v1", template: "breaking-silence", sent_at: "2026-08-24T10:00:00Z" },
    { email: EMAIL, dedupe_key: `${EMAIL}:keka:acme:551`, template: "role", sent_at: "2026-08-25T09:00:00Z" },
  ],
  findIdFromSend: (row) => {
    const key = String(row?.dedupe_key || "");
    return key.startsWith(`${String(row?.email || "").toLowerCase()}:`) ? key : null;
  },
  findById: async (_e, id) => (id === `${EMAIL}:keka:acme:551` ? { id, job } : null),
});

/** The whole path for a question: resolve the role, then answer from it. */
async function turn(question, { job = ROLE, sends = deps(job), priors = [] } = {}) {
  if (askedBefore(question, priors)) return { escalated: "asked before" };
  if (!looksLikeQuestion(question).isQuestion) return { escalated: "not a question, goes to the classifier" };
  const rp = await roleInPlay(EMAIL, sends);
  if (!rp) return { escalated: "no role in play" };
  const a = answerAboutRole({ question, job: rp.job, name: "Priya Nair" });
  return a ? { text: a.text, kind: a.kind } : { escalated: "record cannot answer it" };
}

describe("the ten conversations", () => {
  it("1. role sent -> Can I apply?", async () => {
    const r = await turn("Can I apply?");
    expect(r.text).toMatch(/^Yes\./);
    expect(r.text).toContain("Senior Android Engineer");
    expect(r.text).toContain("Nagpur");
  });

  it("2. role sent -> What about remote? (listing does not say)", async () => {
    const r = await turn("What about remote?");
    // It must NOT claim on-site. `remote` is null and null is not a fact.
    expect(r.text).not.toMatch(/on.?site/i);
    expect(r.text).toMatch(/doesn't say/i);
    expect(r.text).toContain("Nagpur");
  });

  it("2b. role sent -> What about remote? (listing does say)", async () => {
    const r = await turn("What about remote?", { job: ROLE_FULL, sends: deps(ROLE_FULL) });
    expect(r.text).toMatch(/on-site/i);
  });

  it("3. role sent -> How much does it pay? (not published)", async () => {
    const r = await turn("How much does it pay?");
    expect(r.text).toMatch(/haven't published/i);
    expect(r.text).toMatch(/I can ask/i);
    expect(r.text).not.toMatch(/\d/); // no number may appear when none is known
  });

  it("3b. role sent -> How much does it pay? (published)", async () => {
    const r = await turn("How much does it pay?", { job: ROLE_FULL, sends: deps(ROLE_FULL) });
    expect(r.text).toContain("INR 21,00,000 - 27,00,000");
  });

  it("4. role sent -> Is that in Nagpur? answers yes first", async () => {
    const r = await turn("Is that in Nagpur?");
    expect(r.text).toMatch(/^Yes,/);
    expect(r.text).toContain("Nagpur");
  });

  it("4b. and says no when it is somewhere else", async () => {
    const r = await turn("Is that in Bangalore?");
    expect(r.text).toMatch(/^No,/);
    expect(r.text).toContain("Nagpur");
  });

  it("5. I'm interested -> Yes is not treated as a question", async () => {
    expect((await turn("Yes")).escalated).toBe("not a question, goes to the classifier");
  });

  it("6. a later question resolves against the role already sent, with no restating", async () => {
    // They never name the role. "it" is only resolvable from the send record.
    const r = await turn("Where is it based?");
    expect(r.text).toContain("Nagpur");
  });

  it("7. I already told you that -> a repeat escalates instead of repeating", async () => {
    const first = "How much does it pay?";
    const again = await turn(first, { priors: [first] });
    expect(again.escalated).toBe("asked before");
  });

  it("8. No, I meant the other one -> never guesses a different role", async () => {
    const r = await turn("No, I meant the other one.");
    expect(r.text).toBeUndefined();
    expect(r.escalated).toBeTruthy();
  });

  it("9. no role ever sent -> falls back to a human, invents nothing", async () => {
    const none = { ...deps(), roleSends: async () => [{ email: EMAIL, dedupe_key: "v1", template: "welcome", sent_at: "2026-08-01T00:00:00Z" }] };
    const r = await turn("What about remote?", { sends: none });
    expect(r.escalated).toBe("no role in play");
    expect(r.text).toBeUndefined();
  });

  it("10. nothing outside the record is ever answered", async () => {
    for (const q of ["When will they get back to me?", "Did they like my profile?", "What are my chances?"]) {
      const r = await turn(q);
      expect(r.escalated, `"${q}" was answered when it should not have been`).toBeTruthy();
    }
  });
});

describe("no fabrication", () => {
  it("never emits a number that is not in the record", async () => {
    for (const q of ["How much does it pay?", "What about remote?", "Can I apply?", "Where is it based?"]) {
      const r = await turn(q);
      if (r.text) expect(r.text, `"${q}" invented a number`).not.toMatch(/\d/);
    }
  });

  it("a role that resolves but has no title is not answered from", async () => {
    const blank = { ...ROLE, title: "" };
    const r = await turn("Can I apply?", { job: blank, sends: deps(blank) });
    expect(r.escalated).toBe("record cannot answer it");
  });

  it("every answer stays short", async () => {
    for (const q of ["Can I apply?", "What about remote?", "How much does it pay?", "Is that in Nagpur?"]) {
      const r = await turn(q);
      if (r.text) expect(r.text.split(/\s+/).length, `"${q}" ran long`).toBeLessThanOrEqual(30);
    }
  });
});
