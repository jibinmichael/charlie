// lib/send-guard.test.mjs — the ONE send door must enforce suppression + idempotency + release-on-
// failure exactly, because every user-facing email depends on it. deps are injected
// so no Supabase is touched.
import { describe, it, expect, vi } from "vitest";
import { sendGuarded } from "./send-guard.mjs";

function harness({ suppressed = false, claim = true } = {}) {
  const calls = { stamp: 0, release: 0, send: 0 };
  const deps = {
    isSuppressed: vi.fn(async () => suppressed),
    claimSend: vi.fn(async () => claim),
    stampSend: vi.fn(async () => { calls.stamp++; }),
    releaseSend: vi.fn(async () => { calls.release++; }),
  };
  return { deps, calls };
}
const okResend = (id = "re_1") => ({ emails: { send: vi.fn(async () => ({ data: { id }, error: null })) } });

describe("sendGuarded", () => {
  const base = { email: "u@x.com", template: "role", dedupeKey: "u@x.com:job1", payload: { to: "u@x.com", subject: "s", html: "h" }, log: () => {} };

  it("sends: claims, sends with idempotencyKey, stamps the resend id", async () => {
    const { deps } = harness();
    const resend = okResend("re_abc");
    const r = await sendGuarded({ ...base, resend, idempotencyKey: "find-alert/u@x.com:job1", deps });
    expect(r).toEqual({ status: "sent", id: "re_abc" });
    expect(resend.emails.send).toHaveBeenCalledWith(base.payload, { idempotencyKey: "find-alert/u@x.com:job1" });
    // The fifth argument is the copy itself, so the record says WHAT was said and not only WHO was
    // written to: the Resend send key cannot read a sent message back.
    expect(deps.stampSend).toHaveBeenCalledWith("u@x.com", "role", "u@x.com:job1", "re_abc", { subject: "s", text: undefined });
    expect(deps.releaseSend).not.toHaveBeenCalled();
  });

  it("files the words that were sent, not just that a send happened", async () => {
    const { deps } = harness();
    const payload = { to: "u@x.com", subject: "Your update", html: "<p>hi</p>", text: "hi, here is the thing" };
    await sendGuarded({ ...base, payload, resend: okResend("re_x"), deps });
    const filed = deps.stampSend.mock.calls[0][4];
    expect(filed).toEqual({ subject: "Your update", text: "hi, here is the thing" });
  });

  describe("the leak check", () => {
    it("refuses to send copy containing an internal field name", async () => {
      const { deps } = harness();
      const resend = okResend();
      const payload = { to: "u@x.com", subject: "s", text: "I've updated your pay currency, home_place, and your pay floor." };
      const r = await sendGuarded({ ...base, payload, resend, deps });
      expect(r.status).toBe("leak_blocked");
      expect(resend.emails.send).not.toHaveBeenCalled();
    });

    it("does not burn the dedupe key on a blocked send, so the fixed copy can still go", async () => {
      // The check runs BEFORE claimSend on purpose. Claiming first would mark the message as sent,
      // and the corrected version would then be skipped as a duplicate: a leak followed by silence.
      const { deps } = harness();
      const payload = { to: "u@x.com", subject: "s", text: "your mobility_profile changed" };
      await sendGuarded({ ...base, payload, resend: okResend(), deps });
      expect(deps.claimSend).not.toHaveBeenCalled();
      expect(deps.stampSend).not.toHaveBeenCalled();
    });

    it("lets ordinary copy through untouched", async () => {
      const { deps } = harness();
      const resend = okResend();
      const payload = { to: "u@x.com", subject: "A role in Kolkata", text: "The budget goes up to 32 lakhs and it is hybrid." };
      const r = await sendGuarded({ ...base, payload, resend, deps });
      expect(r.status).toBe("sent");
      expect(resend.emails.send).toHaveBeenCalled();
    });
  });

  it("suppressed: never claims or sends", async () => {
    const { deps } = harness({ suppressed: true });
    const resend = okResend();
    const r = await sendGuarded({ ...base, resend, deps });
    expect(r.status).toBe("suppressed");
    expect(deps.claimSend).not.toHaveBeenCalled();
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it("duplicate: claim lost -> does not send", async () => {
    const { deps } = harness({ claim: false });
    const resend = okResend();
    const r = await sendGuarded({ ...base, resend, deps });
    expect(r.status).toBe("duplicate");
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it("send error -> releases the claim, reports failed (retryable)", async () => {
    const { deps } = harness();
    const resend = { emails: { send: vi.fn(async () => ({ data: null, error: "smtp down" })) } };
    const r = await sendGuarded({ ...base, resend, deps });
    expect(r.status).toBe("failed");
    expect(deps.releaseSend).toHaveBeenCalledWith("u@x.com", "role", "u@x.com:job1");
    expect(deps.stampSend).not.toHaveBeenCalled();
  });

  it("send throws -> releases the claim, never crashes the caller", async () => {
    const { deps } = harness();
    const resend = { emails: { send: vi.fn(async () => { throw new Error("network"); }) } };
    const r = await sendGuarded({ ...base, resend, deps });
    expect(r.status).toBe("failed");
    expect(deps.releaseSend).toHaveBeenCalled();
  });

  it("checks suppression against payload.to (distinct from the idempotency email)", async () => {
    const { deps } = harness();
    const resend = okResend();
    await sendGuarded({ email: "owner@x.com", template: "role", dedupeKey: "k", payload: { to: "real@y.com" }, resend, deps, log: () => {} });
    expect(deps.isSuppressed).toHaveBeenCalledWith("real@y.com");
    expect(deps.claimSend).toHaveBeenCalledWith("owner@x.com", "role", "k");
  });

  it("force: releases the prior claim so a --force re-send is not swallowed as duplicate", async () => {
    // simulate an already-claimed row: claimSend returns false UNTIL releaseSend is called.
    let claimed = true;
    const deps = {
      isSuppressed: vi.fn(async () => false),
      claimSend: vi.fn(async () => !claimed), // false while claimed
      stampSend: vi.fn(async () => {}),
      releaseSend: vi.fn(async () => { claimed = false; }),
    };
    const resend = okResend("re_forced");
    const r = await sendGuarded({ ...base, resend, force: true, deps });
    expect(deps.releaseSend).toHaveBeenCalledWith("u@x.com", "role", "u@x.com:job1"); // cleared first
    expect(r).toEqual({ status: "sent", id: "re_forced" });
  });

  it("force: drops Resend's 24h idempotencyKey so a deliberate re-send with a changed body is not 409'd", async () => {
    const { deps } = harness();
    const resend = okResend("re_forced2");
    const r = await sendGuarded({ ...base, resend, idempotencyKey: "marketgap/u@x.com/gapkey", force: true, deps });
    expect(r.status).toBe("sent");
    // non-force would pass { idempotencyKey }; force must send WITHOUT it (Resend keeps keys 24h and
    // 409s a re-send whose body changed). The internal claim is still the idempotency guarantee.
    expect(resend.emails.send).toHaveBeenCalledWith(base.payload, undefined);
  });

  it("force still refuses a suppressed recipient", async () => {
    const { deps } = harness({ suppressed: true });
    const resend = okResend();
    const r = await sendGuarded({ ...base, resend, force: true, deps });
    expect(r.status).toBe("suppressed");
    expect(resend.emails.send).not.toHaveBeenCalled();
  });

  it("omits Resend's idempotencyKey option when none is given", async () => {
    const { deps } = harness();
    const resend = okResend();
    await sendGuarded({ ...base, resend, deps });
    expect(resend.emails.send).toHaveBeenCalledWith(base.payload, undefined);
  });
});
