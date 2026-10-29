// pool-applicants.mjs — pull a Tally form's applicants into the pool. NO SEND. NO MODEL. $0.
//
//   node --env-file=.env.local scripts/pool-applicants.mjs --form <formId>          # DRY
//   node --env-file=.env.local scripts/pool-applicants.mjs --form <formId> --apply
//
// FORM-AGNOSTIC ON PURPOSE. Forms differ ("Full name" or "First Name", a years dropdown or a number,
// one consent question or two), so this derives the fields it needs from the form's own question
// TYPES and keeps everything else verbatim. A new role costs a form id, not a new script.
//
// IT CANNOT SEND. No Resend import, no send-guard import, no template. That is what makes "no email"
// true rather than promised.
//
// IT CANNOT SPEND. No Anthropic import. The dossier is assembled from what they typed, and a real
// grounded build is a separate, costed step.
//
// CONSENT IS READ, NEVER ASSUMED. Both questions are recorded verbatim on the dossier so a later
// decision about a person can point at the words they actually agreed to:
//   share  "may we share your Charlie profile with the employer?"  -> per-role permission
//   pool   "would you like to join the Charlie talent pool?"       -> permission to write again
// Somebody who declined the pool is still stored, because they applied to a role and we need their
// record to run that search; they are simply not somebody we may write to about anything else.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { loadEnv, getCandidate, saveDossier, uploadResume } from "../charlie-store.mjs";
import { TallySubmissionsPage, answersByTitle, titleIndex } from "../lib/schemas/tally.mjs";
import { extractResumeText } from "../server/resume-extract.mjs";
import { extractName } from "../dossier-build.mjs";
import { Dossier } from "../lib/schemas/dossier.mjs";
import { POOL_Q, SHARE_Q, affirmative } from "../lib/consent-questions.mjs";
import { compareToBaseline } from "../lib/consent-drift.mjs";

loadEnv();
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || "") : ""; };
const FORM = flag("--form");
const APPLY = process.argv.includes("--apply");
const CACHE = "job-pool/applicant-resumes";

const norm = (s) => String(s || "").trim();
const yes = (v) => affirmative(v);

/**
 * Find a question by TYPE and a word in its title.
 *
 * `types` is a list, not one value: one form asks years with a DROPDOWN and another with an
 * INPUT_NUMBER; notice period may be a DROPDOWN or MULTIPLE_CHOICE. A single-type lookup would
 * silently report "NOT ON THIS FORM" and store null while the answer sat in the payload. Titles and
 * types both drift between forms. Match on both, loosely.
 */
const findQ = (qs, types, word) => {
  const list = Array.isArray(types) ? types : [types];
  return (qs.find((q) => list.includes(q.type) && (!word || new RegExp(word, "i").test(q.title))) || {}).title || null;
};

async function main() {
  if (!FORM) { console.error("usage: --form <tallyFormId> [--apply]"); process.exit(1); }
  if (!process.env.TALLY_API_KEY) { console.error("TALLY_API_KEY not set"); process.exit(1); }

  let subs = [], questions = null;
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.tally.so/forms/${FORM}/submissions?limit=50&page=${page}`, {
      headers: { Authorization: `Bearer ${process.env.TALLY_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Tally ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const parsed = TallySubmissionsPage.safeParse(await res.json());
    if (!parsed.success) throw new Error(`page ${page} did not match the schema`); // fail closed: an unreadable page hides applicants
    questions = questions || parsed.data.questions;
    subs = subs.concat(parsed.data.submissions);
    if (!parsed.data.hasMore) break;
  }

  const idx = titleIndex(questions);
  const Q = {
    name: findQ(questions, "INPUT_TEXT", "name"),
    email: findQ(questions, "INPUT_EMAIL"),
    resume: findQ(questions, "FILE_UPLOAD"),
    link: findQ(questions, "INPUT_LINK", "linkedin"),
    // MATCH THE INTENT, NOT ONE FORM'S WORDING. Every miss here is silent: the field is stored null
    // and nobody finds out until a query returns the wrong people. A form may ask "Total professional
    // experience" with no "years" in it, or ask about location as "Are you able to work from the
    // <city> office?" with no "relocate" in it.
    //
    // Ordering matters and is relied on: `find` returns the FIRST match, so "Total professional
    // experience" must be found before "hands-on experience with the technologies".
    years: findQ(questions, ["DROPDOWN", "INPUT_NUMBER", "MULTIPLE_CHOICE"], "years|total (professional )?experience"),
    notice: findQ(questions, ["DROPDOWN", "MULTIPLE_CHOICE"], "how soon|notice|join a new role|start"),
    urgency: findQ(questions, ["DROPDOWN", "MULTIPLE_CHOICE"], "actively looking"),
    relocate: findQ(questions, ["DROPDOWN", "MULTIPLE_CHOICE"], "relocat|able to work from|work from the .*office|on-?site role"),
    company: findQ(questions, "INPUT_TEXT", "company"),
    title: findQ(questions, "INPUT_TEXT", "role|title"),
    share: (questions.find((q) => SHARE_Q.test(q.title)) || {}).title || null,
    // PERMISSION TO WRITE AGAIN, asked in completely different words on different forms.
    //
    // Every wording lives in lib/consent-questions.mjs, shared with scripts/backfill-consent.mjs so a
    // new one is added once. A miss is always silent: the run reports success and a missing consent
    // reads exactly like a refusal.
    //
    // Match the INTENT, not one form's phrasing, and keep the matched title so the verbatim answer is
    // still stored beside the boolean.
    pool: (questions.find((q) => POOL_Q.test(q.title)) || {}).title || null,
    // The newer forms add a third acknowledgement: that Charlie recruits on behalf of a client and
    // shares a profile only with permission. Recorded verbatim like the other two.
    ack: (questions.find((q) => /recruiting on behalf|only be shared with the employer with my permission/i.test(q.title)) || {}).title || null,
  };
  console.error(`\nform ${FORM} · ${subs.length} submission(s)\nfields detected:`);
  for (const [k, v] of Object.entries(Q)) console.error(`  ${k.padEnd(8)} ${v ? JSON.stringify(v) : "NOT ON THIS FORM"}`);
  if (!Q.email) { console.error(`\nNo email question on this form. Refusing: a candidate row is keyed on the address.`); process.exit(1); }

  // FAIL CLOSED ON DRIFT. The block above is a report, and a report only works if somebody reads it.
  // A question title edited in Tally after people answered would otherwise print "NOT ON THIS FORM"
  // and carry on storing refusals. `lib/consent-baseline.json` remembers what this form was last seen asking, so a question
  // that disappears stops the run instead of quietly rewriting an answer somebody already gave.
  const base = JSON.parse(readFileSync(new URL("../lib/consent-baseline.json", import.meta.url), "utf8"));
  const { regressions } = compareToBaseline(base[FORM] ? { [FORM]: base[FORM] } : {}, { [FORM]: { pool: Q.pool, share: Q.share } });
  if (regressions.length) {
    for (const r of regressions) {
      console.error(`\nREFUSING: ${r.field} consent used to be detected on this form and is not any more.`);
      console.error(`  it used to be: ${JSON.stringify(r.was)}`);
      console.error(`  Ingesting now would store that permission as false for everyone here, which is`);
      console.error(`  indistinguishable from a refusal. Fix lib/consent-questions.mjs, or confirm the`);
      console.error(`  question really was removed and re-run scripts/consent-drift.mjs --update.`);
    }
    process.exit(1);
  }
  console.error(APPLY ? `\nMODE: APPLY (creates rows at status 'screening', sends nothing)\n` : `\nMODE: DRY RUN\n`);

  // Everything that is not a contact detail is evidence, kept verbatim.
  const contact = new Set([Q.name, Q.email, Q.resume, Q.link, Q.share, Q.pool, Q.ack].filter(Boolean));
  const evidenceTitles = [...idx.values()].filter((t) => !contact.has(t));

  let added = 0, already = 0, withCv = 0, failed = 0;
  for (const s of subs) {
    const a = answersByTitle(s, idx);
    const email = norm(a[Q.email]).toLowerCase();
    // THROUGH THE SAME GUARD AS A RESUME. A Tally name field can hold an email address or junk; the
    // name-shape rule extractName applies must hold for every writer, or it is not a rule.
    const name = Q.name ? (extractName(norm(a[Q.name])) || "") : "";
    if (!email) { failed++; console.error(`  no email on submission ${s.id} — skipped`); continue; }
    try {
      if (await getCandidate(email).catch(() => null)) { already++; console.error(`  already a candidate  ${email}`); continue; }

      const kept = evidenceTitles.filter((t) => norm(a[t]));
      const narrative = kept.map((t) => `${t}\n${a[t]}`).join("\n\n");
      const dossier = {
        name: name || null,
        // THE SAME ANSWERS, STRUCTURED, so nothing downstream has to parse the narrative back apart.
        // A multi-paragraph answer renders as several blank-line blocks, so parsing the narrative back is
        // lossy; keeping the map means the question a person was answering is never inferred.
        // The narrative is unchanged byte for byte; other things read it.
        answers: Object.fromEntries(kept.map((t) => [t, norm(a[t])])),
        headline: [Q.title && norm(a[Q.title]), Q.company && norm(a[Q.company])].filter(Boolean).join(" at ") || `Applied to a role Charlie posted`,
        narrative,
        proof_points: [], case_studies: [], strengths: [], gaps: [],
        // The dropdown gives a band ("12-15 years"), not a number. Take the LOWER bound: it is the
        // only figure their answer actually guarantees, and rounding a band upward would inflate them.
        professional_years: Q.years ? (Number(String(a[Q.years] || "").match(/\d+/)?.[0]) || null) : null,
        preferences: {
          notice_period: Q.notice ? norm(a[Q.notice]) || null : null,
          // Their own words, kept verbatim. "Actively looking" and "open to the right thing" are
          // different facts and normalising them here would destroy the distinction.
          mode: Q.urgency ? norm(a[Q.urgency]) || null : null,
          relocate: Q.relocate ? norm(a[Q.relocate]) || null : null,
        },
        meta: {
          source: `tally:${FORM}`,
          consent_share_with_employer: Q.share ? norm(a[Q.share]) : null,
          consent_talent_pool: Q.pool ? norm(a[Q.pool]) : null,
          consent_ack_client_recruiting: Q.ack ? norm(a[Q.ack]) : null,
          may_share: Q.share ? yes(a[Q.share]) : false,
          may_write_again: Q.pool ? yes(a[Q.pool]) : false,
          applied_at: s.submittedAt || null,
          thin: true, stub: false,
        },
      };
      const ok = Dossier.safeParse(dossier);
      if (!ok.success) { failed++; console.error(`  INVALID  ${email}: ${ok.error.issues.slice(0, 2).map((i) => i.path.join(".")).join(", ")}`); continue; }

      if (!APPLY) {
        added++;
        console.error(`  would add  ${email.padEnd(34)} ${String(dossier.professional_years ?? "?").padStart(2)}y  share=${dossier.meta.may_share ? "yes" : "NO "}  pool=${dossier.meta.may_write_again ? "yes" : "NO "}  ${name}`);
        continue;
      }

      // The attachment, fetched now: Tally's file URLs are short-lived signed links.
      if (Q.resume) {
        const r = (s.responses || []).find((x) => idx.get(x.questionId) === Q.resume);
        const f = Array.isArray(r?.answer) ? r.answer[0] : null;
        if (f?.url) {
          try {
            const res = await fetch(f.url);
            if (res.ok) {
              const out = await extractResumeText(Buffer.from(await res.arrayBuffer()), f.name || "");
              if (out.ok) {
                mkdirSync(CACHE, { recursive: true });
                writeFileSync(`${CACHE}/${s.id}.txt`, out.text);
                await uploadResume(email, out.text);
                withCv++;
              } else console.error(`  resume unreadable    ${email}: ${out.reason}`);
            }
          } catch (e) { console.error(`  resume failed        ${email}: ${e.message}`); }
        }
      }
      await saveDossier(email, dossier, "screening");
      added++;
      console.error(`  added      ${email.padEnd(34)} ${String(dossier.professional_years ?? "?").padStart(2)}y  share=${dossier.meta.may_share ? "yes" : "NO "}  pool=${dossier.meta.may_write_again ? "yes" : "NO "}  ${name}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED, continuing   ${email}: ${e.message}`); // per-record isolation: one bad row never stops the run
    }
  }

  console.error(`\n${"=".repeat(70)}`);
  console.error(`${APPLY ? "added" : "would add"}  ${added}`);
  console.error(`already a candidate   ${already}`);
  console.error(`CV stored             ${withCv}`);
  console.error(`errored               ${failed}`);
  console.error(`emails sent           0   (this script imports no sender)`);
  console.error(`model spend           $0.00   (this script imports no model client)`);
  console.error(`\nEveryone is at status 'screening', so they are in no send and cannot be.`);
  if (!APPLY) console.error(`\nDRY RUN. Nothing was written.\n`);
}

main().catch((e) => { console.error("[pool-applicants] fatal:", e.message); process.exit(1); });
