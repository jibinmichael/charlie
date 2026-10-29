// model-config.test.mjs — guards the two subtle model-config invariants that are easy to break
// in a later edit and would fail silently (a 400, or a voice regression). Static source checks only:
// no API, no key (voice quality itself is measured by the compose evals).
//
//   1. The Opus 4.8 dossier build must NOT use a last-assistant-turn prefill (Opus 4.8 400s on it, and
//      it can't coexist with thinking). It must carry adaptive thinking + an effort setting, gated so
//      it can be turned off.
//   2. The compose model must be env-overridable (default the CURRENT model so no live voice change on
//      merge) AND hold thinking explicitly OFF on every model call — because Sonnet 5 defaults
//      adaptive-ON when `thinking` is omitted, which would silently change the "writes to you" voice.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(ROOT, p), "utf8");

describe("dossier build — thinking on, prefill gone", () => {
  const s = src("dossier-build.mjs");
  it("never pushes a last-assistant prefill (would 400 on Opus 4.8 + conflicts with thinking)", () => {
    expect(/role:\s*["']assistant["']/.test(s), "assistant-turn prefill re-introduced").toBe(false);
  });
  it("adds adaptive thinking + an effort setting, gated by DOSSIER_THINKING", () => {
    expect(s).toContain('thinking = { type: "adaptive" }');
    expect(/output_config\s*=\s*\{\s*effort/.test(s)).toBe(true);
    expect(/DOSSIER_THINKING/.test(s)).toBe(true);
  });
});

describe("compose — env-overridable model, thinking held OFF", () => {
  const s = src("composer.mjs");
  it("model is env-overridable and defaults to the current (non-Sonnet-5) model", () => {
    expect(/process\.env\.COMPOSE_MODEL\s*\|\|\s*"claude-sonnet-4-6"/.test(s)).toBe(true);
    expect(s).not.toContain('const MODEL = "claude-sonnet-5"'); // swap is flag-gated, not hardcoded live
  });
  it("holds thinking disabled on every messages.create call", () => {
    const createCalls = (s.match(/messages\.create\(/g) || []).length;
    const thinkingOff = (s.match(/thinking:\s*NO_THINKING/g) || []).length;
    expect(createCalls).toBeGreaterThanOrEqual(2);
    expect(thinkingOff, "every compose model call must set thinking off").toBe(createCalls);
    expect(s).toContain('NO_THINKING = { type: "disabled" }');
  });
});
