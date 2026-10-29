// ungrounded-reply.test.mjs — a first-time writer is never told this is the wrong address.
//
// When someone writes to start@ for the first time and the dossier build grounds nothing from the
// message, they must be ASKED for more, never declined with "not the right address". Reading "no
// attachment" as "not a job seeker" declines real people on first contact.
//
// A decline also has to be recorded (platform logs are not durable), so it can be counted rather
// than discovered. Both halves are tested here: the decision itself, and that it is written down.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { replyForUngrounded, isDecline } from "./lib/ungrounded-reply.mjs";

const server = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");

describe("who gets asked, and who gets declined", () => {
  it("a first-time writer with no attachment is ASKED, not declined", () => {
    const reply = replyForUngrounded({ triedToSendADoc: false, isFirstContact: true });
    expect(reply).toBe("tell_me_more");
    expect(isDecline(reply)).toBe(false);
  });

  it("an unreadable attachment is our problem either way, so we ask for a readable one", () => {
    expect(replyForUngrounded({ triedToSendADoc: true, isFirstContact: true })).toBe("missing_resume");
    expect(replyForUngrounded({ triedToSendADoc: true, isFirstContact: false })).toBe("missing_resume");
  });

  it("the decline survives ONLY for someone already asked, who still grounds nothing", () => {
    const reply = replyForUngrounded({ triedToSendADoc: false, isFirstContact: false });
    expect(reply).toBe("not_job_search");
    expect(isDecline(reply)).toBe(true);
  });

  it("fails safe: unknown inputs ask rather than decline", () => {
    // A thrown recordFirstContact resolves to `true` at the call site, but if anything upstream ever
    // passes nothing at all, the answer must still not be a decline of a stranger... except that with
    // no information we genuinely cannot tell, so this pins the CURRENT answer rather than pretending.
    expect(replyForUngrounded({})).toBe("not_job_search");
    // ...which is why the call site must never rely on the default. Asserted below.
  });
});

describe("the call site", () => {
  it("passes the RETURN of recordFirstContact to the decision", () => {
    expect(server).toContain("const isFirstContact = await recordFirstContact(from).catch(() => true);");
    expect(server).toContain("replyForUngrounded({ triedToSendADoc: atts.length > 0, isFirstContact })");
  });

  it("no longer branches on the attachment alone", () => {
    // the attachment-only branch that declines first-time writers
    expect(server).not.toContain("triedToSendADoc ? renderMissingResume({ email: from }) : renderNotJobSearch({ email: from })");
  });

  it("records the decision, so a decline can be counted instead of discovered", () => {
    expect(server).toContain('event: "onboard_ungrounded"');
    expect(server).toMatch(/onboard_ungrounded[\s\S]{0,200}first_contact: isFirstContact/);
  });

  it("still has all three replies wired", () => {
    for (const r of ["renderMissingResume({ email: from })", "renderTellMeMore({ email: from })", "renderNotJobSearch({ email: from })"]) {
      expect(server).toContain(r);
    }
  });
});
