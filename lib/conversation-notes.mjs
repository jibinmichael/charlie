// lib/conversation-notes.mjs — the check that runs after prompts/conversation-notes.mjs (registered, not wired yet).
// PURE. A quote merely appearing somewhere in the reply is not enough: a point's own words could still say more than
// the quote ("never led a team" becoming "has led a team"), so every point is checked against its quote.
//
// A POINT IS SHOWN ONLY WHEN ALL OF THESE HOLD, otherwise it is dropped and counted, never shown:
//   - its quote is the candidate's OWN words: found in a reply after quoted history (">" lines, "On ... wrote:") is
//     removed, starting and ending on whole words, at least 3 words and 12 characters;
//   - the words just before the quote do not flip it (never, not, no, would, want to, hope, plan to, if, someday ...)
//     unless the quote itself carries that word;
//   - its text says nothing the quote does not: every content word of the text is in the quote, apart from the
//     candidate's first name, their / they / them for I / my / me, and connecting words. So no upgraded verb, no praise,
//     no other name, no number word, no added fact can pass;
//   - every number keeps its unit (the next word), and a hedge in the quote (about, around ...) stays in the text;
//   - it guesses no gender.
// `supports` (which of the role's checks the quote establishes) is the model's SUGGESTION: kept only for the role's
// own ids, shown beside the exact words, and never used for scoring or gating.
// Every question asked gets an entry: one the model left out reads "not answered", never disappears.
import { ConversationNotesOutput } from "./schemas/conversation-notes.mjs";

const norm = (s) => String(s || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** The candidate's own words in a reply: quoted history and everything after "On ... wrote:" removed. Pure. */
export function ownWords(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const l of lines) {
    if (/^\s*on\b.{0,200}\bwrote:\s*$/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n");
}

// words that join a point without adding to it; and the person swaps (I said it, the note says their name or they)
const GLUE = new Set("a an the and or but of to for in on at by with from as is are was were be been being has have had do does did it its this that these those so than then there here also just still".split(" "));
const PERSON = new Set("they them their theirs themselves i me my mine myself i'm i've i'd i'll".split(" "));
const MARKERS = /\b(not|never|no|none|nor|n't|didn't|don't|doesn't|haven't|hasn't|won't|wouldn't|can't|cannot|would|want to|wanted to|hope|hoping|plan to|planning to|wish|if|someday|one day|might|may)\b/i;
const HEDGES = /\b(about|around|roughly|nearly|approximately|approx|almost|some|~)\b|~/i;
const GENDER = /\b(he|she|him|her|his|hers|himself|herself|mr|mrs|ms)\b/i;
const tokens = (s) => norm(s).replace(/[^a-z0-9'&.\s]/g, " ").split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, "").replace(/\.$/, "")).filter(Boolean);
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);
const numberUnits = (s) => [...norm(s).matchAll(/(\d+(?:[.,]\d+)?)\s*([a-z%]+)?/g)].map((m) => `${m[1]} ${m[2] || ""}`.trim());

/** Why a point cannot be shown, or null when it can. Pure. */
export function pointProblem({ text, quote }, { replies, firstName }) {
  const q = norm(quote);
  if (q.split(" ").length < 3 || q.length < 12) return "its quote is too short to stand on";
  // the latest reply that holds the quote on whole words
  let where = null;
  for (let i = replies.length - 1; i >= 0 && !where; i--) {
    const r = norm(ownWords(replies[i].text));
    let at = r.indexOf(q);
    while (at !== -1) {
      const before = r[at - 1], after = r[at + q.length];
      if ((!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))) { where = { i, at, r }; break; }
      at = r.indexOf(q, at + 1);
    }
  }
  if (!where) return "its quote is not in their own words";
  // the same clause only: what came before a full stop, semicolon or line break does not flip this quote
  const lead = where.r.slice(Math.max(0, where.at - 40), where.at).split(/[.!?;\n]/).pop();
  const flip = lead.match(MARKERS);
  if (flip && !MARKERS.test(q)) return `the words before its quote change its meaning ("${flip[0]}")`;
  if (GENDER.test(text)) return "it guesses a gender";
  const allowed = new Set([...tokens(quote).map(stem), ...tokens(firstName || "").map(stem)]);
  const extra = tokens(text).filter((w) => !GLUE.has(w) && !PERSON.has(w) && !allowed.has(stem(w)));
  if (extra.length) return `it says more than the quote (${extra.slice(0, 3).join(", ")})`;
  const qn = numberUnits(quote);
  const missing = numberUnits(text).filter((n) => !qn.some((x) => x === n || x.split(" ")[0] === n));
  if (missing.length) return `a number or unit the quote does not have (${missing.join(", ")})`;
  if (HEDGES.test(quote) && !HEDGES.test(text)) return "it drops the quote's hedge";
  return null;
}

/**
 * @param raw        the model's parsed JSON
 * @param questions  the questions asked, in order (n counts from 1)
 * @param replies    the candidate's replies, verbatim: [{ text, day? }]
 * @param checkIds   the role's check ids
 * @param firstName  the candidate's first name, from their own record (never from the model)
 * @returns {{ ok: boolean, notes: Array<{ n, question, answered, points: Array<{ text, quote, supports, day }> }>, dropped: Array<{ n, text, why }> }}
 */
export function verifyNotes(raw, { questions, replies, checkIds, firstName = "" }) {
  const parsed = ConversationNotesOutput.safeParse(raw);
  if (!parsed.success) return { ok: false, notes: [], dropped: [{ n: null, text: null, why: `the reply did not match its schema: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }] };
  const known = new Set(checkIds);
  const dropped = [];
  // one entry per question asked, and "also said" (n 0) only when it holds something
  const byN = new Map(questions.map((question, i) => [i + 1, { n: i + 1, question, points: [], said: false }]));
  byN.set(0, { n: 0, question: "Also said", points: [], said: false });
  for (const q of parsed.data.notes) {
    const entry = byN.get(q.n);
    if (!entry) { dropped.push({ n: q.n, text: null, why: "a question that was not asked" }); continue; }
    entry.said = true;
    for (const p of q.points) {
      const why = pointProblem(p, { replies, firstName });
      if (why) { dropped.push({ n: q.n, text: p.text, why }); continue; }
      const day = [...replies].reverse().find((r) => norm(ownWords(r.text)).includes(norm(p.quote)))?.day ?? null;
      entry.points.push({ text: p.text, quote: p.quote, supports: p.supports.filter((id) => known.has(id)), day });
    }
  }
  for (const [n, e] of byN) if (n > 0 && !e.said) dropped.push({ n, text: null, why: "the model left this question out; it reads not answered" });
  const notes = [...byN.values()]
    .filter((e) => e.n > 0 || e.points.length)
    .map((e) => ({ n: e.n, question: e.question, answered: e.points.length > 0, points: e.points }))
    .sort((a, b) => (a.n === 0) - (b.n === 0) || a.n - b.n);
  return { ok: true, notes, dropped };
}
