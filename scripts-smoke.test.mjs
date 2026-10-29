// scripts-smoke.test.mjs — every script the operator docs tell you to run must at least load.
//
// Operator scripts are run by hand, so nothing else imports them and a broken one is only found the
// day someone needs it (scripts/suppression-audit.mjs once imported a name drip-guard.mjs did not
// export, and died on start). Most scripts call main() at top level, so this NEVER executes them:
//
//   1. `node --check` parses each file (syntax only: no env, no network, no side effects);
//   2. every named import from a repo-local module is checked, statically, against the names that
//      module exports. That is the link step `node --check` skips, and the one that broke.
//
// The list is read from scripts/README.md and docs/OPERATIONS.md, so documenting a script enrols it.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DOCS = ["scripts/README.md", "docs/OPERATIONS.md"];

function documentedScripts() {
  const found = new Set();
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    for (const [, name] of text.matchAll(/([\w./-]+\.mjs)\b/g)) {
      const clean = name.replace(/^(\.\.\/)+/, "");
      // A bare name in scripts/README.md means scripts/<name>; otherwise it is repo-relative.
      for (const cand of [join("scripts", clean), clean]) {
        if (existsSync(join(ROOT, cand))) { found.add(cand); break; }
      }
    }
  }
  return [...found].sort();
}

const IMPORT_RE = /^\s*import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+[\w$]+\s*)?from\s+["']([^"']+)["']/gm;

function namedImports(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const [, def, named, spec] = m;
    if (!spec.startsWith(".")) continue; // a package, not our code
    const names = (named || "")
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (def) names.push("default");
    out.push({ spec, names });
  }
  return out;
}

function resolveLocal(fromFile, spec) {
  const p = resolve(dirname(fromFile), spec);
  for (const cand of [p, `${p}.mjs`, `${p}.ts`, `${p}.tsx`, join(p, "index.mjs")]) if (existsSync(cand)) return cand;
  return null;
}

/** The names a module exports, read from its source (follows `export * from`). */
function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const src = readFileSync(file, "utf8");
  const names = new Set();
  for (const [, n] of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/gm)) names.add(n);
  for (const [, list] of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of list.split(",")) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  if (/^\s*export\s+default\b/m.test(src)) names.add("default");
  for (const [, spec] of src.matchAll(/^\s*export\s+\*\s+from\s+["']([^"']+)["']/gm)) {
    const target = spec.startsWith(".") ? resolveLocal(file, spec) : null;
    if (target) for (const n of exportedNames(target, seen)) names.add(n);
  }
  // `export const { a, b } = …` destructuring
  for (const [, list] of src.matchAll(/^\s*export\s+const\s*\{([^}]*)\}\s*=/gm)) {
    for (const part of list.split(",")) {
      const n = part.trim().split(":").pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

const SCRIPTS = documentedScripts();

describe("documented operator scripts load", () => {
  it("found the documented scripts (an empty list would pass every case below)", () => {
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(30);
    expect(SCRIPTS).toContain("scripts/suppression-audit.mjs");
  });

  for (const file of SCRIPTS) {
    it(`${file} parses and its local imports exist`, () => {
      const abs = join(ROOT, file);
      const check = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);

      const missing = [];
      for (const { spec, names } of namedImports(readFileSync(abs, "utf8"))) {
        const target = resolveLocal(abs, spec);
        if (!target) { missing.push(`${spec} (file not found)`); continue; }
        const have = exportedNames(target);
        for (const n of names) if (!have.has(n)) missing.push(`${n} from ${relative(ROOT, target)}`);
      }
      expect(missing, `${file} imports names that are not exported`).toEqual([]);
    });
  }
});
