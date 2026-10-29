// lib/daily-send-verdict.mjs — "did the daily send actually deliver?", as a pure function.
//
// Every check in watchdog.mjs answers "is what we sent CORRECT?". This one answers whether anything
// went out at all. A run can deliver zero role emails while every correctness check stays green: a
// run that aborts on the cost ceiling, a crash mid-run, or a provider refusing every message all hide
// behind a container that reports success.
//
// It lives here, not in watchdog.mjs, because watchdog.mjs is a SCRIPT: importing it runs every check
// and calls process.exit, so its logic cannot be unit-tested in place.
//
// The two failures, each with an unambiguous signature:
//
//   NOTHING PREPARED         zero `finds` created today. The run died before scoring anything (the
//                            cost-ceiling abort). With active users and a stocked pool this cannot
//                            happen legitimately — the scheduler writes a find for every role it
//                            routes, to a solo send OR to the digest.
//
//   PREPARED, NOT DELIVERED  finds created today are still 'new' (a run that died before its own
//                            catch) or 'send_failed' (a send that threw and was recorded). The
//                            scheduler writes a find as 'new' BEFORE the send and flips it to
//                            'emailed' after, so either leftover is a send attempted and refused.
//                            watchdog.mjs owns the status list; this function just counts them.
//
// Deliberately NOT keyed on "zero role emails today": an all-digest day (nobody clears the bar) is
// legitimate and would cry wolf. An unresolved find is the honest signal — it means we TRIED.
export function dailySendVerdict({ active, prepared, stuck }) {
  if (!active) return { ok: true, detail: "no active users — nothing was expected" };
  if (prepared === 0) {
    return { ok: false, detail: `the run produced NOTHING today: 0 finds for ${active} active user(s). The pipeline aborted before scoring (check the scheduler log for ABORT/fatal).` };
  }
  if (stuck > 0) {
    return { ok: false, detail: `${stuck} of ${prepared} role(s) prepared today never left ('new' or 'send_failed') — the send was ATTEMPTED and refused. Roles were found; nobody received them.` };
  }
  return { ok: true, detail: `${prepared} role(s) prepared today, 0 stuck — every attempted send completed` };
}
