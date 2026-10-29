// mandate-run.mjs — fetch a mandate's applicants from Tally, gate on consent, read their CVs, and
// score every one of them against the approved criteria. Writes JSON. Sends nothing. Touches no board.
//
//   node --env-file=.env.local scripts/mandate-run.mjs --mandate northwind --out <dir>
//   ... --only <email>     one applicant, for checking
//   ... --skip-score       fetch and extract only, no model calls, $0
//
// COST: one Sonnet call per applicant, ~$0.04.
//
// THE CONSENT GATE IS FIRST AND IS NOT OPTIONAL. Anyone who did not answer Yes to "may we share your
// Charlie profile with the employer?" is dropped here, before scoring, before a row can exist. It
// fails CLOSED: an applicant whose answer cannot be read is dropped and reported, because showing
// someone to an employer who never agreed is not recoverable.
//
// EVERY APPLICANT WHO PASSES THE GATE IS SCORED. No threshold, no sampling. A model reply that fails
// the schema is retried, and if it still fails the applicant is written out with `failed: true` so
// they appear on the board unscored rather than vanishing from it.

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { MANDATES, SHARE_CONSENT_QUESTION, contactQuestions, MONEY_RE, maxScore, pedigreeQuestions } from "../lib/mandates.mjs";
import { readAll } from "../charlie-store.mjs";
import { ownWords } from "../lib/own-words.mjs";
import { MANDATE_SCORE_SYSTEM, buildMandateScoreMessages } from "../prompts/mandate-score.mjs";
import { mandateScoreSchema } from "../lib/schemas/mandate-score.mjs";

const MODEL = "claude-sonnet-4-6";
const CONCURRENCY = 5;
const POINTS = { strong: 3, some: 2, weak: 1, none: 0 };
// The model has no clock. Without this it reads ordinary past dates as future ones and invents doubt.
const TODAY = new Date().toISOString().slice(0, 10);

const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || d) : d; };
const KEY = flag("--mandate"), OUT = flag("--out");
// One email or a comma-separated list. The merge guard below also refuses to write an empty result.
const ONLY = new Set(flag("--only").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean));
const SKIP = process.argv.includes("--skip-score");
const M = MANDATES[KEY];
if (!M || !OUT) { console.error(`need --mandate <${Object.keys(MANDATES).join("|")}> --out <dir>`); process.exit(1); }
fs.mkdirSync(path.join(OUT, "cvs"), { recursive: true });

// A lone UTF-16 surrogate is broken encoding, not content: it makes the request body invalid JSON and
// fails the call outright. Dropping the orphaned code unit removes nothing a person typed.
const clean = (s) => String(s).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "").replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

const tally = async (p) => {
  const r = await fetch(`https://api.tally.so/${p}`, { headers: { Authorization: `Bearer ${process.env.TALLY_API_KEY}` } });
  if (!r.ok) throw new Error(`Tally ${p} -> ${r.status}`);
  return r.json();
};

console.error(`\n${M.client} — ${M.role}  ·  form ${M.formId}  ·  ${M.criteria.length} criteria, max ${maxScore(M)}\n`);

const qres = await tally(`forms/${M.formId}/questions`);
const QS = qres.questions || qres.items || qres;
const qid = (title) => (QS.find((q) => q.title === title) || {}).id;
const sres = await tally(`forms/${M.formId}/submissions?limit=200`);
const SUBS = sres.submissions || sres.items || [];

const raw = (sub, id) => {
  const r = (sub.responses || []).find((x) => x.questionId === id);
  return r ? r.answer : null;
};
const val = (sub, title) => {
  const a = raw(sub, qid(title));
  if (a == null) return "";
  return clean(Array.isArray(a) ? a.join(", ") : String(a)).trim();
};

// Questions whose answers are the person's own prose about their work. Contact details go to columns;
// compensation is recorded for the hiring team and never enters the model's context.
const PEDIGREE = new Set(pedigreeQuestions(M));
const CONTACT_QS = contactQuestions(M);
const PROSE_QS = QS.filter((q) => !CONTACT_QS.includes(q.title) && !MONEY_RE.test(q.title)
  && !PEDIGREE.has(q.title) && !/share your Charlie profile|talent pool/i.test(q.title)
  && q.type !== "FILE_UPLOAD").map((q) => q.title);
const FILE_Q = (QS.find((q) => q.type === "FILE_UPLOAD") || {}).id;

// A REPLY TO THE DECISION ASK IS EVIDENCE, AND IT MUST REACH THE SCORE.
//
// The ask names a must-have the application was silent on. When somebody answers it, that silence is
// no longer silence — but the score was computed from the form and the CV alone, so without this the
// board keeps showing the number they earned BEFORE they answered, and the whole point of asking is
// lost. Their reply is already filed verbatim on their Notion page; this is the same words reaching
// the arithmetic.
//
// It is their own account, exactly like the form and the CV, so it can raise a level and never
// confirms anything. lib/own-words.mjs strips the thread they replied on top of, keeping any earlier
// message of their own.
const askReplies = new Map();
try {
  const inbound = await readAll("inbound_messages", "email,subject,body,received_at");
  for (const r of inbound) {
    if (!/\[ask:/.test(String(r.subject || ""))) continue;
    const addr = String(r.email || "").toLowerCase();
    const words = ownWords(String(r.body || ""), addr);
    if (words.length < 40) continue;
    const at = String(r.received_at || "").slice(0, 10);
    const prev = askReplies.get(addr) || [];
    if (!prev.some((x) => x.words === words)) prev.push({ words, at });
    askReplies.set(addr, prev);
  }
} catch (e) { console.error(`could not read replies, scoring without them: ${e.message}`); }

const consentId = qid(SHARE_CONSENT_QUESTION);
if (!consentId) { console.error(`REFUSING: this form has no "${SHARE_CONSENT_QUESTION}" question, so consent cannot be established.`); process.exit(1); }

// THE SAME CHECK, FOR THE CONTACT QUESTIONS. A contact question that matches nothing on the form does
// not go missing quietly: it stops being filtered out, and its answer is handed to the MODEL AS
// EVIDENCE: if a form words its on-site question differently from the derived string, "I would need to
// relocate" would be scored as an account of somebody's engineering.
//
// Refusing is right rather than warning: a mandate whose contact questions do not match its form is
// misconfigured, and every score it produced would have to be thrown away anyway.
const missingContact = CONTACT_QS.filter((t) => !qid(t));
if (missingContact.length) {
  console.error(`REFUSING: ${missingContact.length} contact question(s) do not exist on form ${M.formId}, so their answers would be scored as evidence:`);
  for (const t of missingContact) console.error(`   absent: "${t}"`);
  console.error(`\nThe form's own titles are:`);
  for (const q of QS) console.error(`   ${q.title}`);
  process.exit(1);
}


const people = [], withheld = [];
for (const sub of SUBS) {
  const email = val(sub, "Email").toLowerCase();
  const answer = String(raw(sub, consentId) ?? "").trim().toLowerCase();
  if (answer !== "yes") { withheld.push({ email, answer: answer || "(blank)" }); continue; }
  const answers = {};
  for (const t of PROSE_QS) { const v = val(sub, t); if (v) answers[t] = v; }
  const facts = {};
  for (const f of M.facts) facts[f.key] = val(sub, f.question);
  for (const r of askReplies.get(email) || []) {
    answers[`They replied on ${r.at}, to the one thing their application never mentioned`] = r.words;
  }
  people.push({
    email, name: val(sub, "Full name"), submittedAt: sub.createdAt || sub.submittedAt,
    repliedAt: (askReplies.get(email) || [])[0]?.at || null,
    contact: Object.fromEntries(CONTACT_QS.map((t) => [t, val(sub, t)])),
    money: Object.fromEntries(QS.filter((q) => MONEY_RE.test(q.title)).map((q) => [q.title, val(sub, q.title)])),
    answers, facts, files: FILE_Q ? (raw(sub, FILE_Q) || []) : [],
  });
}
console.error(`applied ${SUBS.length} · consented ${people.length} · withheld ${withheld.length}`);
console.error(`model sees ${PROSE_QS.length} question(s); withheld from it: ${[...PEDIGREE].concat(QS.filter((q) => MONEY_RE.test(q.title)).map((q) => q.title)).join(" | ") || "(none)"}`);
withheld.forEach((w) => console.error(`   withheld (no row will be created): ${w.email} -> "${w.answer}"`));

// CVs: Tally serves them behind a signed URL that expires, so the file is pulled now and kept.
//
// PDF AND DOCX BOTH. A magic-byte check catches an expired signed URL answering 200 with an HTML error
// page. It recognises both formats, because rejecting a Word CV would make the board read
// "Application only", which tells a hiring team the person sent nothing. Anything it still rejects is
// reported per person rather than passed over.
const sniff = (buf) => {
  if (buf.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (buf.subarray(0, 2).toString() === "PK") return "docx"; // .docx is a zip
  return null;
};
let gotCv = 0;
const cvProblems = [];
for (const p of people) {
  const f = (Array.isArray(p.files) ? p.files : [])[0];
  if (!f?.url) continue;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(f.url);
      const buf = Buffer.from(await r.arrayBuffer());
      const kind = sniff(buf);
      if (!kind) { p.cvNote = `unreadable file format (${f.name || "?"})`; break; }
      const file = path.join(OUT, "cvs", `${p.email}.${kind}`);
      fs.writeFileSync(file, buf);
      p.cvText = clean(kind === "pdf"
        ? (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text || ""
        : (await mammoth.extractRawText({ buffer: buf })).value || "");
      p.cvFile = file;
      p.cvKind = kind;
      p.cvName = f.name;
      if (p.cvText.trim().length < 200) p.cvNote = `${kind} has almost no extractable text — likely a scan`;
      gotCv++;
      break;
    } catch (e) {
      p.cvNote = `download/extract failed: ${String(e.message).slice(0, 120)}`;
      await new Promise((z) => setTimeout(z, 800 * attempt));
    }
  }
  if (!p.cvFile) cvProblems.push(`${p.name}: ${p.cvNote}`);
}
console.error(`CVs read ${gotCv}/${people.length}`);
// Named, never summarised away: each of these is a person whose board row will say "Application only".
cvProblems.forEach((x) => console.error(`   CV NOT USED — ${x}`));

// ONLY SCORE WHAT HAS NOT BEEN SCORED, OR WHAT CHANGED.
// Re-reading an unchanged application on every sweep cannot produce new information — it can only
// move a real person on a client's board. A score is recomputed
// when the EVIDENCE changes (a CV arrived) and not otherwise. --rescore-all is the deliberate override,
// for a criteria change, where moving everybody is the point.
const RESCORE_ALL = process.argv.includes("--rescore-all");
const priorScores = fs.existsSync(path.join(OUT, `${KEY}-scores.json`))
  ? JSON.parse(fs.readFileSync(path.join(OUT, `${KEY}-scores.json`), "utf8")) : {};
const basisNow = (p) => `${p.cvText ? "Application + CV" : "Application only"}${p.repliedAt ? " + their reply" : ""}`;
const alreadyDone = (p) => {
  const s = priorScores[p.email];
  return s && !s.failed && s.basis === basisNow(p);
};
const skipped = people.filter((p) => !RESCORE_ALL && alreadyDone(p));
const targets = people
  .filter((p) => !ONLY.size || ONLY.has(p.email))
  .filter((p) => ONLY.size || RESCORE_ALL || !alreadyDone(p));
if (skipped.length) console.error(`${skipped.length} already scored on the same evidence — not re-scored${RESCORE_ALL ? " (OVERRIDDEN)" : ""}`);
fs.writeFileSync(path.join(OUT, `${KEY}-people.json`), JSON.stringify({ mandate: KEY, withheld, people }, null, 1));
if (SKIP) { console.error(`\nwrote ${KEY}-people.json · scoring skipped`); process.exit(0); }

const Schema = mandateScoreSchema(M.criteria.map((c) => c.key));
const client = new Anthropic();

async function reviewOne(p) {
  const base = buildMandateScoreMessages({ mandate: M, name: p.name, answers: p.answers, cvText: p.cvText, today: TODAY })
    .map((m) => ({ ...m, content: clean(m.content) }));
  let lastErr = "", lastText = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    // A retry that repeats the identical request tends to reproduce the identical failure (an
    // unescaped quote in the model's own JSON, say), so the retry shows the model what it returned
    // and what was wrong with it.
    const messages = attempt === 1 ? base : [
      ...base,
      { role: "assistant", content: lastText.slice(0, 6000) },
      { role: "user", content: `That reply could not be used: ${lastErr}\n\nReturn the same review again as a single valid JSON object and nothing else. Escape every quote and newline inside string values. Do not wrap it in a code fence and do not add commentary.` },
    ];
    try {
      // TEMPERATURE 0, DELIBERATELY. At the default, a re-run of the SAME application moves people on
      // a client board by several points. A score that wanders
      // when nothing about the person changed is not a reading of evidence, it is a sample of a
      // distribution, and nobody reading the board knows that. Never raise this for "variety".
      const res = await client.messages.create({ model: MODEL, max_tokens: 3000, temperature: 0, system: MANDATE_SCORE_SYSTEM, messages });
      lastText = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const stripped = lastText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = Schema.safeParse(JSON.parse(stripped));
      if (parsed.success) return { ok: true, ...parsed.data };
      lastErr = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) { lastErr = String(e.message || e).slice(0, 200); }
    console.error(`    ${p.name}: attempt ${attempt} unusable (${lastErr.slice(0, 90)})`);
    await new Promise((z) => setTimeout(z, 1200 * attempt));
  }
  return { ok: false, error: lastErr };
}

function rollup(p, r) {
  const by = new Map(r.criteria.map((c) => [c.key, c]));
  let earned = 0, covered = 0;
  const rows = M.criteria.map((c) => {
    const x = by.get(c.key);
    earned += c.weight * (POINTS[x.level] ?? 0);
    if (x.level !== "none") covered++;
    return { ...c, ...x };
  });
  // What the score was computed from, said honestly. No fetched artefact exists for these mandates, so
  // nothing here may claim verification.
  // An "agree / differ" label would fire for nearly everybody (a CV and a form always differ
  // somewhere), carry no information, and read as an accusation. The board carries how many open
  // questions the comparison produced instead.
  const basis = basisNow(p);
  const openQuestions = (r.discrepancies || []).length;
  const coverage = Math.round((covered / M.criteria.length) * 100);
  return {
    score: Math.round((earned / maxScore(M)) * 100), coverage, basis, openQuestions,
    // OUR UNCERTAINTY, NEVER THEIR QUALITY — and it has to be a queue, not the whole board.
    // Open questions are NOT part of it: a CV and a form always differ somewhere, so the flag would be
    // true of everybody and the "Needs Evidence" view would equal the full board. Open questions have
    // their own column. This means one thing: we do not know enough about this person yet.
    needsEvidence: coverage < 70 || !p.cvText,
    rows,
  };
}

console.error(`\nscoring ${targets.length} applicant(s), ${CONCURRENCY} at a time\n`);
const out = {};
let ok = 0, failed = 0;
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (p) => {
    const r = await reviewOne(p);
    if (!r.ok) {
      failed++;
      out[p.email] = { name: p.name, failed: true, error: r.error };
      console.error(`  FAILED (stays on the board, unscored)  ${p.name}: ${r.error}`);
      return;
    }
    const roll = rollup(p, r);
    out[p.email] = {
      name: p.name, failed: false, score: roll.score, coverage: roll.coverage, basis: roll.basis,
      openQuestions: roll.openQuestions,
      needsEvidence: roll.needsEvidence, strongest_evidence: r.strongest_evidence,
      evidence_gaps: r.evidence_gaps, why: r.why, discrepancies: r.discrepancies || [],
      criteria: roll.rows.map((x) => ({ key: x.key, label: x.label, tier: x.tier, weight: x.weight, level: x.level, evidence: x.evidence, source: x.source, confidence: x.confidence })),
    };
    ok++;
    console.error(`  ${String(roll.score).padStart(3)}  cov ${String(roll.coverage).padStart(3)}%  ${roll.basis.padEnd(18)} ${String(roll.openQuestions).padStart(2)} q  ${p.name}`);
  }));
}

// MERGE, NEVER REPLACE. A --only run that matched nobody must not write {} over a completed scoring
// run. Existing scores are read back and only the applicants scored in THIS run are overwritten.
const scoresPath = path.join(OUT, `${KEY}-scores.json`);
const prior = fs.existsSync(scoresPath) ? JSON.parse(fs.readFileSync(scoresPath, "utf8")) : {};
if (!ok && !failed) {
  console.error(`\nNOTHING WAS SCORED — refusing to touch ${KEY}-scores.json (it holds ${Object.keys(prior).length} score(s)).`);
  console.error(ONLY.size ? `--only matched no consented applicant on this form: ${[...ONLY].join(", ")}` : "no applicants passed the consent gate.");
  process.exit(1);
}
fs.writeFileSync(scoresPath, JSON.stringify({ ...prior, ...out }, null, 1));
console.error(`\nscored ${ok} · failed ${failed} · file now holds ${Object.keys({ ...prior, ...out }).length} score(s)`);
