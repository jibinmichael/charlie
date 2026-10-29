// mandate-parse.mjs — the quote check and the report. PURE: no model, no I/O, no clock.
//
// Kept apart from scripts/mandate-parse.mjs so the rule that matters can be tested without an API key:
// a requirement survives only if its quote is genuinely in the job description.

/** Loose enough for whitespace and case, strict about the words themselves. */
export const norm = (s) => String(s || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/**
 * Drop every requirement whose quote is not in the source, and say which.
 *
 * A DROP IS REPORTED, NEVER SILENT. A model that invents a requirement and a model that finds none
 * produce the same short list, and telling those apart is the whole reason this returns two values.
 *
 * @returns {{kept: object, dropped: Array<{bucket:string,requirement:string,quote:string}>}}
 */
export function verifyQuotes(mandate, jdText) {
  const hay = norm(jdText);
  const dropped = [];
  const keep = (bucket, items) =>
    (items || []).filter((it) => {
      const q = norm(it.quote);
      // A quote too short to be distinctive is not evidence that anything was found.
      if (q.length < 8 || !hay.includes(q)) {
        dropped.push({ bucket, requirement: it.requirement || it.phrase || "(unnamed)", quote: it.quote || "" });
        return false;
      }
      return true;
    });

  const kept = {
    ...mandate,
    hard: keep("hard", mandate.hard),
    preferred: keep("preferred", mandate.preferred),
    capabilities: keep("capabilities", mandate.capabilities),
    ambiguous: keep("ambiguous", mandate.ambiguous),
    // A contradiction needs BOTH quotes present, or it is not a contradiction in this document.
    contradictions: (mandate.contradictions || []).filter((c) => {
      const a = norm(c.quote_a), b = norm(c.quote_b);
      const good = a.length >= 8 && b.length >= 8 && hay.includes(a) && hay.includes(b);
      if (!good) dropped.push({ bucket: "contradictions", requirement: c.what || "(unnamed)", quote: `${c.quote_a} / ${c.quote_b}` });
      return good;
    }),
  };
  return { kept, dropped };
}

/** The human-readable matrix. Section 3 of the brief, as something you can read in a terminal. */
export function renderMatrix(m, dropped = [], source = "") {
  const L = [];
  const rule = "─".repeat(78);
  L.push(rule);
  L.push(`${m.role}${m.company ? ` · ${m.company}` : " · company not named"}${m.location ? ` · ${m.location}` : ""}`);
  if (source) L.push(`from ${source}`);
  L.push(rule);

  const block = (title, items, fmt) => {
    L.push(`\n${title}  (${items.length})`);
    if (!items.length) { L.push("  none stated"); return; }
    items.forEach((it, i) => L.push(fmt(it, i)));
  };

  block("HARD REQUIREMENTS — the document makes these mandatory", m.hard, (it) =>
    `  ${it.requirement}\n      needs: ${it.evidence_needed}\n      said:  "${it.quote}"`);
  block("PREFERRED", m.preferred, (it) =>
    `  ${it.requirement}\n      needs: ${it.evidence_needed}\n      said:  "${it.quote}"`);
  block("CAPABILITIES — only visible through evidence of work", m.capabilities, (it) =>
    `  ${it.requirement}\n      look for: ${it.observable.join(" · ")}\n      said:  "${it.quote}"`);
  block("AMBIGUOUS — sounds measurable, is not, until it is defined", m.ambiguous, (it) =>
    `  "${it.phrase}"\n      would have to mean: ${it.translated_to.join(" · ")}\n      said:  "${it.quote}"`);

  if (m.contradictions.length) {
    L.push(`\nCONTRADICTIONS — the document disagrees with itself  (${m.contradictions.length})`);
    for (const c of m.contradictions) L.push(`  ${c.what}\n      "${c.quote_a}"\n      "${c.quote_b}"`);
    L.push(`  These are for the client to settle. Nothing here resolves them.`);
  }
  if (m.unknowns.length) {
    L.push(`\nTHE DOCUMENT DOES NOT SAY  (${m.unknowns.length})`);
    for (const u of m.unknowns) L.push(`  ${u}`);
  }
  if (dropped.length) {
    L.push(`\nDROPPED — a quote that is not in the document  (${dropped.length})`);
    for (const d of dropped) L.push(`  [${d.bucket}] ${d.requirement}\n      claimed: "${String(d.quote).slice(0, 120)}"`);
    L.push(`  Each of these was refused because the words could not be found in the source.`);
  }

  L.push(`\n${rule}`);
  L.push(`${m.hard.length} hard · ${m.preferred.length} preferred · ${m.capabilities.length} capabilities · ${m.ambiguous.length} ambiguous · ${m.contradictions.length} contradictions · ${dropped.length} dropped`);
  L.push(`Nobody was scored. This describes the mandate only.`);
  return L.join("\n");
}
