// lib/inbound-rate.test.mjs — the per-address hourly brake on /inbound.
//
// The expensive step (a full Opus dossier build) runs early on /inbound, so the brake must cap a
// flood from one address and must sit before that step in the real handler.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { noteInboundFrom, _resetInboundRate } from "./inbound-rate.mjs";

describe("noteInboundFrom", () => {
  beforeEach(() => _resetInboundRate());
  afterEach(() => { delete process.env.INBOUND_MAX_PER_HOUR; _resetInboundRate(); });

  it("lets an ordinary conversation through untouched", () => {
    // A real person: writes in, answers a question, sends a resume, follows up. Nowhere near the limit.
    for (let i = 0; i < 6; i++) expect(noteInboundFrom("real@example.com").allowed).toBe(true);
  });

  it("STOPS a flood — the 200-email case, which is 200 Opus builds", () => {
    let allowed = 0;
    for (let i = 0; i < 200; i++) if (noteInboundFrom("flood@example.com").allowed) allowed++;
    expect(allowed).toBe(12);          // the default cap, not 200
    expect(allowed).toBeLessThan(200);
  });

  it("counts each address separately — one abuser cannot silence everyone else", () => {
    for (let i = 0; i < 50; i++) noteInboundFrom("flood@example.com");
    expect(noteInboundFrom("innocent@example.com").allowed).toBe(true);
  });

  it("is case and whitespace insensitive, so trivial variation does not reset the count", () => {
    for (let i = 0; i < 12; i++) noteInboundFrom("Same@Example.com");
    expect(noteInboundFrom("  same@example.com  ").allowed).toBe(false);
  });

  it("forgets after the window, so a blocked person is not blocked forever", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) noteInboundFrom("burst@example.com", t0);
    expect(noteInboundFrom("burst@example.com", t0).allowed).toBe(false);
    // one hour and a second later
    expect(noteInboundFrom("burst@example.com", t0 + 3_600_001).allowed).toBe(true);
  });

  it("honours INBOUND_MAX_PER_HOUR", () => {
    process.env.INBOUND_MAX_PER_HOUR = "2";
    expect(noteInboundFrom("x@example.com").allowed).toBe(true);
    expect(noteInboundFrom("x@example.com").allowed).toBe(true);
    expect(noteInboundFrom("x@example.com").allowed).toBe(false);
  });

  // FAILS OPEN on an address we cannot key. Refusing mail we cannot even identify is a bigger failure
  // than letting it through — signature + sender-auth upstream are what defend against forgery.
  it("fails OPEN on a missing or junk address", () => {
    for (const v of [null, undefined, "", "   "]) expect(noteInboundFrom(v).allowed).toBe(true);
  });

  it("reports the count and limit, so the drop can be logged with a reason", () => {
    const r = noteInboundFrom("y@example.com");
    expect(r.count).toBe(1);
    expect(r.limit).toBe(12);
  });
});

// ── where it sits in the handler ─────────────────────────────────────────────────────────────────
// The brake is only worth anything if it runs BEFORE the expensive step. A refactor that moved it
// below the dossier build would leave every test above passing while the bill came back — so this
// parses the REAL handler, the way cron-chain.test.mjs parses the real chain.
describe("the limiter runs before anything expensive", () => {
  const SERVER = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");
  const at = (re) => SERVER.search(re);

  it("is called before the onboarding build can be reached", () => {
    const limiter = at(/const rate = noteInboundFrom\(/);
    const bio = at(/substantiveBio\(body\)/);
    expect(limiter).toBeGreaterThan(-1);
    expect(bio).toBeGreaterThan(-1);
    expect(limiter).toBeLessThan(bio);
  });

  it("drops SILENTLY — no send on the rate-limited path", () => {
    // Replying to a flood doubles it, and on a spoofed sender it makes Charlie the one sending
    // unsolicited mail. The block must return, not reply.
    const block = SERVER.slice(at(/if \(!rate\.allowed\)/), at(/if \(!rate\.allowed\)/) + 400);
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/await send\(|sendGuarded/);
  });

  it("sits AFTER the self/system-sender check, so our own bounces cost nobody their quota", () => {
    expect(at(/mailer-daemon\|postmaster/)).toBeLessThan(at(/const rate = noteInboundFrom\(/));
  });
});
