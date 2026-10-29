// inbox.mjs — read what people wrote to Charlie (the inbound_messages table).
//
//   node --env-file=.env.local scripts/inbox.mjs                 # the last 30, newest first
//   node --env-file=.env.local scripts/inbox.mjs --days 2        # everything from the last 2 days
//   node --env-file=.env.local scripts/inbox.mjs --from a@b.com  # one person's whole thread
//   node --env-file=.env.local scripts/inbox.mjs --unanswered    # messages with no reply after them
//
// Charlie has no mailbox: Resend delivers inbound mail to a webhook, which stores it in
// inbound_messages. This script is the mailbox view.
//
// --unanswered compares each message against sent_emails for the same address: a message with no
// outbound to that person afterwards is somebody still waiting.

import { loadEnv, store } from "../charlie-store.mjs";

loadEnv();
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || "") : ""; };
const DAYS = Number(flag("--days") || 0);
const FROM = flag("--from").toLowerCase();
const UNANSWERED = process.argv.includes("--unanswered");
const LIMIT = Number(flag("--limit") || 30);

async function main() {
  const db = store();
  let q = db.from("inbound_messages").select("email,subject,body,received_at,stage").order("received_at", { ascending: false });
  if (DAYS) q = q.gte("received_at", new Date(Date.now() - DAYS * 864e5).toISOString());
  if (FROM) q = q.eq("email", FROM);
  const { data, error } = await q.limit(FROM ? 200 : LIMIT);
  if (error) {
    console.error(`\ncannot read inbound_messages: ${error.message}`);
    console.error(`If the table is missing, apply supabase/migrations/20260813120000_inbound_messages.sql`);
    console.error(`in the Supabase SQL editor.\n`);
    process.exit(1);
  }
  const rows = data || [];
  if (!rows.length) { console.error(`\nno inbound messages${FROM ? ` from ${FROM}` : ""}${DAYS ? ` in the last ${DAYS} day(s)` : ""}.\n`); return; }

  let show = rows;
  if (UNANSWERED) {
    const emails = [...new Set(rows.map((r) => r.email))];
    const { data: sent } = await db.from("sent_emails").select("email,sent_at").in("email", emails);
    const lastOut = new Map();
    for (const s of sent || []) {
      const prev = lastOut.get(s.email);
      if (!prev || s.sent_at > prev) lastOut.set(s.email, s.sent_at);
    }
    show = rows.filter((r) => !lastOut.get(r.email) || lastOut.get(r.email) < r.received_at);
    console.error(`\n${show.length} of ${rows.length} message(s) have had no reply since.\n`);
  } else {
    console.error(`\n${rows.length} message(s)${FROM ? ` from ${FROM}` : ""}, newest first.\n`);
  }

  for (const r of show) {
    console.error(`${"─".repeat(78)}`);
    console.error(`${r.received_at.slice(0, 16).replace("T", " ")}  ${r.email}`);
    console.error(`${r.subject || "(no subject)"}${r.stage ? `   [${r.stage}]` : ""}`);
    console.error("");
    console.error(String(r.body || "(empty)").trim().split("\n").map((l) => "  " + l).join("\n").slice(0, 2500));
    console.error("");
  }
}

main().catch((e) => { console.error("[inbox] fatal:", e.message); process.exit(1); });
