// skill-normalise.mjs — one skill, written one way.
//
// THE PROBLEM. Free-text skills arrive in many spellings of the same thing: "rag", "rag pipelines",
// "rag pipeline design", "rag systems", "retrieval-augmented generation (rag)". Left alone, each is a
// separate bucket in every count, so every scarcity number is divided by an arbitrary number of
// spellings.
//
// WHY NOT A PUBLIC TAXONOMY. ESCO is an occupation-and-task classification, not a tool vocabulary (no
// Figma, Kubernetes or LangChain), and commercial ones need paid credentials. So the vocabulary is
// built from our own corpus, which is in any case the ground truth for our own market.
//
// DETERMINISTIC FIRST, AND MOSTLY DETERMINISTIC IS ENOUGH. Rules run before any model does, because
// a regex that collapses "user research" and "user researcher" costs nothing and cannot hallucinate.
//
// IT NORMALISES SPELLING, NEVER MEANING. "rag pipelines" and "rag" become one skill because they name
// the same thing. "rag evaluation" does NOT collapse into "rag", because evaluating a system and
// building one are different work and a hiring manager filtering on one does not mean the other.
// When in doubt the rule leaves the string alone: a missed merge is a smaller count, a wrong merge is
// a person credited with a skill they never claimed.

/** Compound names that are ONE skill and must survive punctuation stripping. */
const ATOMIC = new Map([
  ["a/b testing", "a/b testing"], ["a/b tests", "a/b testing"], ["ab testing", "a/b testing"],
  ["ui/ux design", "ui/ux design"], ["ux/ui design", "ui/ux design"], ["ui/ux", "ui/ux design"],
  ["ux/ui", "ui/ux design"], ["ci/cd pipelines", "ci/cd"], ["ci/cd", "ci/cd"],
  ["agile/scrum", "agile"], ["scrum/agile", "agile"],
]);

/** Words that describe how well somebody knows a skill, not which skill it is. */
const FILLER = new RegExp(
  "\\b(hands[- ]?on|advanced|basic|strong|solid|deep|extensive|working|practical|proficiency|proficient" +
  "|expertise|expert|experience[d]?|knowledge|understanding|skills?|ability|competency|familiarity|familiar" +
  "|in|with|of|using|used|end[- ]to[- ]end)\\b", "g");

/** Acronyms and long forms of the same thing. Left side is what people write; right side is canonical. */
const SYNONYM = new Map([
  ["retrieval augmented generation", "rag"], ["retrieval-augmented generation", "rag"],
  ["large language models", "llm"], ["large language model", "llm"], ["llms", "llm"],
  ["generative ai", "genai"], ["gen ai", "genai"],
  ["machine learning", "ml"], ["artificial intelligence", "ai"],
  ["user experience", "ux"], ["user interface", "ui"],
  ["search engine optimization", "seo"], ["search engine optimisation", "seo"],
  ["continuous integration", "ci/cd"], ["continuous delivery", "ci/cd"],
  ["customer relationship management", "crm"],
  ["objectives and key results", "okrs"], ["okr", "okrs"],
  ["quality assurance", "qa"], ["user acceptance testing", "uat"],
  ["design system", "design systems"],
  ["javascript", "javascript"], ["js", "javascript"],
  ["postgresql", "postgres"], ["node.js", "node"], ["nodejs", "node"],
  ["amazon web services", "aws"], ["google cloud platform", "gcp"],
]);

/**
 * Plural to singular, but ONLY when the singular is a word we have actually seen.
 *
 * A rule-only stemmer damages real names: it turns "kubernetes" into "kubernete" and "analyses"
 * into "analys". English plural rules cannot tell a plural from a word that happens to end in s, and
 * a skill vocabulary is full of the latter. So the corpus decides: "pipelines" folds to "pipeline"
 * because people also write "pipeline"; "kubernetes" does not fold because "kubernete" is not a word
 * anyone has ever written. Without an attested set, nothing is folded, which is the safe direction.
 */
const singular = (w, attested) => {
  if (!attested || !attested.size) return w;
  const cand = /ies$/.test(w) ? `${w.slice(0, -3)}y`
    : /(s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2)
    : /[^s]s$/.test(w) ? w.slice(0, -1)
    : null;
  return cand && cand.length > 2 && attested.has(cand) ? cand : w;
};

/** Is `inner` the acronym of `head`? "retrieval-augmented generation" -> "rag". */
const isAcronymOf = (inner, head) => {
  const a = inner.replace(/[^a-z]/g, "");
  const initials = head.split(/[\s-]+/).filter(Boolean).map((w) => w[0]).join("");
  return a.length >= 2 && a === initials;
};

/**
 * The canonical form of one skill string, or "" if there is nothing usable in it.
 * Pure, deterministic, no model, no network.
 *
 * @param {string} raw
 * @param {Set<string>} [attested]  singular word forms seen in the corpus. Without it no plural is
 *   folded, because folding without evidence is what produced "kubernete".
 */
export function normaliseSkill(raw, attested) {
  let s = String(raw || "").toLowerCase().trim();
  if (!s) return "";
  if (ATOMIC.has(s)) return ATOMIC.get(s);

  // An acronym restated in brackets is the same skill twice: "retrieval-augmented generation (rag)".
  // A bracket is dropped and the HEAD is kept, because the head is the skill: "wireframing (figma)"
  // is wireframing, and reducing it to "figma" deletes the skill and keeps the tool. The one
  // exception is a bracket that merely restates the head as its own acronym.
  const bracket = s.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (bracket) {
    const head = bracket[1].trim(), inner = bracket[2].trim();
    // A comma list inside the bracket is NAMED TOOLS, and they are the searchable part:
    // "agentic ai (google adk, langgraph)", "email deliverability (spf, dkim, dmarc)". Dropping to
    // the head loses langgraph and dkim for everyone who wrote them. Leaving the string whole
    // loses nothing and adds nothing, which is the contract; it merely stays uncanonical.
    if (!inner.includes(",")) s = isAcronymOf(inner, head) ? inner : head;
  }
  if (ATOMIC.has(s)) return ATOMIC.get(s);
  if (SYNONYM.has(s)) return SYNONYM.get(s);

  s = s.replace(/[.,;:]+$/g, "").replace(/\s+/g, " ").trim();
  if (ATOMIC.has(s)) return ATOMIC.get(s);
  if (SYNONYM.has(s)) return SYNONYM.get(s);

  // Strip the words that grade a skill rather than name it, then re-check.
  let stripped = s.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!stripped) stripped = s;                                  // "experience" alone: keep the original
  if (SYNONYM.has(stripped)) return SYNONYM.get(stripped);
  if (ATOMIC.has(stripped)) return ATOMIC.get(stripped);

  const words = stripped.split(" ").filter(Boolean).map((w) => singular(w, attested));
  const out = words.join(" ").trim();
  if (SYNONYM.has(out)) return SYNONYM.get(out);
  return out || s;
}

/**
 * Build the attested singular vocabulary from every skill string we hold. Pass it to normaliseSkill
 * so a plural only folds onto a word somebody has actually written.
 */
export function attestedWords(rawSkills = []) {
  const w = new Set();
  for (const s of rawSkills) for (const t of String(s || "").toLowerCase().split(/[^a-z0-9+#./]+/)) if (t) w.add(t);
  return w;
}

/**
 * Fold a list of raw skills to canonical form, dropping duplicates and preserving order.
 * A person who wrote "RAG" and "rag pipelines" has one skill, not two.
 */
export function normaliseSkillList(list = [], attested) {
  const seen = new Set(); const out = [];
  for (const raw of list) {
    const k = normaliseSkill(raw, attested);
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}
