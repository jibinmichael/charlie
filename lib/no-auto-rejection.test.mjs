// no-auto-rejection.test.mjs — Charlie never tells anybody no by itself.
//
// THE RULE. A rejection cannot produce an interview, which is the only outcome in our lane. It is the
// one email where being wrong costs the recipient something, and the only one that cannot be put
// right by writing to them again later. So no automated path may send one. Silence, or a human.
//
// WHY IT IS A TEST AND NOT A COMMENT. A rejection sent on the strength of a model score inherits every
// error in the screen behind that score (a quote verifier that drops genuine evidence silently lowers
// scores). A comment saying "do not automate this" would not stop that; an import that is not there
// does. Same shape as drip-removal.test.mjs, which fails CI if a deleted drip comes back.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/** Every file that could plausibly send: the scripts, the server, and the root senders. */
function sendingFiles() {
  const out = [];
  for (const dir of ["scripts", "lib", "server", "."]) {
    let names = [];
    try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
    for (const n of names) {
      if (!/\.(mjs|ts)$/.test(n) || /\.test\.(mjs|ts)$/.test(n)) continue;
      out.push(dir === "." ? n : `${dir}/${n}`);
    }
  }
  return out;
}

describe("no automated path can send a rejection", () => {
  const files = sendingFiles();

  it("finds the files it is supposed to be checking", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files).toContain("scripts/send-putforward.mjs");
    expect(files.length).toBeGreaterThan(40);
  });

  it("nothing imports or calls the rejection template", () => {
    // Imports and calls, not mentions: a comment explaining why it is absent is allowed.
    const uses = (src) => /import[^;]*\brenderRepresentNo\b/.test(src) || /\brenderRepresentNo\s*\(/.test(src);
    const offenders = files.filter((f) => f !== "email-kit.mjs" && uses(read(f)));
    expect(offenders).toEqual([]);
  });

  it("the template itself may stay, for a human to use deliberately", () => {
    // Deleting it would be the wrong fix: a person may still want to send one by hand, and having to
    // rewrite the copy under pressure is how a careless sentence reaches somebody.
    expect(read("email-kit.mjs")).toMatch(/export function renderRepresentNo/);
  });

});
