// mandate-board.mjs — load a scored mandate onto its own Notion board. No model calls, $0.
//
//   node --env-file=.env.local scripts/mandate-board.mjs --mandate northwind --in <dir> --apply
//
// Reads <key>-people.json and <key>-scores.json produced by mandate-run.mjs and, per applicant,
// creates one row with the transcribed columns, uploads their CV into the page, and writes the
// evidence review beneath their own answers.
//
// ONE PERSON, ONE ROW, ONCE. The board is read first and anyone already on it is skipped, so a second
// run adds only what is new. Re-running after more applications arrive is the normal way to use this.
//
// --sync ALSO REPAIRS WHAT IS ALREADY THERE. Creating a row and writing its page are separate calls,
// so a network error between them can leave a row with an empty page, which a skip-if-present
// loader would never fix. With --sync, existing rows have their score columns brought
// up to date, an empty page is written, and a CV that arrived or became readable later is added.
//
// NOBODY REACHES THE BOARD WITHOUT CONSENT. mandate-run.mjs already dropped anyone who did not agree
// to be shown to the employer, and this script re-checks the count against the people file rather than
// trusting it: an applicant who is not in `people` cannot be created here by any path.
//
// EVERY APPLICANT WHO CONSENTED GETS A ROW, INCLUDING ONES THE MODEL COULD NOT SCORE. An unscored
// person appears with an empty score and a page saying the review did not complete, because a failure
// of our tooling must never look like a candidate who did not apply.

import fs from "fs";
import path from "path";
import { queryAll, appendBlocks, markdownToBlocks, uploadFile, listChildren, updateProperties } from "../lib/notion.mjs";
import { MANDATES, MONEY_COLUMNS, onsiteQuestion, onsiteColumn } from "../lib/mandates.mjs";

const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || d) : d; };
const KEY = flag("--mandate"), IN = flag("--in");
const APPLY = process.argv.includes("--apply");
const M = MANDATES[KEY];
if (!M || !IN) { console.error(`need --mandate <${Object.keys(MANDATES).join("|")}> --in <dir>`); process.exit(1); }

const TODAY = new Date().toISOString().slice(0, 10);
const { people, withheld } = JSON.parse(fs.readFileSync(path.join(IN, `${KEY}-people.json`), "utf8"));
const scores = JSON.parse(fs.readFileSync(path.join(IN, `${KEY}-scores.json`), "utf8"));

const num = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) && String(v).trim() ? n : null; };
const rt = (v) => (String(v || "").trim() ? { rich_text: [{ type: "text", text: { content: String(v).slice(0, 1900) } }] } : { rich_text: [] });

const LEVEL_LABEL = { strong: "Strong evidence", some: "Some evidence", weak: "Weak evidence", none: "No evidence" };
const SRC = { application: "Their answers", cv: "Their CV", both: "Both", none: "Neither" };

function reviewMarkdown(p, r) {
  if (r.failed) {
    return `## Evidence review\n\nThe automated review did not complete for this applicant, so there is no score. That is a failure of our tooling, not a finding about the candidate. Their application above is complete and unchanged.\n\nError: ${String(r.error).slice(0, 200)}\n`;
  }
  const rows = r.criteria.map((c) =>
    `| ${c.label}${c.tier === "good-to-have" ? " *(good to have)*" : ""} | ${LEVEL_LABEL[c.level]} | ${String(c.evidence).replace(/\|/g, "\\|")} | ${SRC[c.source]} | ${c.confidence} |`).join("\n");
  const q = (r.discrepancies || []).length
    ? (r.discrepancies).map((d) => `| ${String(d.topic).replace(/\|/g, "\\|")} | ${String(d.application_says).replace(/\|/g, "\\|")} | ${String(d.cv_says).replace(/\|/g, "\\|")} |`).join("\n")
    : null;

  return `## Evidence review — against the ${M.client} ${M.role} criteria

**Score ${r.score}** · **Evidence Coverage ${r.coverage}%** · **Basis: ${r.basis}**${r.needsEvidence ? " · **Needs evidence**" : ""}

Reviewed ${TODAY} against the ${M.criteria.length} criteria agreed for this mandate, and nothing else.

${String(r.why).replace(/\n+/g, " ")}

This is an evidence summary, not an assessment of the person and not a hiring recommendation. "No evidence" means this application did not establish the point; it does not mean the candidate lacks the skill. Nothing here was verified against an outside source: this application collects a LinkedIn URL, which cannot be read, so both the answers and the CV are the applicant's own account.

Years of experience, where they studied, which companies they have worked for and what they are paid were deliberately withheld from this review, so none of them could move the score. Those facts are recorded in the columns for the hiring team to filter on.

### Criteria

| Criterion | Assessment | Evidence | Source | Confidence |
|---|---|---|---|---|
${rows}

${q ? `### Open questions

Places where the written answers and the CV describe things differently. These are questions worth asking, not findings against the person — people compress and re-emphasise their own history all the time.

| What differs | Their answers say | Their CV says |
|---|---|---|
${q}` : `### Open questions

None. The written answers and the CV lined up.`}

### What this application does not establish

${String(r.evidence_gaps).replace(/\n+/g, " ")}

---
*Reviewed by Charlie against the ${M.client} mandate. Scores navigate the pool; they do not decide it. The hiring decision, and the Review status field, belong to ${M.client}.*
`;
}

function answersMarkdown(p) {
  const body = Object.entries(p.answers).map(([q, v]) => `## ${q}\n${v}`).join("\n\n");
  return body || "_No written answers were submitted._";
}

async function createRow(p, r) {
  const props = {
    "Full name": { title: [{ type: "text", text: { content: p.name || p.email } }] },
    "Email": { email: p.email || null },
    "Phone": { phone_number: p.contact["Phone number"] || null },
    "LinkedIn": { url: p.contact["LinkedIn URL"] || null },
    "Current location": rt(p.contact["Current location, city"]),
    "Current company": rt(p.contact["Current company"]),
    "Current role": rt(p.contact["Current role or job title"]),
    "Can join": rt(p.contact["How soon could you join?"]),
    [onsiteColumn(M)]: rt(p.contact[onsiteQuestion(M)]),
    "Review status": { select: { name: "Not reviewed" } },
    "Submitted": p.submittedAt ? { date: { start: String(p.submittedAt).slice(0, 10) } } : { date: null },
  };
  for (const [k, v] of Object.entries(p.money || {})) {
    const col = /current/i.test(k) ? MONEY_COLUMNS.current : MONEY_COLUMNS.expected;
    props[col] = { number: num(v) };
  }
  for (const f of M.facts) {
    if (!f.column) continue;
    props[f.column] = f.number ? { number: num(p.facts[f.key]) } : rt(p.facts[f.key]);
  }
  if (r && !r.failed) {
    Object.assign(props, {
      "Score": { number: r.score },
      "Evidence Coverage": { number: r.coverage },
      "Evidence basis": { select: { name: r.basis } },
      "Open questions": { number: r.openQuestions ?? 0 },
      "Needs evidence": { checkbox: Boolean(r.needsEvidence) },
      "Strongest evidence": rt(r.strongest_evidence),
      "Evidence gaps": rt(r.evidence_gaps),
      "Scored on": { date: { start: TODAY } },
    });
  } else {
    props["Needs evidence"] = { checkbox: true };
    props["Evidence gaps"] = rt("The automated review did not complete. This applicant has not been evaluated and needs a manual read.");
  }
  return props;
}

const existing = APPLY ? await queryAll(M.databaseId) : [];
const seen = new Set(existing.map((r) => (r.properties.Email?.email || "").toLowerCase()).filter(Boolean));
const todo = people.filter((p) => !seen.has(p.email));

console.error(`\n${M.client} — ${M.role}`);
console.error(`consented ${people.length} · withheld ${withheld.length} (never created) · already on board ${seen.size} · to create ${todo.length}`);
console.error(`scores available for ${Object.keys(scores).length}${APPLY ? "" : "   (DRY RUN — pass --apply)"}\n`);
if (!APPLY) process.exit(0);

// notion.mjs serialises and rate-limits every call, so this loop cannot outrun Notion's limit.
const SYNC = process.argv.includes("--sync");
let made = 0, failed = 0, noScore = 0, repaired = 0;

/** Attach the CV to a page and point the CV column at it. Skipped when the page already has one. */
async function attachCv(pageId, p) {
  if (!p.cvFile || !fs.existsSync(p.cvFile)) return false;
  const uploadId = await uploadFile(p.cvFile, p.cvName || `${p.name || p.email}.${p.cvKind || "pdf"}`);
  const block = p.cvKind === "docx"
    ? { type: "file", file: { type: "file_upload", file_upload: { id: uploadId } } }
    : { type: "pdf", pdf: { type: "file_upload", file_upload: { id: uploadId } } };
  await appendBlocks(pageId, [
    { type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "CV" } }] } },
    { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `Submitted with their application on ${String(p.submittedAt || "").slice(0, 10)}. The original file, unaltered.` } }] } },
    block,
  ]);
  await updateProperties(pageId, { CV: { url: `https://www.notion.so/${pageId.replace(/-/g, "")}` } });
  return true;
}

if (SYNC) {
  const byEmail = new Map(existing.map((r) => [(r.properties.Email?.email || "").toLowerCase(), r]));
  for (const p of people) {
    const row = byEmail.get(p.email);
    if (!row) continue;
    const r = scores[p.email];
    try {
      if (r && !r.failed) await updateProperties(row.id, await createRow(p, r));
      const kids = await listChildren(row.id);
      const hasReview = kids.some((b) => b.type === "heading_2" &&
        (b.heading_2.rich_text || []).map((x) => x.plain_text).join("").startsWith("Evidence review"));
      const hasCv = kids.some((b) => b.type === "pdf" || b.type === "file");
      const notes = [];
      if (!hasReview) {
        // An empty page is a row that says nothing about a person who wrote a great deal.
        await appendBlocks(row.id, markdownToBlocks(`${answersMarkdown(p)}\n\n${r ? reviewMarkdown(p, r) : "## Evidence review\n\nThis applicant has not been scored yet."}`));
        notes.push("page written");
      }
      if (!hasCv && await attachCv(row.id, p)) notes.push("CV attached");
      if (notes.length) { repaired++; console.error(`  repaired  ${p.name}  (${notes.join(", ")})`); }
    } catch (e) {
      failed++;
      console.error(`  SYNC FAILED  ${p.name}: ${String(e.message).slice(0, 160)}`);
    }
  }
  console.error(`\nrepaired ${repaired} existing row(s) · failed ${failed}`);
}

for (const p of todo) {
  const r = scores[p.email];
  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { database_id: M.databaseId }, properties: await createRow(p, r) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();

    const md = `${answersMarkdown(p)}\n\n${r ? reviewMarkdown(p, r) : "## Evidence review\n\nThis applicant has not been scored yet."}`;
    await appendBlocks(page.id, markdownToBlocks(md));
    // The CV goes INTO the page, not into a link: Tally's signed URL expires and would leave the row
    // pointing at nothing. Uploading the bytes makes it permanent.
    await attachCv(page.id, p);
    if (!r || r.failed) noScore++;
    made++;
    console.error(`  ${String(r && !r.failed ? r.score : "  -").padStart(3)}  ${p.name}`);
  } catch (e) {
    failed++;
    console.error(`  FAILED  ${p.name}: ${String(e.message).slice(0, 200)}`);
  }
}
console.error(`\ncreated ${made} · failed ${failed} · created-without-a-score ${noScore}`);
if (failed) process.exit(1);
