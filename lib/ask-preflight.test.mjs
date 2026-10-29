// lib/ask-preflight.test.mjs — the check that the running server is the code we just tested.
//
// Every other guard in this repo asks "is the code correct?". This one asks "is the correct code the
// code that is RUNNING?": an ask sent against a server built before its handler existed loses the answers.

import { describe, it, expect } from "vitest";
import { assertAskDeployable } from "./ask-preflight.mjs";
import { ASK_TEMPLATES } from "./open-ask.mjs";

const health = (build) => async () => ({ ok: true, json: async () => ({ build }) });

// A FIXED id on BOTH sides. The real buildId() hashes the working tree, so a test that computes it
// twice races anything that writes a file in between (snapshot writes under the full suite). What is
// under test is the COMPARISON, not the hashing.
const MINE = "abc123def456";

describe("sending an ask", () => {
  it("goes ahead when the server is running this exact tree", async () => {
    const r = await assertAskDeployable("client-checkin", { fetch: health(MINE), mine: MINE });
    expect(r.ok).toBe(true);
  });

  it("REFUSES when the server is running different code", async () => {
    await expect(assertAskDeployable("client-checkin", { fetch: health("deadbeefcafe"), mine: MINE }))
      .rejects.toThrow(/refusing to send/i);
  });

  it("names both builds, so the operator knows which way round it is", async () => {
    await expect(assertAskDeployable("client-checkin", { fetch: health("deadbeefcafe"), mine: MINE }))
      .rejects.toThrow(new RegExp(MINE));
  });

  it("REFUSES when it cannot reach the server at all", async () => {
    // An unreachable health check must not read as "fine": a check that stops checking must not keep
    // reporting success.
    const dead = async () => { throw new Error("ECONNREFUSED"); };
    await expect(assertAskDeployable("client-checkin", { fetch: dead, mine: MINE }))
      .rejects.toThrow(/could not reach/i);
  });
});

describe("sending something that is not an ask", () => {
  it("is unaffected, because nothing is waiting on a reply", async () => {
    const r = await assertAskDeployable("breaking-silence", { fetch: health("deadbeefcafe"), mine: MINE });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("not an ask");
  });

  it("is decided by the same registry /inbound reads", () => {
    expect(ASK_TEMPLATES).toContain("client-checkin");
    expect(ASK_TEMPLATES).not.toContain("breaking-silence");
  });
});
