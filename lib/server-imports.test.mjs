// server-imports.test.mjs — every email-kit helper the server CALLS must be one it IMPORTS.
//
// server/charlie-remote.ts is `@ts-nocheck` and runs through tsx, so a helper (say `esc(...)`) that is
// called but never imported is only discovered when a real reply hits that branch and the handler
// throws `esc is not defined` — the person gets no acknowledgement and nobody is told they answered.
// A typecheck that is switched off for the file cannot catch it, so this reads the real source.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as kit from "../email-kit.mjs";

const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

/** Names brought in from email-kit.mjs, across every import statement that names that module. */
function importedFromKit(src) {
  const out = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*email-kit\.mjs["']/g)) {
    for (const n of m[1].split(",")) { const name = n.trim().split(/\s+as\s+/).pop(); if (name) out.add(name); }
  }
  return out;
}

/** Code only: a name inside a comment is not a call. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("the server imports every email-kit helper it calls", () => {
  const imported = importedFromKit(SRC);
  const body = code(SRC);

  it("finds the import at all (or this guard is checking nothing)", () => {
    expect(imported.size).toBeGreaterThan(10);
  });

  it("no exported helper is called without being imported or defined locally", () => {
    const missing = [];
    for (const name of Object.keys(kit)) {
      if (typeof kit[name] !== "function") continue;
      const called = new RegExp(`(^|[^.\\w$])${name}\\(`).test(body);
      if (!called) continue;
      const local = new RegExp(`(function\\s+${name}\\b|(const|let|var)\\s+${name}\\b)`).test(body);
      if (!imported.has(name) && !local) missing.push(name);
    }
    expect(missing, `called in server/charlie-remote.ts but never imported: ${missing.join(", ")}`).toEqual([]);
  });
});
