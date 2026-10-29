// render-plan.mjs — the "game plan" email: how Charlie will work for a person, and where it's looking.
//
// This is the #3 beat in the onboarding chain (welcome -> market briefing -> PLAN -> first role). After
// the briefing has proven Charlie already did the digging, the plan says, in plain words: here's how I'll
// work for you, and here's exactly where I'm aiming. Then it hands the person the wheel: tell me what to
// change and I'll adjust.
//
// It does NOT ask for an approval: the day-2 role is already scheduled before this email is composed,
// so asking would imply the work is contingent on a reply when it is not.
//
// GROUNDING / VOICE: every line traces to the person's OWN stored profile — the positioning
// is a verbatim strength/headline they gave, and "where I'm looking" is the search parameters they stated
// (role, level, location, pay floor, dealbreakers). Nothing is invented, inflated, or upgraded. No model
// call anywhere in this path: game-plan.mjs derives the fields deterministically and passes them in; this
// layer only frames them. A field the person never gave is simply not rendered (never a guessed value).
//
// EMAIL-SAFE + LOCKED DESIGN: reuses email-kit's emailShell (white card, hand logo, sign-off,
// footer) and the LIFECYCLE tokens (Avenir body + Sanchez headings). esc() strips em dashes on every
// interpolated string, so the no-em-dash contract holds by construction. No new fonts, colors, or spacing.
//
//   import { renderGamePlan } from "./render-plan.mjs";
//   const { subject, html, text } = renderGamePlan({ name, positioning, params, email });

import { esc, cleanSubject, emailShell, unsubUrlFor } from "./email-kit.mjs";
import { LIFECYCLE } from "./emails/tokens.mjs";

const SANS = LIFECYCLE.fonts.sans;
const HEAD = LIFECYCLE.fonts.head; // Sanchez -> Georgia
const C = LIFECYCLE.colors;

// Greeting-safe name: a resume header is often ALL CAPS ("PRIYA SHARMA"), which reads as shouting in a
// greeting (no ALL CAPS in user-facing copy). Normalize ONLY a fully-uppercase word to Title case; a name
// the person already cased themselves (McDonald, O'Brien) is left exactly as written. Grounding-safe:
// this changes the letter case of the person's OWN name for the greeting, never the name itself.
function greetName(name) {
  return String(name || "")
    .split(/\s+/)
    .map((w) => (w.length > 1 && /[A-Z]/.test(w) && w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w))
    .join(" ")
    .trim();
}

// ── content helpers (mirror email-kit's private h1/p/lead so the plan reads identical to lifecycle mail) ──
const h1 = (t) => `<h1 style="font-family:${HEAD};font-weight:400;font-size:23px;line-height:1.25;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;">${esc(t)}</h1>`;
const p = (html) => `<p style="font-family:${SANS};font-size:14.5px;line-height:1.62;color:${C.text};margin:0 0 14px;">${html}</p>`;
const lead = (t) => `<p style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 10px;">${esc(t)}</p>`;

// A labeled "where I'm looking" row: bold label, plain value. Every value is esc()'d (em-dash safe).
const paramRow = (label, value) => `<tr>
  <td style="font-family:${SANS};font-size:12.5px;font-weight:600;color:${C.ink};padding:0 12px 11px 0;vertical-align:top;white-space:nowrap;">${esc(label)}</td>
  <td style="font-family:${SANS};font-size:14px;line-height:1.5;color:${C.text};padding:0 0 11px;">${esc(value)}</td>
</tr>`;

// Render the "where I'm looking" table from the already-derived, grounded params. Only rows that have a
// value are shown — a parameter the person never stated is never guessed or padded in.
function paramsTable(params = {}) {
  const rows = [];
  if (params.roles) rows.push(paramRow("Roles", params.roles));
  if (params.level) rows.push(paramRow("Level", params.level));
  if (params.location) rows.push(paramRow("Location", params.location));
  if (params.pay) rows.push(paramRow("Pay floor", params.pay));
  if (params.avoid) rows.push(paramRow("Won't send", params.avoid));
  if (!rows.length) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 16px;"><tbody>${rows.join("")}</tbody></table>`;
}

// The game-plan email. Returns { subject, html, text }.
//   name        first name (grounded, verbatim) or ""
//   positioning one grounded sentence on how Charlie will work them (from a real strength/headline)
//   params      { roles, level, location, pay, avoid } — pre-formatted, grounded strings; absent = omitted
//   note        optional preamble for the "I adjusted your plan" case (modify loop). "" = the first send.
//   email       recipient (for the unsubscribe token)
export function renderGamePlan({ name = "", positioning = "", params = {}, note = "", email = "" } = {}) {
  const nm = greetName(name);
  const hi = nm ? `Hi ${esc(nm)}.` : "Hi.";
  const table = paramsTable(params);

  // The greeting is its own sentence; the grounded positioning is folded into a warm recognition ("one
  // thing jumped out ... that's what I'll lead with"), so a verbatim strength that dossiers store lowercase
  // reads as a natural lead-in, never a subject-less fragment mashed onto the greeting. Verbatim, no upgrade
  // — we only ensure the positioning is terminated before the next clause (never render a run-on).
  const pos = positioning ? (/[.!?]$/.test(positioning.trim()) ? positioning.trim() : `${positioning.trim()}.`) : "";
  const opener = pos
    ? p(`${hi} One thing jumped out when I read your background: ${esc(pos)} That's what I'll lead with when I read a role for you.`) + p(`This is how I'll spend my time, and exactly where I'm aiming for you.`)
    : p(`${hi} Here's how I'll spend my time, and exactly where I'm aiming for you.`);

  const content =
    lead("Your game plan") +
    h1(note ? "Here's your updated plan." : "Here's how I'll work for you.") +
    (note ? p(esc(note)) : "") +
    opener +
    (table
      ? `<p style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:6px 0 10px;">Where I'm looking</p>${table}`
      : "") +
    p(`Every morning I read the market against this, and I only email you a role when it genuinely clears your bar, with the honest read on where you fit and where you don't.`) +
    p(`Want me aiming somewhere else? Tell me what to change, any time, and I'll adjust.`);

  // plaintext alternative (same grounded content, no markup)
  const lines = [];
  if (params.roles) lines.push(`Roles: ${params.roles}`);
  if (params.level) lines.push(`Level: ${params.level}`);
  if (params.location) lines.push(`Location: ${params.location}`);
  if (params.pay) lines.push(`Pay floor: ${params.pay}`);
  if (params.avoid) lines.push(`Won't send: ${params.avoid}`);
  const hiText = nm ? `Hi ${nm}.` : "Hi.";
  const openerText = pos
    ? `${hiText} One thing jumped out when I read your background: ${pos} That's what I'll lead with when I read a role for you.\n\nThis is how I'll spend my time, and exactly where I'm aiming for you.`
    : `${hiText} Here's how I'll spend my time, and exactly where I'm aiming for you.`;
  const text =
    `${note ? `${note}\n\n` : ""}${openerText}` +
    (lines.length ? `\n\nWhere I'm looking:\n${lines.join("\n")}` : "") +
    `\n\nEvery morning I read the market against this, and I only email you a role when it genuinely clears your bar, with the honest read on where you fit and where you don't.` +
    `\n\nWant me aiming somewhere else? Tell me what to change, any time, and I'll adjust.\n\nCharlie`;

  return {
    subject: cleanSubject(note ? "Your updated plan" : "Here's how I'll work for you"),
    html: emailShell({
      preheader: note ? "I adjusted where I'm looking. Tell me if it's still not right." : "Here's how I'll work for you, and where I'm aiming.",
      title: note ? "Your updated plan" : "Here's how I'll work for you",
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
    }),
    text,
  };
}

// There is no approval confirmation: the plan never asks for a reply, so a bare "ok" is acknowledged
// SILENTLY and Charlie gets on with the work, which is what the email already promised.
