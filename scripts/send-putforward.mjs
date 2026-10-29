// scripts/send-putforward.mjs — put ONE person forward for ONE role. ⚠️ SENDS REAL EMAIL.
//
//   node --env-file=.env.local scripts/send-putforward.mjs --in putforward.json          # dry: prints, sends nothing
//   node --env-file=.env.local scripts/send-putforward.mjs --in putforward.json --send   # sends
//
// putforward.json: { "to", "role", "company", "why": [..reasons..], "gap", "roleFile", "dedupe"? }
//   roleFile is a JSON array of job objects; the one whose title equals `role` is the job gated.
//   company stays "" until the employer has agreed to receive anyone: naming an employer who then
//   goes quiet creates a disappointment that cannot be undone.
//
// HAND-RUN, deliberately. Putting someone forward is a human deciding that a specific person should
// be in front of a specific employer; it is not automatable and must never become a loop over a list.
//
// ROUTES THROUGH sendGuarded, so suppression and `sent_emails` idempotency both apply and a re-run is
// a no-op rather than a second copy in a real person's inbox.
//
// $0 OF MODEL SPEND. The fit is computed and reviewed by a human before the input file is written;
// the copy is fixed text. Do not add a model call here.

import { loadEnv, getCandidate, getEmailedRoleSignatures } from "../charlie-store.mjs";
import { renderPutForward } from "../email-kit.mjs";
import { sendGuarded } from "../lib/send-guard.mjs";
import { preSendGuard } from "../presend-guard.mjs"; // the SAME choke point every automated send clears
import { blockingGap, askWith } from "../lib/represent-ready.mjs"; // do we know enough to name a role at all
import { readFileSync } from "node:fs";
import { Resend } from "resend";

loadEnv();
const SEND = process.argv.includes("--send");

// ── the one send, read from the input file. Never generalise this into a loop. ──────────────────
const inIdx = process.argv.indexOf("--in");
const IN = inIdx >= 0 ? process.argv[inIdx + 1] : null;
if (!IN) { console.error("usage: send-putforward.mjs --in <putforward.json> [--send]"); process.exit(1); }
const spec = JSON.parse(readFileSync(IN, "utf8"));
const TO = String(spec.to || "").trim().toLowerCase();
const ROLE = String(spec.role || "");
const COMPANY = String(spec.company || ""); // stays empty until the employer has agreed to receive anyone
const WHY = Array.isArray(spec.why) ? spec.why : [];
const GAP = String(spec.gap || "");
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const DEDUPE = spec.dedupe || `${TO}:putforward:${slug(`${COMPANY || "unnamed"}-${ROLE}`)}`;
if (!TO || !ROLE || !WHY.length) { console.error(`${IN} needs "to", "role" and a non-empty "why" — refusing to send.`); process.exit(1); }

// The ROLE this is about, as a real job object. Required: without it there is nothing for the guard
// to check the person against.
const ROLE_FILE = spec.roleFile;
if (!ROLE_FILE) { console.error(`${IN} needs "roleFile" — refusing to send an introduction we cannot gate.`); process.exit(1); }
const JOB = JSON.parse(readFileSync(ROLE_FILE, "utf8")).find((j) => j.title === ROLE);

const cand = await getCandidate(TO).catch(() => null);
if (!cand) {
  console.error(`${TO} is not a candidate — refusing to send. This email only goes to someone whose fit we actually computed.`);
  process.exit(1);
}

// ── READINESS. Checked BEFORE the match gate, because it is a different question. ────────────────
//
// preSendGuard asks "is this role wrong for them", and can only answer when the fact exists. This
// asks "do we know enough to name ANY role to them yet" (e.g. where they can work). Ask first.
const gap = blockingGap(cand.dossier);
if (gap) {
  console.error(`\nNOT READY — ${gap}`);
  console.error(`Ask them that BEFORE naming a role. The pitch is what cannot be taken back.\n`);
  process.exit(1);
}
const stillAsking = askWith(cand.dossier);
if (stillAsking.length) console.error(`(the email will ask for: ${stillAsking.join(", ")})`);

// ── THE GATE. ───────────────────────────────────────────────────────────────────────────────────
//
// sendGuarded checks whether we may mail this ADDRESS; it says nothing about whether we should mail
// them THIS ROLE. preSendGuard does (repeat, hard constraints such as dealbreakers, geo, language,
// liveness). Every script that mails a candidate about a real job clears it (sender-gate.test.mjs).
if (!JOB) {
  console.error(`no role titled "${ROLE}" in ${ROLE_FILE} — refusing to send an introduction we cannot gate.`);
  process.exit(1);
}
const signatures = await getEmailedRoleSignatures(TO).catch(() => null);
if (!signatures) {
  console.error(`cannot verify no-repeat for ${TO} — refusing to send (fail closed).`);
  process.exit(1);
}
const gate = await preSendGuard({
  job: JOB,
  dossier: cand.dossier,
  signatures,
  // The fit was already computed and read by a human before the input file was written, so the coverage
  // call is skipped rather than re-billed. Every DETERMINISTIC check above it still runs, and those
  // are the ones that matter here: repeat, hard constraints, geo, language, liveness.
  getCov: () => ({ thin: true }),
});
if (gate.decision !== "send") {
  console.error(`\nGATE SAYS ${gate.decision.toUpperCase()} — not sending.`);
  console.error(`  rule:   ${gate.rule}`);
  console.error(`  reason: ${gate.reason}`);
  process.exit(1);
}

const m = renderPutForward({ email: TO, name: cand.dossier?.name || "", role: ROLE, company: COMPANY, why: WHY, gap: GAP });

// Backstop on the rendered output, not the inputs: user-facing copy never contains an em dash, and a
// reason string pasted in from model output is exactly where one arrives unnoticed.
if (/—|–/.test(`${m.subject}${m.text}${m.html}`)) {
  console.error("em dash in the rendered email — fix the copy before sending");
  process.exit(1);
}

console.log(`\nTO: ${TO}  (${cand.dossier?.name || "no name"})`);
console.log(`SUBJECT: ${m.subject}\n${"-".repeat(64)}\n${m.text}\n${"-".repeat(64)}`);

if (!SEND) {
  console.log(`\nDRY RUN. Nothing sent. Re-run with --send.\n`);
  process.exit(0);
}

const res = await sendGuarded({
  resend: new Resend(process.env.RESEND_API_KEY),
  email: TO,
  template: "putforward",
  dedupeKey: DEDUPE,
  payload: { from: process.env.CHARLIE_FROM || "charlie@mail.example.com", to: TO, subject: m.subject, html: m.html, text: m.text },
});
console.log(`\nsend-guard says: ${res?.status}${res?.reason ? ` (${res.reason})` : ""}\n`);
