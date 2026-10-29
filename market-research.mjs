// market-research.mjs — the evidence layer of the weekly market-gap drop.
//
// TWO responsibilities, kept separate so the grounded core is testable with no I/O:
//   1) POOL GROUND TRUTH (pure, no network): aggregateGaps() turns a batch of recomputed
//      fit-coverage reads over a user's near-miss roles into a ranked list of the recurring
//      requirements those roles ask for but the person has NOT shown (status unknown/partial).
//      This is the real, current market signal from Charlie's own scanned pool. classifyGap()
//      decides how the person closes it (share a doc vs adjust a preference).
//   2) MARKET ENRICHMENT (async, cached, flag-gated): researchGap() adds "what the market says"
//      about ONE gap, ATTRIBUTED to real sources — a few web_search lines (each dropped unless it
//      carries a source URL) plus a BLS pay anchor. Cached by (gap × role × region), NOT by user,
//      so cost scales with distinct gap-tuples, not headcount. Gated by MARKETGAP_WEB (off by
//      default): the pool ground truth alone is enough to send; the web layer is enhancement.
//
// Nothing here states a fact about a PERSON — that stays in fit-coverage.mjs. Grounding:
// Charlie never voices a market claim as its own; researchGap returns sourced lines the template
// attributes, or nothing.

import Anthropic from "@anthropic-ai/sdk";
import { MARKET_RESEARCH_SYSTEM } from "./prompts/market-research.mjs";
import { MarketResearchOutput } from "./lib/schemas/market-gap.mjs";
import { getCachedMarket, putCachedMarket } from "./charlie-store.mjs";
import { blsMedian } from "./bls-wage.mjs";

const RESEARCH_MODEL = process.env.MARKETGAP_RESEARCH_MODEL || "claude-sonnet-4-6";
const SEARCH_MAX = Number(process.env.MARKETGAP_SEARCH_MAX || 3);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// A market line is trusted ONLY if it carries a real http(s) source. `researchGap` drops
// any line whose source fails this. Exported so the grounding gate is locked by a test.
export const isHttpUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || "").trim());

// Which requirements a person can DEMONSTRATE (share a doc/story) vs which are a stated PREFERENCE
// they'd adjust (pay floor, location). Drives the drop's close. Preference gaps are the short list;
// everything else is evidence the person can show.
// stems carry \w* where a requirement label inflects (authoriz -> authorization, sponsor -> sponsorship,
// reloc -> relocation), so a trailing word-boundary never misses the inflected form. `comp` is spelled
// out to its real words so it can't swallow "company".
const PREF_RE = /\b(comp(?:ensation)?\s*floor|compensation|salary|salaries|\bpay\b|wage|ctc|budget|reloc\w*|on-?site|in[- ]?office|hybrid|remote|location|based in|visa|sponsor\w*|work\s*auth\w*|authoriz\w*|citizen\w*)/i;
export function classifyGap(label) {
  return PREF_RE.test(String(label || "")) ? "pref" : "share";
}

// PURE. Given recomputed coverage reads over a user's near-miss roles, rank the requirements those
// roles ask for that the person has shown NO evidence of (status `unknown` ONLY). Returns
// [{ gap, key, count, total, kind }] sorted by count desc, keeping only gaps that recur (>= minCount).
//   coverages: array of computeCoverage() results (thin ones ignored).
//   total     = number of scoreable (non-thin) near-misses considered — the "of N" denominator.
//
// `partial` is DELIBERATELY EXCLUDED: fit-coverage.mjs defines partial as "the person HAS shown this
// in part" (it earns 0.5 credit and carries evidence). The drop's honest framing ("nothing from you
// speaks to it yet") would be a FALSE claim about their own evidence for a partial gap, and would
// mildly inflate the gap. Only truly-unshown (`unknown`) requirements are the honest, non-shaming,
// share-a-doc gap this drop aims at.
export function aggregateGaps(coverages, { minCount = 2 } = {}) {
  const scoreable = (Array.isArray(coverages) ? coverages : []).filter((c) => c && !c.thin && Array.isArray(c.coverage));
  const total = scoreable.length;
  const byKey = new Map(); // key -> { key, labels: Map<label,count>, count }
  for (const cov of scoreable) {
    // one role contributes each distinct gap-key at most once (we count ROLES that asked, not reqs).
    const seen = new Set();
    for (const r of cov.coverage) {
      if (!r || r.status !== "unknown") continue;
      const label = String(r.req || "").trim();
      const key = norm(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const e = byKey.get(key) || { key, labels: new Map(), count: 0 };
      e.count += 1;
      e.labels.set(label, (e.labels.get(label) || 0) + 1);
      byKey.set(key, e);
    }
  }
  const ranked = [...byKey.values()]
    .filter((e) => e.count >= minCount)
    .map((e) => {
      // display label = the most frequent original casing seen for this key.
      const gap = [...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { gap, key: e.key, count: e.count, total, kind: classifyGap(gap) };
    })
    .sort((a, b) => b.count - a.count || b.total - a.total);
  return ranked;
}

const stripFences = (s) => String(s || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
const textOf = (res) => (res?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();

// ASYNC, cached, flag-gated. "What the market says" about ONE gap for a role/region: attributed web
// lines + an optional BLS pay anchor (US only). Returns { lines:[{claim,source}], pay:{...}|null }.
// Never throws; on any failure returns empty enrichment and the drop sends on pool signal alone.
export async function researchGap({ gap, role = "", region = "india", log = console.error } = {}) {
  const empty = { lines: [], pay: null };
  if (!gap) return empty;
  if (String(process.env.MARKETGAP_WEB || "").toLowerCase() !== "on") return empty; // web layer gate (off by default)

  const cacheKey = `${norm(gap)}|${norm(role)}|${norm(region)}`;
  const cached = await getCachedMarket(cacheKey).catch(() => null);
  if (cached) return cached;

  const out = { lines: [], pay: null };

  // 1) attributed web lines — each dropped unless it carries a real source URL.
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = new Anthropic();
      const ask = `Requirement: ${gap}\nRole: ${role || "(unspecified)"}\nRegion: ${region}`;
      const res = await client.messages.create({
        model: RESEARCH_MODEL,
        max_tokens: 1200,
        system: MARKET_RESEARCH_SYSTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: SEARCH_MAX }],
        messages: [{ role: "user", content: ask }],
      });
      let parsed;
      try { parsed = JSON.parse(stripFences(textOf(res))); } catch { parsed = null; }
      const v = MarketResearchOutput.safeParse(parsed || {});
      if (v.success) {
        out.lines = v.data.lines.filter((l) => isHttpUrl(l.source)).slice(0, 3);
      } else {
        log(`[market-research] research output failed schema for "${gap}": ${v.error?.issues?.[0]?.message || "invalid"}`);
      }
    }
  } catch (e) {
    log(`[market-research] web lookup failed for "${gap}" (omitting): ${e.message}`);
  }

  // 2) BLS pay anchor — US only, structured + authoritative + separately cached in bls-wage.
  if (region === "us") {
    try {
      const b = await blsMedian(role, "US");
      if (b && Number.isFinite(b.median)) out.pay = { median: b.median, label: b.socLabel, area: b.area, source: b.url };
    } catch (e) { log(`[market-research] bls anchor failed (omitting): ${e.message}`); }
  }

  // cache the combined enrichment by tuple (best-effort). Only cache a non-empty result so a
  // transient miss re-tries next week rather than caching a dry run.
  if (out.lines.length || out.pay) await putCachedMarket(cacheKey, out).catch(() => {});
  return out;
}
