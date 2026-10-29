// lib/form-answers.mjs — get a candidate's form answers back out of a stored dossier.
//
// PREFER THE STORED MAP. scripts/pool-applicants.mjs writes `dossier.answers`, the question-to-answer
// object exactly as Tally returned it. When it is there, this module hands it straight back and no
// parsing happens at all. The fallback below exists only for rows written without that field.
//
// THE FALLBACK CANNOT DROP. `narrative` is built as "Question\nAnswer" blocks joined by a blank line.
// An answer containing a blank line becomes several blocks, and a single-paragraph block has no
// internal newline. A reader that takes each block's first line as the question silently discards
// exactly those paragraphs, which are often the best evidence (one idea per paragraph). So a
// continuation block is appended to the answer it continues, and nothing is skipped, ever. A block
// that cannot be attributed to a question becomes its own entry rather than disappearing, because a
// mislabelled paragraph still reaches the model and a deleted one cannot.

/**
 * @param {object} dossier a stored dossier
 * @returns {Record<string,string>} question title -> answer. Never loses a character of `narrative`.
 */
export function formAnswers(dossier) {
  const stored = dossier?.answers;
  if (stored && typeof stored === "object" && !Array.isArray(stored) && Object.keys(stored).length) {
    return Object.fromEntries(Object.entries(stored).map(([k, v]) => [String(k), String(v ?? "")]));
  }
  return parseNarrative(dossier?.narrative);
}

/** The lossless fallback. Exported for the test that proves it against the old behaviour. */
export function parseNarrative(narrative) {
  const out = {};
  let last = null;
  for (const block of String(narrative || "").split(/\n\n(?=[A-Z])/)) {
    if (!block.trim()) continue;
    const i = block.indexOf("\n");
    if (i > 0) {
      const key = block.slice(0, i);
      const value = block.slice(i + 1);
      // A repeated title is a continuation too, not a replacement: overwriting would lose an answer.
      out[key] = out[key] ? `${out[key]}\n\n${value}` : value;
      last = key;
      continue;
    }
    // No internal newline: a continuation paragraph of the answer above it.
    if (last) out[last] = `${out[last]}\n\n${block}`;
    else out[block] = ""; // nothing to attach to; keep the text as its own entry rather than drop it
  }
  return out;
}
