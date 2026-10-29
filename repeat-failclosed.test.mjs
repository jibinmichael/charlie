// repeat-failclosed.test.mjs — the no-repeat rule must fail CLOSED when it cannot verify.
//
// presend-guard.mjs calls the four-vector repeat check "THE UNBREAKABLE RULE: never send the same
// role to the same person twice." But `repeatDecision` opens with `if (!sig) return null` — a falsy
// signature set reads as "not a repeat" — so a sender that swallows the signature read into null
// (`getEmailedRoleSignatures(...).catch(() => null)`) would let one transient Supabase blip silently
// disable that rule. Every caller must instead let the read throw and skip the user, as
// scheduler.mjs does. These tests pin that posture everywhere.
//
// The rule: a missed first-role is recoverable. A duplicate in a real inbox is not.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { repeatDecision, preSendGuard } from "./presend-guard.mjs";
import { canonicalJobIdentity } from "./charlie-store.mjs";

const read = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
// Region-matched on purpose: the region/eligibility gates run BEFORE the fit routing, so an
// unlocated fixture would drop for the wrong reason and hide the leak this file is about.
const job = { id: "greenhouse:acme:1", company: "Acme", title: "Senior Engineer", location: "Bengaluru, India", apply_url: "https://boards.greenhouse.io/acme/jobs/999", description: "work" };
const dossier = { headline: "Senior Engineer", location: "Bengaluru, India" };

describe("repeatDecision — the documented fail-open, pinned", () => {
  it("catches a genuine repeat when it CAN verify", () => {
    const sig = { identities: new Set([canonicalJobIdentity(job)]), roleKeys: new Set(), coreKeys: new Set(), companies: [] };
    expect(repeatDecision(job, sig)?.rule).toBe("repeat:identity");
  });

  it("DOCUMENTS the hazard: a falsy signature set reads as 'not a repeat'", () => {
    // This is not the desired behavior, it is the behavior. It is safe ONLY because every caller is
    // required to fail closed rather than hand it null. The tests below enforce that requirement.
    // If this ever changes to return a drop, delete this test and relax the callers.
    expect(repeatDecision(job, null)).toBeNull();
    expect(repeatDecision(job, undefined)).toBeNull();
  });

  it("therefore an unverifiable send would pass the guard — which is why callers must not reach here", async () => {
    const g = await preSendGuard({
      job, dossier, matcherScore: 90, signatures: null,
      getCov: async () => ({ thin: true, reason: "jd" }),
      fetchImpl: async () => ({ status: 200, json: async () => ({}), text: async () => "" }),
    });
    expect(g.decision).toBe("send"); // why callers must never pass null
  });
});

// The callers are scripts that connect on import, so their behavior cannot be executed here. Assert on
// the source — same technique as evals/rubric-lint.test.mjs.
describe("every sender fails CLOSED on an unverifiable signature read", () => {
  it("first-role.mjs does not swallow the read into null", () => {
    const src = read("first-role.mjs");
    expect(src).not.toMatch(/getEmailedRoleSignatures\([^)]*\)\s*\.catch\(\s*\(\)\s*=>\s*null\s*\)/);
  });

  it("first-role.mjs returns without sending when it cannot verify", () => {
    const src = read("first-role.mjs");
    expect(src).toMatch(/cannot verify no-repeat/i);
    expect(src).toMatch(/sending nothing/i);
  });

  it("match-one.mjs does not swallow the read into null", () => {
    const src = read("match-one.mjs");
    expect(src).not.toMatch(/getEmailedRoleSignatures\([^)]*\)\s*\.catch\(\s*\(\)\s*=>\s*null\s*\)/);
  });

  it("scheduler.mjs still lets the read throw (the path that was always correct)", () => {
    const src = read("scheduler.mjs");
    expect(src).toMatch(/getEmailedRoleSignatures\(u\.email\)/);
    expect(src).not.toMatch(/getEmailedRoleSignatures\(u\.email\)\s*\.catch/);
  });
});
