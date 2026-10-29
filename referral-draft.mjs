// referral-draft.mjs — writes the short intro the USER sends to a warm-intro contact.
//
// GROUNDING (non-negotiable): every claim about the person traces to their dossier. Never
// invent or inflate an employer, title, date, metric, or skill; never fabricate a mutual
// connection or a reason they "know" the contact. Thin dossier -> shorter note, not padding.
// The note is honest: the user is a candidate reaching out, not pretending to be anything.
//
// Returns { subject, body } as PLAINTEXT (the user reviews and sends it from their own
// inbox). Never throws — a safe, grounded template backs the model up so the send-intro
// button always has something real to open.

import Anthropic from "@anthropic-ai/sdk";
import { REFERRAL_DRAFT_SYSTEM, buildReferralAsk } from "./prompts/referral-draft.mjs"; // versioned prompt — see prompts/

const MODEL = process.env.REFERRAL_MODEL || "claude-sonnet-4-6";

function textOf(response) {
  return (response?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// Fix an all-caps resume-header name (e.g. "PRIYA SHARMA") to natural case for display,
// WITHOUT altering a name that already carries real mixed case (leave "McDonald", "de Souza"
// alone). This is presentation only, the same name, shown professionally, not invented.
function displayCase(raw) {
  const n = String(raw || "").trim();
  const letters = n.replace(/[^A-Za-z]/g, "");
  if (letters && letters === letters.toUpperCase()) {
    return n.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
  }
  return n;
}

// pull a display name from the dossier without letting the model touch it (all-caps -> natural)
function candidateName(dossier) {
  return displayCase((dossier?.name || dossier?.full_name || "").toString().trim());
}

// A real portfolio / personal-site URL from the dossier, or "" — never invented. Skips
// social profiles (those aren't a portfolio); accepts the first http(s) link that looks
// like a personal site or a field explicitly named portfolio/website.
function portfolioUrl(dossier) {
  const direct = dossier?.portfolio || dossier?.website || dossier?.portfolio_url || dossier?.site || "";
  const pick = (u) => (typeof u === "string" && /^https?:\/\//i.test(u.trim())) ? u.trim() : "";
  if (pick(direct)) return pick(direct);
  const links = dossier?.links || dossier?.urls || dossier?.contact?.links || [];
  const arr = Array.isArray(links) ? links : Object.values(links || {});
  for (const l of arr) {
    const u = typeof l === "string" ? l : (l?.url || l?.href || "");
    if (pick(u) && !/(linkedin|twitter|x\.com|facebook|instagram|github\.io\/?$)/i.test(u)) return pick(u);
  }
  return "";
}

// A grounded fallback that uses only fields we can read directly — no model, no invention.
function fallbackDraft({ dossier, roleTitle, company, contact }) {
  const me = candidateName(dossier);
  const cur = (dossier?.headline || dossier?.current_title || dossier?.title || "").toString().trim();
  const first = (contact?.first || contact?.name || "").toString().split(" ")[0] || "there";
  const role = roleTitle || "the open role";
  const at = company ? ` at ${company}` : "";
  const port = portfolioUrl(dossier);
  const body =
    `Hi ${first},\n\n` +
    `I came across the ${role}${at} and it lines up closely with what I do${cur ? ` (${cur})` : ""}. ` +
    `I'm planning to apply and wanted to introduce myself first in case it's helpful.\n\n` +
    (port ? `You can see some of my work here: ${port}\n\n` : "") +
    `Would you be open to a quick note or pointing me to the right person? Happy to send my resume. ` +
    `Either way, thanks for reading.\n\n` +
    `Best,\n${me || ""}`.trimEnd();
  const noDash = (s) => s.replace(/\s*—\s*/g, ", ");
  return { subject: noDash(`${role}${at}, quick hello`), body: noDash(body) };
}

// Compose the intro with the model, grounded in the dossier. Falls back on any failure.
export async function draftIntro({ dossier = {}, roleTitle = "", company = "", contact = {} } = {}) {
  const me = candidateName(dossier);
  const first = (contact?.first || contact?.name || "").toString().split(" ")[0] || "";
  const system = REFERRAL_DRAFT_SYSTEM;
  const port = portfolioUrl(dossier);
  const ask = buildReferralAsk({ contactName: contact?.name || first, contactTitle: contact?.position, company, roleTitle, candidateName: me, portfolioUrl: port, dossier });
  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
    const response = await client.messages.create({
      model: MODEL, max_tokens: 700, system,
      messages: [{ role: "user", content: ask }],
    });
    const raw = textOf(response).replace(/^```(?:json)?\s*|\s*```$/g, "");
    const obj = JSON.parse(raw);
    let subject = String(obj.subject || "").replace(/\s*—\s*/g, ", ").trim();
    let body = String(obj.body || "").replace(/\s*—\s*/g, ", ").trim();
    if (!body || body.length < 20) throw new Error("empty draft");
    if (!subject) subject = `${roleTitle || "the role"}${company ? ` at ${company}` : ""} — hello`.replace(/\s*—\s*/g, ", ");
    return { subject, body };
  } catch (err) {
    console.error(`[referral] draft fell back to template: ${err.message}`);
    return fallbackDraft({ dossier, roleTitle, company, contact });
  }
}
