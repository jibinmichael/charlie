// talent-enrich.mjs — populate the talent_pool table. NO SEND.
//
//   node --env-file=.env.local scripts/talent-enrich.mjs --limit 3     # smoke test, prints rows
//   node --env-file=.env.local scripts/talent-enrich.mjs --apply
//   node --env-file=.env.local scripts/talent-enrich.mjs --apply --force   # re-enrich everyone
//   node --env-file=.env.local scripts/talent-enrich.mjs --apply --emails fix.json  # just these people
//
// --emails takes a JSON array of addresses, or an array of objects with an `email` key. It exists so
// a fix that only affects a known subset can be applied to that subset: bumping ENRICHMENT_VERSION
// makes every row stale and re-reads all of them at ~$0.02 each, which is the right thing when the
// extraction genuinely changed for everyone and wasted spend when it did not.
//
// SEPARATE FROM `candidates`. Reads it, never writes it. The weekly email product is untouched: a
// person can be in the talent pool, in candidates, in both or in neither.
//
// IT CANNOT SEND. No Resend import, no send-guard import, no template.
//
// IDEMPOTENT. Somebody already enriched at the current version costs nothing on a re-run. --force
// re-reads everyone, which is what to use when the extraction prompt or the normaliser changes.
//
// COST. One Sonnet read per candidate, once, ~$0.02.

import { readFileSync } from "node:fs";
import { loadEnv, store, getResume, readAll } from "../charlie-store.mjs";
import { enrichCandidate, ENRICHMENT_VERSION } from "../lib/enrich.mjs";
import { formAnswers } from "../lib/form-answers.mjs";

loadEnv();
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || "") : ""; };
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const LIMIT = Number(flag("--limit")) || 0;
const EMAILS = (() => {
  const f = flag("--emails");
  if (!f) return null;
  const raw = JSON.parse(readFileSync(f, "utf8"));
  const list = raw.map((r) => String(typeof r === "string" ? r : r?.email || "").toLowerCase()).filter(Boolean);
  if (!list.length) { console.error(`--emails ${f} held no addresses`); process.exit(1); }
  return new Set(list);
})();

/**
 * The consent meta to enrich with, which is NOT the same question for the two kinds of person here.
 *
 * `enrichCandidate` reads permission straight off `meta.may_write_again` and `meta.may_share`. Those
 * are written by the form pipeline. Somebody who arrived by writing to start@ has neither, so passing
 * their meta through unchanged would store them as consent_pool=false and make them invisible to
 * every search: a permission nobody recorded is indistinguishable from a permission somebody refused.
 *
 * So the two are separated, and they genuinely are different agreements:
 *
 *   pool   TRUE for a start@ person. They wrote in asking Charlie to find them roles. There is no
 *          ambiguity about whether they want to hear about roles; it is the thing they asked for.
 *   share  FALSE. Nobody ever asked them whether their profile may go to an employer, and applicants
 *          are asked that explicitly. An unasked question is not a yes.
 *
 * The share permission gets collected at the moment there is a real role to collect it for, which is
 * the same email that fills in whatever else is missing about them.
 */
function consentFor(d) {
  const meta = d?.meta || {};
  if (String(meta.source || "").startsWith("tally:")) return meta; // their form answers already say
  return {
    ...meta,
    consent_process: true,
    may_write_again: true,
    may_share: false,
    consent_text: {
      ...(meta.consent_text || {}),
      talent_pool: "Wrote to start@ asking Charlie to find them roles.",
      share_with_employer: null, // never asked. Collected when there is a role to ask about.
    },
  };
}

async function main() {
  const db = store();
  // EVERYONE EXCEPT THE PEOPLE WHO ASKED US TO STOP. That includes people who came in by writing to
  // start@ rather than by filling in a form: they have dossiers, usually richer ones built through
  // conversation, and being findable when a matching role appears is the purpose of this table.
  //
  // `unsubscribed` is the one status excluded, and it is excluded on purpose. Somebody who asked us
  // to stop does not belong in a table whose whole job is finding people to contact.
  // PAGINATED, AND THAT IS NOT A DETAIL. A plain select() stops at Supabase's 1000-row default and
  // does NOT error, so people past the first thousand would silently never be read while every run
  // reported "errored 0". A truncated `done` map is worse: already-enriched people look unenriched and
  // are re-read (and paid for) on every run. A short read is indistinguishable from a complete one.

  let rows;
  try {
    rows = await readAll("candidates", "email, dossier, status", (q) => q.neq("status", "unsubscribed"));
  } catch (e) { throw new Error(e.message); }

  let existing;
  try {
    existing = await readAll("talent_pool", "email, enrichment_version");
  } catch (e) {
    console.error(`talent_pool unreadable: ${e.message}\nApply supabase/migrations/20260814130000_talent_pool.sql first.`);
    process.exit(1);
  }
  const done = new Map(existing.map((r) => [r.email, r.enrichment_version]));

  const todo = rows
    .filter((c) => !EMAILS || EMAILS.has(String(c.email).toLowerCase()))
    .filter((c) => FORCE || EMAILS || done.get(String(c.email).toLowerCase()) !== ENRICHMENT_VERSION);
  if (EMAILS) {
    const found = new Set(todo.map((c) => String(c.email).toLowerCase()));
    const missing = [...EMAILS].filter((e) => !found.has(e));
    // A silently short list is the failure described above.
    if (missing.length) console.error(`--emails: ${missing.length} of ${EMAILS.size} are not in candidates and will NOT be enriched:\n  ${missing.slice(0, 10).join("\n  ")}`);
  }
  const work = LIMIT ? todo.slice(0, LIMIT) : todo;

  console.error(EMAILS
    ? `\npool ${rows.length} · restricted to --emails: ${EMAILS.size} asked for · this run ${work.length}`
    : `\npool ${rows.length} · already enriched at ${ENRICHMENT_VERSION}: ${rows.length - todo.length} (skipped, $0) · this run ${work.length}`);
  console.error(APPLY ? `MODE: APPLY\n` : `MODE: DRY RUN\n`);

  let spend = 0, wrote = 0, failed = 0;
  const dist = {};
  for (const c of work) {
    const email = String(c.email).toLowerCase();
    try {
      const resume = await getResume(email).catch(() => "");
      const d = c.dossier || {};
      // The stored map when there is one, the lossless fallback when there is not (lib/form-answers.mjs).
      const answers = formAnswers(d);
      const { row, usage, reason } = await enrichCandidate({
        email, name: d.name, resume: String(resume || ""), answers,
        prefs: d.preferences || {}, meta: consentFor(d),
        log: (m) => console.error(`   [${email}] ${m}`),
      });
      if (usage) spend += ((usage.input_tokens || 0) / 1e6) * 3 + ((usage.output_tokens || 0) / 1e6) * 15;
      if (!row) { failed++; console.error(`  FAILED ${email}: ${reason}`); continue; }

      dist[row.mobility_profile] = (dist[row.mobility_profile] || 0) + 1;
      if (!APPLY) {
        console.error(`  ${email.padEnd(34)} ${String(row.total_years ?? "?").padStart(4)}y  ${String(row.seniority).padEnd(9)} ${String(row.role_family).padEnd(18)} ${String(row.mobility_profile).padEnd(7)} notice=${row.notice_days ?? "?"}  ${row.completeness}%`);
        continue;
      }
      const { error: e3 } = await db.from("talent_pool").upsert(row, { onConflict: "email" });
      if (e3) { failed++; console.error(`  WRITE FAILED ${email}: ${e3.message}`); continue; }
      wrote++;
      console.error(`  ${email.padEnd(34)} ${String(row.total_years ?? "?").padStart(4)}y  ${String(row.seniority).padEnd(9)} ${String(row.role_family).padEnd(18)} ${String(row.mobility_profile).padEnd(7)} ${row.completeness}%`);
    } catch (e) { failed++; console.error(`  FAILED ${email}: ${e.message}`); } // per-record isolation
  }

  console.error(`\n${"=".repeat(70)}`);
  console.error(`${APPLY ? "written" : "would write"}  ${wrote || work.length - failed}`);
  console.error(`errored   ${failed}`);
  console.error(`spend     ~$${spend.toFixed(2)}`);
  console.error(`mobility  ${Object.entries(dist).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  console.error(`emails    0  (this script imports no sender)`);
  if (!APPLY) console.error(`\nDRY RUN. Nothing written.\n`);
}

main().catch((e) => { console.error("[talent-enrich] fatal:", e.message); process.exit(1); });
