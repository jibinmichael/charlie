// candidate-pii.test.mjs — a bulk dump of applicants must not reach git.
//
// Applicant exports (names, addresses, phone numbers) are written to the working tree by the board
// pipeline, and `railway up` uploads the working tree, not git HEAD. .gitignore only stops the files
// somebody remembered to name, so this is the mechanical half. It catches the two shapes that are
// unambiguously a leak:
//
//   1. ANY Indian mobile number. Charlie never has a legitimate reason to commit one.
//   2. A file carrying 20+ distinct personal addresses. That is a dump, not a recipient list.
//
// If it fires, do not add an exception. Add the path to .gitignore and rebuild the file from source.

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const PHONE = /\+91[0-9]{10}/g;
const PERSONAL = /[a-zA-Z0-9._%+-]+@(?:gmail|outlook|yahoo|hotmail|zohomail|protonmail|icloud)\.[a-z.]{2,}/gi;
const BULK_THRESHOLD = 20;

// Text-ish files only. A binary would be a different kind of problem and grep would be noise.
const SKIPPABLE = /\.(png|jpg|jpeg|gif|webp|pdf|ico|woff2?|ttf|zip|lock)$/i;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((f) => f && !SKIPPABLE.test(f));
}

function read(f) {
  try {
    const s = fs.statSync(f);
    if (!s.isFile() || s.size > 8 * 1024 * 1024) return "";
    return fs.readFileSync(f, "utf8");
  } catch { return ""; }
}

// This scans `git ls-files`, so it needs a git checkout. A tarball / fresh non-git copy skips it.
const IN_GIT = spawnSync("git", ["rev-parse"], { stdio: "ignore" }).status === 0;
if (!IN_GIT) console.warn("candidate-pii.test.mjs: skipped, not inside a git repository (it scans tracked files)");

describe.skipIf(!IN_GIT)("candidate PII must not be committed", () => {
  const files = IN_GIT ? trackedFiles() : [];

  it("finds tracked files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no tracked file contains a mobile number", () => {
    const offenders = [];
    for (const f of files) {
      const hits = read(f).match(PHONE);
      if (hits) offenders.push(`${f} (${new Set(hits).size} distinct)`);
    }
    expect(
      offenders,
      `A phone number reached git. Do not allow-list it: add the path to .gitignore, remove it from ` +
        `the index, and rebuild from source.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no tracked file is a bulk dump of personal addresses", () => {
    const offenders = [];
    for (const f of files) {
      const hits = read(f).match(PERSONAL);
      if (!hits) continue;
      const n = new Set(hits.map((h) => h.toLowerCase())).size;
      if (n >= BULK_THRESHOLD) offenders.push(`${f} (${n} distinct addresses)`);
    }
    expect(
      offenders,
      `A file carrying ${BULK_THRESHOLD}+ distinct personal addresses is an applicant dump, not a ` +
        `recipient list. Add it to .gitignore and rebuild it from Tally rather than storing it here.` +
        `\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
