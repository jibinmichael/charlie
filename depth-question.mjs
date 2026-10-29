// depth-question.mjs — the depth-question email: give a real market read, then ask ONE thing.
//
// WHY THIS EXISTS. Engagement concentrates in people Charlie knows well; thin profiles barely click.
// The obvious response, to stop mailing thin profiles, is wrong twice over: it guarantees they never
// engage, and it silently excludes people. The better move is to send them something DIFFERENT.
//
// THE SHAPE. Charlie has been scoring their near-miss roles all along and knows which requirement
// keeps coming up that their record has never spoken to. That is a genuinely useful thing to tell
// someone about their own market, and it makes the question that follows worth answering:
//
//     "Six roles came close for you this month. Two asked for Kubernetes in production.
//      Your record doesn't say either way, so I've been treating it as a no.
//      Have you run it in production?"
//
// Give first, then ask. The insight is the incentive; the question is one line to answer; and BOTH
// answers help them — more roles if yes, less noise if no. Nothing about it is a "complete your
// profile" nag, which is the form this always takes and the reason it always fails.
//
// IT READS STORED COVERAGE AND NEVER COMPUTES ANY. The send already scores every near-miss to decide
// send/digest/drop, and persists that as composed._cov. Re-deriving it here would pay a model call per
// role for a number already bought. So when the stored coverage is missing this module SKIPS the
// person rather than paying again; a skipped question is recoverable next pass.
//
// COST: $0 in model spend, by construction. The only calls are database reads.

import { Resend } from "resend";
import { listActiveCandidates, getFinds, recordSignal, sentCountSince } from "./charlie-store.mjs";
import { aggregateGaps } from "./market-research.mjs";
import { renderDepthQuestion } from "./email-kit.mjs";
import { sendGuarded } from "./lib/send-guard.mjs";
import { profileDepth } from "./profile-depth.mjs";

const TEMPLATE = "depth-question";

/** How many near-misses to read per person. Matches the scan the gate already walks. */
const SCAN = 12;

/** A requirement must recur before it is worth a person's attention. One role is an anecdote. */
const MIN_COUNT = 2;

/** One question per person per fortnight, however many gaps they have. */
const COOLDOWN_DAYS = 14;

/** Off by default. Read at call time so a deploy can change it without a code change. */
export function depthQuestionMode() {
  const v = String(process.env.DEPTH_QUESTION || "off").toLowerCase();
  return v === "dry" || v === "on" ? v : "off";
}

/**
 * The coverage the SEND already paid for, pulled back off the near-miss rows.
 *
 * Returns only what is genuinely there: an older row may have no `_cov`, and this returns
 * fewer coverages rather than inventing or recomputing them.
 */
export function storedCoverages(finds) {
  const out = [];
  for (const f of finds || []) {
    const cov = f?.composed?._cov;
    if (cov && typeof cov === "object" && Array.isArray(cov.coverage)) out.push(cov);
  }
  return out;
}

/**
 * The one thing worth asking this person, or null.
 *
 * PURE. Given their stored coverages, returns the recurring requirement their record has never spoken
 * to — `status: "unknown"` in the gate's own readout, which means the JD asked and the dossier was
 * silent. Not "they lack it": we genuinely do not know, which is precisely why it is a question and
 * never a statement.
 *
 * @returns {{gap:string, count:number, total:number, kind:string}|null}
 */
export function questionFor(coverages, { minCount = MIN_COUNT } = {}) {
  const ranked = aggregateGaps(coverages, { minCount });
  if (!ranked.length) return null;
  const top = ranked[0];
  // A gap that shows up in every single role is usually a scoring artefact rather than a real market
  // signal, and a gap in one of twenty is noise. Require it to recur without being universal.
  if (!top.total || top.count > top.total) return null;
  return top;
}

/**
 * Ask, at most one person-question per pass per person.
 *
 * Best-effort throughout, per-record isolation, and every skip is a silent no-op rather than a retry
 * storm. Writes signals so the answer has a denominator: `depth_question_asked` on send,
 * `depth_question_answered` when the reply lands (server inbound handler).
 */
export async function runDepthQuestionSweep({ log = console.error } = {}) {
  const mode = depthQuestionMode();
  if (mode === "off") return { mode, considered: 0, asked: 0, skipped: 0, noCoverage: 0 };

  let people = [];
  try {
    people = await listActiveCandidates();
  } catch (e) {
    log(`[depth-q] could not list candidates (${e.message}) — asking nobody this pass`);
    return { mode, considered: 0, asked: 0, skipped: 0, noCoverage: 0 };
  }

  const resend = mode === "on" ? new Resend(process.env.RESEND_API_KEY) : null;
  const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString();
  let asked = 0;
  let skipped = 0;
  let noCoverage = 0;

  for (const p of people) {
    try {
      if (!p?.email) { skipped++; continue; }
      if ((await sentCountSince(p.email, TEMPLATE, since)) > 0) { skipped++; continue; }

      const finds = await getFinds(p.email, { status: "digest", limit: SCAN }).catch(() => []);
      const coverages = storedCoverages(finds);
      if (coverages.length < MIN_COUNT) { noCoverage++; continue; } // never recompute — see the header

      const q = questionFor(coverages);
      if (!q) { skipped++; continue; }

      const before = profileDepth(p.dossier).depth;
      const { subject, html, text } = renderDepthQuestion({
        email: p.email,
        name: p.dossier?.name || "",
        gap: q.gap,
        count: q.count,
        total: q.total,
      });

      if (mode === "dry") {
        log(`[depth-q] DRY would ask ${p.email}: "${q.gap}" (${q.count} of ${q.total} near-misses, depth ${before})`);
        asked++;
        continue;
      }

      const res = await sendGuarded({
        resend,
        email: p.email,
        template: TEMPLATE,
        dedupeKey: `${p.email}:${q.key || q.gap}`, // never the same question twice
        payload: { from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: p.email, subject, html, text },
      });
      if (res?.status === "sent") {
        asked++;
        // The denominator for "did asking work". depthBefore is what makes the delta measurable when
        // the answer lands and the dossier deepens.
        await recordSignal({
          email: p.email,
          event: "depth_question_asked",
          meta: { gap: q.gap, count: q.count, total: q.total, depthBefore: before },
        }).catch(() => {});
      } else {
        skipped++;
      }
    } catch (e) {
      skipped++;
      log(`[depth-q] ${p?.email} failed (${e.message}) — continuing`);
    }
  }

  log(`[depth-q] ${mode}: ${people.length} considered, ${asked} asked, ${skipped} skipped, ${noCoverage} without stored coverage`);
  return { mode, considered: people.length, asked, skipped, noCoverage };
}

/** Exported for the inbound handler + tests: does this subject look like our question? */
export const DEPTH_QUESTION_SUBJECT_RE = /^\s*(re:|fwd:)?\s*about your last few roles/i;

