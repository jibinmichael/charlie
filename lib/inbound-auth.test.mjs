// lib/inbound-auth.test.mjs — a missing inbound signing secret must REJECT, never accept.
//
// The shape this guards against:
//   INBOUND_SECRETS.length === 0 || INBOUND_SECRETS.some(verify)
// With no secret configured the `||` short-circuits to TRUE and every POST is processed. The handler
// replies via Resend to the address in the payload, which would make the server an open relay on
// Charlie's sending domain.
//
// The first test below fails against that expression (which returns true for an empty secret list)
// and passes against `inboundSigOk`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { inboundSigOk, inboundSecretsMissing } from "./inbound-auth.mjs";

const alwaysVerifies = () => true;
const neverVerifies = () => false;

describe("inboundSigOk — no secret configured", () => {
  it("REJECTS when no secrets are configured, even if the verifier would say yes", () => {
    // The naive inline logic: [].length === 0 || ... -> true (ACCEPT).
    expect(inboundSigOk([], alwaysVerifies)).toBe(false);
  });

  it("proves the naive expression does the opposite, so this test cannot pass by construction", () => {
    const secrets = [];
    const oldBehaviour = secrets.length === 0 || secrets.some(alwaysVerifies);
    expect(oldBehaviour).toBe(true); // what shipped: accept
    expect(inboundSigOk(secrets, alwaysVerifies)).toBe(false); // what ships now: reject
  });
});

describe("inboundSigOk — secrets configured", () => {
  it("accepts when a configured secret verifies the request", () => {
    expect(inboundSigOk(["whsec_a"], alwaysVerifies)).toBe(true);
  });

  it("rejects when no configured secret verifies the request", () => {
    expect(inboundSigOk(["whsec_a", "whsec_b"], neverVerifies)).toBe(false);
  });

  it("accepts when the SECOND secret verifies (the inbound/delivery fallback)", () => {
    expect(inboundSigOk(["whsec_wrong", "whsec_right"], (s) => s === "whsec_right")).toBe(true);
  });

  it("ignores empty-string secrets rather than treating them as configured", () => {
    expect(inboundSigOk(["", ""], alwaysVerifies)).toBe(false);
  });

  it("requires a strict true from the verifier, not a truthy value", () => {
    expect(inboundSigOk(["whsec_a"], () => "yes")).toBe(false);
  });
});

describe("inboundSigOk — defensive (fail closed on the impossible case)", () => {
  it("rejects a non-array secrets argument", () => {
    for (const bad of [undefined, null, "whsec_a", 0, {}]) {
      expect(inboundSigOk(bad, alwaysVerifies)).toBe(false);
    }
  });

  it("rejects a non-function verifier", () => {
    for (const bad of [undefined, null, true, "verify"]) {
      expect(inboundSigOk(["whsec_a"], bad)).toBe(false);
    }
  });
});

describe("inboundSecretsMissing", () => {
  it("is true only when nothing is configured", () => {
    expect(inboundSecretsMissing([])).toBe(true);
    expect(inboundSecretsMissing(undefined)).toBe(true);
    expect(inboundSecretsMissing(["whsec_a"])).toBe(false);
  });
});

// The unit tests above prove the policy. This one proves the SERVER still uses it — the policy
// is worthless if /inbound quietly goes back to an inline check.
describe("server/charlie-remote.ts wiring", () => {
  const SERVER = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

  it("guards /inbound with inboundSigOk", () => {
    expect(SERVER).toMatch(/const sigOk = inboundSigOk\(INBOUND_SECRETS,/);
  });

  it("no longer contains the fail-open short-circuit", () => {
    expect(SERVER).not.toMatch(/INBOUND_SECRETS\.length === 0 \|\|/);
  });

  it("refuses to boot when no secret is configured", () => {
    expect(SERVER).toMatch(/inboundSecretsMissing\(INBOUND_SECRETS\)/);
    expect(SERVER).toMatch(/process\.exit\(1\)/);
  });
});
