// lib/suppression-policy.test.mjs — the inbound reply exception, enumerated.
//
// WHY. /inbound sends through sendGuarded, which calls isSuppressed, and isSuppressed does not look at
// WHY an address is suppressed. /unsubscribe writes to the same suppressions table as a hard bounce,
// so without this exception unsubscribe would be a ONE-WAY DOOR: someone who unsubscribed and later
// emailed asking to come back would get total silence, on a product whose only surface is email.
//
// The rule is a WHITELIST and the test is exhaustive over every reason the codebase writes (the
// server's /unsubscribe and webhook handlers, scripts/deactivate-users.mjs) plus the degenerate inputs,
// because "which reasons open the door" is exactly the question a future suppression kind will
// silently answer wrong. A new reason must default to BLOCKING.

import { describe, it, expect } from "vitest";
import { mayReplyDespiteSuppression as mayReply } from "./suppression-policy.mjs";

describe("an unsubscribe does not silence a reply to someone who wrote in", () => {
  for (const reason of ["unsubscribe", "unsubscribe-oneclick"]) {
    it(`"${reason}" still gets an answer`, () => {
      expect(mayReply(reason)).toBe(true);
    });
  }

  it("is case- and whitespace-insensitive (the value is written by several call sites)", () => {
    for (const r of ["Unsubscribe", "UNSUBSCRIBE-ONECLICK", "  unsubscribe  "]) expect(mayReply(r)).toBe(true);
  });
});

describe("everything else still blocks — the whitelist fails closed", () => {
  for (const reason of ["hard_bounce", "complaint", "admin-deactivate-test"]) {
    it(`"${reason}" is NOT replyable`, () => {
      expect(mayReply(reason)).toBe(false);
    });
  }

  it("an unknown or future reason blocks by default, never opens", () => {
    // The whole point of a whitelist: adding a suppression kind must not start mailing people.
    for (const r of ["quarantine", "legal_hold", "manual", "bounce", "spam"]) expect(mayReply(r)).toBe(false);
  });

  it("a reason that merely CONTAINS 'unsubscribe' does not qualify — it must start with it", () => {
    expect(mayReply("pre-unsubscribe-review")).toBe(false);
    expect(mayReply("complaint-after-unsubscribe")).toBe(false);
  });

  it("degenerate inputs block rather than throw", () => {
    for (const r of [null, undefined, "", "   ", 0, 1, {}, [], true, NaN]) expect(mayReply(r)).toBe(false);
  });
});

describe("not-suppressed is not this function's job", () => {
  it("null (no suppression row) returns false, so the caller falls through to the ordinary check", () => {
    // This function answers only 'may we reply DESPITE a suppression'. A null reason means there is
    // no suppression to override, and the caller must still run isSuppressed — returning true here
    // would short-circuit the real check for everyone.
    expect(mayReply(null)).toBe(false);
  });
});
