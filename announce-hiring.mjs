// announce-hiring.mjs — the "State of Hiring" report note to active users, personalized per person.
//
//   node announce-hiring.mjs --dry      print the personalization plan for every active user (no send)
//   node announce-hiring.mjs <email>    send to one address now (ignores the flag; owner test)
//   node announce-hiring.mjs --all      send to every ACTIVE user not yet sent (the one-time blast)
//
// Highly personalized and grounded: each person sees their own field's real demands (from the
// verified report data) and, if they're in India, the honest remote-reachability wall that Charlie
// exists to get them past. Idempotent via email_config.hiring_report_sent_at. Skips suppressed.
// One-click unsubscribe. Nothing here is invented: role numbers come straight from the report's
// ROLES data (app/hiring/Report.tsx), reachability from the live pool.

import { Resend } from "resend";
import { getCandidate, listNewsletterCandidates, setEmailConfig, isV2 } from "./charlie-store.mjs";
import { sendGuarded } from "./lib/send-guard.mjs"; // the one physical send door
import { renderHiringReport, unsubUrlFor } from "./email-kit.mjs";

const log = (...a) => console.error("[announce-hiring]", ...a);
const RUST = "#C8502A", GREY = "#8F8F8F";

// grounded per-field data (bars scaled to the field's top skill; LLM/GenAI is the rust accent).
// Numbers trace to ROLES in app/hiring/Report.tsx; reality lines to the same senior/remote figures.
const FIELDS = {
  designer: {
    phrase: "in design",
    chartLabel: "What design roles now ask for:",
    bars: [["Prototyping", 100, "52%", GREY], ["Design Systems", 96, "50%", GREY], ["Figma", 85, "44%", GREY], ["LLM / GenAI", 21, "11%", RUST]],
    reality: "54% of design roles want senior or above, only 2% are junior, and 44% are remote (a third of those US-only).",
  },
  swe: {
    phrase: "in engineering",
    chartLabel: "What engineering roles now ask for:",
    bars: [["Python", 100, "40%", GREY], ["AWS", 78, "31%", GREY], ["TypeScript", 75, "30%", GREY], ["LLM / GenAI", 58, "23%", RUST]],
    reality: "65% of engineering roles want senior or above, just 1% are junior, and 47% are remote. AI now shows up in nearly 1 in 4.",
  },
  pm: {
    phrase: "in product",
    chartLabel: "What product roles now lean on:",
    bars: [["LLM / GenAI", 100, "24%", RUST], ["Prototyping", 75, "18%", GREY], ["SQL", 67, "16%", GREY], ["Salesforce", 42, "10%", GREY]],
    reality: "95% of product roles are manager-level, and 46% are remote (a third US-only). AI fluency now appears in 1 in 4 postings.",
  },
  data: {
    phrase: "in data and ML",
    chartLabel: "What data and ML roles now ask for:",
    bars: [["Python", 100, "68%", GREY], ["LLM / GenAI", 69, "47%", RUST], ["Machine Learning", 68, "46%", GREY], ["SQL", 62, "42%", GREY]],
    reality: "62% of data roles want senior or above, only 1% are junior, and 49% are remote (41% of those US-only).",
  },
  sales: {
    phrase: "in sales",
    chartLabel: "What sales roles now run on:",
    bars: [["Outbound", 100, "29%", RUST], ["Salesforce", 90, "26%", GREY], ["CRM", 72, "21%", GREY], ["HubSpot", 24, "7%", GREY]],
    reality: "Sales is the rare field still open to newcomers, only 11% ask for senior, and half are remote (just 27% US-only).",
  },
  fallback: { phrase: "", chartLabel: "", bars: null, reality: "" },
};

const HOOK_INDIA = `<b style="color:${RUST};">From India, the remote door is barely open:</b> of every 100 remote jobs, 44 are quietly US-only, and only about 4 are within reach (2 name India, 2 open to anyone worldwide). Most of the rest never make it here. That wall is exactly what I'm built to get you past.`;
const HOOK_GENERIC = `<b style="color:${RUST};">The remote door is narrower than it looks:</b> of every 100 remote jobs, 44 are quietly US-only, and only about 2 are open to anyone in the world. That's the wall I'm built to get you past.`;

// first name, case-normalized ("PRIYA SHARMA" -> "Priya"). Warm greeting, nothing invented.
function firstName(full) {
  const tok = String(full || "").trim().split(/\s+/)[0] || "";
  if (!tok) return "";
  // only de-shout ALL-CAPS ("PRIYA" -> "Priya"); leave mixed-case names (McDonald, Jean-Paul) as-is
  return tok === tok.toUpperCase() ? tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase() : tok;
}

// map a person's own stated field -> one of the grounded FIELDS keys. Order matters: SWE before
// designer so "UI developer" reads as engineering, not design.
function classify(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(product owner|product manager|scrum|program manager)\b/.test(t)) return "pm";
  if (/\b(data scientist|machine learning|\bml\b|data engineer|ml engineer|applied scientist|ai researcher)\b/.test(t)) return "data";
  if (/\b(developer|engineer|full[- ]?stack|software|programmer|back[- ]?end|front[- ]?end|swe)\b/.test(t)) return "swe";
  if (/\b(designer|\bux\b|\bui\b|product design|design systems)\b/.test(t)) return "designer";
  if (/\b(sales|account executive|business development|\bsdr\b|\bbdr\b|account manager)\b/.test(t)) return "sales";
  return "fallback";
}

function isIndia(dossier) {
  const p = dossier?.preferences || {};
  const t = `${p.remote || ""} ${p.location || ""} ${(p.values || []).join(" ")}`.toLowerCase();
  return /\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|gurgaon|chennai|noida|kochi|trivandrum|kerala|ist)\b/.test(t);
}

export function personalize(dossier) {
  // classify on the headline (the crisp identity), not preferences.role — switchers list many
  // exploratory interests there ("product design, supply chain, ...") that cause false matches.
  const key = classify(dossier?.headline || "");
  const f = FIELDS[key];
  return {
    key, india: isIndia(dossier),
    name: firstName(dossier?.name),
    rolePhrase: f.phrase, chartLabel: f.chartLabel, bars: f.bars, reality: f.reality,
    regionHook: isIndia(dossier) ? HOOK_INDIA : HOOK_GENERIC,
  };
}

async function sendTo(email, { dossier = {}, emailConfig = {}, force = false } = {}) {
  if (!force && emailConfig?.hiring_report_sent_at) return "skip";
  const pz = personalize(dossier);
  const m = renderHiringReport({ email, name: pz.name, rolePhrase: pz.rolePhrase, chartLabel: pz.chartLabel, bars: pz.bars, reality: pz.reality, regionHook: pz.regionHook });
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.CHARLIE_FROM || "charlie@mail.example.com";
  const unsub = `<${unsubUrlFor(email)}>`;
  const payload = { from, to: email, subject: m.subject, html: m.html, text: m.text, headers: { "List-Unsubscribe": unsub, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
  // The send door enforces suppression and the sent_emails idempotency claim.
  const res = await sendGuarded({ resend, email, template: "hiring", dedupeKey: "v1", payload, force, log });
  if (res.status === "suppressed") return "suppressed";
  if (res.status === "duplicate") { log(`${email}: already sent (idempotency) — skip`); return "skip"; }
  if (res.status === "failed") return "failed";
  try { await setEmailConfig(email, { ...(emailConfig || {}), hiring_report_sent_at: new Date().toISOString() }); }
  catch (e) { log(`${email}: sent but flag-mark failed: ${e.message}`); }
  log(`${email}: sent (${pz.key}${pz.india ? "/india" : ""}, resend ${res.id})`);
  return "sent";
}

async function main() {
  const { loadEnv } = await import("./charlie-store.mjs");
  loadEnv();
  const arg = (process.argv[2] || "").trim();
  if (!arg) { console.error("usage: node announce-hiring.mjs --dry | <email> | --all"); process.exit(1); }

  if (arg === "--dry") {
    const cands = await listNewsletterCandidates();
    console.log(`plan for ${cands.length} active users:\n`);
    for (const c of cands) {
      if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
      const pz = personalize(c.dossier || {});
      const sent = c.email_config?.hiring_report_sent_at ? "ALREADY-SENT" : "";
      console.log(`  ${(pz.name || "(no name)").padEnd(16)} ${pz.key.padEnd(9)} ${pz.india ? "india " : "global"}  ${c.email.padEnd(34)} ${sent}`);
    }
    return;
  }
  if (arg !== "--all") {
    const email = arg.toLowerCase();
    const c = await getCandidate(email);
    console.log(`announce-hiring ${email}: ${await sendTo(email, { dossier: c?.dossier || {}, emailConfig: c?.email_config || {}, force: true })}`);
    return;
  }
  const cands = await listNewsletterCandidates();
  let sent = 0, skipped = 0, failed = 0;
  for (const c of cands) {
    if (isV2(c)) continue; // v1 sweep — v2 cohort fenced out
    const ec = c.email_config || {};
    if (ec.hiring_report_sent_at) { skipped++; continue; }
    const r = await sendTo(c.email, { dossier: c.dossier || {}, emailConfig: ec });
    if (r === "sent") sent++; else if (r === "failed") failed++; else skipped++;
  }
  console.log(`announce-hiring --all: sent=${sent} skipped=${skipped} failed=${failed} (of ${cands.length} active)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error("[announce-hiring] fatal:", e.message); process.exit(1); });
