// judging-determinism.test.mjs — every Anthropic call that JUDGES must run at temperature 0.
//
// WHY THIS FILE EXISTS. At the Anthropic default temperature of 1.0, the same candidate against the
// same role can clear the gate on one run and fail it on the next with nothing changed in between.
// That is not a fit signal, it is a dice roll, and it decides what a real person receives.
//
// The three calls below GRADE or VERIFY. None of them writes prose:
//   match-batch.mjs      scores (person, role) against MATCH_BAR
//   fit-coverage.mjs     computes the coverage composite behind the fit chart
//   grounding-verify.mjs decides whether a composed claim is grounded — the last gate before an inbox
//
// composer.mjs is DELIBERATELY ABSENT. It writes the email's prose, and its temperature is a voice
// decision, not a correctness one.
//
// TEST HONESTY. grounding-verify accepts an injectable client, so it is tested for real: we capture
// the request it actually sends. computeCoverage and runMatchBatch construct their own clients, so
// those two are asserted as MECHANICAL GUARDS over the source text — weaker than a behavioural test,
// but strong enough to fail the build if someone removes the setting, which is what this file is for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGrounding } from "./grounding-verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, f), "utf8");

describe("grounding-verify — the last gate before a real inbox (behavioural)", () => {
  it("sends temperature 0 on the request it actually makes", async () => {
    const seen = [];
    const fake = {
      messages: {
        create: async (req) => {
          seen.push(req);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, severity: "none", violations: [] }) }] };
        },
      },
    };
    await verifyGrounding({ sourceText: "Kavya Nair, Lead Product Manager at LUMORA since 2023.", artifactText: "You lead product at LUMORA.", client: fake });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].temperature, "the verifier must not be stochastic").toBe(0);
  });

  it("returns the SAME verdict for the same (source, artifact) across repeated calls", async () => {
    // With a deterministic client this is trivially true; the point is the CONTRACT — a verifier whose
    // verdict varies run to run cannot support citeOrDrop, which assumes the same ungrounded claim is
    // caught every time. Locks the expectation so a future "add some variety" change fails here.
    const fake = { messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({ ok: false, severity: "high", violations: [{ claim: "invented metric", why: "not in source" }] }) }] }) } };
    const a = await verifyGrounding({ sourceText: "S", artifactText: "A", client: fake });
    const b = await verifyGrounding({ sourceText: "S", artifactText: "A", client: fake });
    expect(a).toEqual(b);
  });
});

describe("the other two judging calls carry temperature 0 (mechanical guard over source)", () => {
  // A regex over source is a weaker instrument than a behavioural test and is used here only because
  // neither call takes an injectable client. If either is ever refactored to accept one, replace the
  // corresponding assertion with a real captured-request test like the two above.
  it("fit-coverage.mjs passes temperature: 0 to messages.create", () => {
    const s = src("fit-coverage.mjs");
    const call = s.slice(s.indexOf("messages.create("));
    expect(call.slice(0, 240)).toMatch(/temperature:\s*0\b/);
  });

  it("match-batch.mjs puts temperature: 0 in every batch request's params", () => {
    const s = src("match-batch.mjs");
    const push = s.slice(s.indexOf("requests.push("));
    expect(push.slice(0, 240)).toMatch(/temperature:\s*0\b/);
  });

  it("composer.mjs is NOT forced to 0 — its temperature is a voice decision, not a correctness one", () => {
    // Asserted so the omission reads as deliberate rather than forgotten.
    expect(src("composer.mjs")).not.toMatch(/temperature:\s*0\b/);
  });
});
