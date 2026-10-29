// evals/live.mjs — the live grounding regression test (opt-in, calls the Anthropic API).
//
// The deterministic Vitest suite fences the enforcer; this fences the JUDGE. It runs the real
// `verifyGrounding` (Haiku) over the labelled corpus and reports:
//   - adversarial specimens the auditor CAUGHT (severity "high") vs MISSED  → recall on invention
//   - clean specimens the auditor FALSELY FLAGGED                            → false-positive rate
// Run this before merging any change to a generation prompt or to grounding-verify:
//   node evals/live.mjs
// It is NOT a *.test.mjs and is never run by Vitest/CI (which have no API key). Without a key it
// prints "skipped" and exits 0, so it can sit in any pipeline harmlessly.

import { verifyGrounding } from "../grounding-verify.mjs";
import { loadAll, allStrings } from "./lib/load.mjs";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("evals/live: skipped (no ANTHROPIC_API_KEY). Deterministic gate runs via `npm run test:evals`.");
    return;
  }

  const fixtures = loadAll();
  const rows = [];
  let caught = 0,
    missed = 0,
    falsePos = 0,
    cleanTotal = 0,
    advTotal = 0;

  for (const fx of fixtures) {
    const artifactText = allStrings(fx.artifact).join("\n");
    const res = await verifyGrounding({ sourceText: fx.source, artifactText });
    const high = res.severity === "high";
    let mark;
    if (fx.label === "adversarial") {
      advTotal++;
      if (high) { caught++; mark = "CAUGHT"; }
      else { missed++; mark = res.errored ? "ERRORED" : "MISSED ⚠"; }
    } else {
      cleanTotal++;
      if (high) { falsePos++; mark = "FALSE-POSITIVE ⚠"; }
      else { mark = "clean-ok"; }
    }
    rows.push({ file: fx.file, label: fx.label, severity: res.severity, violations: (res.violations || []).length, mark });
  }

  console.table(rows);
  console.log(
    `\nadversarial: ${caught}/${advTotal} caught, ${missed} missed` +
      `  |  clean: ${cleanTotal - falsePos}/${cleanTotal} clean, ${falsePos} false-positive`
  );
  if (missed > 0) console.log("⚠ the auditor MISSED an invented claim — investigate before merging a prompt change.");
  if (falsePos > 0) console.log("⚠ the auditor FALSELY FLAGGED a grounded claim — a prompt change may be over-dropping.");

  await interrogateJudge();
}

// One opt-in judge case for the interrogation prompt — generate real questions from a resume and
// check the voice/grounding invariants (no em dash; no numeric metric that isn't in the resume). This is
// a human-review aid, not a hard gate; the deterministic path is fenced in evals/interrogate.
async function interrogateJudge() {
  let generateQuestions;
  try { ({ generateQuestions } = await import("../email-onboard.mjs")); }
  catch (e) { console.log(`\ninterrogate judge: skipped (${e.message})`); return; }

  const resume = "Maya Chen. Product designer, 6 years. Led the Lumen design system at Acme; shipped a checkout redesign that cut drop-off by 18 percent. Mentored 3 designers.";
  const dossier = { name: "Maya Chen", headline: "Product designer", preferences: {}, proof_points: [
    { claim: "led the Lumen design system at Acme", source: "resume" },
    { claim: "shipped a checkout redesign that cut drop-off by 18 percent", source: "resume" },
  ] };
  const { questions } = await generateQuestions({ resumeText: resume, dossier, transcript: [] });
  const src = resume.toLowerCase();
  const rows = questions.map((q) => {
    const emDash = /[—–]/.test(q);
    const nums = (q.match(/\b\d[\d,]*\b/g) || []).filter((n) => !src.includes(n.toLowerCase()));
    return { question: q, emDash: emDash ? "⚠" : "ok", inventedNumber: nums.length ? `⚠ ${nums.join(",")}` : "ok" };
  });
  console.log("\ninterrogate judge (human review — questions grounded in the resume?):");
  console.table(rows);
  if (rows.some((r) => r.emDash !== "ok" || r.inventedNumber !== "ok")) {
    console.log("⚠ a generated question has an em dash or a number absent from the resume — inspect before merging.");
  }
}

main().catch((e) => {
  console.error("evals/live: unexpected error:", e.message);
  process.exit(1);
});
