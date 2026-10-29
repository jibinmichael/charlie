// scan-only.test.mjs — engine:scan runs the job scan WITHOUT the send half.
//
// Vacancy duration is a real measure of skill scarcity, and accruing that history must not require
// running the daily send: a missed scan is recoverable, a wrong email in a real inbox is not.
//
// This parses the real script string, because a comment promising "engine:scan does not send"
// cannot enforce it and a future edit to package.json would not be reading this file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

// Everything that can put a message in somebody's inbox.
const SENDERS = ["scheduler.mjs", "newsletter.mjs", "digest.mjs", "first-role.mjs", "market-briefing.mjs", "run-charlie.mjs"];

describe("engine:scan", () => {
  it("exists", () => {
    expect(scripts["engine:scan"], "package.json has no engine:scan").toBeTruthy();
  });

  it("runs the scan", () => {
    expect(scripts["engine:scan"]).toContain("scan-jobs.mjs");
  });

  it("invokes nothing that can send", () => {
    for (const s of SENDERS) {
      expect(scripts["engine:scan"], `engine:scan invokes ${s}, which sends`).not.toContain(s);
    }
  });

  it("engine:run still does send, so the two cannot be confused", () => {
    // if this ever fails, the send pipeline moved and the guard above is checking the wrong names
    expect(scripts["engine:run"]).toContain("scheduler.mjs");
  });

  it("keeps the pre-scan preflight", () => {
    expect(scripts["engine:scan"]).toContain("preflight.mjs --phase=pre-scan");
  });
});
