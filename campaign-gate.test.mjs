// campaign-gate.test.mjs — proves the two deterministic campaign gates fail closed.
// Registered in vitest.config.mjs include (root tests are listed explicitly; an unlisted root test runs
// nowhere).
import { describe, it, expect } from "vitest";
import { attemptVerdict, orderGateVerdict, parseOwnerVerdict, stripQuotedReply } from "./campaign-gate.mjs";

describe("stripQuotedReply — keep only the sender's own words", () => {
  it("drops the Gmail quote header and quoted lines", () => {
    const reply = `here is my answer to the question

On Fri, Jul 24, 2026 at 9:02 PM Charlie <join@mail.example.com> wrote:
> I have a car that only exists as a prototype.
> Sell me the first ten.`;
    expect(stripQuotedReply(reply)).toBe("here is my answer to the question");
  });
  it("leaves an un-quoted reply untouched", () => {
    expect(stripQuotedReply("just my answer, no quote")).toBe("just my answer, no quote");
  });
  it("handles a quote header that wraps across lines (On <...>\\nwrote:)", () => {
    const wrapped = "i can't answer that\n\nOn Fri, Jul 24, 2026 at 9:21 PM Charlie <join@mail.example.com>\nwrote:\n> the question";
    expect(stripQuotedReply(wrapped)).toBe("i can't answer that");
  });
});

describe("attemptVerdict — did they attempt the two questions (NOT whether the answer was good)", () => {
  // A serious role can't be done by someone who didn't read the posting, so the gate checks the
  // questions were attempted.
  //
  // This is NOT a rejection and must never behave like one. The campaign's standing non-negotiable is
  // that the verdict is 100% human, so this only asks whether the questions were ATTEMPTED — a fact
  // about the message. Everything it catches gets the two questions sent back and may write again.
  it("catches the CV-forward with nothing said", () => {
    expect(attemptVerdict("PFA my resume. Interested in this role.")).toBe("incomplete");
    expect(attemptVerdict("Please find attached my CV. Kindly consider.")).toBe("incomplete");
    expect(attemptVerdict("I am applying for the position. Attached is my resume.")).toBe("incomplete");
  });

  it("catches the one-liner", () => {
    for (const t of ["Interested.", "Looking for opportunities.", "Hi, is this role open?", "", "   ", null]) {
      expect(attemptVerdict(t), JSON.stringify(t)).toBe("incomplete");
    }
  });

  it("PASSES anyone who engaged with the product, however briefly", () => {
    // The bar is "attempted", not "answered well". Judging quality is the human's job, and a short
    // honest answer from someone who actually used it is exactly who this role wants.
    expect(attemptVerdict("I signed up and the onboarding asked me things no job site has. It felt personal, almost uncomfortable.")).toBe("ok");
    expect(attemptVerdict("Charlie is for people who have stopped believing anyone reads their applications.")).toBe("ok");
    expect(attemptVerdict("The role you sent me was wrong for me, and the honest bit about the gap is what made me trust it.")).toBe("ok");
  });

  it("FAILS OPEN on anything ambiguous — the asymmetry is deliberate", () => {
    // A wasted read costs the owner two minutes. A wrongly-blocked applicant is lost silently and
    // forever, and never learns why. So length alone is never a reason to block a considered note.
    const long = "I have spent the last two years watching friends apply into silence and I think that is the actual problem worth solving here, more than the matching itself. I would like to help with that and I am willing to start anywhere, doing anything, including the unglamorous parts nobody volunteers for.";
    expect(long.length).toBeGreaterThan(120);
    expect(attemptVerdict(long)).toBe("ok");
  });

  it("reads the sender's OWN words, not the quoted thread", () => {
    // A reply that quotes Charlie's letter back would otherwise pass on Charlie's own words.
    const quoted = "PFA resume.\n\n> On Wed, Charlie wrote:\n> I signed up and the onboarding asked me things no job site has, Charlie is for people who...";
    expect(attemptVerdict(quoted)).toBe("incomplete");
  });

  it("a signature block does not rescue an empty note", () => {
    expect(attemptVerdict("Interested!\n\n--\nRahul\nBengaluru\n+91 90000 00000")).toBe("incomplete");
  });
});

describe("orderGateVerdict — Case 2, onboarded first (fail-closed)", () => {
  it("advances once they have actually onboarded", () => {
    expect(orderGateVerdict({ hasCandidate: true, hasDeliveredMatch: true })).toBe("ok");
  });
  it("redirects when they never onboarded", () => {
    expect(orderGateVerdict({ hasCandidate: false, hasDeliveredMatch: true })).toBe("redirect");
  });

  it("A DELIVERED ROLE IS NO LONGER REQUIRED, because it was unreachable", () => {
    // Requiring a delivered match would make the gate impossible to satisfy for a brand-new applicant
    // (role sends are weekly and cohort-limited), leaving them in a polite loop that is worse than a
    // rejection because nobody finds out it is one. The gate's PURPOSE is intact: they must have used
    // the product before talking to us about it. Whether a role cleared their bar is a cost-control
    // artifact and says nothing about them.
    expect(orderGateVerdict({ hasCandidate: true, hasDeliveredMatch: false })).toBe("ok");
  });

  it("redirects on missing/ambiguous facts (the fail-closed default)", () => {
    expect(orderGateVerdict({})).toBe("redirect");
    expect(orderGateVerdict()).toBe("redirect");
    // truthy-but-not-true must NOT slip through (strict === true)
    expect(orderGateVerdict({ hasCandidate: 1, hasDeliveredMatch: "yes" })).toBe("redirect");
  });
});

describe("parseOwnerVerdict — the human verdict, strict on keyword", () => {
  it("reads a verdict with an explicit target", () => {
    expect(parseOwnerVerdict("advance jane@doe.com")).toEqual({ verdict: "advance", target: "jane@doe.com" });
    expect(parseOwnerVerdict("Reject: SPAM@x.io")).toEqual({ verdict: "reject", target: "spam@x.io" });
  });
  it("reads a bare verdict (target then comes from the reply thread)", () => {
    expect(parseOwnerVerdict("advance")).toEqual({ verdict: "advance", target: null });
    expect(parseOwnerVerdict("hold")).toEqual({ verdict: "hold", target: null });
  });
  it("strips trailing punctuation off the target", () => {
    expect(parseOwnerVerdict("advance jane@doe.com.")).toEqual({ verdict: "advance", target: "jane@doe.com" });
  });
  it("reads the verdict keyword anywhere in the owner's own words (real replies carry preambles)", () => {
    expect(parseOwnerVerdict("ok reject this one")).toEqual({ verdict: "reject", target: null });
    expect(parseOwnerVerdict("she was great, advance her")).toEqual({ verdict: "advance", target: null });
    expect(parseOwnerVerdict("reject.")).toEqual({ verdict: "reject", target: null });
  });
  it("returns null when there is no verdict keyword at all", () => {
    expect(parseOwnerVerdict("maybe we should talk to jane")).toBeNull();
    expect(parseOwnerVerdict("")).toBeNull();
    expect(parseOwnerVerdict(null)).toBeNull();
  });

  it("reads the verdict from a real Gmail reply that quotes the original (the smoke-test bug)", () => {
    const gmailReply = `advance

On Thu, Jul 24, 2026 at 1:24 PM Charlie <join@mail.example.com> wrote:
> A candidate cleared the gate
> To decide: reply advance to move them forward, or reject to send the honest no. Reply hold to pause.`;
    expect(parseOwnerVerdict(gmailReply)).toEqual({ verdict: "advance", target: null });
  });

  it("does not let the QUOTED 'advance/reject/hold' instruction trigger a verdict", () => {
    const noVerdictTop = `not sure yet, let me look again

On Thu Charlie <join@mail.example.com> wrote:
> reply advance / reject / hold`;
    expect(parseOwnerVerdict(noVerdictTop)).toBeNull();
  });
});
