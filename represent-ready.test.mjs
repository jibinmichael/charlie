// represent-ready.test.mjs — do not name a role to someone we cannot check the role against.
//
// If a profile does not say where the person can work, nothing can check a role against it: pitching
// an on-site role first and asking the qualifying question second puts a wrong pitch in their inbox.
//
// preSendGuard catches the same shape at SEND time, but only when the fact exists. This covers the
// case with no fact to check: we do not know, so we do not guess, and we do not pitch.
//
// Where they can work is usually known; notice period and pay usually are not. Blocking on all four
// facts would leave almost nobody reachable, so only the one that misfires blocks. That is the split
// below.
import { describe, it, expect } from "vitest";
import { blockingGap, readyToRepresent, knowsWhereTheyCanWork, askWith } from "./lib/represent-ready.mjs";

const dossier = (prefs = {}, extra = {}) => ({ headline: "Talent acquisition professional", proof_points: ["a", "b"], preferences: prefs, ...extra });

describe("where they can work is the ONE blocking fact", () => {
  it("blocks when nothing on the profile says where they can work", () => {
    // A profile with a dealbreaker but nothing about where they can work.
    const gap = blockingGap(dossier({ dealbreakers: ["agencies"] }));
    expect(gap).toMatch(/where they can work/i);
    expect(readyToRepresent(dossier({}))).toBe(false);
  });

  it("any ONE of these settles it — the gate stops a wrong pitch, it does not demand a form", () => {
    expect(knowsWhereTheyCanWork(dossier({ remote: "remote only" }))).toBe(true);
    expect(knowsWhereTheyCanWork(dossier({ home_place: "Bengaluru" }))).toBe(true);
    expect(knowsWhereTheyCanWork(dossier({ location: "Chennai" }))).toBe(true);
    expect(knowsWhereTheyCanWork(dossier({}, { location: "Pune" }))).toBe(true);
    expect(knowsWhereTheyCanWork(dossier({}, { city: "Kochi" }))).toBe(true);
  });

  it("a dealbreaker that names the constraint IS an answer to the question", () => {
    // "on-site only" as a dealbreaker tells us exactly what we needed to know.
    expect(knowsWhereTheyCanWork(dossier({ dealbreakers: ["on-site only"] }))).toBe(true);
    expect(knowsWhereTheyCanWork(dossier({ dealbreakers: ["no relocation"] }))).toBe(true);
    // ...but an unrelated dealbreaker is not
    expect(knowsWhereTheyCanWork(dossier({ dealbreakers: ["agencies", "night shifts"] }))).toBe(false);
  });

  it("an empty array is not an answer", () => {
    expect(knowsWhereTheyCanWork(dossier({ remote: "", dealbreakers: [] }))).toBe(false);
  });

  it("FAILS CLOSED on a missing or junk profile", () => {
    // We are about to tell someone a specific job might be theirs. Doing that on no information is
    // worse than doing nothing.
    for (const bad of [null, undefined, "nope", 42]) {
      expect(blockingGap(bad), String(bad)).toBeTruthy();
    }
  });

  it("passes once we know, even with everything else unknown", () => {
    // The other three facts never block: the introduction email asks for them in the same message.
    expect(blockingGap(dossier({ remote: "remote only" }))).toBeNull();
  });
});

describe("what the email asks for, which never blocks", () => {
  it("names the unknowns in the order a founder asks them", () => {
    expect(askWith(dossier({ remote: "remote" }))).toEqual(["notice period", "pay expectation", "whether they are actively looking"]);
  });

  it("does not ask for something already known", () => {
    const known = dossier({ remote: "remote", notice_period: "30 days", comp_floor: 25, mode: "actively looking" });
    expect(askWith(known)).toEqual([]);
  });

  it("survives a junk dossier rather than throwing", () => {
    for (const bad of [null, undefined, {}, { preferences: "nope" }]) {
      expect(Array.isArray(askWith(bad)), String(bad)).toBe(true);
    }
  });
});

describe("the sender refuses when readiness fails", () => {
  it("send-putforward checks readiness BEFORE the match gate", async () => {
    // Order matters and is asserted, not assumed: readiness answers "may we name ANY role", the match
    // gate answers "is THIS role wrong". Running them the other way round would spend a guard call on
    // someone we should not be mailing at all.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("scripts/send-putforward.mjs", "utf8");
    expect(src).toMatch(/import \{[^}]*blockingGap[^}]*\} from "\.\.\/lib\/represent-ready\.mjs"/);
    expect(src.indexOf("blockingGap(cand.dossier)")).toBeGreaterThan(-1);
    expect(src.indexOf("blockingGap(cand.dossier)")).toBeLessThan(src.indexOf("await preSendGuard("));
  });
});
