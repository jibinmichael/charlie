// evals/voice.test.mjs — the artifacts respect the locked voice (deterministic).
//
// Two properties Charlie's voice guarantees, checkable without a model:
//   1. no em/en dash anywhere in generated prose (render strips them via email-kit `esc` /
//      `cleanSubject`, but the generator should not produce them in the first place).
//   2. the person's name appears verbatim where the fixture carries one (never shortened, translated,
//      or invented).

import { describe, it, expect } from "vitest";
import { loadAll, allStrings } from "./lib/load.mjs";

const DASH = /[—–]/; // em dash / en dash — mirrors email-kit.mjs cleanSubject

describe("generated artifacts carry no em/en dash", () => {
  for (const fx of loadAll()) {
    it(`${fx.file}: prose is dash-clean`, () => {
      for (const s of allStrings(fx.artifact)) {
        expect(DASH.test(s), `dash found in: "${s}"`).toBe(false);
      }
    });
  }
});

describe("the person's name is verbatim where present", () => {
  for (const fx of loadAll().filter((f) => f.expectName)) {
    it(`${fx.file}: contains "${fx.expectName}" exactly`, () => {
      expect(JSON.stringify(fx.artifact)).toContain(fx.expectName);
    });
  }
});
