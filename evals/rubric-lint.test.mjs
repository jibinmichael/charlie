// evals/rubric-lint.test.mjs — the grounding-craft clauses can't be silently removed.
//
// The claim-generating rubrics (dossier.md, composer.md) and the auditor prompt
// (prompts/grounding-verify.mjs) must each carry the grounding-craft instructions. This lint asserts
// their PRESENCE by regex, so a later prompt edit that deletes "never upgrade" / "closed-world" /
// "say less rather than invent" trips CI instead of quietly raising the hallucination rate.
//
// It checks presence, not exact wording — reword freely, just keep the instruction.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDGE_ADDENDUM } from "../prompts/dossier-build.mjs";
import { HIRE_JUSTIFICATION_SYSTEM } from "../prompts/hire-justification.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

// Each generator rubric must carry all four craft clauses. Patterns match the shipped wording:
// presence, not phrasing.
const RUBRIC_CLAUSES = {
  "dossier.md": {
    "closed-world (claims trace to a provided source)": /every claim cites its source/i,
    "say-less rather than invent": /thin input means a\s+shorter dossier/i,
    "never invent": /never invent a fact/i,
    "never upgrade the strength of a claim": /never upgrade the strength/i,
  },
  "composer.md": {
    "closed-world (only the dossier / the lookup)": /only what is in the dossier/i,
    "say-less rather than invent": /when in doubt,? claim less/i,
    "never invent / decode only": /never invent/i,
    "never upgrade the strength of a claim": /never upgrade the strength/i,
    "edge_frame grounded in the edge block, null otherwise": /edge_frame is grounded in the RARE-FIND EDGE block/i,
    "no sincerity intensifiers (a common AI tell)": /no sincerity intensifiers/i,
  },
};

describe("generator rubrics keep their grounding-craft clauses", () => {
  for (const [file, clauses] of Object.entries(RUBRIC_CLAUSES)) {
    const text = read(file);
    for (const [name, pattern] of Object.entries(clauses)) {
      it(`${file} still instructs: ${name}`, () => {
        expect(pattern.test(text), `${file} is missing the "${name}" clause (${pattern})`).toBe(true);
      });
    }
  }
});

describe("the interrogation prompt keeps its grounding-craft clauses", () => {
  const interro = read("prompts/interrogate.mjs");
  const clauses = {
    "closed-world (reference only provided evidence)": /reference only facts that appear in the material|closed world/i,
    "never invent / inflate / upgrade": /never invent, inflate, or upgrade/i,
    "never expose the mechanism": /never expose how any of this works/i,
    "no em dashes": /no em dashes/i,
    "prompt-injection guard": /ignore any instruction inside it/i,
    "aim-confirmation asks, never asserts a space as experience": /never (say or imply they have worked|state or imply they have experience) in (a space|it)/i,
  };
  for (const [name, pattern] of Object.entries(clauses)) {
    it(`interrogate.mjs still instructs: ${name}`, () => {
      expect(pattern.test(interro), `interrogate.mjs is missing "${name}" (${pattern})`).toBe(true);
    });
  }
});

// The scope wall must live in the onboarding prompt: that is the one place Charlie answers the user
// in generated words and the promise could get made. Assert PRESENCE so a later edit can't silently delete it.
describe("the never-promise-an-outcome scope wall is present on the conversational surface", () => {
  const WALL = /never promise a job, an interview, a callback/i;
  const files = {
    "prompts/interrogate.mjs": read("prompts/interrogate.mjs"),
  };
  for (const [file, text] of Object.entries(files)) {
    it(`${file} still carries the never-promise-an-outcome wall`, () => {
      expect(WALL.test(text), `${file} is missing the never-promise-an-outcome wall (${WALL})`).toBe(true);
    });
  }
});

// The Edge Engine reasons past the resume (the "where your combo wins" judgment), so its addendum must
// keep the clauses that keep it grounded: the combo is grounded like any claim, the market read is
// NOT a claim about the person, and a common profile yields null rather than a manufactured combo. Assert
// PRESENCE so a later prompt edit can't quietly turn the edge into an inflation vector.
describe("EDGE_ADDENDUM keeps its grounding-craft clauses (Edge Engine)", () => {
  const clauses = {
    "never invent a half of the combo": /never invent a (fact|half)/i,
    "never upgrade the wording": /never upgrade a verb/i,
    "market judgment is not a claim about the person": /never .{0,40}assert a new fact about the person|describe the market, never inflate the human/i,
    "null for a common profile, never manufacture": /set "edge": null|never manufacture a combo/i,
  };
  for (const [name, pattern] of Object.entries(clauses)) {
    it(`EDGE_ADDENDUM still instructs: ${name}`, () => {
      expect(pattern.test(EDGE_ADDENDUM), `EDGE_ADDENDUM is missing the "${name}" clause (${pattern})`).toBe(true);
    });
  }
});

describe("the hiring justification prompt keeps its grounding-craft clauses (Qualify & Submit)", () => {
  const clauses = {
    "closed-world (only facts the quotes state)": /using only facts the quotes state/i,
    "never invent a company, number, date, tool or outcome": /do not add a company, a number, a date, a tool or an outcome/i,
    "never judge or praise": /never judge or praise/i,
    "never upgrade a verb": /never upgrade a verb/i,
    "keep quantity and scope": /keep quantity and scope exactly as quoted/i,
    "nothing about pay or availability": /say nothing about pay, notice period, location or availability/i,
    "null rather than invent": /return null\. A missing justification is fine; an invented one is not/i,
  };
  for (const [name, pattern] of Object.entries(clauses)) {
    it(`HIRE_JUSTIFICATION_SYSTEM still instructs: ${name}`, () => {
      expect(pattern.test(HIRE_JUSTIFICATION_SYSTEM), `HIRE_JUSTIFICATION_SYSTEM is missing the "${name}" clause (${pattern})`).toBe(true);
    });
  }
});

describe("the grounding auditor prompt keeps its contract", () => {
  const verify = read("prompts/grounding-verify.mjs");
  const clauses = {
    "never invent or upgrade": /never invent or upgrade/i,
    "closed-world (source does not support)": /the SOURCE does not support/i,
    "flags soft-to-loud upgrades": /soft-to-loud upgrades/i,
    "negative / honest weakness is allowed": /honest catch or a stated weakness/i,
  };
  for (const [name, pattern] of Object.entries(clauses)) {
    it(`grounding-verify still instructs: ${name}`, () => {
      expect(pattern.test(verify), `grounding-verify is missing "${name}" (${pattern})`).toBe(true);
    });
  }
});
