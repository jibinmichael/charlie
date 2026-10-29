// prompts/composer.mjs — the role-email composer request builder.
//
// WHAT IT DOES: assembles the compose request. The voice + field rules are human-edited in
//   `composer.md` (loaded here, never inlined); this centralizes the user-turn scaffolding
//   (## TODAY / ## DOSSIER / ## JOB / ## MATCHER VERDICT / ## COMPANY LOOKUP blocks).
// MODEL: Sonnet 4.6 (composer.mjs `MODEL`).
// EXPECTED OUTPUT: JSON email fields (composer.md defines the schema).
// VALIDATED AT: composer.mjs `composeEmailFields` (parseJsonLoose; throws on unparseable).
//
// NOTES:
//   - why_you is shown the screen verdicts it will sit above, and must not claim a fit on a row the
//     read marks `close` or `no`. Absent screen data leaves the prompt byte-identical.
//   - resume_tips is 3 bullets, one sentence each, max 18 words, with no trailing self-assessment.
//     Prompted rather than truncated: cutting prose in the renderer stops mid-thought.
//   - Never upgrade the dossier's verbs/scope (gated by evals/rubric-lint.test.mjs).
//   - Desire-led why_you: motivation/admired are hidden from the composer unless DESIRE_COPY=on
//     (composer.mjs stripDesire); when on, the connection must be grounded in the role's own text.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUBRIC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "composer.md");

/** Load the human-edited composer voice/field rules (composer.md). */
export function loadComposerPrompt() {
  return readFileSync(RUBRIC_PATH, "utf8");
}

/** Build the compose user turn (grounded data blocks). */
export function buildComposerUserContent({ dossierText, jobText, match = null, companyInsight = null, edge = null, today, screen = null }) {
  const parts = [
    `## TODAY\n\n${today} (use this to judge tenure and recency; do not call a past date "future")`,
    `## DOSSIER\n\n${dossierText}`,
    `## JOB\n\n${jobText}`,
  ];
  if (match) {
    parts.push("## MATCHER VERDICT (copy score, verdict, and chips through exactly)\n\n" + JSON.stringify(match, null, 2));
  }
  // WHAT THE READER SEES DIRECTLY BELOW why_you.
  //
  // why_you and the screen rows are written by two different model calls. Each half can be grounded
  // and still contradict the other (a "maps well" rationale above a row reading "a stretch"), which
  // reads as a pitch. So the composer sees the verdicts BEFORE it writes, and the rationale can
  // acknowledge a stretch instead of talking over it. Costs nothing: same call, a few hundred more input tokens.
  if (screen && screen.rows && screen.rows.length) {
    parts.push(
      "## THE READ THE PERSON WILL SEE UNDER YOUR why_you (already written, already shown to them; " +
        "yes = clears, close = a stretch, no = a real gap)\n\n" + JSON.stringify(screen.rows, null, 2) +
        (screen.seniorityLevel ? `\n\nseniority: they read as "${screen.seniorityLevel}" for this role.` : ""),
    );
  }
  // Edge Engine: present ONLY when the caller determined this role is a rare-find (edgeHit).
  // Its presence is the composer's signal to write edge_frame; its absence keeps edge_frame null.
  // GROUNDING: pass ONLY the grounded halves (combo + evidence). strong_in/generic_in are MARKET
  // judgments, never the person's experience (lib/schemas/dossier.mjs consumer contract) — the composer
  // must never see them, or it will restate a market domain as something they did.
  if (edge && edge.combo) {
    const grounded = { combo: edge.combo, evidence: edge.evidence || [] };
    parts.push(
      "## RARE-FIND EDGE (this role is a rare fit for this person — write edge_frame from THIS, grounded; " +
        "both halves of `combo` are real facts already in their dossier)\n\n" + JSON.stringify(grounded, null, 2),
    );
  }
  parts.push(
    "## COMPANY LOOKUP (copy into company_insight exactly; keep null fields null)\n\n" +
      (companyInsight
        ? JSON.stringify(companyInsight, null, 2)
        : "null — no verified company facts were found. set company_insight to null."),
  );
  return parts.join("\n\n");
}
