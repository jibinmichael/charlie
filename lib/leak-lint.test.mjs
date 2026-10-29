// leak-lint.test.mjs — no internal identifier may reach an inbox, and no existing template may be
// broken by saying so.
//
// The second half is the point: a guard that blocks real sends is a new source of silence. So the
// sweep below runs the lint over the rendered output of every template we have a snapshot for, and
// fails if any of them would now be blocked.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { leakLint, INTERNAL_TOKENS, JUDGEMENT_WORDS } from "./leak-lint.mjs";

describe("it catches the thing that actually shipped", () => {
  it("blocks the exact sentence a real person received", () => {
    const text = "Got it. I've updated where you want to work, your pay currency, home_place, what matters to you, and your pay floor, and I'll factor it into the roles I send you.";
    const r = leakLint({ text });
    expect(r.ok).toBe(false);
    expect(r.hits[0].token).toBe("home_place");
    expect(r.hits[0].context).toContain("your pay currency");
  });

  it("blocks a private judgement about the person", () => {
    // The one word here that would genuinely wound whoever read it about themselves.
    expect(leakLint({ text: "Your profile looks like a hopper to me." }).ok).toBe(false);
  });

  it("blocks a bare screen score, which no human is meant to see", () => {
    expect(leakLint({ text: "You scored 11/18 against the brief." }).ok).toBe(false);
    expect(leakLint({ text: "You scored 9 / 18." }).ok).toBe(false);
  });

  it("checks the subject line too", () => {
    expect(leakLint({ subject: "Your seeking_status is updated", text: "hello" }).ok).toBe(false);
  });

  it("names every hit rather than just the first", () => {
    const r = leakLint({ text: "updated comp_floor and mobility_profile for you" });
    expect(r.hits.map((h) => h.token).sort()).toEqual(["comp_floor", "mobility_profile"]);
  });
});

describe("it does not block real copy", () => {
  it("allows ordinary words that are also enum values", () => {
    // "stable", "steady" and "mover" are real mobility_profile values AND ordinary English. They
    // cannot be banned by spelling, which is why the list is columns and snake_case enums only.
    expect(leakLint({ text: "Your career looks stable and steady, and you are a mover on delivery." }).ok).toBe(true);
  });

  it("allows a job description that happens to contain snake_case", () => {
    // A blanket snake_case ban would block this, and a role email quotes postings verbatim.
    expect(leakLint({ text: "They want someone comfortable with user_id joins and event_name schemas." }).ok).toBe(true);
  });

  it("ignores underscores inside links and addresses", () => {
    expect(leakLint({ text: "Apply here: https://boards.greenhouse.io/x/jobs/1?gh_src=abc_def and mail a_b@c.com" }).ok).toBe(true);
  });

  it("allows a number that is not a score out of 18", () => {
    expect(leakLint({ text: "They have 11 people and 18 open roles. Cut it from 6 to 2." }).ok).toBe(true);
    expect(leakLint({ text: "Roughly 11/20 of the market is reachable." }).ok).toBe(true);
  });

  it("allows an empty message rather than throwing on it", () => {
    expect(leakLint({}).ok).toBe(true);
    expect(leakLint({ text: "" }).ok).toBe(true);
  });
});

describe("every template we render today still passes", () => {
  const snap = new URL("../emails/__snapshots__/templates.test.mjs.snap", import.meta.url).pathname;

  it("the snapshot file exists, so this sweep is checking something", () => {
    expect(existsSync(snap)).toBe(true);
  });

  it("no snapshotted template output would be blocked", () => {
    // The snapshot holds the rendered html+text of every template with a fixture. If the lint would
    // block any of them, it would block a real send, and that is a worse bug than the one it fixes.
    const body = readFileSync(snap, "utf8");
    const blocks = body.split(/^exports\[/m).filter(Boolean);
    const broken = [];
    for (const b of blocks) {
      const name = (b.match(/^`([^`]+)`/) || [])[1] || "(unnamed)";
      const r = leakLint({ text: b });
      if (!r.ok) broken.push(`${name}: ${r.hits.map((h) => h.token).join(", ")}`);
    }
    expect(broken).toEqual([]);
  });
});

describe("the send door enforces it", () => {
  const SRC = readFileSync(new URL("./send-guard.mjs", import.meta.url), "utf8");

  it("runs the lint inside sendGuarded", () => {
    expect(SRC).toContain("leakLint({");
  });

  it("runs BEFORE the idempotency claim, so a blocked send does not burn its dedupe key", () => {
    expect(SRC.indexOf("leakLint({")).toBeLessThan(SRC.indexOf("claimSend(email"));
  });

  it("fails closed: a hit returns without sending", () => {
    const block = SRC.slice(SRC.indexOf("leakLint({"), SRC.indexOf("// 2) idempotency"));
    expect(block).toContain('return { status: "leak_blocked"');
    expect(block).not.toContain("resend.emails.send");
  });

  it("logs what it found, so a block is diagnosable rather than mysterious", () => {
    const block = SRC.slice(SRC.indexOf("leakLint({"), SRC.indexOf("// 2) idempotency"));
    expect(block).toContain("h.context");
  });
});

describe("the vocabulary is real", () => {
  it("lists the field that leaked", () => {
    expect(INTERNAL_TOKENS).toContain("home_place");
  });

  it("contains no bare English word that a person might legitimately write", () => {
    // Everything on the token list must be snake_case; the judgement list is the only exception and
    // is kept deliberately tiny.
    for (const t of INTERNAL_TOKENS) expect(t).toMatch(/_/);
    expect(JUDGEMENT_WORDS.length).toBeLessThanOrEqual(2);
  });
});

describe("both halves are checked, because they are not guaranteed to match", () => {
  it("catches a value that exists only in the html", () => {
    // Every template today builds html and text from the same values, and the sweep above confirms
    // it. Nothing enforces it, so a future badge rendered only in the html must not be a blind spot.
    const r = leakLint({ text: "All fine here.", html: "<p>All fine here.</p><span class='pill'>mobility_profile</span>" });
    expect(r.ok).toBe(false);
    expect(r.hits[0].token).toBe("mobility_profile");
  });

  it("does not trip on markup, attributes, or a style block", () => {
    const html = `<style>.a{font-family:Helvetica;mso-line-height-rule:exactly}</style>
      <table role="presentation" data-x="a_b"><tr><td class="wrap_cell"><a href="https://x.io/j?gh_src=a_b">Apply</a></td></tr></table>`;
    expect(leakLint({ html, text: "Apply here." }).ok).toBe(true);
  });

  it("reads the words a person would see in the html", () => {
    expect(leakLint({ html: "<p>You look like a <b>hopper</b> to me.</p>" }).ok).toBe(false);
  });
});
