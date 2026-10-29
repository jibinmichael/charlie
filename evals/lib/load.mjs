// evals/lib/load.mjs — deterministic loader for the grounding-eval corpus.
//
// Fixtures live in evals/corpus/<surface>/*.json. Each is a labelled specimen:
//   { surface, label:"clean"|"adversarial", source, artifact, violations, ... }
// where `source` is the resume/dossier the artifact was written from, `artifact` is a
// representative generated output, and `violations` is the verifyGrounding-shaped
// [{claim, issue}] a correct auditor returns (empty for clean specimens).
//
// Pure fs read, no model call — safe to import from any Vitest test.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
export const SURFACES = ["composer", "dossier"];

/** Load every labelled fixture for one surface ("composer" | "dossier"). */
export function loadCorpus(surface) {
  const dir = join(CORPUS, surface);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: `${surface}/${f}`, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

/** Every fixture across every surface. */
export function loadAll() {
  return SURFACES.flatMap((s) => loadCorpus(s));
}

/** Case-insensitive substring test — mirrors grounding-enforce.mjs `hit()` (the enforcer's own match). */
export function contains(haystack, needle) {
  return String(haystack == null ? "" : haystack).toLowerCase().includes(String(needle || "").toLowerCase());
}

/** Every prose string in a composed-email `fields` + `cov` pair, for "no flagged claim survived" checks. */
export function composerProse(fields = {}, cov = null) {
  const out = [];
  for (const k of ["why_you", "flag", "cover_letter"]) if (fields[k]) out.push(String(fields[k]));
  for (const t of fields.resume_tips || []) out.push(String(t));
  for (const x of fields.facts || []) out.push(`${x?.k || ""}: ${x?.v || ""}`);
  if (cov) {
    if (cov.reason) out.push(String(cov.reason));
    if (cov.topMove) out.push(String(cov.topMove));
    for (const r of cov.coverage || []) if (r?.evidence) out.push(`${r.req}: ${r.evidence}`);
  }
  return out;
}

/** Deep-collect every string value in an object (for the voice / em-dash lint). */
export function allStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) allStrings(v, out);
  return out;
}
