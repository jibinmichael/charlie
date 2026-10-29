// onboarding-ask-first.test.mjs — ask one question and wait, instead of building a profile from too little.
//
// A full dossier build plus a charted read of "your market", from a couple of lines, is Charlie
// sounding certain about someone it has not met. So a thin first message gets one question and a wait.
//
// substantiveBio's 80-char floor answers "is there anything here at all". tooThinToBuild answers a
// different question — "is there enough to build a PROFILE on" — and two sentences clears the first
// and nowhere near the second.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { tooThinToBuild, askFirstOn, substantiveBio } from "./email-onboard.mjs";

const TWO_LINES = "I am a product designer with about 6 years, mostly B2B SaaS. Looking for senior roles, remote or Bangalore.";
const A_REAL_BIO = TWO_LINES + " " + "I led the redesign of the onboarding flow at Acme, which took activation from 31 to 48 percent over two quarters. Before that I ran design for the payments team at Foo, shipping the checkout rebuild that cut drop-off by a third. I work end to end: research, prototypes, and I write my own specs.";

describe("tooThinToBuild", () => {
  afterEach(() => { delete process.env.ONBOARD_ASK_FIRST; delete process.env.ONBOARD_ASK_FIRST_CHARS; });

  it("is OFF by default — it changes who gets a profile, so it earns its way on", () => {
    expect(askFirstOn()).toBe(false);
    expect(tooThinToBuild(TWO_LINES)).toBe(false);
  });

  it("holds two sentences when on", () => {
    process.env.ONBOARD_ASK_FIRST = "on";
    expect(TWO_LINES.length).toBeGreaterThan(80);      // it DOES clear substantiveBio
    expect(substantiveBio(TWO_LINES)).toBeTruthy();     // proving the two bars are different
    expect(tooThinToBuild(TWO_LINES)).toBe(true);       // and this one still says wait
  });

  it("builds for a bio with real specifics in it", () => {
    process.env.ONBOARD_ASK_FIRST = "on";
    expect(tooThinToBuild(A_REAL_BIO)).toBe(false);
  });

  it("honours the threshold", () => {
    process.env.ONBOARD_ASK_FIRST = "on";
    process.env.ONBOARD_ASK_FIRST_CHARS = "50";
    expect(tooThinToBuild(TWO_LINES)).toBe(false);      // now above the bar
  });

  it("never fires on empty input (that path is renderMissingResume's, not this one)", () => {
    process.env.ONBOARD_ASK_FIRST = "on";
    for (const v of ["", "   ", null, undefined]) expect(tooThinToBuild(v)).toBe(false);
  });
});

// The wiring, parsed from the real handler — a helper that is never reached protects nobody.
describe("the gate is actually in the inbound path", () => {
  const SERVER = readFileSync(new URL("./server/charlie-remote.ts", import.meta.url), "utf8");
  const at = (re) => SERVER.search(re);

  it("runs BEFORE the bio is promoted to resumeText and built on", () => {
    const gate = at(/tooThinToBuild\(bio\)/);
    const promote = at(/resumeText = bio;/);
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(promote);
  });

  it("returns without building — no dossier, no candidate row, no market read", () => {
    const block = SERVER.slice(at(/tooThinToBuild\(bio\)/), at(/tooThinToBuild\(bio\)/) + 800);
    expect(block).toMatch(/renderTellMeMore/);
    expect(block).toMatch(/return;/);
    expect(block).not.toMatch(/onboardFromEmail|buildDossier/);
  });

  it("schedules a day-3 follow-up, so asking cannot become silence", () => {
    const block = SERVER.slice(at(/tooThinToBuild\(bio\)/), at(/tooThinToBuild\(bio\)/) + 800);
    expect(block).toMatch(/scheduleTask/);
    expect(block).toMatch(/ask_first_nudge/);
  });

  it("the nudge says nothing once they have a profile", () => {
    const c = SERVER.slice(at(/case "ask_first_nudge"/), at(/case "ask_first_nudge"/) + 500);
    expect(c).toMatch(/dossier\)\s*break|cand\?\.dossier/);  // replied -> silent
    expect(c).toMatch(/isSuppressed/);                        // bounced/unsubscribed -> silent
  });
});
