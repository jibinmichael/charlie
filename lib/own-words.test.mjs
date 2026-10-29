// own-words.test.mjs — whose words survive a reply.
//
// The case that matters: a person replies on top of THEIR OWN earlier email. A cleaner that cuts at
// the first quote marker would keep "any update?" and delete "Link to my work: <url>" — the only thing
// we had asked for — and report success.

import { describe, it, expect } from "vitest";
import { ownWords } from "./own-words.mjs";

const CHARLIE_QUOTE = `

On Mon, 17 Aug 2026 at 20:23, <charlie@mail.example.com> wrote:

> Every company asks what you actually did. Right now I cannot answer that
> for you.
`;

describe("ownWords", () => {
  it("drops a quote attributed to Charlie", () => {
    const out = ownWords(`Here is the work I owned.${CHARLIE_QUOTE}`, "someone@example.com");
    expect(out).toBe("Here is the work I owned.");
    expect(out).not.toMatch(/Every company asks/);
  });

  it("KEEPS a quote attributed to the person themselves", () => {
    // Their earlier mail is still their own words and often holds the evidence.
    const body = `Hope you are well, any update?

On Mon, 17 Aug 2026 at 20:23, Asha Rao <asha@example.com> wrote:

> Link to my work: https://portfolio.example.com/
`;
    const out = ownWords(body, "asha@example.com");
    expect(out).toMatch(/portfolio\.example\.com/);
  });

  it("cuts at Charlie's quote even when the person quoted themselves first", () => {
    const body = `Latest answer.

On Mon, 17 Aug 2026, Asha Rao <asha@example.com> wrote:

> My earlier answer, which still counts.
${CHARLIE_QUOTE}`;
    const out = ownWords(body, "asha@example.com");
    expect(out).toMatch(/Latest answer/);
    expect(out).toMatch(/still counts/);
    expect(out).not.toMatch(/Every company asks/);
  });

  it("keeps everything when no attribution can be read", () => {
    // Deleting their words is unrecoverable; keeping a little of ours is not. Bias to keeping.
    const body = "One long answer with no quote markers at all, written straight into the reply box.";
    expect(ownWords(body, "a@b.com")).toBe(body);
  });

  it("never returns less than half the text to an unattributed stripper", () => {
    const body = `A real answer.\n\n>>> some client's odd quoting style\n>>> more of it\n>>> and more`;
    const out = ownWords(body, "a@b.com");
    expect(out.length).toBeGreaterThanOrEqual(Math.floor(body.trim().length * 0.5));
  });

  it("is safe on empty and non-string input", () => {
    expect(ownWords("", "a@b.com")).toBe("");
    expect(ownWords(null, "a@b.com")).toBe("");
    expect(ownWords(undefined, "")).toBe("");
  });
});

// The backfill key must be unique PER REPLY. It was (person, day, ask), and one applicant who
// answered twice on the same day had his 5,435-character second reply counted as "already on the
// record" against his 1,145-character first. The run reported success and the better answer vanished.
describe("one person, two replies, same day", () => {
  const key = (r, n = 0) =>
    `Sent to Charlie ${r.at} — asked: ${String(r.subject).replace(/^(re|fwd):\s*/i, "").trim()}${n ? ` (${n + 1})` : ""}`;

  it("gives two same-day replies to the same ask different keys", () => {
    const r = { at: "2026-08-17", subject: "Re: Send me the evidence" };
    expect(key(r, 0)).not.toBe(key(r, 1));
    expect(key(r, 1)).toMatch(/\(2\)$/);
  });

  it("leaves a single reply's key unsuffixed, so a re-run stays idempotent", () => {
    expect(key({ at: "2026-08-17", subject: "Send me the evidence" }, 0))
      .toBe("Sent to Charlie 2026-08-17 — asked: Send me the evidence");
  });
});
