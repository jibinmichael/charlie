// email-font-tokens.test.mjs — one typeface, defined once, used everywhere.
//
// WHY. A one-off sender that hand-rolls its own paragraph ships a different typeface, and nobody sees
// a diff because a one-off script has no snapshot. The scripts that send corrections and apologies
// are exactly the emails a person reads most carefully, so they are held to the same tokens.
//
// THE RULE. Font stacks live in emails/tokens.mjs. Anything that produces a user-facing email uses
// `para` from email-kit.mjs, or the kit's own helpers, and never writes `font-family:` with a literal
// family name in it. A `font-family:${SANS}` interpolation is fine; that IS the token.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// A literal family name inside a font-family declaration. `font-family:${SANS}` does not match,
// because that is the token being used correctly.
const HARDCODED = /font-family:\s*['"]?(?:-apple-system|BlinkMacSystem|Avenir|Helvetica|Arial|Georgia|'Segoe|"Segoe|Roboto|Menlo|Sanchez|Times|ui-monospace|Consolas|serif|sans-serif|monospace)/i;

// Owner-only alarm mail. These reach one inbox, never a user, and a monitoring alert is not a brand
// surface. Listed rather than silently skipped, so the exemption is a decision somebody can argue with.
const OWNER_ONLY = new Set(["watchdog.mjs", "preflight.mjs"]);

/** Every file that can produce an email body: the kit, the role email, and every sender in scripts/. */
function emailProducers() {
  // HAND-MAINTAINED, AND THAT IS THE KNOWN WEAKNESS: a stale list does not fail, it just quietly
  // stops checking. Add the file when you add a renderer; the `length > 4` assertion below is the
  // only thing standing behind that sentence.
  const out = ["email-kit.mjs", "render-email.mjs", "render-invite.mjs", "render-confirmation.mjs", "render-reply.mjs"].filter((f) => existsSync(join(ROOT, f)));
  for (const f of readdirSync(join(ROOT, "scripts"))) {
    if (!f.endsWith(".mjs")) continue;
    const src = read(join("scripts", f));
    if (/emailShell|renderEmail|sendGuarded/.test(src)) out.push(join("scripts", f));
  }
  return out;
}

describe("no email hardcodes a font stack", () => {
  const files = emailProducers();

  it("found the files that produce email (an empty list would pass everything)", () => {
    expect(files.length).toBeGreaterThan(4);
    expect(files).toContain("email-kit.mjs");
  });

  for (const f of files) {
    if (OWNER_ONLY.has(f)) continue;
    it(`${f} uses the tokens`, () => {
      const offenders = read(f)
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => HARDCODED.test(line) && !line.startsWith("//") && !line.startsWith("*"));
      expect(
        offenders.map((o) => `${f}:${o.n}  ${o.line.slice(0, 90)}`),
        `hardcoded font stack. Use \`para\` from email-kit.mjs, or a token from emails/tokens.mjs.`,
      ).toEqual([]);
    });
  }

  it("the kit still exports the paragraph helper the rule depends on", () => {
    // Without this, the rule above has no supported alternative and everyone hand-rolls again.
    expect(read("email-kit.mjs")).toMatch(/export \{ p as para \}/);
  });

  it("the tokens themselves are the ONE place a family name is written", () => {
    const tokens = read("emails/tokens.mjs");
    expect(tokens).toMatch(/Avenir Next/);
    expect(tokens).toMatch(/Sanchez/);
  });
});
