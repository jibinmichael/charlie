// affordance-guards.test.mjs — an affordance Charlie offers must be an affordance Charlie has.
//
// Every user-facing button, mailto and "reply <word>" keyword must have the code that serves it.
// A promise with no handler ("just reply prep me") answers the person who obeys it with a generic ack.
//
// Capabilities route by the LOCAL-PART of the address the mail arrives at (intro@, check@, track@),
// while every Charlie email is sent from charlie@. So copy that says "just reply and I'll <special
// capability>" is wrong BY CONSTRUCTION — a reply can only ever reach the generic conversation path.
// Naming the address is the only thing that works. Each assertion fails CI if a promise returns
// without the machinery behind it.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { stripQuotedLines } from "./campaign-gate.mjs";

const readRaw = (p) => readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
// Strip whole-line `//` comments before matching (the idiom role-attachments.test.mjs already uses).
// A commented MENTION of a removed affordance is documentation (it tells the next reader why not to
// re-add it). A promise inside
// a template literal is the thing under test.
const read = (p) => readRaw(p).replace(/^\s*\/\/.*$/gm, "");
const TEMPLATES = ["email-kit.mjs", "render-email.mjs", "render-plan.mjs", "render-market-report.mjs", "digest.mjs"];
const SERVER = read("server/charlie-remote.ts");

describe("no template promises a reply keyword that /inbound cannot serve", () => {
  // Every "reply <word>" Charlie teaches, and the route that must exist for it. A keyword with no
  // route is a dead promise; the person who obeys it is answered with a generic ack.
  it("does not offer 'prep me' (there is no interview-prep path)", () => {
    for (const f of TEMPLATES) {
      expect(read(f), `${f} offers "prep me" — no handler exists for it in /inbound`).not.toMatch(/prep\s+me/i);
    }
    expect(SERVER, "a prep-me route appeared without the copy being restored").not.toMatch(/prep\s*me/i);
  });

  it("does not offer to draft a follow-up (there is no follow-up drafter)", () => {
    // referral-draft.mjs drafts warm INTROS, which is a different thing and stays.
    for (const f of TEMPLATES) {
      expect(read(f), `${f} offers to draft a follow-up`).not.toMatch(/I'll draft one/i);
    }
  });

  it("does not offer 'reply status' (the standings route was removed)", () => {
    for (const f of TEMPLATES) {
      expect(read(f), `${f} still teaches "reply status" but the route is gone`).not.toMatch(/reply\s*(<b>)?\s*status/i);
    }
  });

  it("does not point at the deleted 'Track this application' button", () => {
    for (const f of TEMPLATES) {
      expect(read(f), `${f} points at a button deleted in commit 87b30fb`).not.toMatch(/Track this application/i);
    }
  });
});

describe("a capability reachable only at a special address is never advertised as 'just reply'", () => {
  // Every send is from CHARLIE_FROM (charlie@), so a plain reply lands on the generic path. If a
  // template mentions a special-route capability it must name the address, not say "reply".
  const kit = read("email-kit.mjs");

  it("the warm intro names intro@ rather than telling people to reply", () => {
    expect(kit).not.toMatch(/reply to this email or send:\s*intro@/i);
    // intro@ is offered by the digest, so the assertion follows the offer to where it lives: an offer
    // without its address is the bug this file exists to catch.
    expect(read("digest.mjs"), "the intro capability lost its address").toMatch(/intro@mail\.example\.com/);
  });

  it("tracking names track@ everywhere it is offered", () => {
    // "forward me" is the failure phrase: "me" is charlie@, which does not track anything.
    expect(kit, 'a template says "forward me" for tracking — that address does not track').not.toMatch(/forward me (anything|their reply|the company)/i);
    expect(kit).toMatch(/track@mail\.example\.com/);
  });

  it("no template offers the retired tailored CV + cover letter", () => {
    for (const f of TEMPLATES) {
      expect(read(f), `${f} offers a tailored CV/cover — Charlie does not offer that`).not.toMatch(/mailto:prepare@/);
    }
    expect(SERVER, "the prepare@ route came back").not.toMatch(/template:\s*"inbound:prepare"/);
  });
});

describe("a reply to the daily role email is read, not swallowed", () => {
  // The chase branch. REPLY_SIGNAL=on makes the role email's Reply-To a chase+<token>@ address. That
  // branch must record the signal and then FALL THROUGH, not return: a reply to the most-sent email
  // Charlie has can carry a stated preference ("remote only from now on"), and recording a signal is
  // not a reason to stop reading someone's words.
  //
  // End the slice on the next real IDENTIFIER, not a comment — read() strips comments, so a comment
  // marker would resolve to -1 and silently slice to end-of-file (where other `return;`s live).
  // The boundary is STRUCTURAL: from the chase test to the start of whatever branch comes next, so it
  // checks the chase branch and only the chase branch, and survives anything inserted after it.
  const chaseAt = SERVER.indexOf('/^chase\\+/i.test(lp)');
  const nextBranch = SERVER.indexOf("\n    if (", chaseAt);
  const branch = SERVER.slice(chaseAt, nextBranch > -1 ? nextBranch : SERVER.indexOf("const onboardBuildFailed"));

  it("does not return early, so the reply is not discarded", () => {
    expect(branch, "the chase branch returns again — every role-email reply is being swallowed").not.toMatch(/\breturn;/);
  });

  it("still records the chasing signal (the fix must not cost the signal)", () => {
    expect(branch).toMatch(/recordSignal\(/);
    expect(branch).toMatch(/event:\s*"chasing"/);
  });

  it("falls through to the ordinary reply path, so the message is answered", () => {
    // applyEmailChange is the generic path. It must sit AFTER the chase branch and still be reachable.
    expect(SERVER.indexOf("applyEmailChange(from")).toBeGreaterThan(SERVER.indexOf('/^chase\\+/i.test(lp)'));
  });

  // THE COST OF THAT FALLTHROUGH, AND THE GUARD FOR IT (grounding).
  // Because the chase branch falls through, a reply to the ROLE email reaches applyEmailChange,
  // which feeds its input to extractPrefs AND ingestUrls, and whose `material` is the corpus
  // writebackIsGrounded checks a conversation-tier proof against. A Gmail reply quotes the whole role
  // email: the job's location, level, pay, company, and its apply URL. Raw, the quoted JOB's
  // attributes could be written back as the PERSON's stated preferences, and the crawled JD could
  // ground a claim about them.
  it("hands applyEmailChange the person's OWN words, never the quoted role email", () => {
    // ASSERTS THE PROPERTY, NOT PROXIMITY: what applyEmailChange is FED, checked both directions.
    expect(SERVER, "ownWords is not derived from the de-quoted body")
      .toMatch(/const ownWords = stripQuotedLines\(body\) \|\| body;/);
    expect(SERVER, "applyEmailChange is not being handed ownWords")
      .toMatch(/applyEmailChange\(from, `\$\{subject\}\\n\\n\$\{ownWords\}`\)/);
    // The failure this guards against, stated as its own assertion: the raw body must never be the
    // argument, because a Gmail reply carries the whole quoted role email.
    expect(SERVER, "applyEmailChange is being fed the raw body — a quoted job description can contaminate the dossier")
      .not.toMatch(/applyEmailChange\(from,\s*body\b/);
    expect(SERVER).not.toMatch(/applyEmailChange\(from, `\$\{subject\}\\n\\n\$\{body\}`\)/);
  });

  it("PROOF the raw body really did carry the job's attributes (this is not a hypothetical)", () => {
    // A realistic Gmail reply to a role email: two words of their own, then the quoted posting.
    const reply = [
      "still chasing this one",
      "",
      "On Fri, Charlie <charlie@mail.example.com> wrote:",
      "> Staff Product Designer at Acme",
      "> Bengaluru, India  ·  12 to 14 years  ·  Rs 90L",
      "> Apply at Acme: https://boards.example.com/acme/staff-designer",
    ].join("\n");

    // The raw reply carries everything, including the job's city, seniority band and pay.
    expect(reply).toMatch(/Bengaluru/);
    expect(reply).toMatch(/90L/);
    expect(reply).toMatch(/https:\/\/boards\.example\.com/);

    // What is passed on: only their own words. None of the job's attributes survive, so extractPrefs
    // cannot mistake the posting for a stated preference and ingestUrls has no link to crawl.
    const ownWords = stripQuotedLines(reply) || reply;
    expect(ownWords).toBe("still chasing this one");
    expect(ownWords).not.toMatch(/Bengaluru|90L|12 to 14|Acme|https:/);
  });

  it("a bottom-posted reply still reaches the writeback (the fallback is not a silent drop)", () => {
    const bottomPosted = ["On Fri, Charlie wrote:", "> Staff Product Designer at Acme", "", "actually make it remote only"].join("\n");
    const ownWords = stripQuotedLines(bottomPosted) || bottomPosted;
    expect(ownWords, "a reply written below the quote must not be swallowed").toMatch(/remote only/);
  });
});
