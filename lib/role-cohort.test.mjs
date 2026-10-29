// role-cohort.test.mjs — WHO may receive a role email.
//
// The dangerous default here is "empty means everybody": a ROLE_COHORT that goes missing would
// silently put the entire list in scope. These lock the fail-closed reading, and the
// separation from suppression (this gate must never be confused with the bounce/complaint list, which
// also blocks Charlie's replies).
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inRoleCohort, roleCohortSize } from "./role-cohort.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const ORIGINAL = process.env.ROLE_COHORT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ROLE_COHORT;
  else process.env.ROLE_COHORT = ORIGINAL;
});

describe("inRoleCohort — an allowlist that fails closed", () => {
  it("an unset ROLE_COHORT sends to NOBODY, never to everybody", () => {
    delete process.env.ROLE_COHORT;
    expect(inRoleCohort("anyone@example.com")).toBe(false);
    expect(roleCohortSize()).toBe(0);
  });

  it("a blank or comma-only value is also nobody", () => {
    for (const v of ["", "   ", ",", " , , "]) {
      process.env.ROLE_COHORT = v;
      expect(inRoleCohort("anyone@example.com")).toBe(false);
      expect(roleCohortSize()).toBe(0);
    }
  });

  it("lets exactly the listed addresses through, and nobody else", () => {
    process.env.ROLE_COHORT = "a@x.com,b@y.com";
    expect(inRoleCohort("a@x.com")).toBe(true);
    expect(inRoleCohort("b@y.com")).toBe(true);
    expect(inRoleCohort("c@z.com")).toBe(false);
    expect(roleCohortSize()).toBe(2);
  });

  it("is case and whitespace insensitive, the way real config gets typed", () => {
    process.env.ROLE_COHORT = "  A@X.com , b@Y.COM  ";
    expect(inRoleCohort("a@x.com")).toBe(true);
    expect(inRoleCohort(" B@y.com ")).toBe(true);
    expect(roleCohortSize()).toBe(2);
  });

  it("never lets a blank/null address through", () => {
    process.env.ROLE_COHORT = "a@x.com";
    for (const v of ["", "   ", null, undefined]) expect(inRoleCohort(v)).toBe(false);
  });

  it("a near-miss address is not a member (no prefix or substring matching)", () => {
    process.env.ROLE_COHORT = "a@x.com";
    expect(inRoleCohort("aa@x.com")).toBe(false);
    expect(inRoleCohort("a@x.com.evil.com")).toBe(false);
    expect(inRoleCohort("x.com")).toBe(false);
  });

  it("re-reads the env each call, so a config change does not need a restart to take effect", () => {
    process.env.ROLE_COHORT = "a@x.com";
    expect(inRoleCohort("b@y.com")).toBe(false);
    process.env.ROLE_COHORT = "a@x.com,b@y.com";
    expect(inRoleCohort("b@y.com")).toBe(true);
  });
});

// THE ALLOWLIST IS NOT A SEND GATE. A hand-maintained allowlist on the daily send would make every new
// signup invisible until somebody added their address, which is a recurring outage with a variable
// name. The module is used by operator scripts (pause-cohort, suppression-audit) that scope
// themselves to a named list on purpose, and its fail-closed "empty means NOBODY" property is what
// makes those safe. The tests above pin that.
//
// These assert the gate is absent from the send paths, and that the protections the send paths do
// rely on are wired.
describe("wiring — the allowlist gates no send path any more", () => {
  it("the daily scheduler no longer filters candidates by the cohort", () => {
    const s = read("scheduler.mjs");
    expect(s).not.toMatch(/candidates\s*=\s*candidates\.filter\(\(c\)\s*=>\s*inRoleCohort\(c\.email\)\)/);
    expect(s).not.toMatch(/inRoleCohort/);
  });

  it("the day-2 first role no longer refuses anyone for being off a list", () => {
    const f = read("first-role.mjs");
    expect(f).not.toMatch(/inRoleCohort/);
  });

  it("the completeness nudge no longer skips anyone for being off a list", () => {
    expect(read("completeness-nudge.mjs")).not.toMatch(/inRoleCohort/);
  });

  it("the protections the send path relies on are wired, and before the batch", () => {
    const s = read("scheduler.mjs");
    // suppression: dropped before we pay to score them
    expect(s).toMatch(/suppressedFlags/);
    expect(s.indexOf("suppressedFlags")).toBeLessThan(s.indexOf("runMatchBatch("));
    // out-of-market: an honest note, not a role
    expect(s).toMatch(/out-of-market/);
    // and only ACTIVE candidates are ever considered
    expect(s).toMatch(/listActiveCandidates\(\)/);
  });

  it("the inbound REPLY path still never consults the cohort", () => {
    const server = read("server/charlie-remote.ts");
    const handler = server.slice(server.indexOf('app.post("/inbound"'), server.indexOf("async function sendMailTo"));
    expect(handler).not.toMatch(/inRoleCohort/);
  });

  it("pausing is done with status, never by writing to the suppression table", () => {
    const script = read("scripts/pause-cohort.mjs");
    expect(script).toMatch(/setCandidateStatus\(/);
    expect(script).not.toMatch(/suppressAddress\(/); // suppression blocks replies AND is the deliverability record
  });
});
