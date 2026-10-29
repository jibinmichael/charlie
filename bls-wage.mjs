// bls-wage.mjs — the market anchor for the role email's "Pay vs market" block.
//
// Given a role title and a US location, return the BLS OES (OEWS) annual MEDIAN wage for the
// closest occupation in that metro — a public-domain, legally-clean market band to say a posting's
// stated range is above / in line with / below market. This is NEVER company-level: it's an
// occupation-level median, and we label it as such in the email.
//
// Grounding + enterprise rules:
//   - FAIL-OPEN. No confident occupation mapping, a network error, or an empty BLS response →
//     return null, and the email simply omits the anchor (shows the listed range alone). We never
//     invent or approximate a number.
//   - The title→SOC map is deliberately SMALL and confident. Unmapped titles (e.g. product manager,
//     sales) return null rather than a coarse guess. Expand only with confident mappings.
//   - Every call goes through safeFetch (SSRF-guarded) and is cached long (wages are annual).
//
// BLS OEWS series ID (25 chars): OE + U + areatype(M/N/S) + area(7) + industry(6) + occ(6) + datatype(2)
//   industry 000000 = cross-industry, datatype 13 = annual median wage.
// Docs: https://www.bls.gov/developers/  ·  OEWS: https://www.bls.gov/oes/

import { safeFetch } from "./safe-fetch.mjs";
import { getCachedBls, putCachedBls } from "./charlie-store.mjs";

// title → { soc (6-digit, no dash), label }. Confident mappings only; everything else fails open.
const SOC_MAP = [
  { re: /\b(ux|ui|product|web|digital|interaction)\b.*design|design.*\b(ux|ui|product|web|digital|systems)\b|\bproduct designer\b|\bux designer\b|\bui designer\b/i, soc: "151255", label: "digital & interface designers" },
  { re: /\b(graphic|visual|brand|motion)\b.*design|\bgraphic designer\b/i, soc: "271024", label: "graphic designers" },
  { re: /\b(software|backend|front.?end|full.?stack|application|platform|systems)\b.*\b(engineer|developer)\b|\bswe\b|\bsoftware engineer\b|\bdeveloper\b/i, soc: "151252", label: "software developers" },
  { re: /\b(data scientist|machine learning|\bml\b|\bai\b.*engineer|data engineer)\b/i, soc: "152051", label: "data scientists" },
  { re: /\b(marketing manager|head of marketing|growth manager)\b/i, soc: "112021", label: "marketing managers" },
  { re: /\b(marketing|growth|demand gen|content strateg)\b/i, soc: "131161", label: "marketing specialists" },
];
function socFor(title) {
  const t = String(title || "");
  for (const m of SOC_MAP) if (m.re.test(t)) return { soc: m.soc, label: m.label };
  return null;
}

// US location → OEWS metro area (7-digit MSA code) or the national fallback. Order matters
// (check specific metros before broad state names).
const METRO_MAP = [
  { re: /new york|nyc|manhattan|brooklyn|newark|jersey city/i, type: "M", code: "0035620", label: "New York metro" },
  { re: /san jose|santa clara|sunnyvale|silicon valley/i, type: "M", code: "0041940", label: "San Jose metro" },
  { re: /san francisco|\bsf\b|oakland|bay area/i, type: "M", code: "0041860", label: "San Francisco metro" },
  { re: /seattle|bellevue|tacoma/i, type: "M", code: "0042660", label: "Seattle metro" },
  { re: /los angeles|\bla\b|long beach|anaheim/i, type: "M", code: "0031080", label: "Los Angeles metro" },
  { re: /boston|cambridge/i, type: "M", code: "0014460", label: "Boston metro" },
  { re: /austin/i, type: "M", code: "0012420", label: "Austin metro" },
  { re: /chicago/i, type: "M", code: "0016980", label: "Chicago metro" },
  { re: /denver|boulder/i, type: "M", code: "0019740", label: "Denver metro" },
  { re: /atlanta/i, type: "M", code: "0012060", label: "Atlanta metro" },
  { re: /washington|\bdc\b|arlington/i, type: "M", code: "0047900", label: "Washington DC metro" },
];
function areaFor(location) {
  const l = String(location || "");
  for (const m of METRO_MAP) if (m.re.test(l)) return { type: m.type, code: m.code, label: m.label };
  return { type: "N", code: "0000000", label: "US" }; // national fallback
}

function seriesId(area, soc) { return `OEU${area.type}${area.code}000000${soc}13`; }

// The occupation median for (title, location). Returns { median, socLabel, area, url } or null.
export async function blsMedian(roleTitle, location) {
  const occ = socFor(roleTitle);
  if (!occ) return null; // no confident occupation → fail open
  const area = areaFor(location);
  const id = seriesId(area, occ.soc);
  const cacheKey = `${area.type}${area.code}:${occ.soc}`;

  let median = await getCachedBls(cacheKey).catch(() => null);
  if (median == null) {
    try {
      const key = process.env.BLS_API_KEY;
      const base = key ? "https://api.bls.gov/publicAPI/v2" : "https://api.bls.gov/publicAPI/v1";
      const url = `${base}/timeseries/data/${id}?latest=true${key ? `&registrationkey=${key}` : ""}`;
      const res = await safeFetch(url, { timeoutMs: 8000, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const j = await res.json();
      const series = j?.Results?.series?.[0];
      const pts = Array.isArray(series?.data) ? series.data : [];
      if (!pts.length) return null;
      // most recent year's annual median wage
      const latest = pts.reduce((a, b) => (Number(b.year) > Number(a.year) ? b : a), pts[0]);
      const val = Number(String(latest.value).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(val) || val <= 0) return null;
      median = Math.round(val);
      await putCachedBls(cacheKey, median);
    } catch (err) {
      console.error(`[bls] wage lookup failed (${err.message}) — omitting the market anchor`);
      return null;
    }
  }
  return { median, socLabel: occ.label, area: area.label, url: `https://www.bls.gov/oes/current/oes${occ.soc}.htm` };
}
