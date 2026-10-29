// role-in-play.mjs — which role is this person talking about?
//
// "What about remote?" has no referent without this, so every follow-up question would otherwise
// reach the human fallback.
//
// THE LAST ROLE WE EMAILED THEM IS THE ROLE IN PLAY. Not the newest find, not the best-scoring one:
// the one we actually put in their inbox, because that is the only one they can be replying to.
// `sent_emails` is the record of what was said and when, and `roleFindIdFromSend` (charlie-store.mjs)
// turns one of its rows into a find id.
//
// IT RESOLVES OR IT RETURNS NULL. There is no "probably this one". A wrong role produces a confident
// answer about a job the person never saw, which is worse than the fallback it replaces.

/**
 * @param {string} email
 * @param {{ roleSends: (email:string)=>Promise<Array<{email:string,dedupe_key:string,sent_at:string}>>,
 *           findIdFromSend: (row:any)=>string|null,
 *           findById: (email:string,id:string)=>Promise<any> }} deps
 * @returns {Promise<{findId: string, job: object, sentAt: string}|null>}
 */
export async function roleInPlay(email, deps) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr) return null;
  // The impossible case, handled on purpose: a missing dependency must resolve to "no role", never to
  // a guessed one.
  if (typeof deps?.roleSends !== "function" || typeof deps?.findIdFromSend !== "function" || typeof deps?.findById !== "function") {
    return null;
  }

  let rows = [];
  try { rows = (await deps.roleSends(addr)) || []; } catch { return null; }

  // Newest first. Only rows whose dedupe key is a find id are role sends; a digest or a lifecycle
  // mail returns null from findIdFromSend and is skipped rather than guessed at.
  const sorted = [...rows].sort((a, b) => String(b?.sent_at || "").localeCompare(String(a?.sent_at || "")));
  for (const row of sorted) {
    const findId = deps.findIdFromSend(row);
    if (!findId) continue;
    let find = null;
    try { find = await deps.findById(addr, findId); } catch { return null; }
    if (find?.job) return { findId, job: find.job, sentAt: String(row?.sent_at || "") };
  }
  return null;
}
