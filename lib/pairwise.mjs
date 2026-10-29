// lib/pairwise.mjs — order the shortlist by asking "which of these two", not "score this one".
//
// THE PROBLEM. Matcher scores cluster: most verdicts above the bar share a handful of values.
// scheduler.mjs walks candidates in score order and sends the first that clears the gate, so without
// a tiebreak the daily pick is drawn from a near-total tie.
//
// THE FIX. Rank the top GATE_SCAN candidates by pairwise comparison before the walk. Merge sort with
// an async comparator gives a total order in O(n log n) comparisons — for 6 candidates that is ~10,
// not the 15 an all-pairs matrix would need, and it is exact rather than a heuristic.
//
// COST, because this runs per user per day: ~10 Haiku comparisons per person, each a short prompt
// (the person block plus two truncated postings). If it ever costs more than the match batch it is
// not worth it.
//
// FAILS OPEN, ALWAYS. Any error, any unparseable reply, any missing key returns the ORIGINAL order.
// A ranking that cannot run must never stop a send — the person gets today's role in score order,
// exactly as before. This is the one behaviour that cannot regress: the send is the product.

import Anthropic from "@anthropic-ai/sdk";
import { PAIRWISE_SYSTEM, buildPairwiseUser, personBlock } from "../prompts/pairwise-rank.mjs";

const MODEL = process.env.PAIRWISE_MODEL || "claude-haiku-4-5";

/** off | shadow | on. Read at call time so a deploy can change it without a code change. */
export function pairwiseMode() {
  const v = String(process.env.PAIRWISE_RANK || "off").toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

/**
 * Ask once: is A better than B for this person?
 * @returns {Promise<boolean|null>} true = A wins, false = B wins, null = could not decide
 */
async function aBeatsB({ client, person, a, b }) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4, // one letter; a bigger budget only buys a model the room to explain itself
    temperature: 0,
    system: [{ type: "text", text: PAIRWISE_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: buildPairwiseUser({ person, a, b }) }],
  });
  const t = (res?.content || []).filter((x) => x.type === "text").map((x) => x.text).join("").trim().toUpperCase();
  if (t.startsWith("A")) return true;
  if (t.startsWith("B")) return false;
  return null; // an unreadable reply is a tie, not a guess
}

/**
 * Merge sort with an async comparator. Stable, so an undecidable pair keeps its incoming order and
 * the result degrades gracefully toward the score ranking rather than scrambling.
 */
async function mergeSort(items, cmp) {
  if (items.length <= 1) return items;
  const mid = Math.floor(items.length / 2);
  const [left, right] = await Promise.all([mergeSort(items.slice(0, mid), cmp), mergeSort(items.slice(mid), cmp)]);
  const out = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    // A null (undecided) keeps LEFT first, which is the incoming order: stable by construction.
    const aWins = await cmp(left[i], right[j]);
    if (aWins === false) out.push(right[j++]);
    else out.push(left[i++]);
  }
  return out.concat(left.slice(i), right.slice(j));
}

/**
 * Reorder a shortlist by pairwise preference.
 *
 * @param {object[]} candidates  score-ordered, already above the bar
 * @param {object}   dossier
 * @param {object}   opts        { limit } how many to rank (the rest keep their order behind them)
 * @returns {Promise<{order: object[], comparisons: number, changed: boolean}>}
 */
export async function pairwiseReorder(candidates, dossier, { limit = 6, log = console.error } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const head = list.slice(0, limit);
  const tail = list.slice(limit);
  if (head.length < 2) return { order: list, comparisons: 0, changed: false };

  let comparisons = 0;
  try {
    if (!process.env.ANTHROPIC_API_KEY) return { order: list, comparisons: 0, changed: false };
    const client = new Anthropic();
    const person = personBlock(dossier);
    const memo = new Map(); // the same pair can recur across merge levels; never pay for it twice

    const cmp = async (a, b) => {
      const key = `${a?.id}|${b?.id}`;
      if (memo.has(key)) return memo.get(key);
      const inv = memo.get(`${b?.id}|${a?.id}`);
      if (inv !== undefined) return inv === null ? null : !inv;
      comparisons++;
      let r = null;
      try {
        r = await aBeatsB({ client, person, a, b });
      } catch (e) {
        log(`[pairwise] comparison failed (${e.message}) — keeping score order for this pair`);
      }
      memo.set(key, r);
      return r;
    };

    const sorted = await mergeSort(head, cmp);
    const changed = sorted.some((c, i) => c?.id !== head[i]?.id);
    return { order: sorted.concat(tail), comparisons, changed };
  } catch (e) {
    log(`[pairwise] reorder failed (${e.message}) — sending in score order`);
    return { order: list, comparisons, changed: false };
  }
}
