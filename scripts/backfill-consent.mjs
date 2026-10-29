// backfill-consent.mjs — re-read permission-to-write-again from every form. NO SEND. NO MODEL. $0.
//
//   node --env-file=.env.local scripts/backfill-consent.mjs           # DRY
//   node --env-file=.env.local scripts/backfill-consent.mjs --apply
//
// WHAT IT IS FOR. When lib/consent-questions.mjs learns a new wording of the "may we write to you
// again" question, rows ingested before that were stored with `may_write_again = false`. A missing
// consent is indistinguishable from a refusal once stored, and everything downstream that filters on
// it then excludes people who agreed. This re-reads every form and repairs those rows.
//
// IT READS TALLY, NOT A LIST. The answer comes from the applicant's own submission every time, so
// this can be re-run and can only ever converge on what they actually ticked. It never invents a yes:
// a blank answer stays false, because not answering an optional question is not agreement.
//
// IT CANNOT SEND AND CANNOT SPEND. No Resend import, no Anthropic import.

import { loadEnv, store, getCandidate, saveDossier, readAll } from "../charlie-store.mjs";
import { TallySubmissionsPage, TallyFormsPage, answersByTitle, titleIndex } from "../lib/schemas/tally.mjs";
import { POOL_Q, SHARE_Q, affirmative } from "../lib/consent-questions.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
/**
 * EVERY form, asked for at run time. Never a list in this file.
 *
 * A hardcoded list does not fail when it goes stale: it succeeds narrowly and reports "0 rows wrong"
 * for forms it never looked at.
 *
 * Asking Tally is the only version that cannot go stale, and it fails loudly if it cannot.
 */
async function allFormIds() {
  const res = await fetch("https://api.tally.so/forms?limit=100", {
    headers: { Authorization: `Bearer ${process.env.TALLY_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Tally forms list failed: ${res.status}`); // fail closed
  // Validated at the boundary: a reshaped response must fail, not produce a shorter list of forms
  // that the run would call success.
  const parsed = TallyFormsPage.safeParse(await res.json());
  if (!parsed.success) throw new Error(`Tally forms list did not match the schema: ${parsed.error.issues.slice(0, 2).map((i) => i.path.join(".")).join(", ")}`);
  if (!parsed.data.length) throw new Error("Tally returned no forms");
  return parsed.data.map((f) => f.id);
}

// The same intent, several ways of asking it. ONE definition, shared with scripts/pool-applicants.mjs,
// so the repair tool can never share a blind spot the detector does not.

const yes = (v) => affirmative(v);

async function submissions(formId) {
  let subs = [], questions = null;
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.tally.so/forms/${formId}/submissions?limit=50&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.TALLY_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Tally ${res.status} on ${formId}`); // fail closed: a short read looks like refusals
    const p = TallySubmissionsPage.safeParse(await res.json());
    if (!p.success) throw new Error(`${formId} page ${page} did not match the schema`);
    questions = questions || p.data.questions;
    subs = subs.concat(p.data.submissions);
    if (!p.data.hasMore) break;
  }
  return { subs, questions };
}

async function main() {
  const db = store();
  const truth = new Map(); // email -> { pool, share, poolText, shareText, form }

  const FORMS = await allFormIds();
  console.error(`forms found: ${FORMS.length}  (${FORMS.join(', ')})`);
  for (const formId of FORMS) {
    const { subs, questions } = await submissions(formId);
    const idx = titleIndex(questions);
    const qPool = (questions.find((q) => POOL_Q.test(q.title)) || {}).title || null;
    const qShare = (questions.find((q) => SHARE_Q.test(q.title)) || {}).title || null;
    const qEmail = (questions.find((q) => q.type === "INPUT_EMAIL") || {}).title || null;
    console.error(`\n${formId}  ${subs.length} submissions`);
    console.error(`  pool question:  ${qPool ? JSON.stringify(qPool.slice(0, 78)) : "NONE ON THIS FORM"}`);
    console.error(`  share question: ${qShare ? JSON.stringify(qShare.slice(0, 78)) : "NONE ON THIS FORM"}`);
    if (!qEmail) { console.error(`  no email question — skipping`); continue; }

    let y = 0;
    for (const s of subs) {
      const a = answersByTitle(s, idx);
      const email = String(a[qEmail] || "").trim().toLowerCase();
      if (!email) continue;
      const poolText = qPool ? String(a[qPool] || "").trim() : "";
      const shareText = qShare ? String(a[qShare] || "").trim() : "";
      // Latest submission wins, same rule as dedupeByEmail: a second application is a correction.
      truth.set(email, { pool: yes(poolText), share: yes(shareText), poolText, shareText, form: `tally:${formId}` });
      if (yes(poolText)) y++;
    }
    console.error(`  said yes to future roles: ${y}`);
  }

  // What the database currently believes.
  const pool = await readAll("talent_pool", "email,full_name,consent_pool,consent_share,consent_text,source_form");
  const error = null;
  if (error) throw new Error(`talent_pool read failed: ${error.message}`);

  const fixes = [];
  for (const row of pool || []) {
    const t = truth.get(String(row.email).toLowerCase());
    if (!t) continue;
    if (Boolean(row.consent_pool) !== t.pool || Boolean(row.consent_share) !== t.share) {
      fixes.push({ row, t });
    }
  }

  const gained = fixes.filter((f) => f.t.pool && !f.row.consent_pool);
  const lost = fixes.filter((f) => !f.t.pool && f.row.consent_pool);

  console.error(`\n${"=".repeat(78)}`);
  console.error(`talent_pool rows            ${(pool || []).length}`);
  console.error(`matched to a submission     ${(pool || []).filter((r) => truth.has(String(r.email).toLowerCase())).length}`);
  console.error(`rows whose consent is wrong ${fixes.length}`);
  console.error(`  they said YES, we stored no    ${gained.length}   <- these people were invisible`);
  console.error(`  we stored yes, they said no    ${lost.length}   <- these must be corrected too`);

  if (!APPLY) {
    console.error(`\nDRY RUN. Nothing written.\n`);
    for (const f of gained.slice(0, 12)) console.error(`  + ${String(f.row.full_name || f.row.email).slice(0, 34).padEnd(34)} ${JSON.stringify(f.t.poolText.slice(0, 40))}`);
    if (gained.length > 12) console.error(`  ... and ${gained.length - 12} more`);
    for (const f of lost) console.error(`  - ${String(f.row.full_name || f.row.email).slice(0, 34).padEnd(34)} they did not tick it`);
    return;
  }

  let wrote = 0, dossiers = 0, failed = 0;
  for (const { row, t } of fixes) {
    const email = String(row.email).toLowerCase();
    try {
      const { error: upErr } = await db.from("talent_pool").update({
        consent_pool: t.pool,
        consent_share: t.share,
        // The verbatim answers, so the boolean can always be defended by what they actually typed.
        consent_text: { ...(row.consent_text || {}), talent_pool: t.poolText || null, share_with_employer: t.shareText || null, reread_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      }).eq("email", email);
      if (upErr) { failed++; console.error(`  FAILED ${email}: ${upErr.message}`); continue; }
      wrote++;

      // Keep the dossier in step, so a later re-enrichment does not undo this from stale meta.
      // saveDossier defaults status to "screening"; passing the row's own status back is mandatory,
      // because dropping it silently changes who is in a send.
      const c = await getCandidate(email).catch(() => null);
      if (c?.dossier?.meta) {
        const d = { ...c.dossier, meta: { ...c.dossier.meta, may_write_again: t.pool, may_share: t.share, consent_talent_pool: t.poolText || null, consent_share_with_employer: t.shareText || null } };
        await saveDossier(email, d, c.status);
        dossiers++;
      }
    } catch (e) {
      failed++; console.error(`  ERRORED, continuing ${email}: ${e.message}`); // per-record isolation
    }
  }

  const { count } = await db.from("talent_pool").select("*", { count: "exact", head: true }).eq("consent_pool", true);
  console.error(`\ncorrected ${wrote} pool rows, ${dossiers} dossiers, ${failed} failed`);
  console.error(`talent_pool now holds ${count} people who agreed to hear about other roles.`);
  console.error(`emails sent 0   (this script imports no sender)`);
}

main().catch((e) => { console.error("[backfill-consent] fatal:", e.message); process.exit(1); });
