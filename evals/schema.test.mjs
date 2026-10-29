// evals/schema.test.mjs — recorded dossier artifacts satisfy the boundary schema (deterministic).
//
// The dossier is what every downstream surface projects from, so its SHAPE is load-bearing. This
// asserts every dossier fixture (clean AND adversarial — shape is independent of truth) passes the
// same `Dossier` Zod schema the runtime enforces (lib/schemas/dossier.mjs). If a prompt edit drifts
// the output shape, the fixture that mirrors it fails here.

import { describe, it, expect } from "vitest";
import { Dossier } from "../lib/schemas/dossier.mjs";
import { loadCorpus } from "./lib/load.mjs";

describe("dossier fixtures satisfy the Dossier schema", () => {
  for (const fx of loadCorpus("dossier")) {
    it(`${fx.file} parses`, () => {
      const r = Dossier.safeParse(fx.artifact);
      expect(r.success, r.success ? "" : JSON.stringify(r.error?.issues)).toBe(true);
    });
  }
});
