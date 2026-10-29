// font-guard.test.mjs — the marketing site is set in ONE font: Courier Prime mono (--mono).
// This guard fails the build the moment a second typeface reappears on the site.
// Run: node app/font-guard.test.mjs  (wired into `npm test` as test:font, so it runs in CI).
//
// If this fails, the fix is NOT to weaken the guard: use var(--mono).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url)); // this file lives in app/

// The ONE font — the only family name and the only CSS var allowed to carry a typeface.
const ALLOWED_FONT_NAME = "Courier Prime";
// font-family values that are allowed. Anything else is a violation.
const ALLOWED_FONT_FAMILY_VALUES = [
  "var(--mono)",
  "inherit",
  `"Courier Prime", ui-monospace, Menlo, monospace`, // the raw stack, if ever used inline
];

// Walk app/ for the files that can carry type (skip node_modules / build output).
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(css|tsx|ts|jsx|js)$/.test(entry) && !full.endsWith("font-guard.test.mjs")) out.push(full);
  }
  return out;
}

const FILES = walk(APP_DIR);

// Strip /* ... */ CSS comments and // line comments so a mention of an old font in a comment
// (e.g. "was Sanchez") is not flagged. We only police live code.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // keep http:// intact via the [^:] guard
}

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── 1. No next/font imports anywhere in app/ (that is how the extra families kept coming back) ──
test("no next/font import in app/", () => {
  const offenders = [];
  for (const f of FILES) {
    const src = stripComments(readFileSync(f, "utf8"));
    const m = src.match(/from\s+["']next\/font(?:\/\w+)?["']/);
    if (m) offenders.push(`${f}: ${m[0]}`);
  }
  assert.equal(offenders.length, 0, `next/font is banned in app/ — use var(--mono):\n  ${offenders.join("\n  ")}`);
});

// ── 2. The only @font-face is Courier Prime ───────────────────────────────────────────────
test("the only @font-face is Courier Prime", () => {
  const offenders = [];
  for (const f of FILES) {
    const src = stripComments(readFileSync(f, "utf8"));
    const faces = src.match(/@font-face\s*\{[^}]*\}/g) || [];
    for (const face of faces) {
      if (!face.includes(ALLOWED_FONT_NAME)) offenders.push(`${f}: ${face.replace(/\s+/g, " ").slice(0, 80)}...`);
    }
  }
  assert.equal(offenders.length, 0, `only the Courier Prime @font-face is allowed:\n  ${offenders.join("\n  ")}`);
});

// ── 3. Every font-family value is the mono stack / var(--mono) / inherit ─────────────────
test("every font-family value is the one mono stack", () => {
  const offenders = [];
  for (const f of FILES) {
    const src = stripComments(readFileSync(f, "utf8"));
    // Match `font-family: <value>;` in CSS. (@font-face's own `font-family:` names the face
    // Courier Prime, which is fine — it's caught/allowed by rule 2's family check anyway.)
    const re = /font-family\s*:\s*([^;}\n]+)[;}\n]/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      const value = m[1].trim().replace(/\s+/g, " ");
      const ok =
        value === `"${ALLOWED_FONT_NAME}"` || // the @font-face declaration itself
        ALLOWED_FONT_FAMILY_VALUES.some((v) => value === v);
      if (!ok) offenders.push(`${f}: font-family: ${value}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `font-family must be var(--mono) (or inherit) — no second typeface:\n  ${offenders.join("\n  ")}`,
  );
});

// ── 4. No stale font CSS vars (--serif/--roboto/--caveat/--bser/--bsans) are read anywhere ──
test("no dead font vars are referenced", () => {
  const banned = ["--serif", "--roboto", "--caveat", "--bser", "--bsans"];
  const offenders = [];
  for (const f of FILES) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const v of banned) {
      if (src.includes(`var(${v})`)) offenders.push(`${f}: var(${v})`);
    }
  }
  assert.equal(offenders.length, 0, `these font vars are retired — use var(--mono):\n  ${offenders.join("\n  ")}`);
});

// ── runner ───────────────────────────────────────────────────────────────────────────
console.log(`font-guard: scanning ${FILES.length} files under app/`);
for (const [name, fn] of tests) {
  try {
    fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${pass}/${tests.length} passed`);
if (pass !== tests.length) process.exitCode = 1;
