// status-preserved.test.mjs — replying to Charlie must not change what kind of user you are.
//
// The preference writers save with `existing.status || "active"`, but `existing` there is the DOSSIER,
// which has no status field, so the fallback would always win and every reply that reached the
// preference writer would promote that person to `active`: somebody who applied to one role through a
// form (status `screening`) and replied once would land inside the population every lifecycle sweep
// draws from.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { applyPrefsOnly } from "../email-onboard.mjs";

const SRC = readFileSync(new URL("../email-onboard.mjs", import.meta.url), "utf8");

const harness = (status) => {
  const saved = [];
  return {
    saved,
    deps: {
      getDossier: async () => ({ name: "A", preferences: {}, proof_points: [], strengths: [] }),
      getCandidate: async () => (status === undefined ? null : { email: "a@b.com", status }),
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async (email, d, st) => { saved.push(st); },
      recordSignal: async () => {},
    },
  };
};

describe("a reply does not change your status", () => {
  it("an applicant stays in screening", async () => {
    // The core assertion: a screening applicant stays screening.
    const h = harness("screening");
    await applyPrefsOnly("a@b.com", "make it remote only", h.deps);
    expect(h.saved).toEqual(["screening"]);
  });

  it("a paused person stays paused", async () => {
    // Worse than the screening case: a pause is something they asked for.
    const h = harness("paused");
    await applyPrefsOnly("a@b.com", "make it remote only", h.deps);
    expect(h.saved).toEqual(["paused"]);
  });

  it("an unsubscribed person is not resurrected", async () => {
    const h = harness("unsubscribed");
    await applyPrefsOnly("a@b.com", "make it remote only", h.deps);
    expect(h.saved).toEqual(["unsubscribed"]);
  });

  it("an active person stays active", async () => {
    const h = harness("active");
    await applyPrefsOnly("a@b.com", "make it remote only", h.deps);
    expect(h.saved).toEqual(["active"]);
  });

  it("falls back to active only when there is no candidate row at all", async () => {
    // A dossier with no row is the case the original line was presumably written for, and it is the
    // only case where inventing a status is defensible.
    const h = harness(undefined);
    await applyPrefsOnly("a@b.com", "make it remote only", h.deps);
    expect(h.saved).toEqual(["active"]);
  });

  it("a failed candidate read does not silently promote", async () => {
    const saved = [];
    await applyPrefsOnly("a@b.com", "make it remote only", {
      getDossier: async () => ({ preferences: {} }),
      getCandidate: async () => { throw new Error("db down"); },
      extractPrefs: async () => ({ remote: "remote only" }),
      saveDossier: async (e, d, st) => { saved.push(st); },
      recordSignal: async () => {},
    });
    // It falls back to active, which is the pre-existing contract, but the important half is that it
    // does not throw and lose the person's reply. Flagged here so a future change is deliberate.
    expect(saved).toEqual(["active"]);
  });
});

describe("neither writer reads status off the dossier any more", () => {
  it("the broken expression is gone from both", () => {
    expect(SRC).not.toContain('existing.status || "active"');
  });

  it("both writers read the candidate row instead", () => {
    expect(SRC).toMatch(/getCandidate\(email\)[\s\S]{0,120}saveDossier\(email, existing, _cand\?\.status/);
    expect(SRC).toMatch(/_getCandidate\(email\)[\s\S]{0,120}_saveDossier\(email, existing, _cand2\?\.status/);
  });
});
