// role-attachments.test.mjs — the role email carries no tailored resume or cover letter.
//
// The tailored resume and cover letter are not generated or attached to role emails; "how to position
// you" is the email's primary payload. Only ONE thing may ride along with a role email: a resolved
// referral's intro message (US-only in practice because both senders gate the referral on region). It
// ships ATTACHED but is NEVER named in the email body (no "Attached: intro message." footnote).
//
// Every sender of a role email is checked here, so a caller that drifts from the decision fails CI
// instead of quietly mailing retired attachments.
//
// EXEMPT: intro@ (server/charlie-remote.ts) attaches the tailored RESUME a person drags into a warm
// intro. That is a different email, not the role email.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const read = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8");

// Every sender that puts a ROLE email in an inbox. prepare@ (server/charlie-remote.ts) is NOT here.
const ROLE_SENDERS = [
  "scheduler.mjs",              // the daily cron — every live user
  "first-role.mjs",             // the first email a new user ever gets
  "scripts/send-india-first.mjs",
  "scripts/send-finding.mjs",
];

describe("no role-email sender generates or attaches the retired tailored docs", () => {
  for (const file of ROLE_SENDERS) {
    const src = read(file);
    it(`${file} does not import buildEmailAttachments`, () => {
      // A commented mention is fine (both scripts carry a "deliberately NOT imported" note); a real
      // import statement is not.
      expect(src, `${file} imports buildEmailAttachments — the resume/cover are not part of the role email. Only a resolved referral's intro message may be attached.`)
        .not.toMatch(/^\s*import\s+\{[^}]*buildEmailAttachments/m);
    });
    it(`${file} does not call buildEmailAttachments`, () => {
      expect(src.replace(/^\s*\/\/.*$/gm, ""), `${file} calls buildEmailAttachments`).not.toMatch(/buildEmailAttachments\s*\(/);
    });
  }
});

describe("the ONE thing that may still ride along is a resolved referral's intro", () => {
  for (const file of ["scheduler.mjs", "scripts/send-finding.mjs"]) {
    const src = read(file);
    it(`${file} starts its attachment list empty`, () => {
      expect(src).toMatch(/const attachments = \[\]/);
    });
    it(`${file} only ever pushes the referral's introAttachment`, () => {
      const pushes = [...src.matchAll(/attachments\.push\(([^)]*)\)/g)].map((m) => m[1].trim());
      expect(pushes.length, `${file} should push at most the intro`).toBeLessThanOrEqual(1);
      for (const p of pushes) expect(p).toMatch(/introAttachment/);
    });
  }
});

describe("the warm intro stays exempt (its resume attachment is a different feature)", () => {
  // Charlie does not write your CV on request. What survives is intro@: it attaches the tailored
  // RESUME a person drags into a warm intro. If this fails, the retirement was over-applied and the
  // warm intro lost its attachment too.
  it("server/charlie-remote.ts still builds the resume for a warm intro", () => {
    expect(read("server/charlie-remote.ts")).toMatch(/buildEmailAttachments/);
  });
  it("the prepare@ route is gone, and no template offers a tailored cover letter", () => {
    expect(read("server/charlie-remote.ts")).not.toMatch(/template:\s*"inbound:prepare"/);
    expect(read("email-kit.mjs")).not.toMatch(/mailto:prepare@/);
  });
});

describe("the role email body NEVER names an attachment", () => {
  it("render-email builds no 'Attached:' footnote", () => {
    // The intro message ships attached but is never mentioned in the body (also locked by the
    // ROLE_RARE snapshot's not.toContain assertion).
    // strip line comments first (a comment may mention the retired footnote); the RENDERED code must not.
    expect(read("render-email.mjs").replace(/^\s*\/\/.*$/gm, ""), "render-email.mjs must not render any 'Attached:' footnote").not.toMatch(/Attached:/);
  });
});
