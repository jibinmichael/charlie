// grounding-verify.test.mjs — the fence on the verifier's reliability.
//
// WHY THIS EXISTS: when the verifier emits malformed JSON, the send is HELD. Holding is correct (we
// never send a claim we could not verify), but a single syntax flake on an unconstrained model call
// would cost a person their role for the day, because the scheduler `continue`s the user loop.
//
// Two things prevent that, and both are pinned here:
//   1. output_config.format (GroundingVerdictFormat) — schema-valid by construction.
//   2. ONE retry when a reply still can't be read — rare, not impossible.
//
// The line this must never cross: the retry buys ANY verdict, never a FRIENDLIER one. Re-asking until
// the auditor stops objecting would game the moat. So a readable verdict — especially "high" — is
// returned from the first attempt and never re-rolled. That invariant is asserted below.
//
// The Anthropic client is injected; no live API key is read, so this runs in CI.

import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyGrounding } from "./grounding-verify.mjs";
import { GroundingVerdictFormat } from "./lib/schemas/grounding-verdict.mjs";

// The flag is read per call, so tests set it per case and always restore it.
const setFlag = (v) => { if (v === undefined) delete process.env.VERIFY_CONSTRAINED_DECODE; else process.env.VERIFY_CONSTRAINED_DECODE = v; };
afterEach(() => setFlag(undefined));

const SOURCE = "Maya Chen. Product designer, 6 years. Contributed to the Lumen design system at Acme.";
const ARTIFACT = "You led the Lumen design system at Acme.";

const reply = (text) => ({ content: [{ type: "text", text }] });
const CLEAN = JSON.stringify({ severity: "none", violations: [] });
const HIGH = JSON.stringify({ severity: "high", violations: [{ claim: "you led the Lumen design system", issue: "source says 'contributed to'" }] });
const GARBAGE = '```json\n{"severity": "none", "violations": [{,,,\n';

// A stub Anthropic client that replays a scripted list of replies, one per call.
function stubClient(...replies) {
  const create = vi.fn(async () => {
    if (!replies.length) throw new Error("verifier called more times than the test scripted");
    return replies.shift();
  });
  return { messages: { create } };
}

const verify = (client) => verifyGrounding({ sourceText: SOURCE, artifactText: ARTIFACT, client });

// The flag mirrors the matcher's MATCH_CONSTRAINED_DECODE: default OFF leaves the request unchanged
// byte for byte, so constrained decoding is an explicit opt-in. It matters
// because this call is fail-closed: a schema the API rejected would 400 -> errored -> shouldHold ->
// every role held, on an unattended run. The flag is the lever that makes that a config
// change, not a deploy.
describe("verifyGrounding — constrained decoding is behind VERIFY_CONSTRAINED_DECODE", () => {
  it("attaches output_config.format when the flag is `on`", async () => {
    setFlag("on");
    const client = stubClient(reply(CLEAN));
    await verify(client);
    expect(client.messages.create.mock.calls[0][0].output_config).toEqual({ format: GroundingVerdictFormat });
  });

  it("is INERT by default — the request is byte-identical to today's", async () => {
    setFlag(undefined);
    const client = stubClient(reply(CLEAN));
    await verify(client);
    expect(client.messages.create.mock.calls[0][0].output_config).toBeUndefined();
  });

  it.each([["off"], ["false"], ["0"], [""], ["ON_MAYBE"], ["yes"]])("stays off for a non-`on` value (%s) — opt-in, never inferred", async (v) => {
    setFlag(v);
    const client = stubClient(reply(CLEAN));
    await verify(client);
    expect(client.messages.create.mock.calls[0][0].output_config).toBeUndefined();
  });

  it("accepts `ON` / `On` (case-insensitive, like MATCH_CONSTRAINED_DECODE)", async () => {
    for (const v of ["ON", "On"]) {
      setFlag(v);
      const client = stubClient(reply(CLEAN));
      await verify(client);
      expect(client.messages.create.mock.calls[0][0].output_config, `"${v}" should enable`).toEqual({ format: GroundingVerdictFormat });
    }
  });

  it.each([[undefined], ["on"]])("the retry works with the flag %s (the retry is NOT flagged)", async (v) => {
    setFlag(v);
    const client = stubClient(reply(GARBAGE), reply(CLEAN));
    expect(await verify(client)).toMatchObject({ ok: true, severity: "none" });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("still sends the versioned prompt as the system turn (the constraint is not a prompt change)", async () => {
    const client = stubClient(reply(CLEAN));
    await verify(client);
    const req = client.messages.create.mock.calls[0][0];
    expect(req.system).toContain("grounding auditor");
    expect(req.messages[0].content).toContain("## ARTIFACT");
  });
});

describe("verifyGrounding — the retry (this is the bug that lost a real role)", () => {
  // THE REGRESSION TEST: without the retry this returns errored:true and the person gets no email.
  it("garbage then valid → recovers and SENDS (one flake no longer costs a role)", async () => {
    const client = stubClient(reply(GARBAGE), reply(CLEAN));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: true, severity: "none" });
    expect(r.errored).toBeFalsy();
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("garbage then garbage → HOLDS (fail closed; never send unverified)", async () => {
    const client = stubClient(reply(GARBAGE), reply(GARBAGE));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: false, errored: true, reason: "unparseable verifier output" });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("retries a schema-malformed reply too (readable JSON, wrong shape, is still no verdict)", async () => {
    const client = stubClient(reply(JSON.stringify(["not", "an", "object"])), reply(CLEAN));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: true, severity: "none" });
  });

  it("holds when BOTH replies are schema-malformed, reporting the schema reason", async () => {
    const client = stubClient(reply('"a bare string"'), reply('"a bare string"'));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: false, errored: true, reason: "verifier output failed schema" });
  });

  it("retries AT MOST once (a flake costs one extra call, never an unbounded loop)", async () => {
    const client = stubClient(reply(GARBAGE), reply(GARBAGE));
    await verify(client);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("logs the flake when it recovers (a silent recovery hides a real failure rate)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await verify(stubClient(reply(GARBAGE), reply(CLEAN)));
      expect(spy.mock.calls.flat().join(" ")).toMatch(/retrying once/i);
    } finally {
      spy.mockRestore();
    }
  });
});

// The moat's boundary. Constrained decoding + retry fix SYNTAX. They must not touch MEANING.
describe("verifyGrounding — the retry buys a verdict, never a friendlier one", () => {
  it("a high-severity verdict is returned from attempt ONE and never re-rolled", async () => {
    // Scripted so a second call would return a CLEAN pass. If the code ever re-asked on a verdict it
    // did not like, this test would see ok:true — the moat quietly gone. It must see the hold.
    const client = stubClient(reply(HIGH), reply(CLEAN));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: false, severity: "high" });
    expect(r.violations).toHaveLength(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1); // never asked twice
  });

  it("a clean verdict is returned from attempt ONE (no wasted call on the happy path)", async () => {
    const client = stubClient(reply(CLEAN));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: true, severity: "none" });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("severity drift still fails CLOSED after a retry (normalize stays the semantic gate)", async () => {
    // Constrained decoding makes "critical" unemittable, but the semantic gate must not be relaxed on
    // its account — an un-constrained reply naming violations under an unknown severity still holds.
    const drifted = JSON.stringify({ severity: "critical", violations: [{ claim: "you led it", issue: "inflated" }] });
    const client = stubClient(reply(GARBAGE), reply(drifted));
    const r = await verify(client);
    expect(r).toMatchObject({ ok: false, severity: "high" });
  });
});

describe("verifyGrounding — contract preserved (it NEVER throws)", () => {
  it("a transport error is uncertainty → held, not thrown, and NOT retried", async () => {
    // Retrying is scoped to unreadable replies. A transport failure is preflight's domain: re-asking
    // would double every call during an outage, and a schema-rejected request would 400 twice.
    const create = vi.fn(async () => { throw new Error("connection reset"); });
    const r = await verify({ messages: { create } });
    expect(r).toMatchObject({ ok: false, errored: true, reason: "connection reset" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("nothing to check (missing source or artifact) is skipped, not held or called", async () => {
    const client = stubClient();
    expect(await verifyGrounding({ sourceText: "", artifactText: ARTIFACT, client })).toMatchObject({ skipped: true, ok: true });
    expect(await verifyGrounding({ sourceText: SOURCE, artifactText: "", client })).toMatchObject({ skipped: true, ok: true });
    expect(await verifyGrounding()).toMatchObject({ skipped: true, ok: true });
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});
