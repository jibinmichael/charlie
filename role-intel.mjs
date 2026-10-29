// role-intel.mjs — computes the US-only "Pay vs market" and "Hiring momentum" data for the role
// email. Kept out of the composer (this is DATA, not model prose) and out of render-email (this is
// where the grounding/fail-open logic lives). Both functions fail open: they return null rather than
// guess, and the renderer omits the block when the data is null.

import { blsMedian } from "./bls-wage.mjs";
import { getCompanyReqCount, getCompanyHistory } from "./charlie-store.mjs";

const num = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; };
const normCo = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Parse a posting's stated compensation into { lo, hi, currency } — ONLY when it's a confident
// annual range. Handles object forms (Lever/Workable-style min/max) and string summaries (Ashby "$120K–$160K").
// Returns null for hourly, single-value, or unparseable comp (fail open → no pay block).
export function parseComp(raw) {
  if (!raw) return null;
  let currency = "USD";
  if (typeof raw === "object") {
    currency = String(raw.currency || raw.currencyCode || currency).toUpperCase();
    const min = num(raw.min ?? raw.minValue ?? raw.minimum ?? raw.from);
    const max = num(raw.max ?? raw.maxValue ?? raw.maximum ?? raw.to);
    if (min >= 20000 && max >= min) return { lo: min, hi: max, currency }; // currency carried; BLS anchor gated to USD in computePay
    raw = raw.summary ?? raw.compensationTierSummary ?? raw.text ?? raw.value ?? "";
  }
  const s = String(raw);
  if (/\/\s*hr|per hour|hourly/i.test(s)) return null;           // annual only
  if (!/\$|usd|per year|annually|\bk\b/i.test(s)) return null;
  if (/eur|gbp|inr|cad|aud|sgd|chf|nzd|jpy|₹|£|€|¥/i.test(s)) return null; // non-USD → don't parse (avoids a cross-currency verdict)
  const vals = [...s.matchAll(/\$?\s*([0-9][0-9,.]{1,})\s*(k)?/gi)].map((m) => {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2] || v < 1000) v *= 1000;                             // "160k" or a bare "160"
    return v;
  }).filter((v) => v >= 20000 && v <= 1000000);
  if (vals.length < 2) return null;
  return { lo: Math.min(...vals), hi: Math.max(...vals), currency };
}

// Pay block data: the posting's listed range + a BLS occupational anchor (both optional/fail-open).
export async function computePay(rawJob) {
  const parsed = parseComp(rawJob?.compensation);
  if (!parsed) return null;                                      // no stated range → no block
  // Anchor to BLS only for USD ranges — comparing a non-USD listed range to a USD occupational
  // median would produce a misleading "above/below market" verdict. Non-USD still shows the range.
  const bls = parsed.currency === "USD" ? await blsMedian(rawJob?.title || "", rawJob?.location || "").catch(() => null) : null;
  return { ...parsed, bls };
}

// Momentum block data: open reqs on THIS company's ATS right now (from the current pool), how many
// posted in the last 30 days, and the month-ago count from snapshots (null until history accrues).
export async function computeMomentum(company, jobs) {
  if (!company || !Array.isArray(jobs)) return null;
  const target = normCo(company);
  const mine = jobs.filter((j) => normCo(j.company) === target);
  const openNow = mine.length;
  if (!openNow) return null;
  const now = Date.now(), D30 = 30 * 864e5;
  const opened30d = mine.filter((j) => { const t = Date.parse(j.posted_at); return t && now - t < D30; }).length;
  const monthAgoKey = new Date(now - D30).toISOString().slice(0, 10);
  const monthAgo = await getCompanyReqCount(company, monthAgoKey).catch(() => null);
  // trend sparkline: the snapshot series over the last ~6 weeks, downsampled to ~7 points + the
  // current count as the latest bar. null until history accrues (fail-open; the chart just hides).
  const hist = await getCompanyHistory(company, new Date(now - 45 * 864e5).toISOString().slice(0, 10)).catch(() => []);
  let trend = null, trendSource = null;
  if (hist.length >= 1) {
    // best: the true daily open-req series from our snapshots (accrues over time).
    const pts = hist.map((h) => h.open_count);
    const step = Math.max(1, Math.ceil(pts.length / 7));
    const sampled = pts.filter((_, i) => i % step === 0);
    sampled.push(openNow);
    if (sampled.length >= 2) { trend = sampled; trendSource = "snapshot"; }
  }
  if (!trend) {
    // fallback until snapshots accrue: reconstruct a grounded ramp from each open role's real
    // posted_at — how many of today's open roles were already posted as of each of the last 6
    // weekly marks. Only used when enough roles carry a real date (else it would be misleading).
    const dated = mine.filter((j) => { const t = Date.parse(j.posted_at); return t && t <= now; });
    if (dated.length >= Math.max(3, Math.ceil(openNow * 0.5))) {
      const pts = [];
      for (let w = 6; w >= 1; w--) {
        const mark = now - w * 7 * 864e5;
        pts.push(dated.filter((j) => Date.parse(j.posted_at) <= mark).length);
      }
      pts.push(openNow);
      trend = pts; trendSource = "posted";
    }
  }
  return { openNow, opened30d, monthAgo, trend, trendSource, company };
}

// Per-company open-req counts for the whole pool — the daily snapshot payload (scan-jobs writes it).
export function countByCompany(jobs) {
  const counts = {};
  for (const j of jobs || []) { const c = j?.company; if (c) counts[c] = (counts[c] || 0) + 1; }
  return counts;
}
