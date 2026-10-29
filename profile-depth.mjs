// profile-depth.mjs — profile depth (grounded proof points per person) and its time series.
//
// WHY DEPTH AND NOT USER COUNT. Engagement with role emails rises with the number of grounded proof
// points Charlie holds about a person; it is concentrated in people Charlie knows well. buildTable
// below re-derives that evidence table (depth band -> clicks per role email) from live data.
//
// THE CAUSAL DIRECTION IS UNPROVEN AND THIS FILE DOES NOT PRETEND OTHERWISE. Either a deeper profile
// produces better matches which produce clicks, or engaged people simply volunteer more about
// themselves. Almost certainly both, and this data cannot separate them. The decision is the same
// under either reading, which is what makes it safe to measure now and act on later.
//
// WHAT MAKES IT A MOAT RATHER THAN A DASHBOARD. A competitor can copy the scanner in a quarter. They
// cannot copy proof points a person chose to tell Charlie, and they cannot start with them. Depth per
// user is the accumulation curve of that asset, so its DERIVATIVE is the number worth reporting: not
// "we have N users" but "our users' grounded profiles deepen by X per month".
//
// Reads only. No model call, no send, no writes except the optional snapshot.

/**
 * The headline number: the count of grounded proof points. Redefining it to something richer would
 * make the historical evidence table incomparable,
 * which is how a metric quietly stops meaning anything. The components are reported alongside.
 */
export function profileDepth(dossier) {
  const d = dossier || {};
  const arr = (v) => (Array.isArray(v) ? v.length : 0);

  // A preference counts only when the person actually stated it. `null` is the build leaving it
  // blank on purpose (dossier.md tells it not to guess), so counting keys would count silence.
  const prefs = d.preferences && typeof d.preferences === "object" ? d.preferences : {};
  const statedPrefs = Object.values(prefs).filter((v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim().length > 0;
  }).length;

  return {
    depth: arr(d.proof_points), // THE metric — same definition as the evidence table
    proofPoints: arr(d.proof_points),
    caseStudies: arr(d.case_studies),
    strengths: arr(d.strengths),
    statedPrefs,
    hasEdge: Boolean(d.edge),
    hasYears: Number.isFinite(Number(d.professional_years)),
  };
}

/** The bands the evidence table uses. Kept as data so the report and any test agree by construction. */
export const DEPTH_BANDS = [
  { label: "0-3", lo: 0, hi: 3 },
  { label: "3-6", lo: 3, hi: 6 },
  { label: "6-10", lo: 6, hi: 10 },
  { label: "10+", lo: 10, hi: Infinity },
];

export function bandFor(depth) {
  const n = Number(depth) || 0;
  return (DEPTH_BANDS.find((b) => n >= b.lo && n < b.hi) || DEPTH_BANDS[DEPTH_BANDS.length - 1]).label;
}

/**
 * Rebuild the evidence table from live data, so the claim is re-derivable on any day by anyone rather
 * than quoted from a one-off measurement.
 *
 * PURE — takes the three inputs, returns the table. No store, no clock.
 *
 * @param {object[]} candidates  [{ email, dossier }]
 * @param {object[]} roleSends   [{ email }] one row per role email actually sent
 * @param {object[]} clicks      [{ email }] one row per apply_click
 */
export function depthEngagementTable({ candidates = [], roleSends = [], clicks = [] } = {}) {
  const sent = {};
  for (const r of roleSends) {
    const e = String(r?.email || "").toLowerCase();
    if (e) sent[e] = (sent[e] || 0) + 1;
  }
  const clicked = {};
  for (const c of clicks) {
    const e = String(c?.email || "").toLowerCase();
    if (e) clicked[e] = (clicked[e] || 0) + 1;
  }

  const rows = DEPTH_BANDS.map((b) => ({ band: b.label, users: 0, emails: 0, clicks: 0, everClicked: 0 }));
  const byLabel = Object.fromEntries(rows.map((r) => [r.band, r]));

  for (const c of candidates) {
    const email = String(c?.email || "").toLowerCase();
    if (!email) continue;
    const emails = sent[email] || 0;
    if (!emails) continue; // never mailed a role -> cannot speak to engagement
    const row = byLabel[bandFor(profileDepth(c.dossier).depth)];
    row.users++;
    row.emails += emails;
    row.clicks += clicked[email] || 0;
    if (clicked[email]) row.everClicked++;
  }

  for (const r of rows) r.clicksPerEmail = r.emails ? Number((r.clicks / r.emails).toFixed(2)) : null;
  return rows;
}

/** Print the table. The shape a human reads when deciding whether the thesis still holds. */
export function logDepthTable(rows, log = console.log) {
  log("\n— profile depth vs engagement —");
  log("  band      users  emails  clicks  clicks/email  ever clicked");
  for (const r of rows) {
    if (!r.users) continue;
    log(
      `  ${r.band.padEnd(8)} ${String(r.users).padStart(5)} ${String(r.emails).padStart(7)} ${String(r.clicks).padStart(7)}` +
        `  ${String(r.clicksPerEmail ?? "n/a").padStart(12)}  ${r.everClicked}/${r.users}`,
    );
  }
}

// ── The time series ──────────────────────────────────────────────────────────────────────────────
//
// A single depth reading is a dashboard number. The DERIVATIVE is the moat claim: "our users'
// grounded profiles deepen by X per month, and none of it can be scraped." That sentence needs
// history, and history only exists if something writes it down starting now.
//
// Stored as a `profile_depth` signal per person rather than a new table: `signals.event` is free text
// and `meta` is jsonb, so this needs no migration (the same reasoning as the prefs_updated trail).
import { listActiveCandidates, recordSignal } from "./charlie-store.mjs";

/** Off by default. Read at call time so a deploy can change it without a code change. */
export function depthSnapshotMode() {
  const v = String(process.env.DEPTH_SNAPSHOT || "off").toLowerCase();
  return v === "dry" || v === "on" ? v : "off";
}

/**
 * Record one depth reading per active user, at most weekly.
 *
 * Writes SIGNALS ONLY — it never emails anyone and never touches a dossier, so the worst failure
 * available to it is a missing data point. Best-effort per record: one bad row cannot abort the pass.
 *
 * @returns {{mode:string, users:number, recorded:number, skipped:number}}
 */
export async function runDepthSnapshotSweep({ log = console.error } = {}) {
  const mode = depthSnapshotMode();
  if (mode === "off") return { mode, users: 0, recorded: 0, skipped: 0 };

  let candidates = [];
  try {
    candidates = await listActiveCandidates();
  } catch (e) {
    log(`[depth] could not list candidates (${e.message}) — no snapshot this pass`);
    return { mode, users: 0, recorded: 0, skipped: 0 };
  }

  let recorded = 0;
  let skipped = 0;
  const bands = {};

  for (const c of candidates) {
    try {
      const d = profileDepth(c?.dossier);
      bands[bandFor(d.depth)] = (bands[bandFor(d.depth)] || 0) + 1;
      if (mode === "dry") { recorded++; continue; }
      const ok = await recordSignal({
        email: c.email,
        event: "profile_depth",
        meta: { depth: d.depth, caseStudies: d.caseStudies, strengths: d.strengths, statedPrefs: d.statedPrefs, hasEdge: d.hasEdge },
      });
      if (ok) recorded++; else skipped++;
    } catch (e) {
      skipped++;
      log(`[depth] ${c?.email} failed (${e.message}) — continuing`);
    }
  }

  log(`[depth] ${mode}: ${candidates.length} active, ${recorded} recorded, ${skipped} skipped · bands ${JSON.stringify(bands)}`);
  return { mode, users: candidates.length, recorded, skipped };
}
