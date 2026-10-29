// chase-signal.test.mjs — the reply-as-signal round-trip: the role email mints a
// signed chase+<token>@ Reply-To; a reply to it must resolve back to the EXACT (user, job) that was
// sent. This is the join that turns "just hit reply" into a `chasing` signal on the right find. The
// HMAC (signEvent/readEvent) makes a tampered token fail closed -> null -> logged for manual review.
//
// Registered in vitest.config.mjs include (an unlisted root test runs NOWHERE — the drip-guard trap).
// CHARLIE_TOKEN_SECRET is set by vitest.config.mjs env, so the token signs/verifies deterministically.
import { describe, it, expect } from "vitest";
import { chaseReplyTo, findRefFromChase, signEvent } from "./charlie-store.mjs";

// Build the local-part directly, so the PARSE side keeps full coverage regardless of whether the
// MINT side can legally emit an address (see the note below).
const chaseLocal = (e, j) => `chase+${signEvent({ e, j })}`;

// ── chaseReplyTo must only ever emit a LEGAL address. The token base64s the full email + job id, so
// the local-part runs ~84-154 chars against an RFC cap of 64, and Resend rejects the ENTIRE message
// on an over-long reply_to. A test that only checks the round-trip would stay green while every send
// fails, so these assert the SAFE DROP (telemetry is never worth a send). Length legality lives in
// chase-replyto.test.mjs. The round-trip and tamper coverage below builds its token directly.
describe("chase reply-as-signal round-trip", () => {
  it("drops the Reply-To rather than emit an over-long address that 422s the send", () => {
    const email = "jane@example.com";
    const jobId = "lever:netomi:a5606db8"; // ATS-prefixed job id (contains colons)
    expect(chaseReplyTo({ email, jobId, from: "charlie@mail.example.com" })).toBeNull();
    // the parse side is untouched: a token for that exact pair still resolves to the exact find
    const ref = findRefFromChase(chaseLocal(email, jobId));
    expect(ref).toEqual({ email, jobId, findId: `${email}:${jobId}` });
  });

  it("derives the domain from CHARLIE_FROM when `from` is omitted", () => {
    const prev = process.env.CHARLIE_FROM;
    process.env.CHARLIE_FROM = "charlie@mail.example.com";
    const addr = chaseReplyTo({ email: "a@b.com", jobId: "greenhouse:x:1" });
    // Domain resolution still works; the address is dropped only on the length bar, never silently
    // pointed at the wrong domain. If a future short token clears the cap, this must be on-domain.
    if (addr !== null) expect(addr).toMatch(/@mail\.example\.com$/);
    expect(findRefFromChase(chaseLocal("a@b.com", "greenhouse:x:1")).findId).toBe("a@b.com:greenhouse:x:1");
    process.env.CHARLIE_FROM = prev;
  });

  it("returns null when required parts are missing (no fake address)", () => {
    expect(chaseReplyTo({ email: "", jobId: "x", from: "c@d.com" })).toBeNull();
    expect(chaseReplyTo({ email: "a@b.com", jobId: "", from: "c@d.com" })).toBeNull();
    expect(chaseReplyTo({ email: "a@b.com", jobId: "x", from: "no-domain" })).toBeNull();
  });

  it("fails closed on a tampered / forged token (HMAC) -> null find", () => {
    // Built directly: chaseReplyTo returns null here, and deriving the token from that would quietly
    // turn this into a test of the string "null" — coverage that looks alive but proves nothing.
    const tampered = chaseLocal("jane@example.com", "lever:co:1").replace(/.$/, (c) => (c === "A" ? "B" : "A")); // flip the last char
    expect(findRefFromChase(tampered)).toBeNull();
    expect(findRefFromChase("chase+not-a-real-token")).toBeNull();
  });

  it("ignores a non-chase local-part", () => {
    expect(findRefFromChase("track+abc")).toBeNull();
    expect(findRefFromChase("chase")).toBeNull(); // no token
    expect(findRefFromChase("")).toBeNull();
  });
});
