// intent-open-attribution.test.mjs — proves the pure helper that attributes a Resend
// delivery/open event back to the exact role it was about. A role send keys its sent_emails
// idempotency on the find id (`<email>:<jobId>`); every other template keys on something else, so a
// dedupe_key that starts with the owning address IS that role's find. This is the join that lets an
// `email.opened` webhook (once Resend open-tracking is on) land with its find_id — the difference
// between "delivered, never opened" and "opened, then ignored".
//
// Registered in vitest.config.mjs include (an unlisted root test runs NOWHERE — the drip-guard trap).
import { describe, it, expect } from "vitest";
import { roleFindIdFromSend } from "./charlie-store.mjs";

describe("roleFindIdFromSend — attribute a send back to its role", () => {
  it("returns the find id for a role send (dedupe_key starts with the owner address)", () => {
    // find id shape includes the ATS-prefixed job id, which itself contains colons
    const row = { email: "jane@example.com", dedupe_key: "jane@example.com:lever:netomi:a5606db8" };
    expect(roleFindIdFromSend(row)).toBe("jane@example.com:lever:netomi:a5606db8");
  });

  it("returns null for a non-role template (dedupe_key is not a find id)", () => {
    expect(roleFindIdFromSend({ email: "jane@example.com", dedupe_key: "whatsnew-2026-07-28" })).toBeNull();
    expect(roleFindIdFromSend({ email: "jane@example.com", dedupe_key: "newsletter/week-30" })).toBeNull();
  });

  it("requires the address PLUS a colon — the bare address alone is not a find id", () => {
    expect(roleFindIdFromSend({ email: "jane@example.com", dedupe_key: "jane@example.com" })).toBeNull();
  });

  it("does not mis-attribute a different user's dedupe_key", () => {
    // a key belonging to someone else must never resolve to this row's owner
    expect(roleFindIdFromSend({ email: "jane@example.com", dedupe_key: "bob@example.com:greenhouse:x:1" })).toBeNull();
  });

  it("is fail-soft on missing / malformed rows (webhook stays fail-open)", () => {
    expect(roleFindIdFromSend(null)).toBeNull();
    expect(roleFindIdFromSend({})).toBeNull();
    expect(roleFindIdFromSend({ email: "", dedupe_key: ":x" })).toBeNull();
    expect(roleFindIdFromSend({ email: "jane@example.com", dedupe_key: null })).toBeNull();
  });
});
