// email-voice.test.mjs — the voice rules that a human cannot be relied on to remember.
//
// WHY THIS FILE EXISTS. Charlie sends from a server in one timezone to people in another, so a line
// like "this morning I sent you a read of your market" is false for most readers most of the time.
// "Today" says the same thing and is true everywhere. A test enforces this; a comment cannot.
//
// SCOPE: user-facing COPY only. The scan reads the string and template literals in the files that
// produce email text, so a variable named `morningRun` or a comment explaining the rule is not a
// violation. Time-of-day words remain legitimate in job descriptions, model prompts, and logs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Every file that puts words in front of a reader.
const COPY_FILES = [
  "email-kit.mjs",
  "render-email.mjs",
  "render-market-report.mjs",
  "render-invite.mjs",
  "render-confirmation.mjs",
];

// A time of day is a claim about the reader's clock, and Charlie does not know it.
const TIME_OF_DAY = /\b(this |that |tomorrow |yesterday )?(morning|afternoon|evening|tonight)\b/i;

/** Strip comments, then return the contents of every string / template literal. */
function copyStrings(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...noComments.matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g)].map((m) => m[0]);
}

describe("email voice: Charlie never names a time of day", () => {
  for (const file of COPY_FILES) {
    it(`${file} contains no time-of-day word in user-facing copy`, () => {
      let src;
      try {
        src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      } catch {
        return; // a one-off correction script may be retired; its absence is not a failure
      }
      const offenders = copyStrings(src).filter((s) => TIME_OF_DAY.test(s));
      expect(offenders, `say "today" instead:\n${offenders.join("\n")}`).toEqual([]);
    });
  }

  it("catches a known-bad sentence, so this test cannot pass by construction", () => {
    const bad = `p("this morning I sent you a read of your market")`;
    expect(copyStrings(bad).filter((s) => TIME_OF_DAY.test(s))).toHaveLength(1);
  });

  it("does not fire on a comment or an identifier", () => {
    const fine = `// never say morning\nconst morningRun = true;\np("today I sent you a read")`;
    expect(copyStrings(fine).filter((s) => TIME_OF_DAY.test(s))).toEqual([]);
  });
});
