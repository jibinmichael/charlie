// eligibility-pregate.mjs — the deterministic checks that could run BEFORE we pay to score a role.
//
// SHADOW ONLY: this module counts, it never filters. There is deliberately no "enforce" mode — see
// pregateMode() below.
//
// WHY. A role is scored by the matcher (~300 pairs per user) and only THEN walked through the gates,
// many of which are deterministic and free. This measures how many paid pairs a free check the
// pipeline already owns would have eliminated.
//
// IT REIMPLEMENTS NOTHING. Every predicate here is imported from the module that already owns it, so
// the pre-pass and the real gate cannot drift into disagreeing about the same role.
//
// WHAT IS DELIBERATELY ABSENT, and why each one:
//   repeat         needs getEmailedRoleSignatures — a per-user DB read match-batch does not do.
//                  Excluded to keep this pass (job, dossier)-pure.
//   ghost          with GHOST_SCORE unset, ghostMode() is "shadow", so it eliminates nothing.
//                  Counting it as eliminable would overstate the saving.
//   liveness       network.
//   tier-2 remote  a model call.
//   region / work-auth / knockouts   already run pre-scoring, inside selectForUser.
//   data-sufficiency / seniority-chasm / fit routing   need the grounded coverage read. Downstream
//                  by construction; they cannot move.
//
// ⚠️ ENFORCING THIS WOULD NOT BE FREE, AND THE REASON IS THE DIGEST. Most of these gates route a role
// to DIGEST, not drop (presend-guard.mjs, quality-gate.mjs). A role eliminated before scoring can
// never become a digest row, so "which roles appear in the weekly digest" would change. That has to
// be answered before any of this is allowed to filter.

import { auditRole } from "../send-audit.mjs";
import { seniorityVerdict, seniorityMode } from "./role-level.mjs";
import { languageBlocker, statedCities, onsiteCity } from "../quality-gate.mjs";
import { belowStatedFloor } from "./pay.mjs";
import { levelOf } from "../market-report.mjs";

/** "shadow" (default) counts and logs. "off" disables. There is NO enforce mode: this may not filter. */
export function pregateMode() {
  return String(process.env.PREGATE_MODE || "shadow").toLowerCase() === "off" ? "off" : "shadow";
}

const cityCorridorOn = () => String(process.env.CITY_CORRIDOR ?? "on").toLowerCase() !== "off";

/**
 * Would a free, deterministic gate have rejected this (job, person) pair?
 *
 * Ordered exactly as the live path orders them, so the rule reported here is the rule that would
 * actually have fired. Returns null when nothing would.
 *
 * Every branch is wrapped: this is measurement, and measurement must never break a send.
 * @returns {{rule: string} | null}
 */
export function pregateVerdict(job, dossier) {
  try {
    const miss = auditRole({ dossier, role: job }).find((f) => f && f.severity === "high");
    if (miss) return { rule: `constraint:${miss.rule}` };
  } catch { /* never let measurement break matching */ }

  try {
    if (seniorityMode() === "enforce" && seniorityVerdict(job, dossier, levelOf)?.below) {
      return { rule: "constraint:level-below-target" };
    }
  } catch { /* noop */ }

  try {
    if (cityCorridorOn()) {
      const mine = statedCities(dossier);
      const theirs = onsiteCity(job);
      if (mine?.size && theirs && ![...theirs].some((c) => mine.has(c))) return { rule: "city-corridor:outside" };
    }
  } catch { /* noop */ }

  try {
    if (languageBlocker(job, dossier)) return { rule: "language:required" };
  } catch { /* noop */ }

  try {
    const shadowPay = String(process.env.PAY_FLOOR_MODE || "enforce").toLowerCase() === "shadow";
    if (!shadowPay && belowStatedFloor(job?.compensation, dossier?.preferences)?.below) return { rule: "pay-floor:below" };
  } catch { /* noop */ }

  return null;
}

/**
 * Count what a pre-scoring pass would have removed, for one user's retrieved shortlist.
 * Pure: takes jobs, returns numbers. Never mutates, never filters, never throws.
 * @returns {{scored:number, eliminable:number, byRule:Record<string,number>}}
 */
export function pregateCensus(jobs, dossier) {
  const byRule = {};
  let eliminable = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const v = pregateVerdict(job, dossier);
    if (!v) continue;
    eliminable++;
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }
  return { scored: Array.isArray(jobs) ? jobs.length : 0, eliminable, byRule };
}
