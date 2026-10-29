// lib/ask-registry.test.mjs — a script that asks a question must be in the ask registry.
//
// A stale ASK_TEMPLATES list (lib/open-ask.mjs) does not fail on its own: it quietly stops recognising answers,
// and /inbound treats a reply to the question as a preference update. This test reads every send script and fails
// when one whose copy asks a question is not registered.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { ASK_TEMPLATES } from "./open-ask.mjs";

const SCRIPTS = new URL("../scripts/", import.meta.url);

/** The template name a send script files under, from its own `const TEMPLATE = "..."`. */
function templateOf(src) {
  const m = src.match(/const\s+TEMPLATE\s*=\s*["'`]([^"'`]+)["'`]/);
  return m ? m[1] : null;
}

/**
 * Does this script ASK, or does it TELL?
 *
 * Judged on the RENDERED COPY rather than the script source: a question mark anywhere in a script would
 * flag status updates that ask nothing. What makes a template an ask is that the person is expected to
 * write back with an answer, and the only reliable sign of that is a question in the copy itself.
 */
const KIT = readFileSync(new URL("../email-kit.mjs", import.meta.url), "utf8");

function rendererOf(src) {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'`][^"'`]*email-kit\.mjs["'`]/);
  if (!m) return null;
  return (m[1].match(/render\w+/g) || [])[0] || null;
}

function copyOf(fnName) {
  const i = KIT.indexOf(`export function ${fnName}(`);
  if (i < 0) return "";
  const end = KIT.indexOf("\nexport function ", i + 1);
  return KIT.slice(i, end < 0 ? KIT.length : end);
}

function asksSomething(src) {
  const fn = rendererOf(src);
  if (!fn) return false;
  const body = copyOf(fn);
  // ONLY THE `text:` FIELD, which is the plaintext message: the whole function body holds ternaries
  // (`const nm = name ? ...`), and a ternary is not a question.
  const t = body.match(/\n\s*text:\s*`([\s\S]*?)`,\n/);
  if (!t) return false;
  // AND STRIP THE INTERPOLATIONS. `${name ? ... }` is a ternary living inside the template literal,
  // so even the plaintext field carries JavaScript question marks. What is left after removing every
  // ${...} is the prose the person actually reads, and a question mark there is a real question.
  const prose = t[1].replace(/\$\{[\s\S]*?\}/g, " ").replace(/https?:\/\/\S+/g, "");
  return /\?/.test(prose);
}

describe("every send script that asks a question is registered", () => {
  const offenders = [];
  for (const f of readdirSync(SCRIPTS)) {
    if (!f.endsWith(".mjs")) continue;
    const src = readFileSync(new URL(f, SCRIPTS), "utf8");
    if (!/sendGuarded/.test(src)) continue;          // not a sender
    const t = templateOf(src);
    if (!t) continue;                                 // no single template name to register
    if (!asksSomething(src)) continue;                // it tells rather than asks
    if (!ASK_TEMPLATES.includes(t)) offenders.push(`${f} sends "${t}"`);
  }

  it("no ask is missing from ASK_TEMPLATES", () => {
    expect(offenders, `these ask a question and are not in lib/open-ask.mjs:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  // Registering it is not enough: the send can still run against a server built before the entry existed. So an
  // ask sender must also refuse to run when the deployed build is not this build (lib/ask-preflight.mjs).
  it("every ask sender refuses to run against a server built from other code", () => {
    const unguarded = [];
    for (const f of readdirSync(SCRIPTS)) {
      if (!f.endsWith(".mjs")) continue;
      const src = readFileSync(new URL(f, SCRIPTS), "utf8");
      if (!/sendGuarded/.test(src)) continue;
      const t = templateOf(src);
      if (!t || !ASK_TEMPLATES.includes(t)) continue;
      if (!/assertAskDeployable\s*\(/.test(src)) unguarded.push(`${f} sends the ask "${t}"`);
    }
    expect(
      unguarded,
      `these send an ask without calling assertAskDeployable (lib/ask-preflight.mjs), so they can go\n` +
      `out against a server that cannot handle the replies:\n  ${unguarded.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the registry is not back down to one entry", () => {
    // The shape of the original bug: a list with a single name in it, and a comment asking politely.
    expect(ASK_TEMPLATES.length).toBeGreaterThan(1);
    expect(ASK_TEMPLATES).toContain("studio-ask");
  });

});
