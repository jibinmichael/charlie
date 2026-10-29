// evidence-reconcile.mjs — check that every evidence reply people sent reached their record. READ-ONLY. $0.
//
//   node --env-file=.env.local scripts/evidence-reconcile.mjs
//   node --env-file=.env.local scripts/evidence-reconcile.mjs --file   # file anything that slipped
//
// It compares every evidence reply in `inbound_messages` against the answers on that person's
// dossier. A reply with no matching answer is a person whose words were asked for, received and not
// filed. A failure here looks like success from the outside (the reply arrives, the person is
// answered, the run reports OK), so this counts and exits non-zero when the two sides disagree.
//
// --file repairs the gap with the SAME writer /inbound uses (lib/evidence-record.mjs), so a repair can
// never differ from a live filing. Without it this writes nothing at all.

import { loadEnv, readAll, getCandidate } from "../charlie-store.mjs";
import { ownWords } from "../lib/own-words.mjs";
import { recordOwnWords, isEvidenceReply, MIN_CHARS } from "../lib/evidence-record.mjs";

loadEnv();
const FILE = process.argv.includes("--file");

const inbound = await readAll("inbound_messages", "email,subject,body,received_at");
const replies = inbound
  .filter((r) => isEvidenceReply(r.subject))
  .map((r) => {
    const email = String(r.email || "").toLowerCase();
    return { email, subject: String(r.subject || ""), own: ownWords(String(r.body || ""), email), at: String(r.received_at || "").slice(0, 10) };
  })
  .filter((r) => r.email && r.own.length >= MIN_CHARS);

const people = [...new Set(replies.map((r) => r.email))];
console.error(`\nevidence replies on file   ${replies.length} from ${people.length} people`);

const missing = [];
let onRecord = 0, noRow = 0;
for (const email of people) {
  const c = await getCandidate(email).catch(() => null);
  if (!c) { noRow++; console.error(`  no candidate row: ${email}`); continue; }
  const stored = Object.values(c.dossier?.answers || {}).map((v) => String(v).trim());
  for (const r of replies.filter((x) => x.email === email)) {
    if (stored.includes(r.own)) { onRecord++; continue; }
    missing.push(r);
  }
}

console.error(`already on the record      ${onRecord}`);
console.error(`no candidate row           ${noRow}`);
console.error(`NOT ON THE RECORD          ${missing.length}`);
for (const m of missing.slice(0, 20)) {
  console.error(`   ${m.email.padEnd(34)} ${m.at}  ${String(m.own.length).padStart(5)} chars  "${m.own.replace(/\s+/g, " ").slice(0, 60)}..."`);
}
if (missing.length > 20) console.error(`   ...and ${missing.length - 20} more`);

if (missing.length && FILE) {
  let filed = 0, failed = 0;
  for (const m of missing) {
    try {
      const r = await recordOwnWords({ email: m.email, subject: m.subject, body: m.own, receivedAt: m.at });
      r.ok && r.key ? filed++ : failed++;
      if (!r.ok) console.error(`   NOT FILED ${m.email}: ${r.reason}`);
    } catch (e) { failed++; console.error(`   FAILED ${m.email}: ${String(e.message).slice(0, 120)}`); }
  }
  console.error(`\nfiled ${filed} · failed ${failed}`);
  process.exit(failed ? 1 : 0);
}

// Non-zero on a gap so a scheduled run is a real alarm rather than a log line nobody reads.
if (missing.length) {
  console.error(`\n${missing.length} repl${missing.length === 1 ? "y" : "ies"} never reached a record. Re-run with --file to fix.`);
  process.exit(1);
}
console.error(`\nno gap: every reply people sent is on their record.`);
