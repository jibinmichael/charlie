// lib/schemas/__tests__/preferences.test.mjs — the boundary between what a model SAYS and what gets
// STORED about a person.
//
// Model output is external data, so extracted preferences pass a schema before mergePrefs stores them.
// These cases make prompt-injection resistance independent of whether the MODEL behaves.
import { describe, it, expect } from "vitest";
import { safePreferences } from "../preferences.mjs";

describe("safePreferences — a model cannot invent a field on a real person", () => {
  it("DROPS keys nobody asked for", () => {
    const { prefs, dropped } = safePreferences({ role: "PM", admin: true, verified: true, internal_notes: "escalate" });
    expect(prefs).toEqual({ role: "PM" });
    expect(dropped.sort()).toEqual(["admin", "internal_notes", "verified"]);
  });
  it("keeps the legitimate part of a mixed payload", () => {
    // The real zero-width attack: a genuine request with an override smuggled after it.
    const { prefs } = safePreferences({ role: "PM", seniority: "CEO", is_premium: true });
    expect(prefs.role).toBe("PM");
    expect(prefs.seniority).toBe("CEO"); // a claim about THEM, allowed — it is theirs to state
    expect("is_premium" in prefs).toBe(false);
  });
});

describe("safePreferences — size and shape", () => {
  it("refuses a string long enough to stuff a dossier (observed max in prod: 187 chars)", () => {
    const { prefs, dropped } = safePreferences({ role: "x".repeat(5000) });
    expect(prefs.role).toBeUndefined();
    expect(dropped).toContain("role");
  });
  it("refuses an oversized list", () => {
    const { prefs } = safePreferences({ dealbreakers: Array.from({ length: 500 }, (_, i) => `d${i}`) });
    expect(prefs.dealbreakers).toBeUndefined();
  });
  it("a pay floor must be a positive number — a string is how a wrong floor deletes real roles", () => {
    expect(safePreferences({ comp_floor: "30 lakh" }).prefs.comp_floor).toBeUndefined();
    expect(safePreferences({ comp_floor: -5 }).prefs.comp_floor).toBeUndefined();
    expect(safePreferences({ comp_floor: 3000000 }).prefs.comp_floor).toBe(3000000);
  });
});

describe("safePreferences — injection-shaped content", () => {
  it("refuses markup, which is only ever an injection or a mangled paste", () => {
    const { prefs } = safePreferences({ role: '<script>alert(1)</script>' });
    expect(prefs.role).toBeUndefined();
  });
  it("strips zero-width characters used to hide a second instruction", () => {
    const { prefs } = safePreferences({ role: "PM​​﻿" });
    expect(prefs.role).toBe("PM");
  });
  it("does not choke on a whole reply being junk", () => {
    for (const v of [null, undefined, "a string", [1, 2], 42]) {
      expect(safePreferences(v)).toEqual({ prefs: {}, dropped: [] });
    }
  });
});

describe("safePreferences — must not break real people", () => {
  it("passes a full, realistic live dossier's preferences unchanged", () => {
    // Every preference key in use, with realistic values.
    const real = {
      role: "Lead product manager", seniority: "Lead", remote: "remote",
      comp_floor: 8000000, comp_currency: "INR", home_place: "Bangalore, India",
      mode: null, employment_type_wanted: null, motivation: null, values: null, ping_bar: null,
      tech: ["figma", "sql"], stage: ["growth"], dealbreakers: ["agencies"], admired: ["Stripe"],
    };
    const { prefs, dropped } = safePreferences(real);
    expect(dropped).toEqual([]);
    expect(prefs.role).toBe("Lead product manager");
    expect(prefs.comp_floor).toBe(8000000);
    expect(prefs.tech).toEqual(["figma", "sql"]);
    expect(prefs.dealbreakers).toEqual(["agencies"]);
  });
});
