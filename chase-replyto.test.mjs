// chase-replyto.test.mjs — a Reply-To must never be able to kill the role email it rides on.
//
// REPLY_SIGNAL=on makes the daily role email carry a Reply-To of `chase+<token>@<domain>`, where the
// token base64s the FULL user email + FULL job id so the reply can be routed back to the exact role.
// For a real pair that local-part lands around 154 chars, and RFC 5321 caps a local-part at 64.
// Resend refuses the whole message:
//
//     422 validation_error: Invalid `reply_to` field.
//
// It fails the SEND, not just the Reply-To, and it looks identical to "Charlie found nothing".
//
// THE RULE THIS PINS: telemetry is never worth a send. If the address can't be legal, we drop the
// Reply-To and still deliver the role. Fail SAFE, not fail-closed-to-sending.

import { describe, it, expect } from "vitest";
import { chaseReplyTo, findRefFromChase } from "./charlie-store.mjs";

const FROM = "charlie@mail.example.com";
const DOMAIN = "mail.example.com";

// RFC 5321 §4.5.3.1: local-part <= 64 octets, path <= 254.
const LOCAL_MAX = 64;

describe("chaseReplyTo never emits an address that would 422 the send", () => {
  it("returns null for a REAL (email, jobId) pair instead of a 154-char local-part", () => {
    const addr = chaseReplyTo({
      email: "candidate@example.com",
      jobId: "smartrecruiters:BoschGroup:744000139560988", // a realistic long job id
      from: FROM,
    });
    expect(addr).toBeNull();
  });

  it("any address it DOES return is RFC-legal", () => {
    // Sweep realistic shapes; whatever survives must be legal, so no future token change can
    // reintroduce an over-long address without failing here.
    const pairs = [
      ["a@b.co", "gh:1"],
      ["someone.with.a.long.address@subdomain.example.com", "greenhouse:acme-corporation:99887766"],
      ["x@y.io", "ashby:verylongcompanyslughere:96f2faea-96d2-4965-8904-62176947ff3c"],
    ];
    for (const [email, jobId] of pairs) {
      const addr = chaseReplyTo({ email, jobId, from: FROM });
      if (addr === null) continue; // dropped — the safe outcome
      const [local, domain] = addr.split("@");
      expect(local.length, `local-part for ${email}/${jobId}`).toBeLessThanOrEqual(LOCAL_MAX);
      expect(addr.length).toBeLessThanOrEqual(254);
      expect(domain).toBe(DOMAIN);
    }
  });

  it("still returns null on the pre-existing empty-input paths (unchanged behaviour)", () => {
    expect(chaseReplyTo({ email: "", jobId: "gh:1", from: FROM })).toBeNull();
    expect(chaseReplyTo({ email: "a@b.co", jobId: "", from: FROM })).toBeNull();
    expect(chaseReplyTo({ email: "a@b.co", jobId: "gh:1", from: "no-domain" })).toBeNull();
  });

  it("round-trip still works for any address short enough to ship", () => {
    // If a future short-token scheme brings the address under the cap, the inbound parse must still
    // resolve it — this guards the guard, so shortening the token can't silently break routing.
    const addr = chaseReplyTo({ email: "a@b.co", jobId: "g:1", from: FROM });
    if (addr) {
      const ref = findRefFromChase(addr.split("@")[0]);
      expect(ref).toEqual({ email: "a@b.co", jobId: "g:1", findId: "a@b.co:g:1" });
    }
  });
});
