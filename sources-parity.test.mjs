// sources-parity.test.mjs — every ATS family that scan-jobs can actually fetch must be
// listed in SOURCES, or its boards fetch and contribute roles while staying invisible in the funnel
// report (the stat increments are all guarded `if (stat[source])`, so an unlisted source is silently
// uncounted rather than loudly broken).
//
// This is a static parse, not an import: scan-jobs.mjs calls main() at module scope, so importing it
// would run a live scan. The invariant lives in the source text, so the check reads the source text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scan-jobs.mjs"), "utf8");

// Grab a top-level `const NAME = { ... };` block and return its first-level keys.
function objectKeys(name) {
  const start = SRC.indexOf(`const ${name} = {`);
  expect(start, `${name} object not found in scan-jobs.mjs`).toBeGreaterThan(-1);
  let i = SRC.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") {
      depth--;
      if (depth === 0) { end = j; break; }
    }
  }
  expect(end, `${name} object is unbalanced`).toBeGreaterThan(-1);
  const body = SRC.slice(i + 1, end);
  // first-level `key:` only — skip anything nested inside a template literal or comment
  const keys = new Set();
  // Strip template literals BEFORE line comments: the endpoint URLs contain `https://`, and a
  // comment-first pass would eat the rest of the line and unbalance the backticks.
  const withoutComments = body.replace(/`[^`]*`/g, "``").replace(/\/\/[^\n]*/g, "");
  let d = 0;
  for (const line of withoutComments.split("\n")) {
    const m = d === 0 && line.match(/^\s*([a-z_][a-z0-9_]*)\s*:/i);
    if (m) keys.add(m[1]);
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") d++;
      else if (ch === "}" || ch === ")" || ch === "]") d--;
    }
  }
  return keys;
}

function sourcesArray() {
  const m = SRC.match(/const SOURCES = \[([^\]]*)\]/);
  expect(m, "SOURCES array not found in scan-jobs.mjs").toBeTruthy();
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

describe("scan-jobs SOURCES parity (no silently uncounted source)", () => {
  it("lists keka", () => {
    expect(sourcesArray()).toContain("keka");
  });

  it("lists every source that has a fetchable ENDPOINT", () => {
    const sources = sourcesArray();
    const missing = [...objectKeys("ENDPOINT")].filter((s) => !sources.has(s));
    expect(missing, `these sources fetch but are uncounted in the funnel: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no SOURCES entry that cannot actually be fetched", () => {
    const endpoints = objectKeys("ENDPOINT");
    const dead = [...sourcesArray()].filter((s) => !endpoints.has(s));
    expect(dead, `these sources are reported but have no ENDPOINT: ${dead.join(", ")}`).toEqual([]);
  });

  it("keeps ENDPOINT, JOBS_KEY and EXTRACT in lockstep, so a listed source is wired end to end", () => {
    const endpoints = objectKeys("ENDPOINT");
    const jobsKeys = objectKeys("JOBS_KEY");
    const extract = objectKeys("EXTRACT");
    for (const s of endpoints) {
      expect(jobsKeys, `${s} has an ENDPOINT but no JOBS_KEY picker`).toContain(s);
      expect(extract, `${s} has an ENDPOINT but no extractor`).toContain(s);
    }
  });
});
