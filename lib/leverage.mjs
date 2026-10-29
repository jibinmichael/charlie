// lib/leverage.mjs — where this person is MEMORABLE, not merely qualified.
//
// THE IDEA. Everyone who applies meets the requirements; that is what makes them requirements. The
// bonus (nice-to-have) list is the only place a candidate can stand out. That is the material for the
// one line in a role email that is worth forwarding:
//
//     "They listed four bonuses. You have actually done three of them."
//
// GROUNDED OR SILENT. A bonus counts as MATCHED only when the term appears in what the person has
// already told us — proof points, strengths, narrative, stated tech. Never from a title, never from
// the job, never inferred. If nothing matches we say nothing at all: an invented "you have this" is
// an invented claim about the person, and they will believe it about themselves.
//
// DETERMINISTIC, $0. Token overlap and a frequency count. No model call, so it can run on every role
// for every person without a cost conversation.

/** Words that carry no signal as a "bonus" and would match everyone. */
const STOP = new Set([
  "the","and","for","with","you","your","our","are","have","has","been","this","that","from","will","not",
  "any","all","can","was","were","its","their","them","they","who","what","when","where","which","while",
  "experience","skills","knowledge","understanding","familiarity","exposure","working","work","strong",
  "good","great","excellent","plus","bonus","nice","preferred","desirable","ability","years","year",
  "team","teams","role","roles","job","company","using","use","used","other","more","like","such","etc",
  // Two-letter words are allowed through below (Go, R, QA, UX, AI, ML are real skills), so the common
  // short English words have to be named here or they would match everyone.
  "of","in","to","on","at","is","it","be","as","by","or","an","we","us","do","if","so","no","up","my",
  "me","he","re","vs","via","per","not","but","and","are","was","has","had","who","you","our","its",
]);

// A trailing plural is stripped on BOTH sides before comparison. Without it "REST APIs" in a posting
// never matches "REST API integrations" in a person's record. Applied symmetrically, so "kubernetes" -> "kubernete" on both
// sides and still matches itself; the normalisation only has to be CONSISTENT, not linguistically right.
const singular = (w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/** Normalise to comparable tokens: lowercase words of 3+ chars, stopwords dropped, plurals folded. */
export function tokens(text) {
  return [
    ...new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9+#./ -]/g, " ")
        .split(/[\s,/]+/)
        .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
        // 2 chars, not 3: Go, R, QA, UX, AI and ML are real skills and a 3-char floor silently
        // dropped every one of them. The short-word stoplist above is what keeps this from matching noise.
        .filter((w) => w.length >= 2 && !STOP.has(w))
        .map(singular),
    ),
  ];
}

/**
 * Split a bonus section into individual items.
 *
 * Employers write these as bullets, semicolons, or one comma-separated line, so all three are handled.
 * The heading itself ("Nice to have:") is dropped — it is not something they asked for.
 */
export function parseBonuses(niceToHave) {
  // STRING ONLY. A number or object stringifies into something that passes every length check and
  // becomes a "bonus the employer asked for" — a claim invented out of a type error.
  if (typeof niceToHave !== "string") return [];
  const s = niceToHave.replace(/^[^:]{0,40}:\s*/, "");
  if (!s.trim()) return [];
  return s
    .split(/[••\n;]|(?:,\s(?=[A-Za-z]))/)
    .map((x) => x.replace(/^[\s\-–*]+/, "").trim())
    // 2 chars, not 1: "Go", "QA" and "UX" are real bonuses, but a lone character is far more often a
    // stray bullet or list marker than a skill. R and C lose out, and that is the right side to err on
    // — a fake bonus is a claim about what an employer wants.
    .filter((x) => x.length >= 2 && x.length <= 120);
}

/** Everything this person has actually told us. The ONLY place a match may come from. */
export function personEvidence(dossier) {
  const d = dossier || {};
  const claims = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x?.claim || x?.evidence || "")) : []);
  const prefs = d.preferences || {};
  const tech = Array.isArray(prefs.tech) ? prefs.tech : typeof prefs.tech === "string" ? [prefs.tech] : [];
  return [d.headline, d.narrative, ...claims(d.strengths), ...claims(d.proof_points), ...claims(d.case_studies), ...tech]
    .filter(Boolean)
    .join(" \n ");
}

/**
 * Which bonuses can this person actually evidence?
 *
 * A bonus matches when EVERY distinctive token in it appears in their record. Requiring all of them
 * (rather than any) is what stops "experience with Kubernetes and Terraform" matching someone who has
 * only ever mentioned Terraform — a half-truth we would then print as a whole one.
 *
 * @returns {{item:string, tokens:string[]}[]}
 */
export function matchedBonuses(dossier, niceToHave) {
  const evidence = new Set(tokens(personEvidence(dossier)));
  if (!evidence.size) return [];
  const out = [];
  for (const item of parseBonuses(niceToHave)) {
    const t = tokens(item);
    if (!t.length) continue;
    if (t.every((w) => evidence.has(w))) out.push({ item, tokens: t });
  }
  return out;
}

// ── RARITY: COMPUTABLE, NEVER USER-FACING ───────────────────────────────────────────────────────
//
// Weighting a bonus by how rare it is ("under 3% of postings even mention it") sounds useful, but
// document frequency over bonus lists measures SPELLING, not scarcity:
//
//     restful / rest / api / apis       one concept, an order-of-magnitude spread
//     kubernetes / k8s                  one concept, an order-of-magnitude spread
//
// So "only 0.09% of postings ask for REST APIs" would be false about the market and true only about
// the word, and a person might repeat it in an interview.
//
// It therefore MUST NOT reach an email, and a test pins that. It stays computable because a synonym
// map could make it honest; until then it is used for neither display nor ranking.
/**
 * @returns {{df: Record<string, number>, docs: number}}
 */
export function buildRarityIndex(jobs) {
  const df = Object.create(null);
  let docs = 0;
  for (const j of jobs || []) {
    const n = j?.nice_to_have;
    if (!n) continue;
    docs++;
    for (const w of tokens(n)) df[w] = (df[w] || 0) + 1;
  }
  return { df, docs };
}

/** Share of bonus lists that mention this token, as a percentage. Null when we cannot say. */
export function rarityPct(token, index) {
  if (!index?.docs || !token) return null;
  const n = index.df[token] || 0;
  if (!n) return null; // never seen: saying "0%" would overstate a number we did not observe
  return (100 * n) / index.docs;
}

/**
 * The whole readout for one person and one role.
 *
 * @returns {{matched:{item:string,rarest:number|null}[], total:number, rarestItem:string|null, rarestPct:number|null}}
 */
export function leverageFor(dossier, job, index = null) {
  const bonuses = parseBonuses(job?.nice_to_have);
  const matched = matchedBonuses(dossier, job?.nice_to_have);
  let rarestItem = null;
  let rarestPct = null;
  const withRarity = matched.map((m) => {
    let best = null;
    for (const t of m.tokens) {
      const p = rarityPct(t, index);
      if (p != null && (best == null || p < best)) best = p;
    }
    if (best != null && (rarestPct == null || best < rarestPct)) { rarestPct = best; rarestItem = m.item; }
    return { item: m.item, rarest: best };
  });
  // rarestPct is returned for measurement and future work ONLY. See the note above: it must never be
  // rendered to a person, and leverageLine() below is what callers should use.
  return { matched: withRarity, total: bonuses.length, rarestItem, rarestPct };
}

/**
 * The one line worth putting in a role email, or null.
 *
 * COUNTS AND THEIR OWN WORDS ONLY. No percentage, no market claim, nothing that cannot be pointed at
 * in the posting and in what they told us. Null when nothing matched, because an email that says "you
 * evidence 0 of 6 bonuses" is a verdict on someone, not information.
 */
export function leverageLine(dossier, job, index = null) {
  const L = leverageFor(dossier, job, index);
  if (!L.matched.length || !L.total) return null;
  const n = L.matched.length;
  const listed = L.total === 1 ? "one bonus" : `${L.total} bonuses`;
  const items = L.matched.slice(0, 3).map((m) => m.item.replace(/\s+/g, " ").trim());
  const have = n === 1 ? "You have done one of them" : `You have done ${n} of them`;
  return { text: `They listed ${listed}. ${have}: ${items.join("; ")}.`, matched: n, total: L.total };
}
