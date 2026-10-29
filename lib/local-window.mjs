// lib/local-window.mjs — coarse timezone + quiet hours for v2 proactive sends (pure, no I/O).
//
// A considerate person doesn't email you at 2am; the timing itself is the care. There is no stored
// timezone: a COARSE local clock is derived from the market we already know (homeRegion): IST for
// India, ET for the US. That is enough to never land a proactive touch in someone's night. A coarse
// offset can mis-serve a US user on the far coast by up to ~3h, which is acceptable for "don't email
// at 2am"; precise per-user timezones would need a new dossier field.
//
// Two pure functions, clock injected for deterministic tests:
//   localWindow(candidate, atMs)   -> { market, offsetMinutes, localHour, quiet, ymd }
//   nextSendWindow(candidate, fromMs) -> UTC ms of the next moment we're allowed to send (== fromMs
//                                        when fromMs is already inside the allowed window).
//
// Used by the v2 journey watchdog (journey-watchdog.mjs): a communicating fire that lands in quiet
// hours (or on a holiday) reschedules to nextSendWindow instead of sending. v2-only by construction
// (only v2 users have a journey), so no separate flag.

import { homeRegion } from "../quality-gate.mjs";

// Coarse fixed offsets from UTC, in minutes. No DST (deliberately coarse — see header).
//   India  = IST = UTC+5:30
//   US     = ET  = UTC-5:00 (EST; we don't track DST — a summer send may land an hour early, fine)
const OFFSETS = { india: 330, us: -300 };

// Allowed send window in LOCAL time: 08:00–20:59. Quiet hours are 21:00–07:59 ("no 2am emails").
// Deferred sends land at MORNING_HOUR local, the first allowed hour.
const QUIET_START_HOUR = 21; // 9pm
const MORNING_HOUR = 8; // 8am — start of the allowed window; deferred touches deliver here

const DAY_MS = 86_400_000;

// A small, STATIC holiday list (YYYY-MM-DD, local date), per market — refresh yearly. A proactive
// touch that would land on one of these defers to the next working morning. Coarse on purpose: only
// the few days where an automated email would read as tone-deaf. Not payroll-grade; extend as needed.
const HOLIDAYS = {
  india: new Set([
    "2026-01-26", // Republic Day
    "2026-03-14", // Holi (approx; regional)
    "2026-08-15", // Independence Day
    "2026-10-02", // Gandhi Jayanti
    "2026-11-08", // Diwali (approx; regional)
    "2026-12-25", // Christmas
  ]),
  us: new Set([
    "2026-01-01", // New Year's Day
    "2026-05-25", // Memorial Day
    "2026-07-04", // Independence Day
    "2026-09-07", // Labor Day
    "2026-11-26", // Thanksgiving
    "2026-12-25", // Christmas
  ]),
};

/** The market ("india" | "us") for a candidate/dossier, defaulting India (matches homeRegion). */
export function marketOf(candidate) {
  const dossier = candidate?.dossier ?? candidate;
  return homeRegion(dossier || {});
}

// The local wall-clock date (YYYY-MM-DD) for a UTC instant shifted by a fixed offset. We read the
// shifted timestamp with UTC getters so it reflects local wall time without any Intl/TZ dependency.
const localYmd = (utcMs, offsetMinutes) => new Date(utcMs + offsetMinutes * 60_000).toISOString().slice(0, 10);

/** UTC ms of a local wall-clock moment (that ymd, that hour) in a fixed-offset market. */
function localWallToUtcMs(ymd, hour, offsetMinutes) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour, 0, 0) - offsetMinutes * 60_000; // utc = local - offset
}

/** True if `ymd` (local date) is a holiday in `market`. */
export function isHoliday(ymd, market) {
  return (HOLIDAYS[market] || new Set()).has(ymd);
}

/**
 * The candidate's coarse local clock at `atMs`.
 * @returns {{ market:string, offsetMinutes:number, localHour:number, quiet:boolean, ymd:string }}
 */
export function localWindow(candidate, atMs) {
  const market = marketOf(candidate);
  const offsetMinutes = OFFSETS[market] ?? OFFSETS.india;
  const local = new Date(atMs + offsetMinutes * 60_000);
  const localHour = local.getUTCHours();
  const quiet = localHour >= QUIET_START_HOUR || localHour < MORNING_HOUR;
  return { market, offsetMinutes, localHour, quiet, ymd: local.toISOString().slice(0, 10) };
}

/**
 * The next UTC instant we may send a proactive touch to this candidate, at or after `fromMs`.
 * Returns `fromMs` unchanged when it already falls in the allowed window on a non-holiday. Otherwise
 * the next MORNING_HOUR local that isn't a quiet hour or a holiday.
 */
export function nextSendWindow(candidate, fromMs) {
  const { market, offsetMinutes, quiet, ymd } = localWindow(candidate, fromMs);
  if (!quiet && !isHoliday(ymd, market)) return fromMs; // already fine — send now

  const localMidnightUtc = localWallToUtcMs(ymd, 0, offsetMinutes); // UTC of local 00:00 today
  for (let d = 0; d < 14; d++) {
    const dayStartUtc = localMidnightUtc + d * DAY_MS; // fixed offset ⇒ +1 local day is exactly +DAY_MS
    const dayYmd = localYmd(dayStartUtc, offsetMinutes);
    if (isHoliday(dayYmd, market)) continue; // skip a holiday entirely → next working morning
    const morningUtc = dayStartUtc + MORNING_HOUR * 3_600_000;
    if (morningUtc >= fromMs) return morningUtc;
  }
  return fromMs; // pathological (14 straight holidays) — never suppress forever, just send
}

/** Convenience for callers: is a proactive send to this candidate allowed at `atMs`? */
export function canSendNow(candidate, atMs) {
  const { market, quiet, ymd } = localWindow(candidate, atMs);
  return !quiet && !isHoliday(ymd, market);
}
