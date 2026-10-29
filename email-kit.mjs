// email-kit.mjs — the shared shell + lifecycle templates for every email Charlie sends.
//
// One look across the whole lifecycle: a logo header, headings in Sanchez (the same slab
// serif as the site, with a Georgia fallback for clients that don't load web fonts), a
// warm card, a Charlie signature, and a one-click unsubscribe footer on EVERY email.
//
// The daily matched-role email (render-email.mjs) reuses the presentational pieces here
// (FONT_LINK / logoHeaderHtml / signatureHtml / footerHtml) so it stays visually identical.
// The onboarding/confirmation/preference emails are rendered end-to-end by the templates
// below. Email-safe throughout: table layout, inline styles, no CSS vars, tiny payload.

import { signToken, signEvent } from "./charlie-store.mjs";
import { LIFECYCLE } from "./emails/tokens.mjs"; // LOCKED design tokens (emails/tokens.mjs is the single source)
import { greetingName } from "./lib/say-name.mjs";

const SITE = process.env.CHARLIE_SITE_URL || "https://example.com";
const BASE = process.env.PUBLIC_BASE_URL || "https://api.example.com";
// The brand mark is the coral hand (matches the landing masthead). Email clients strip inline
// SVG, so the logo is a hosted PNG referenced by absolute URL.
export const HAND = `${SITE}/charlie-hand.png`;

// Sanchez for headings (matches the site). The <link> is honored by Apple Mail / iOS Mail;
// Gmail and others ignore it and fall back to Georgia, a serif that reads close.
export const FONT_LINK = LIFECYCLE.fontLink;
export const HEAD_FONT = LIFECYCLE.fonts.head;
export const SANS = LIFECYCLE.fonts.sans;

// WHITE CANVAS, WARM INK — Charlie's theme. The reading surface is PURE WHITE (#FFFFFF), like
// Notion's page canvas. The warmth that makes it feel human does NOT go in the paper (cream
// backgrounds read as dated and muddy); it goes in the INK. Notion's body text is a warm near-black
// (#37352F), not a cold #000, and that is where the calm comes from. So: white background, warm-dark
// text, warm grays, and one warm accent (signal coral) that still means "this is the thing that
// matters." NEVER put a cream/off-white/paper tint on a background surface (`body` or `card`); the
// background is always white. Token names are stable for the renderers: `coral` = the accent (signal
// blue), `card`/`body` = the white surfaces, `peach`/`frame`/`soft` = barely-tinted light insets
// (reads as light gray, never cream). Semantic tints (green = positive, amber = the one caution) stay.
export const C = LIFECYCLE.colors;

// THE dash rule, in ONE place. Every gate in this file calls it, so they cannot drift apart (esc()
// and cleanSubject() must strip exactly the same characters, or a dash in model-written copy leaks).
//
// ORDER IS LOad-BEARING. The numeric carve-out runs FIRST. An en dash is the natural range character
// ("2020–2024", "20–30%"), so a bare prose-strip rewrites a person's tenure or metric into a list
// ("2020, 2024") — silently restating a fact about them, which is the one thing this product must never
// do. Same rule, same order as resume-pdf.tsx's deDash(), where it was already proven.
//
// Not exhaustive by design: a non-numeric range ("Series A–B") still becomes a comma. That matches
// resume-pdf.tsx and is the correct trade — prose dashes are the "AI tell" this rule exists to kill.
export function deDash(value) {
  return String(value ?? "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1-$2") // keep number/date ranges readable: 2020-2024, 20-30%
    .replace(/\s*[—–]\s*/g, ", ");           // prose em/en dash -> comma (the "AI tell")
}

export function esc(value) {
  return deDash(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Subject lines are raw email headers, not HTML — they never pass through esc(), so the dash rule has
// to be applied here too. Same rule as the body, now literally the same function. lintMessage's
// /[—–]/ in lib/convo-lint.mjs is the third gate; it only ever rejects, so it needs no carve-out.
export function cleanSubject(value) {
  return deDash(value).trim();
}

// the signed one-click unsubscribe link for a recipient (HMAC token = identity)
export function unsubUrlFor(email) {
  return `${BASE}/unsubscribe?e=${encodeURIComponent(email)}&t=${encodeURIComponent(signToken(email))}`;
}

// a signed one-click feedback / tracked-apply link -> GET /e/<token>. `event` is the ladder
// rung (worth | not | apply_click); `dest` is the real apply URL for apply_click redirects.
export function feedbackUrl(email, findId, event, dest) {
  const payload = { e: String(email || "").toLowerCase(), f: findId || null, v: event };
  if (dest) payload.u = dest;
  return `${BASE}/e/${signEvent(payload)}`;
}

// the centered hand-icon logo that sits above every card
export function logoHeaderHtml() {
  return `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tbody><tr>
    <td align="center" style="padding:0 0 18px;">
      <img src="${HAND}" width="34" height="34" alt="Charlie" style="display:inline-block;">
    </td>
  </tr></tbody></table>`;
}

// the sign-off inside the card
export function signatureHtml() {
  return `<div style="margin:24px 0 0;border-top:1px solid ${C.line};padding:16px 0 0;">
    <img src="${HAND}" width="26" height="26" alt="Charlie" style="display:block;">
    <p style="font-family:${SANS};font-size:12px;color:${C.muted};margin:6px 0 0;">Your personal career agent</p>
  </div>`;
}

// the footer that carries the one-click unsubscribe on every email
export function footerHtml(unsubUrl = "#") {
  return `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tbody><tr>
    <td style="text-align:center;padding:20px 0 0;">
      <a href="${esc(unsubUrl)}" style="font-family:${SANS};font-size:11px;color:${C.faint};text-decoration:underline;">Unsubscribe</a>
    </td>
  </tr></tbody></table>`;
}

// the full document wrapper for the lifecycle (non-role) emails. `tag` is a hidden, Gmail-
// searchable anchor (e.g. "charlieinterviews") that the imported Gmail filter matches on to
// drop the mail into its stage sub-label (Charlie/Applied, /Interviews, /Offers, /Intros).
export { p as para };

export function emailShell({ preheader = "", title = "Charlie", contentHtml = "", unsubUrl = "#", tag = "" }) {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
${FONT_LINK}
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.body};font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${tag ? ` ${tag}` : ""}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.body};"><tbody><tr>
    <td align="center" style="padding:30px 16px 50px;">
      ${logoHeaderHtml()}
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:16px;"><tbody><tr>
        <td style="padding:26px 24px;">
          ${contentHtml}
          ${signatureHtml()}
        </td>
      </tr></tbody></table>
      ${footerHtml(unsubUrl)}
    </td>
  </tr></tbody></table>
</body>
</html>`;
}

// ── content helpers ──────────────────────────────────────────────────────────
function h1(text) {
  return `<h1 style="font-family:${HEAD_FONT};font-weight:400;font-size:23px;line-height:1.25;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;">${esc(text)}</h1>`;
}
// paragraphs accept inline HTML (so callers can bold/link); plain text comes via `text`.
//
// EXPORTED AS `para` BECAUSE HAND-ROLLING ONE IS HOW A TEMPLATE GOES OFF-BRAND: a one-off sender that
// writes its own <p style="font-family:..."> ships a different typeface. The helper is the only
// supported way to write a paragraph in an email, and email-font-tokens.test.mjs fails on a hardcoded
// font stack anywhere a user-facing email is produced.
function p(html) {
  return `<p style="font-family:${SANS};font-size:14.5px;line-height:1.62;color:${C.text};margin:0 0 14px;">${html}</p>`;
}
function bullets(items, dot = C.coral) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 14px;"><tbody>${items
    .map(
      (t) => `<tr>
      <td style="width:16px;vertical-align:top;padding:0 0 9px;"><div style="width:5px;height:5px;border-radius:50%;background:${dot};margin-top:8px;"></div></td>
      <td style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.text};padding:0 0 9px;">${t}</td>
    </tr>`,
    )
    .join("")}</tbody></table>`;
}
const lead = (text, color = C.coral) => `<p style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${color};margin:0 0 10px;">${esc(text)}</p>`;
const lead2 = lead;

// ── lifecycle templates ──────────────────────────────────────────────────────
// Each returns { subject, html, text }. `text` is a clean plaintext alternative.

// First reply when the resume didn't arrive (sequence-friendly: send again on each try).
export function renderMissingResume({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  // COPY: one fact (a resume is not required), the ask, and what happens next. No stack of value props
  // and no "no spam" claim. Warm, plain, spare.
  //
  // THE THREE PATHS. "Send your resume" assumes a current resume exists, and for most people it does
  // not — that is the moment they postpone and never come back. LinkedIn's own Save-to-PDF and
  // Peerlist's Markdown export are things they already have, in one click, so the ask becomes
  // "whichever is quickest" instead of a chore. The instruction is spelled out because "export your
  // LinkedIn" is not a thing most people have done, and a vague ask is a dropped one.
  //
  // NO SCRAPING, deliberately. Reading LinkedIn directly breaks their terms, and the anonymous page is
  // an auth wall carrying a dozen OTHER people's names (see url-ingest.mjs looksGated). A file the
  // person exported themselves is first-party, complete, and unambiguously their own words.
  //
  // Both formats already work: ALLOWED_EXT (server/resume-extract.mjs) covers pdf and md, and the
  // inbound handler takes the resume-named file as primary with the rest riding along as extra
  // sources — so a LinkedIn PDF sent ALONGSIDE a resume enriches it rather than replacing it.
  const content =
    h1("You don't need a resume.") +
    p(`${hi}I'm Charlie. Thanks for writing.`) +
    p(`You don't need a resume to start. Tell me about yourself in your own words instead. A few lines is plenty:`) +
    bullets([
      "What you've worked on",
      "The kind of role you want",
      "Remote, a city, or either",
      "Your pay floor, and anything you won't accept",
    ]) +
    p(`Or send a file instead, whichever is quickest. Any <b style="color:${C.ink};font-weight:600;">one</b> of these works:`) +
    bullets([
      "Your resume, if it's current. PDF or Word.",
      "Your LinkedIn, as a PDF. On your profile, open <b style=\"color:" + C.ink + ";font-weight:600;\">Resources</b>, then <b style=\"color:" + C.ink + ";font-weight:600;\">Save to PDF</b>. Takes about ten seconds.",
      "Your Peerlist profile, exported as Markdown.",
    ]) +
    p(`Then I'll start watching your market, and write to you when a role is genuinely worth your time. I'll be honest about where you fit and where you don't.`);
  return {
    subject: "A few lines about you is enough",
    html: emailShell({ preheader: "You don't need a resume. A few lines in your own words is enough.", title: "You don't need a resume", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `Hi ${name}, ` : "Hi, "}I'm Charlie. Thanks for writing.\n\nYou don't need a resume to start. Tell me about yourself in your own words instead. A few lines is plenty: what you've worked on, the kind of role you want, remote, a city, or either, your pay floor, and anything you won't accept.\n\nOr send a file instead, whichever is quickest. Any ONE of these works: your resume, if it's current (PDF or Word); your LinkedIn as a PDF (on your profile, open Resources, then Save to PDF, about ten seconds); or your Peerlist profile exported as Markdown.\n\nThen I'll start watching your market, and write to you when a role is genuinely worth your time. I'll be honest about where you fit and where you don't.\n\nCharlie`,
  };
}

// The second chance: someone wrote in, was asked for their resume, and never wrote back. A common
// cause is ours — a LINK sent where onboarding can only read an ATTACHED file, so "it didn't come
// through" reads as broken to a person who just sent what they were asked for. This owns that plainly and gives ONE instruction. No pitch and no urgency: they
// already said they wanted in, so the job here is to remove the confusion, not to sell again.
export function renderSecondChance({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    h1("Still happy to take a look.") +
    p(`${hi}you wrote to me a few days ago and I asked for your resume, but it never reached me. That was most likely my fault: the page asked you for a link, and I can only read a file that's attached.`) +
    p(`If you still want in, reply to this email with a resume, LinkedIn PDF, or Peerlist export attached, and add a line or two on what you're after:`) +
    bullets([
      "The kind of role you want",
      "Remote, a city, or either",
    ]) +
    p(`I'll take it from there.`);
  return {
    subject: "Still happy to take a look",
    html: emailShell({ preheader: "Your resume never reached me. Reply with it attached and I'll pick this up.", title: "Still happy to take a look", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `Hi ${name}, ` : "Hi, "}you wrote to me a few days ago and I asked for your resume, but it never reached me. That was most likely my fault: the page asked you for a link, and I can only read a file that's attached.\n\nIf you still want in, reply to this email with a resume, LinkedIn PDF, or Peerlist export attached and tell me the kind of role you want and whether you're after remote, a city, or either.\n\nI'll take it from there.\n\nCharlie`,
  };
}

// The resume-not-needed note: someone wrote in, was told to send a resume, and stopped there. Now a
// written bio genuinely onboards them (server/charlie-remote.ts's bio branch + email-onboard's
// substantiveBio), so the ask that stalled them no longer exists.
//
// NOT renderSecondChance, deliberately. That template's premise is "your resume never reached me,
// the page asked for a link" — a delivery problem that is no longer the story, and its dedupeKey
// "v1" is already burned for at least one of these people. A stale premise in a recovery email
// reads as a form letter, which is the one thing that makes a person write you off for good.
//
// Three jobs, in this order: lead with the FACT that changed, own the friction without
// over-apologising, and give a clean exit. The exit is real — no resume, no reply, no follow-up.
export function renderResumeNotNeeded({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    h1("You don't need a resume.") +
    p(`${hi}you wrote to me a while back and I asked you to send a resume. You don't need one, and I'm sorry that's where it stopped.`) +
    p(`Tell me about yourself in your own words instead. A few lines is plenty:`) +
    bullets([
      "What you've worked on",
      "The kind of role you want",
      "Remote, a city, or either",
      "Your pay floor, and anything you won't accept",
    ]) +
    p(`Or attach a file if you'd rather: your resume, your LinkedIn saved as a PDF, or your Peerlist export. Any of them works now.`) +
    p(`And if you'd rather not, just ignore this. You won't hear from me again.`);
  return {
    subject: "You don't need a resume after all",
    html: emailShell({ preheader: "I asked you for a resume. You don't need one. A few lines in your own words is enough.", title: "You don't need a resume", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `Hi ${name}, ` : "Hi, "}you wrote to me a while back and I asked you to send a resume. You don't need one, and I'm sorry that's where it stopped.\n\nTell me about yourself in your own words instead. A few lines is plenty: what you've worked on, the kind of role you want, remote, a city, or either, your pay floor, and anything you won't accept.\n\nOr attach a file if you'd rather: your resume, your LinkedIn saved as a PDF, or your Peerlist export. Any of them works now.\n\nAnd if you'd rather not, just ignore this. You won't hear from me again.\n\nCharlie`,
  };
}

// A gentle re-opt-in for someone whose address got unsubscribed right as they were engaging (a mail
// scanner following the one-click link can do this before the person means to). They wrote in, so a
// single reply is allowed despite the suppression (lib/suppression-policy.mjs). No pitch, no blame,
// no mechanism: just a check, with silence as the costless "no".
export function renderReoptIn({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    h1("Did that unsubscribe come from you?") +
    p(`${hi}right as you were signing up, your email got marked as unsubscribed. That often happens on its own, before anyone means it to, so I wanted to check with you rather than just go quiet.`) +
    p(`If you still want me looking for roles for you, just reply to this email and I'll pick up right where we left off.`) +
    p(`If you'd rather I stop, you don't need to do anything at all. You won't hear from me again.`);
  return {
    subject: "Did that unsubscribe come from you?",
    html: emailShell({ preheader: "Your email got unsubscribed as you signed up. Reply if you still want me looking.", title: "Did that unsubscribe come from you?", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hi}right as you were signing up, your email got marked as unsubscribed. That often happens on its own, before anyone means it to, so I wanted to check with you rather than just go quiet.\n\nIf you still want me looking for roles for you, just reply to this email and I'll pick up right where we left off.\n\nIf you'd rather I stop, you don't need to do anything at all. You won't hear from me again.\n\nCharlie`,
  };
}

// A candidate whose GROUNDED home is outside Charlie's two markets (India + US). We serve only those
// two, so rather than keep sending roles they can't take, or go quiet, we say so plainly, once. `place`
// is their stated home (grounded, rendered verbatim) when known. The load-bearing honest half is the
// correction path: if we read their location wrong, one reply puts it right (and flips homeRegion back),
// so a false positive is self-recoverable. `name` is guarded — a resume section header can land in the
// name slot (grounding bug), and this is the LAST email that should open "Hi WORK EXPERIENCE".
export function renderOutOfMarket({ email, name = "", place = "" } = {}) {
  const clean = /[a-z]/.test(name) && name.trim().split(/\s+/).length <= 3 ? name.trim() : "";
  const hi = clean ? `Hi ${esc(clean)}, ` : "Hi, ";
  const whereHtml = place ? ` It looks like you're in ${esc(place)}, ` : " It looks like you're outside both, ";
  const whereTxt = place ? ` It looks like you're in ${place}, ` : " It looks like you're outside both, ";
  const content =
    h1("A straight answer on where I can help.") +
    p(`${hi}thanks for trying me out. I want to be upfront: right now I only cover jobs in India and the US.${whereHtml}and I'd rather tell you that than keep sending you roles you can't actually take.`) +
    p(`So I'm going to hold off, instead of filling your inbox with the wrong thing. It isn't about you, it's the edge of where I can look today.`) +
    p(`If I've got your location wrong, just reply and tell me where you're based, and I'll pick right back up. And if I reach your market later, I'll come find you.`);
  return {
    subject: "A straight answer on where I can help",
    html: emailShell({ preheader: "I only cover India and the US right now. Rather than send you roles you can't take, here's the honest version.", title: "A straight answer on where I can help", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hi}thanks for trying me out. I want to be upfront: right now I only cover jobs in India and the US.${whereTxt}and I'd rather tell you that than keep sending you roles you can't actually take.\n\nSo I'm going to hold off, instead of filling your inbox with the wrong thing. It isn't about you, it's the edge of where I can look today.\n\nIf I've got your location wrong, just reply and tell me where you're based, and I'll pick right back up. And if I reach your market later, I'll come find you.\n\nCharlie`,
  };
}

// Onboarding hit a snag (a model/infra hiccup, or a resume that needs longer to ground) for a NEW
// person who DID send a resume. Never blame their file for our outage: reassure them it arrived,
// tell them honestly it will take a moment, and promise to come back. A retry is queued behind this
// (server task onboard_retry); only after it keeps failing do we ask them to resend (renderMissingResume).
export function renderBuildDelayed({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    h1("Got it. Give me a few minutes.") +
    p(`${hi}your resume came through fine. I need a little longer than usual to read it properly, so I'm on it now and I'll come back to you shortly with what I found.`) +
    p(`Nothing you need to do. If I hit a real wall, I'll tell you plainly.`);
  return {
    subject: "Got it, give me a few minutes",
    html: emailShell({ preheader: "Your resume came through. I need a moment to read it, then I'll be back.", title: "Got it, give me a few minutes", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hi}your resume came through fine. I need a little longer than usual to read it properly, so I'm on it now and I'll come back to you shortly with what I found.\n\nNothing you need to do. If I hit a real wall, I'll tell you plainly.\n\nCharlie`,
  };
}

// The wedge drip (variant A — pure typography). Names the rare, GROUNDED combination in a person's
// background as their edge and reframes their search around it. `combo` is the dossier's verified
// `edge.combo` (fail-closed upstream: only a high-confidence, grounded edge ever reaches here) and is
// code-rendered VERBATIM as the quiet pull-quote — the model never touches it. `copy` is the warm
// connective prose (prompts/wedge.mjs); when it is null every line falls back to a grounded default,
// so the email is honest and sendable even with no model call. The honest half ("some rooms won't see
// it, I won't send you those") is what makes this Charlie and not a horoscope; it always ships.
export function renderWedge({ email, combo = "", copy = null } = {}) {
  const c = copy || {};
  const subject = cleanSubject(c.subject || "I think I found your edge");
  const opening = c.opening || "I went back through everything you've told me, and one thing keeps standing out.";
  const edge_line = c.edge_line || "That combination is rarer than you'd guess, and it's the most valuable thing you bring.";
  const advantage_line = c.advantage_line || "It's an edge in the rooms built for it, the ones where that exact mix is the whole point, not a footnote.";
  const honest_line = c.honest_line || "Some rooms won't see why it matters, and that's alright. I won't send you those.";
  const close_line = c.close_line || "So from here on, I'm looking for the roles where your combination is the point. That's the job.";
  const content =
    p(esc(opening)) +
    // variant A: the grounded combination, set large and quiet. The words are the design.
    `<div style="text-align:center;margin:22px 0 18px;"><p style="font-family:${HEAD_FONT};font-weight:400;font-size:22px;line-height:1.4;color:${C.ink};margin:0;">${esc(combo)}</p></div>` +
    p(esc(edge_line)) +
    p(esc(advantage_line)) +
    p(esc(honest_line)) +
    p(esc(close_line));
  return {
    subject,
    html: emailShell({ preheader: "I went back through everything you told me. One thing stands out.", title: subject, contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${deDash(opening)}\n\n${deDash(combo)}\n\n${deDash(edge_line)}\n\n${deDash(advantage_line)}\n\n${deDash(honest_line)}\n\n${deDash(close_line)}\n\nCharlie`,
  };
}

// The confirmation: dossier built, what to expect, first role on its way.
// The welcome IS the first turn of a conversation: names what Charlie actually read (grounded), sets
// expectations, then ends with ONE small ask (the highest-leverage missing thing, passed as `ask`) and
// One question, never a form.
// `thin` is LOAD-BEARING. isThinDossier (email-onboard.mjs) says we do NOT have enough to match
// sharply; without it a skeletal profile would get the confident welcome below ("I know what to look
// for"), an overclaim about a person we have not read enough of, in the first email.
// Fenced by the thin/rich divergence tests in emails/welcome-thin.test.mjs.
export function renderWelcome({ email, name = "", thin = false, ask = "", strength = "" } = {}) {
  const nm = name ? ` ${esc(name)}` : "";
  const read = thin
    ? p(`I've read what you sent. Honestly, it's a start, but it's thinner than I'd like, and I'd rather say that than pretend I've got the full picture of you.`)
    : strength
      ? p(`I've read your background. Honestly, "${esc(strength)}" is exactly the kind of thing that earns a second read, and it's what I'll lead with. I know what to look for.`)
      : p(`I've read your background, and I know what to look for.`);
  const question = ask
    ? p(`One quick thing before I go deep: <b style="color:${C.ink};font-weight:600;">${esc(ask)}</b> Just reply, that's the whole reply.`)
    : p(`That's it. You can get on with your day, I'll take it from here.`);
  // THE TIMING PROMISE HAS TO MATCH THE ENGINE. There is one run for everybody and it happens on
  // Monday (scheduler.mjs, and the cron-chain "no Railway service starts itself" tests), so the welcome
  // never promises "within minutes". An unbacked promise in the very first email is the worst place
  // for one.
  //
  // Never promise a time on a thin profile at all: with little to go on, little will clear the bar,
  // and a promise we quietly fail for weeks is worse than an honest wait.
  const next = thin
    ? p(`Here's what happens now: I read the market every Monday. With this much to go on I'd be guessing, and I'd rather be right than quick. Tell me a bit more and I'll aim properly. The more I have, the sharper what I send you.`)
    : p(`Here's what happens now: every Monday I read every live posting across more than 1,000 companies. If something clears your bar, that's when you'll hear from me. If nothing does, I stay quiet, and that's the point.`);
  const content =
    lead("you're in") +
    h1(`You're all set${nm}.`) +
    read +
    next +
    `<div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:6px 0 10px;">every email gives you</div>` +
    bullets([
      "One role at a time, never a list to dig through",
      "Why it fits you, gaps and all",
      "How to position yourself for it, in your own words",
    ]) +
    question +
    p(`This stays a conversation. Change what you're after any time, just reply. And if you've got more that shows your work, a deck, a case study, a writeup, send it over and I'll fold it into what I look for.`);
  const readTxt = thin
    ? `I've read what you sent. Honestly, it's a start, but it's thinner than I'd like, and I'd rather say that than pretend I've got the full picture of you.`
    : `I've read your background${strength ? `, and "${deDash(strength)}" is exactly the kind of thing I'll lead with` : ""}, and I know what to look for.`;
  const nextTxt = thin
    ? `I read the market every Monday. With this much to go on I'd be guessing, and I'd rather be right than quick. Tell me a bit more and I'll aim properly.`
    : `Every Monday I read every live posting across more than 1,000 companies. If something clears your bar, that's when you'll hear from me. If nothing does, I stay quiet, and that's the point.`;
  return {
    subject: thin ? "You're in, and one thing would help" : "You're all set, I'm on it",
    html: emailShell({
      preheader: thin
        ? "You're in. I've got less to go on than I'd like, so tell me a bit more and I'll aim properly."
        : "Every Monday I read the whole market. If something clears your bar, that's when you'll hear from me.",
      title: "You're all set", contentHtml: content, unsubUrl: unsubUrlFor(email),
    }),
    text: `You're all set${name ? `, ${name}` : ""}. ${readTxt}\n\n${nextTxt}\n\nEvery email gives you one role at a time, why it fits, gaps and all, and how to position yourself for it.\n\n${ask ? `One quick thing before I go deep: ${deDash(ask)} Just reply, that's the whole reply.` : "That's it, I'll take it from here."}\n\nThis stays a conversation. Change what you're after any time, just reply. And if you've got more that shows your work, a deck, a case study, a writeup, send it over and I'll fold it into what I look for.\n\nCharlie`,
  };
}

// A reply landed and Charlie advances the conversation: acknowledge what changed (echoing their own
// words), open strengths-first (grounded), then ask the ONE next thing — or, if nothing's left to ask,
// just confirm and go quiet. This is what makes the inbox feel like a chat, one turn at a time.
export function renderConvoReply({ email, name = "", changedText = "", strength = "", ask = "" } = {}) {
  const ackLine = changedText
    ? p(`Got it. I've updated <b style="color:${C.ink};font-weight:600;">${esc(changedText)}</b>, and I'll factor it into the roles I send you.`)
    : p(`Got it, noted, and I'll factor it in.`);
  const advance = ask
    ? (strength ? p(`${esc(strength)} is doing a lot of work in there, by the way.`) : "") +
      p(`One thing that'd sharpen every match I send: <b style="color:${C.ink};font-weight:600;">${esc(ask)}</b> Just reply, that's the whole reply.`)
    : p(`You're all set. Reply any time to tweak anything.`);
  return {
    subject: changedText ? "Done, that's updated" : "Got it",
    html: emailShell({ preheader: ask ? "Updated, and one quick thing that would sharpen your matches." : "Updated, I'll factor it in.", title: "Got it", contentHtml: h1(changedText ? "Done, that's updated." : "Got it.") + ackLine + advance, unsubUrl: unsubUrlFor(email) }),
    text: `${changedText ? `Got it. I've updated ${deDash(changedText)}, and I'll factor it into the roles I send you.` : "Got it, noted, and I'll factor it in."}\n\n${ask ? `${strength ? `${deDash(strength)} is doing a lot of work in there, by the way.\n\n` : ""}One thing that'd sharpen every match I send: ${deDash(ask)} Just reply, that's the whole reply.` : "You're all set. Reply any time to tweak anything."}\n\nCharlie`,
  };
}

// ONE turn of the interrogation onboarding (v2 cohort). Asks exactly ONE grounded question — the
// convo lint enforces a single genuine "?", and the voice contract is "one question at a time, never a
// form" — opening from a real fact so it reads as "I saw your work." `first` frames it as the welcome;
// otherwise it acknowledges what just changed. Always carries a costless exit ("no rush"), never an em
// dash. The question is normalized to exactly one trailing "?" so the whole message clears the lint by
// construction. Only ever sent when there IS a question to ask; completion goes straight to the role email.
export function renderInterroTurn({ email, name = "", first = false, changedText = "", strength = "", question = "" } = {}) {
  const nm = name ? ` ${esc(name)}` : "";
  const qClean = deDash(String(question || "").replace(/\?/g, "")).trim(); // the plaintext half needs the dash rule too (the HTML half gets it via esc)
  const ask = qClean ? `${qClean}?` : "";
  const openHtml = first
    ? lead("you're in") + h1(`You're all set${nm}.`) +
      (strength
        ? p(`I've read your background. "${esc(strength)}" is exactly the kind of thing I'll lead with, and it tells me a lot about where you're headed.`)
        : p(`I've read your background, and I've got a good sense of your work.`))
    : h1(changedText ? "Got it, that's in." : "Got it.") +
      (changedText
        ? p(`I've noted <b style="color:${C.ink};font-weight:600;">${esc(changedText)}</b>, and I'll factor it in.`)
        : p(`Noted, and I'll factor it in.`)) +
      (strength ? p(`${esc(strength)} is doing a lot of work in there.`) : "");
  const askHtml = p(`<b style="color:${C.ink};font-weight:600;">${esc(ask)}</b>`) +
    p(`<span style="color:${C.muted};">No rush, just reply whenever you have a minute and we'll keep going.</span>`);
  const subject = first ? "You're all set, I'm on it" : changedText ? "Got it, that's in" : "Got it";
  const openText = first
    ? `You're all set${name ? `, ${name}` : ""}. I've read your background${strength ? `, and "${deDash(strength)}" is exactly the kind of thing I'll lead with` : ""}.`
    : `${changedText ? `Got it. I've noted ${deDash(changedText)}, and I'll factor it in.` : "Got it, noted, and I'll factor it in."}${strength ? `\n\n${deDash(strength)} is doing a lot of work in there.` : ""}`;
  return {
    subject,
    html: emailShell({ preheader: first ? "One quick thing and I'll go deep." : "One quick thing to sharpen your matches.", title: first ? "You're all set" : "Got it", contentHtml: openHtml + askHtml, unsubUrl: unsubUrlFor(email) }),
    text: `${openText}\n\n${ask}\n\nNo rush, just reply whenever you have a minute and we'll keep going.\n\nCharlie`,
  };
}

// A preference change landed: confirm what changed.
export function renderPrefsUpdated({ email, changedText = "" } = {}) {
  const did = changedText
    ? `Got it. I've updated <b style="color:${C.ink};font-weight:600;">${esc(changedText)}</b>, and I'll factor it into the roles I send you.`
    : `Got it, I've noted that and I'll factor it into the roles I send you.`;
  const content =
    h1("Done, that's updated.") +
    p(did) +
    p(`Want to tweak anything else, the kind of role, pay, or where you want to work? Just reply.`);
  return {
    subject: "Done, that's updated",
    html: emailShell({ preheader: "Your preferences are updated.", title: "Done, that's updated", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    // changedText is MODEL-written (applyEmailChange), and the plaintext half never passes through
    // esc(), so it is de-dashed here like every other text path. (The HTML half above is covered by esc().)
    text: `${changedText ? `Got it. I've updated ${deDash(changedText)}, and I'll factor it into the roles I send you.` : "Got it, I've noted that and I'll factor it into the roles I send you."}\n\nWant to tweak anything else, the kind of role, pay, or where you want to work? Just reply.\n\nCharlie`,
  };
}

// NOT THE RIGHT ADDRESS — the reply to a stranger's email that is not a job search at all.
//
// `groundsNothing` (email-onboard.mjs) refuses to build a candidate row from, say, a sales pitch. The
// reply must match that diagnosis: asking a salesperson for their resume and what kind of role they
// want would be Charlie diagnosing it right and then saying something silly.
//
// Deliberately does NOT ask for a resume. That is the whole point: the reason we are here is that the
// person is not job hunting. The one open line at the end exists for the FALSE POSITIVE — a real person
// whose email was misread — so they have a way back in without being handed a form.
export function renderNotJobSearch({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, thanks` : "Thanks";
  const content =
    h1("Not the right address, I think.") +
    p(`${hi} for writing. I do one thing: I read what someone has actually done, and email them a job worth their time. That is the whole product, so I do not think I am useful to you here.`) +
    p(`If I have read this wrong and you are looking for work yourself, just reply and tell me what you do. No forms.`);
  return {
    subject: "Not the right address",
    html: emailShell({ preheader: "I only do job matching.", title: "Not the right address", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, thanks` : "Thanks"} for writing. I do one thing: I read what someone has actually done, and email them a job worth their time. That is the whole product, so I do not think I am useful to you here.\n\nIf I have read this wrong and you are looking for work yourself, just reply and tell me what you do. No forms.\n\nCharlie`,
  };
}

// A CORRECTION, when Charlie stated something about a role that the posting never said.
//
// Never automatic and never model-written: a wrong or spammy correction is worse than the original
// miss (see send-audit.mjs). So this takes the sentence to correct as an argument, a human writes it,
// and a human approves the send.
//
// Typical case: a role email stated a fact the posting never said (e.g. "onsite" when the posting is
// silent on remote). citeOrDrop covers claims about the PERSON, not about the JOB, so this is the
// remedy when such a word slips through.
//
// The shape is deliberate: own the error first, keep the role if the role was right, then say what is
// actually unknown rather than replacing one guess with another.
// A correction for the OTHER kind of miss: not a wrong word about a role, but a wrong reading of the
// person. renderRoleCorrection cannot carry this ("earlier today I sent you X and called it Y" is
// shaped for a role that exists), and this reader may never have been sent a role at all.
//
// Every field here is hand-written and hand-approved for one person, exactly like renderRoleCorrection:
// a correction is never model-generated, because a wrong apology is worse than the original miss.
export function renderMarketReadCorrection({ email, name = "", wrongClaim = "", truth = "", cause = "", whatIDid = "", stands = "" } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const content =
    h1("I got your market wrong.") +
    p(`${hi}${esc(wrongClaim)} <b style="color:${C.ink};font-weight:600;">${esc(truth)}</b>`) +
    (cause ? p(esc(cause)) : "") +
    (whatIDid ? p(esc(whatIDid)) : "") +
    (stands ? p(esc(stands)) : "");
  return {
    subject: "I got your market wrong",
    html: emailShell({ preheader: "A correction on the read I sent you today.", title: "I got your market wrong", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    // deDash every interpolation: the plaintext half never passes through esc().
    text: `${name ? `${deDash(name)}, ` : ""}${deDash(wrongClaim)} ${deDash(truth)}\n\n${cause ? `${deDash(cause)}\n\n` : ""}${whatIDid ? `${deDash(whatIDid)}\n\n` : ""}${stands ? `${deDash(stands)}\n\n` : ""}Charlie`,
  };
}

// The depth question (depth-question.mjs). A real read on their market, then ONE thing to answer.
//
// THE ORDER IS THE PRODUCT. Give first: the opening line is a fact about their own market that Charlie
// worked out from roles it actually scored for them, and it is worth reading on its own. The question
// only earns its place because that came first. Every "complete your profile" email inverts this and
// that is exactly why they get ignored.
//
// IT NEVER SAYS THEY LACK THE THING. The gate's readout marks a requirement "unknown", which means the
// posting asked and their record was silent. We genuinely do not know. So the line is "your record
// doesn't say either way", never "you're missing this" — the difference between a question and a
// verdict. Telling somebody their own field is a gap is the worst error this product can make.
//
// BOTH ANSWERS PAY THEM. Yes means more roles counted in; no means fewer wasted. That is what makes it
// honest to ask rather than extractive: there is no answer that only helps us.
//
// Every number is code-rendered from the stored coverage. No model writes any part of this.
// "pause" / "restart" — a temporary control, so `unsubscribe` is not the only lever (a permanent exit
// for a temporary feeling).
//
// THE COMING-BACK LINE IS THE POINT OF THE EMAIL. A pause confirmation that does not say how to
// return is just a quieter unsubscribe. It is stated plainly, in the same sentence, every time.
// ── THE REPRESENT LIST ────────────────────────────────────────────────────────────────────────────
//
// The subject Charlie sends AND the pattern the inbound handler listens for. One constant, so they
// cannot drift and route a reply into the preference writer (the trap the Pro block already documents).
export const REPRESENT_SUBJECT = "Can I represent you?";

/** The exact subject the per-company introduction asks for. One definition, not two that agree today. */
export const PUTFORWARD_SUBJECT = "Put me forward";

/**
 * "A company is hiring for this, and I think it is you." The introduction offer, one person, one role.
 *
 * THIS IS NOT THE REPRESENT LETTER. That one asked, in general, whether Charlie may represent someone
 * — 54 asked, 11 said yes, and expecting the other 43 to have noticed an email is not a consent model.
 * This one is gated on FIT instead: it only reaches a person whose grounded coverage against THIS role
 * cleared the floor, so the mismatch that makes a blast feel like a blast cannot happen. Their reply
 * IS the consent, and it is consent for one named company rather than a blanket yes.
 *
 * FOUR PARTS, IN THIS ORDER, and the order is the whole design:
 *   1. the role, named plainly
 *   2. why THEM, in their own evidence — this is what makes it representation and not a forward
 *   3. the ONE thing we cannot answer for them, phrased as an invitation, which is also how the
 *      missing fact gets collected without a form
 *   4. the ask, which is a single yes
 *
 * `company` may be omitted before the employer has agreed. Naming a company that then goes quiet
 * manufactures a disappointment we cannot undo, so until they say yes it is "a company I have been
 * talking to". Charlie's position is that he does not waste anyone's hope.
 *
 * NEVER PROMISES AN OUTCOME. It is an introduction, not a job, and it says so — an intro that is
 * oversold is worse than none, because the let-down lands on the one product they trusted.
 */
export function renderPutForward({ email, name = "", role = "", company = "", why = [], gap = "" } = {}) {
  // FIRST NAME ONLY, and a real greeting. A dossier `name` is the full extracted name ("Priya S"), and
  // opening a letter with someone's surname initial reads like a mail merge, which is the one thing
  // this email cannot afford: its whole claim is that a person looked at them.
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  const hi = first ? `Dear ${esc(first)},` : "";
  const where = company ? `at <b style="color:${C.ink};font-weight:600;">${esc(company)}</b>` : "at a company I have been talking to";
  const mailto = `mailto:start@mail.example.com?subject=${encodeURIComponent(PUTFORWARD_SUBJECT)}&body=${encodeURIComponent("Yes, put me forward.\n\n")}`;
  const reasons = (Array.isArray(why) ? why : []).map((w) => String(w || "").trim()).filter(Boolean).slice(0, 3);
  const content =
    h1(role ? `${esc(role)}` : "Someone is hiring") +
    (hi ? p(hi) : "") +
    p(`There is an opening ${where}, and I think it is you.`) +
    (reasons.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tbody>${reasons.map((w) => `<tr><td width="16" style="vertical-align:top;padding:0 0 8px;"><div style="width:5px;height:5px;border-radius:50%;background:${C.coral};margin-top:9px;font-size:1px;line-height:1px;">&nbsp;</div></td><td style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.text};padding:0 0 8px;">${esc(w)}</td></tr>`).join("")}</tbody></table>` : "") +
    (gap ? p(`One thing I cannot answer for them: <b style="color:${C.ink};font-weight:600;">${esc(gap)}</b> If that is something you have done, tell me and I will put it in.`) : "") +
    p(`If you say yes I will write you up properly, in your own words, and put your name in front of the founders. Not a form and not a pile.`) +
    // The four things a founder asks before a first conversation. Asked ONCE, here, so the yes and the
    // facts arrive together — a second email to collect them would lose half the people who said yes.
    // Deliberately NOT a form: they reply in one message, in whatever order they like.
    p(`Reply with four things and I will take it from there:`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;"><tbody>${[
      "Your notice period",
      "What you are expecting on pay",
      "Which city you are in",
      "Anything you want the founders to know, in your own words",
    ].map((t) => `<tr><td width="16" style="vertical-align:top;padding:0 0 8px;"><div style="width:5px;height:5px;border-radius:50%;background:${C.coral};margin-top:9px;font-size:1px;line-height:1px;">&nbsp;</div></td><td style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.text};padding:0 0 8px;">${esc(t)}</td></tr>`).join("")}</tbody></table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 14px;"><tbody><tr><td style="background:${C.green};border-radius:6px;">
      <a href="${mailto}" style="display:block;padding:11px 26px;font-family:${SANS};font-size:14.5px;font-weight:500;color:#FFFFFF;text-decoration:none;text-align:center;">Put me forward</a>
    </td></tr></tbody></table>` +
    // Muted closing line, written with this file's own helpers: `pmut` belongs to render-campaign.mjs,
    // not here, and borrowing it was a straight ReferenceError at render time.
    `<p style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.muted};margin:0;">I cannot promise they will reply. I can promise a real person will read your name.</p>`;
  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(role ? `${role}, and I think it is you` : "I think this one is you"),
    html: emailShell({ preheader: "An introduction, if you want it.", title: role || "An opening", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${first ? `Dear ${t(first)},\n\n` : ""}There is an opening ${company ? `at ${t(company)}` : "at a company I have been talking to"}, and I think it is you.\n\n${role ? `${t(role)}\n\n` : ""}${reasons.map((w) => `- ${t(w)}`).join("\n")}${reasons.length ? "\n\n" : ""}${gap ? `One thing I cannot answer for them: ${t(gap)} If that is something you have done, tell me and I will put it in.\n\n` : ""}If you say yes I will write you up properly, in your own words, and put your name in front of the founders. Not a form and not a pile.\n\nReply with four things and I will take it from there:\n\n- Your notice period\n- What you are expecting on pay\n- Which city you are in\n- Anything you want the founders to know, in your own words\n\nI cannot promise they will reply. I can promise a real person will read your name.\n\nCharlie`,
  };
}

// THE HONESTY LINE IN THIS EMAIL IS "I am starting", NOT "Charlie has partnered".
// As of writing, no headhunter has replied yet. Announcing a partnership that does not exist would be
// a claim about ourselves of exactly the kind Charlie refuses to make about a person — and if it
// slipped, every later email would be worth less. "I am starting something small" is true today, and
// asking permission converts better than announcing a benefit because it makes the reader the scarce
// thing rather than us.
//
// No application statistic. We do not have a number for how many people apply per job, and the
// observation lands without one. An invented statistic about a person's market is exactly the kind
// of claim this product must never make.
export function renderRepresent({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const mailto = `mailto:start@mail.example.com?subject=${encodeURIComponent(REPRESENT_SUBJECT)}&body=${encodeURIComponent("Represent me.")}`;
  const content =
    h1("Can I represent you?") +
    p(`${hi}you know how this works now. A job goes up, hundreds apply, and something automated decides in seconds whether you are worth a human's attention. Good people get cut for the wrong reasons, so they apply to more places, and the pile gets bigger. Nobody in that loop is reading anyone's story.`) +
    p(`I read yours. That is the entire reason I exist.`) +
    p(`Late August I am starting something small, and I am calling it <b style="color:${C.ink};font-weight:600;">Represent</b>. A handful of people put directly in front of headhunters and startups who are hiring. Not a job board, not an application. A short list, with your story attached, written by someone who actually knows it.`) +
    p(`<b style="color:${C.ink};font-weight:600;">I want you on it.</b>`) +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 14px;"><tbody><tr><td style="background:${C.ink};border-radius:6px;">
      <a href="${mailto}" style="display:block;padding:11px 26px;font-family:${SANS};font-size:14.5px;font-weight:500;color:#FFFFFF;text-decoration:none;text-align:center;">Represent me</a>
    </td></tr></tbody></table>` +
    p(`Tap that and I will tell you the two or three things I still do not know about you. They are the things anyone hiring asks first, and right now I cannot answer them for you.`);
  return {
    subject: cleanSubject(REPRESENT_SUBJECT),
    html: emailShell({ preheader: "A short list, with your story attached.", title: "Can I represent you?", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, ` : ""}you know how this works now. A job goes up, hundreds apply, and something automated decides in seconds whether you are worth a human's attention. Good people get cut for the wrong reasons, so they apply to more places, and the pile gets bigger. Nobody in that loop is reading anyone's story.\n\nI read yours. That is the entire reason I exist.\n\nLate August I am starting something small, and I am calling it Represent. A handful of people put directly in front of headhunters and startups who are hiring. Not a job board, not an application. A short list, with your story attached, written by someone who actually knows it.\n\nI want you on it. Reply "represent me" and I will tell you the two or three things I still do not know about you. They are the things anyone hiring asks first, and right now I cannot answer them for you.\n\nCharlie`,
  };
}

// The answer to "I'm interested": the specific things missing from THEIR record, not a form.
//
// Asks for at most THREE. A list of eight reads as homework and gets nothing; three reads as a
// conversation. They are ordered by what a headhunter actually asks first, which is also the honest
// reason to want them.
export function renderRepresentAsk({ email, name = "", missing = [] } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const items = (missing || []).slice(0, 3);
  const list = items.length
    ? bullets(items.map((m) => `<b style="color:${C.ink};font-weight:600;">${esc(m.label)}</b> ${esc(m.prompt)}`))
    : "";
  const content =
    h1("You're on the Represent list.") +
    p(`${hi}good. Here is what I still cannot answer for you, and every one of them comes up in the first conversation:`) +
    list +
    p(`Reply in a line or two. No form, no fields, just tell me and I will write it down properly.`) +
    p(`I will come back to you when the first introductions are real. If nothing comes of it, I will tell you that too.`);
  return {
    subject: cleanSubject("You're on the Represent list"),
    html: emailShell({ preheader: "Two or three things I still cannot answer for you.", title: "You're on the Represent list", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, ` : ""}good. Here is what I still cannot answer for you, and every one of them comes up in the first conversation:\n\n${items.map((m) => `- ${deDash(m.label)}: ${deDash(m.prompt)}`).join("\n")}\n\nReply in a line or two. No form, no fields, just tell me and I will write it down properly.\n\nI will come back to you when the first introductions are real. If nothing comes of it, I will tell you that too.\n\nCharlie`,
  };
}

export function renderPaused({ email, name = "", days = null } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const until = days ? `for the next ${days === 1 ? "day" : `${days} days`}` : "until you tell me otherwise";
  const back = days
    ? `I will pick it up again on my own after that. If you want it sooner, reply "restart".`
    : `Reply "restart" whenever you want it back, in a week or in six months. Nothing is lost.`;
  const content =
    h1("Paused.") +
    p(`${hi}I have stopped sending you roles ${esc(until)}.`) +
    p(esc(back)) +
    p(`Everything you have told me stays exactly as it is. I am not deleting your profile and I am not going to nag you.`);
  return {
    subject: cleanSubject("Paused"),
    html: emailShell({ preheader: "No more roles until you say so.", title: "Paused", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, ` : ""}I have stopped sending you roles ${deDash(until)}.\n\n${deDash(back)}\n\nEverything you have told me stays exactly as it is. I am not deleting your profile and I am not going to nag you.\n\nCharlie`,
  };
}

// The other half. Says what changed while they were away, because "you're back" on its own is a
// notification rather than a reason to stay.
export function renderResumed({ email, name = "", poolSize = null } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const scale = Number.isFinite(Number(poolSize)) && poolSize > 0
    ? ` I have ${Number(poolSize).toLocaleString("en-US")} live roles on the board right now.`
    : "";
  const content =
    h1("Back on.") +
    p(`${hi}I am looking again.${esc(scale)}`) +
    p(`Same bar as before: one role, only when it clears it. If what you want has changed, just tell me in a line and I will work to that instead.`);
  return {
    subject: cleanSubject("Back on"),
    html: emailShell({ preheader: "I am looking again.", title: "Back on", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, ` : ""}I am looking again.${deDash(scale)}\n\nSame bar as before: one role, only when it clears it. If what you want has changed, just tell me in a line and I will work to that instead.\n\nCharlie`,
  };
}

export function renderDepthQuestion({ email, name = "", gap = "", count = 0, total = 0 } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const g = esc(gap);
  const roles = total === 1 ? "role" : "roles";
  const asked = count === 1 ? "one asked" : `${count} asked`;
  const content =
    h1("About your last few roles.") +
    p(`${hi}I have been reading the roles that came closest for you lately. Of the ${total} ${roles}, ${asked} for <b style="color:${C.ink};font-weight:600;">${g}</b>.`) +
    p(`Your record doesn't say either way, so I have been treating it as a no. That may be costing you roles you would actually want.`) +
    p(`<b style="color:${C.ink};font-weight:600;">Have you done ${g}?</b>`) +
    p(`One line is plenty. If yes, I start counting those roles in. If no, I stop showing you the ones that hinge on it.`);
  return {
    subject: cleanSubject("About your last few roles"),
    html: emailShell({ preheader: `${count} of your ${total} closest roles asked for ${gap}.`, title: "About your last few roles", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, ` : ""}I have been reading the roles that came closest for you lately. Of the ${total} ${roles}, ${asked} for ${deDash(gap)}.\n\nYour record doesn't say either way, so I have been treating it as a no. That may be costing you roles you would actually want.\n\nHave you done ${deDash(gap)}?\n\nOne line is plenty. If yes, I start counting those roles in. If no, I stop showing you the ones that hinge on it.\n\nCharlie`,
  };
}

export function renderRoleCorrection({ email, name = "", wrongLine = "", roleLine = "", truth = "", standBy = "", honest = "" } = {}) {
  const hi = name ? `${esc(name)}, ` : "";
  const content =
    h1("I got that one wrong.") +
    p(`${hi}earlier today I sent you ${esc(roleLine)} and called it <b style="color:${C.ink};font-weight:600;">${esc(wrongLine)}</b>. ${esc(truth)}`) +
    (standBy ? p(esc(standBy)) : "") +
    (honest ? p(esc(honest)) : "") +
    p(`Either way, reply and tell me which, and I'll work to that.`);
  return {
    subject: "I got that one wrong",
    html: emailShell({ preheader: "A correction on the role I sent you.", title: "I got that one wrong", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    // deDash on every text-half interpolation: the plaintext alternative never passes through esc().
    text: `${name ? `${deDash(name)}, ` : ""}earlier today I sent you ${deDash(roleLine)} and called it ${deDash(wrongLine)}. ${deDash(truth)}\n\n${standBy ? `${deDash(standBy)}\n\n` : ""}${honest ? `${deDash(honest)}\n\n` : ""}Either way, reply and tell me which, and I'll work to that.\n\nCharlie`,
  };
}

// The State of Hiring report announcement, a value-add note to active users. Charts are
// bulletproof HTML (table cells with background + width), so they render in Gmail/Outlook/Apple.
export function renderHiringReport({ email, name = "", rolePhrase = "", chartLabel = "", bars = null, reality = "", regionHook = "" } = {}) {
  // De-dash at the door — FIRST, before any of these are read into `heading`/`intro`/`barsText` below.
  // Every copy field here reaches the reader twice: the HTML half esc()s it, but the plaintext half
  // (see `text:`) interpolates it RAW, so esc() alone leaves the text half unguarded. rolePhrase and
  // regionHook skip esc() in BOTH halves (regionHook carries the deliberate rust-bold markup; escaping
  // it would print the tags) — so de-dash, which covers both halves and does not escape, is the gate
  // that fits. These fields are hardcoded in announce-hiring.mjs today, making this latent rather than
  // live — but a dash gate that only holds while the caller stays hardcoded is not a gate.
  rolePhrase = deDash(rolePhrase);
  regionHook = deDash(regionHook);
  chartLabel = deDash(chartLabel);
  reality = deDash(reality);

  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const url = `${SITE}/hiring`;
  // report palette: single rust accent, everything else grayscale, square corners
  const RUST = LIFECYCLE.chart.rust, GREY = LIFECYCLE.chart.grey, INK = LIFECYCLE.chart.ink, TRACK = LIFECYCLE.chart.track;

  const bar = (label, pct, val, color) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 9px;"><tbody><tr>
    <td width="132" style="font-family:${SANS};font-size:13px;color:${INK};text-align:right;padding-right:12px;">${esc(label)}</td>
    <td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${TRACK};"><tbody><tr>
        <td width="${pct}%" style="background:${color};height:12px;font-size:1px;line-height:12px;">&nbsp;</td>
        <td style="font-size:1px;line-height:12px;">&nbsp;</td>
      </tr></tbody></table>
    </td>
    <td width="42" align="right" style="font-family:${SANS};font-size:12px;color:${C.muted};padding-left:10px;">${esc(val)}</td>
  </tr></tbody></table>`;
  const defaultBars = [["Python", 100, "16.8%", GREY], ["LLM / GenAI", 81, "13.6%", RUST], ["AWS", 70, "11.8%", GREY], ["SQL", 66, "11.1%", GREY], ["Salesforce", 61, "10.2%", GREY]];
  const useBars = bars && bars.length ? bars : defaultBars;
  const chartBars = useBars.map(([l, p, v, c]) => bar(l, p, v, c || GREY)).join("");
  const heading = chartLabel || "What the market as a whole now runs on:";

  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 4px;"><tbody><tr>
    <td style="background:${INK};border-radius:8px;">
      <a href="${esc(url)}" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.white};text-decoration:none;padding:12px 22px;">Read the State of Hiring &rarr;</a>
    </td>
  </tr></tbody></table>`;

  const intro = rolePhrase
    ? `${hi}you came to Charlie ${rolePhrase}. This week I read every live posting across more than 1,000 companies, 11,530 jobs, to map what your market actually looks like right now.`
    : `${hi}you came to Charlie for your next role. This week I read every live posting across more than 1,000 companies, 11,530 jobs, to map what the market actually looks like right now.`;

  const content =
    h1("The state of hiring, and what it means for you.") +
    p(intro) +
    p(`<span style="font-family:${SANS};font-size:13px;font-weight:600;color:${INK};">${esc(heading)}</span>`) +
    chartBars +
    (reality ? p(`<span style="font-size:13px;color:${C.muted};">${esc(reality)}</span>`) : "") +
    (regionHook ? p(regionHook) : "") +
    button +
    p("So I keep doing the one thing that matters: sending you a role that is genuinely reachable from where you are, not a pile you can't apply to.");

  const barsText = useBars.map(([l, , v]) => `${deDash(l)} ${deDash(v)}`).join(", "); // esc() covers the HTML bars; the text half needs it too
  const strip = (s) => String(s).replace(/<[^>]+>/g, "");
  return {
    subject: "We read 11,530 open jobs. Here's what your market looks like.",
    html: emailShell({ preheader: "What your field actually demands, and where remote really reaches.", title: "The State of Hiring", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliehiring" }),
    text: `${strip(intro)}\n\n${heading} ${barsText}.\n${reality ? reality + "\n" : ""}${regionHook ? strip(regionHook) + "\n" : ""}\nRead the State of Hiring: ${url}\n\nSo I keep doing the one thing that matters: sending you a role genuinely reachable from where you are.\n\nCharlie`,
  };
}

// A proactive check-in to an existing user: one honest question, low-friction tap answers that
// record to `signals` (via the existing /e/ endpoint, no backend change), plus an open reply that
// routes to /inbound where Charlie acknowledges. `applied` tailors the opener for users who've
// already clicked through to apply. Charlie's real email voice: warm, sentence case, no em dashes.
export function renderCheckin({ email, name = "", applied = false } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const pill = (label, event) => `<a href="${esc(feedbackUrl(email, null, event))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.text};text-decoration:none;border:1px solid ${C.line};border-radius:100px;padding:9px 16px;margin:0 8px 9px 0;">${label}</a>`;
  const opener = applied
    ? "you've applied to a few of the roles I sent, which is exactly the point. I want to make sure the picks are genuinely right, not just clickable."
    : "you've had me in your inbox for a little while now, and I want to make sure I'm earning the spot.";
  const content =
    h1("Quick gut check, how's it going?") +
    p(`${hi}${opener}`) +
    p(`<b style='font-weight:600;'>One honest question: are the roles landing for you?</b>`) +
    `<div style="margin:2px 0 18px;">${pill("&#128077; yeah, they're good", "checkin_good")}${pill("&#129300; not quite right yet", "checkin_off")}${pill("&#9995; I've been applying", "checkin_applied")}</div>` +
    p("Or just hit reply and tell me what's working and what isn't. The kind of role you wish I'd caught, where I've been off, anything at all. I read every reply myself, and I'll tune to you.") +
    p(`<span style="font-size:13px;color:${C.muted};">No role today unless one genuinely clears your bar. This is just me checking in.</span>`);
  return {
    subject: "Quick gut check, how's Charlie doing?",
    html: emailShell({ preheader: "One honest question, and a reply box. Tell me what's landing and what isn't.", title: "How's it going?", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliecheckin" }),
    text: `${hi}${opener}\n\nOne honest question: are the roles landing for you?\n\nJust hit reply and tell me what's working and what isn't. The kind of role you wish I'd caught, where I've been off, anything at all. I read every reply myself, and I'll tune to you.\n\nNo role today unless one genuinely clears your bar. This is just me checking in.\n\nCharlie`,
  };
}

// A personal note from the founder to a specific early user who gave feedback.
// Deliberately breaks the Charlie persona: it is signed by the founder (FOUNDER_NAME, or "the
// founder" when unset), warm, no apology, and gives a direct line. Sent through the Charlie system
// but reads as a human note. No em dashes.
//
// THIS IS A TEMPLATE. The body is deliberately neutral and makes no claim about specific work. An
// operator who sends it should edit the second paragraph to say what has actually changed, in their
// own words, and must not claim work that has not shipped. Keep the HTML and plaintext in step.
export function renderFounderNote({ email, name = "", linkedin = "", founder = process.env.FOUNDER_NAME || "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const who = founder ? String(founder) : "the founder";
  const li = esc(linkedin);
  const liText = esc(String(linkedin).replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, ""));
  const content =
    p(`${hi}this is ${esc(who)}, the human building Charlie. Not an automated email.`) +
    p(`You told me the roles weren't quite landing yet. Thank you for saying so plainly. I read your note myself, and it is now on the list of things I am working on in the matching. I will not tell you it is fixed until it is.`) +
    p(`Honest feedback this early is rare, and it makes Charlie better for everyone who comes after you.`) +
    p(`So, for you specifically:`) +
    bullets([
      // NOT "up to three a day". That promised a per-user cadence that does not exist in code
      // (scheduler.mjs picks "their single top above-bar role", once), and it broke the one-role
      // identity the whole product rests on. Promise the effort, never a number we cannot count.
      `You'll still get one role at a time, only when it genuinely clears your bar. That doesn't change. What changes is how hard I'm looking, and how much of your picture I've got to look with.`,
      `Help me aim better: reply and tell me exactly what you're after, the kind of role, your must-haves, dealbreakers, where you'll work, and add more of your work if you can. The sharper your picture, the sharper the matches.`,
    ]) +
    p(`And if you ever want to send feedback or ideas straight to me, not through Charlie, you can find me here: <a href="${li}" style="color:${C.coral};text-decoration:none;font-weight:600;">${liText}</a>.`) +
    p(`Thanks for being early. It matters more than you know.`);
  const sign = `<div style="margin-top:18px;"><div style="font-family:${HEAD_FONT};font-size:16px;color:${C.ink};">${esc(founder ? who : "The founder")}</div><div style="font-family:${SANS};font-size:12.5px;color:${C.muted};margin-top:2px;">building Charlie</div></div>`;
  const html = `<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="x-apple-disable-message-reformatting">${FONT_LINK}<title>A note from ${esc(who)}</title></head>
<body style="margin:0;padding:0;background:${C.body};font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">A quick personal note, not an automated one. charliefounder</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.body};"><tbody><tr>
<td align="center" style="padding:30px 16px 50px;">
${logoHeaderHtml()}
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:16px;"><tbody><tr>
<td style="padding:26px 24px;">${content}${sign}</td>
</tr></tbody></table>
${footerHtml(unsubUrlFor(email))}
</td></tr></tbody></table></body></html>`;
  const text = `${hi}this is ${who}, the human building Charlie. Not an automated email.\n\nYou told me the roles weren't quite landing yet. Thank you for saying so plainly. I read your note myself, and it is now on the list of things I am working on in the matching. I will not tell you it is fixed until it is.\n\nHonest feedback this early is rare, and it makes Charlie better for everyone who comes after you.\n\nFor you specifically:\n- You'll still get one role at a time, only when it genuinely clears your bar. That doesn't change. What changes is how hard I'm looking, and how much of your picture I've got to look with.\n- Reply and tell me exactly what you're after (role, must-haves, dealbreakers, where you'll work), and add more of your work if you can. The sharper your picture, the sharper the matches.\n\nGot more feedback or ideas? You can send them straight to me here, not through Charlie: ${linkedin}\n\nThanks for being early. It matters more than you know.\n\n${founder ? who : "The founder"}, building Charlie`;
  return { subject: "A note from the person behind Charlie", html, text };
}

// The first-touch when a brand-new user has NO clean match yet: show the closest real, reachable
// role honestly ("close, not perfect") and turn the gap into the reason to reply — one detail
// (from nextGap) sharpens every future match. No forms, no app: reply to the email. The reply lands
// in /inbound, which updates their preferences. Never oversell; the honesty is the whole point.
export function renderFirstRoleClosest({ email, name = "", role = {}, gapAsk = "", label = "Closest to your profile", findId = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const company = esc(role.company || "a company");
  const title = esc(role.title || "a role");
  const loc = role.location ? esc(role.location) : "";
  const url = role.apply_url || role.url || SITE;
  const roleCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;"><tbody><tr>
    <td style="border:1px solid ${C.line};border-radius:12px;padding:16px 18px;">
      <div style="font-family:${HEAD_FONT};font-size:16px;color:${C.ink};line-height:1.3;">${title}</div>
      <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin-top:3px;">${company}${loc ? ` &middot; ${loc}` : ""}</div>
      <div style="margin-top:12px;"><a href="${esc(url)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.coral};text-decoration:none;">See the role &rarr;</a></div>
    </td>
  </tr></tbody></table>`;
  const ask = gapAsk || "a bit more about the kind of role you want";
  // No "prepare my CV" offer: Charlie does not write your resume. The value is the grounded match and
  // the honest read on it, not a commodity document. Every send is from charlie@, so an offer that
  // needs a different route would be unreachable by a plain reply anyway.
  const content =
    (label ? lead(label) : "") +
    h1("The closest role I've found so far") +
    p(`${hi}I've been scanning, and I don't have a clean match for you just yet, so I won't pretend this one is perfect. But here's the closest real, reachable role right now:`) +
    roleCard +
    p(`It's close, not quite there. The fastest way for me to find you something sharper is one quick thing: <b style='font-weight:600;'>${esc(ask)}</b>`) +
    p(`Just reply to this email with that and I'll fold it in right away, then keep looking with a clearer picture of what you actually want. No forms, no app. One reply.`);
  return {
    subject: "The closest role I found, and how to make the next one sharper",
    html: emailShell({ preheader: "Close, not perfect. One quick reply and I'll sharpen it.", title: "Your first role from Charlie", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliefirstclosest" }),
    text: `${hi}I've been scanning, and I don't have a clean match for you just yet, so I won't pretend this one is perfect. But here's the closest real, reachable role right now:\n\n${role.title || "a role"} at ${role.company || "a company"}${role.location ? ` (${role.location})` : ""}\n${role.apply_url || role.url || ""}\n\nIt's close, not quite there. The fastest way for me to find you something sharper is one quick thing: ${ask}\n\nJust reply to this email with that and I'll fold it in right away, then keep looking with a clearer picture of what you actually want. No forms, no app. One reply.\n\nCharlie`,
  };
}

// Role-share block for the bottom of a role email. When a role isn't YOUR match but you know who'd
// nail it, forward THAT posting: the role goes straight to the ATS apply page, and Charlie rides
// The gift-a-role block (the "see your fit" loop). Sits at the bottom of a role Charlie sends the user:
// if a role is not theirs but is clearly someone else's, they send it, and the friend gets Charlie's
// HONEST read on whether they fit (check@ scorecard), in one reply. No account, no page to sign up on.
// Each channel carries a signed /j/<token> link (token = signEvent({e:giver, j:jobId})) so the friend's
// click + fit-check attribute back to this giver AND this exact role. Soft inset, no left border; the
// heading is Sanchez, the body Avenir. Returns "" unless we have both the giver and a job id (needed to
// mint an attributable link). NEVER promises the friend fits — the honest read is Charlie's to give.
export function giftRoleBlock({ email, role = {} } = {}) {
  const giver = String(email || "").toLowerCase();
  const jobId = String(role.id || role.jobId || "");
  if (!giver || !jobId) return "";
  const title = role.title || "this role";
  const company = role.company || "";
  const roleLine = `${title}${company ? ` at ${company}` : ""}`;
  const link = `${BASE}/j/${signEvent({ e: giver, j: jobId })}`;
  const msg = `Saw this and thought of you: ${roleLine}. Charlie can tell you honestly if you fit, no signup. ${link}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  const em = `mailto:?subject=${encodeURIComponent(`A role I think you'd fit: ${title}`)}&body=${encodeURIComponent(msg)}`;
  const pill = (label, icon, event, dest, color) => `<a href="${esc(feedbackUrl(giver, null, event, dest))}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${color};text-decoration:none;background:${C.white};border:1px solid ${C.line};border-radius:100px;padding:7px 14px 7px 11px;margin:0 8px 8px 0;">
    <img src="${SITE}/logos/share/${icon}.png" width="16" height="16" alt="" style="vertical-align:middle;margin-right:6px;">${label}</a>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;"><tbody><tr><td style="background:${C.soft};border-radius:14px;padding:18px 20px;">
    <div style="font-family:${HEAD_FONT};font-weight:400;font-size:17px;color:${C.ink};margin:0 0 5px;">Not yours, but someone's?</div>
    <div style="font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};margin:0 0 14px;">Send it over. They'll get an honest read on whether they fit, straight from me, no account needed.</div>
    ${pill("WhatsApp", "whatsapp", "share_whatsapp", wa, LIFECYCLE.whatsapp)}${pill("Email", "email", "share_email", em, C.text)}
  </td></tr></tbody></table>`;
}

// A note we couldn't turn into a concrete change: acknowledge warmly, invite specifics.
// The reply to someone who clicked "I'm interested" on the Pro block in a role email.
//
// It has to do exactly two things: confirm the click landed, and NOT sell. There is no product to
// buy, no date to promise and no price to name — the block says "nothing to pay, nothing to sign up
// for", and this is where that stays true or becomes a lie. So: thank them, tell them the one thing
// their answer changes (what gets built first), and stop.
/** The exact subject the positioning email sends under. Exported so the inbound matcher uses the
 *  SAME string rather than a copy that can drift. */
export const POSITION_SUBJECT = "How to position you for this one";

/**
 * The answer to "show me how to position for this role" — sent when they tap the link.
 *
 * $0 AND INSTANT. Everything here was already computed for the role email and stored on the find
 * (`topMove`, `resume_tips`). No model call, so a click cannot cost money, cannot be slow, and cannot
 * fail on an API incident. The one new thing is the invitation to reply.
 *
 * IT ENDS WITH A QUESTION, on purpose. The click tells us positioning was wanted; the REPLY is where
 * the person says what they are actually worried about, which is the thing Charlie has never known.
 * Replies land on the ordinary conversational path, so the back-and-forth needs no new machinery.
 */
export function renderPositioning({ email, name = "", role = "", company = "", lead = "", tips = [] } = {}) {
  const who = name ? `${esc(name)}, here` : "Here";
  const where = [role, company].filter(Boolean).map(esc).join(" at ");
  const list = (Array.isArray(tips) ? tips : []).map((t) => String(t || "").trim()).filter(Boolean).slice(0, 4);
  const content =
    h1("How to position you") +
    p(`${who} is how I would put you in front of ${where || "this one"}.`) +
    (lead ? p(`<strong style="font-weight:600;color:${C.ink};">${esc(lead)}</strong>`) : "") +
    (list.length ? `<ul style="margin:0 0 18px;padding-left:20px;">${list.map((t) => `<li style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.text};margin:0 0 8px;">${esc(t)}</li>`).join("")}</ul>` : "") +
    p(`All of that is already true of you. None of it is a suggestion to add something you have not done.`) +
    p(`What is the part you are least sure about? Tell me and I will work it through with you.`);
  const t = (s) => deDash(String(s || ""));
  return {
    subject: POSITION_SUBJECT,
    html: emailShell({ preheader: "Everything below is already true of you.", title: "How to position you", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${t(name)}, here` : "Here"} is how I would put you in front of ${t([role, company].filter(Boolean).join(" at ")) || "this one"}.\n\n${lead ? `${t(lead)}\n\n` : ""}${list.map((x) => `- ${t(x)}`).join("\n")}${list.length ? "\n\n" : ""}All of that is already true of you. None of it is a suggestion to add something you have not done.\n\nWhat is the part you are least sure about? Tell me and I will work it through with you.\n\nCharlie`,
  };
}

export function renderProInterest({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, that` : "That";
  const content =
    h1("Noted, and it counts.") +
    p(`${hi} is genuinely useful. None of those exist yet, and what people ask for most is what I build first.`) +
    p(`If you did not say which one you wanted, reply and tell me. One word is enough.`) +
    p(`Nothing changes for you in the meantime. I will keep looking, and write when a role is worth your time.`);
  return {
    subject: "Noted",
    html: emailShell({ preheader: "Noted. What people ask for most is what gets built first.", title: "Noted", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, that` : "That"} is genuinely useful. None of those exist yet, and what people ask for most is what I build first.\n\nIf you did not say which one you wanted, reply and tell me. One word is enough.\n\nNothing changes for you in the meantime. I will keep looking, and write when a role is worth your time.\n\nCharlie`,
  };
}

// ASKED, NOT BUILT — the reply when someone writes in with real words, but not yet enough to ground a
// profile on.
//
// WHY THIS EXISTS. Two sentences is not a career. Charlie asks questions and waits rather than build a
// full dossier from a short note and then speak with confidence about that person and "their market".
//
// The shape matters. It must NOT read as rejection or as a form: they did the thing we asked, and the
// honest position is "that is a start, and one more answer makes it useful". So: acknowledge what they
// sent, ask exactly ONE thing, and say what happens next.
export function renderTellMeMore({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, thanks` : "Thanks";
  const content =
    h1("Tell me one more thing.") +
    p(`${hi} for that. It is a start, but not quite enough for me to be useful yet, and I would rather ask than guess.`) +
    p(`What have you actually built or run? One or two specifics is plenty. A project, a number, something you owned end to end.`) +
    p(`Or attach a file if it is quicker: your resume, your LinkedIn saved as a PDF, or your Peerlist export. Then I will read it properly and start looking.`);
  return {
    subject: "One more thing and I can start",
    html: emailShell({ preheader: "One or two specifics and I can start looking.", title: "Tell me one more thing", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `${deDash(name)}, thanks` : "Thanks"} for that. It is a start, but not quite enough for me to be useful yet, and I would rather ask than guess.\n\nWhat have you actually built or run? One or two specifics is plenty. A project, a number, something you owned end to end.\n\nOr attach a file if it is quicker: your resume, your LinkedIn saved as a PDF, or your Peerlist export. Then I will read it properly and start looking.\n\nCharlie`,
  };
}

export function renderAck({ email } = {}) {
  const content =
    h1("Got it.") +
    p(`Thanks for the note. If you'd like to change the kind of role, your pay floor, or where you want to work, just tell me in a reply and I'll update it.`) +
    p(`Otherwise sit tight, I'll email you a role the moment one's worth your time.`);
  return {
    subject: "Got it, noted",
    html: emailShell({ preheader: "Tell me what to change and I'll update it.", title: "Got it", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `Thanks for the note. If you'd like to change the kind of role, your pay floor, or where you want to work, just tell me in a reply and I'll update it.\n\nOtherwise sit tight, I'll email you a role the moment one's worth your time.\n\nCharlie`,
  };
}

// There is no bring-a-friend share loop: Charlie does not ask people to recruit their friends. The
// /g/<token> plumbing stays because gift-a-role shares it. See drip-removal.test.mjs.

// ── the email-native "honest read" (check@) ──────────────────────────────────
const calloutColor = (score) => (score >= 75 ? C.green : score >= 55 ? C.ink : C.amber);

// The scorecard: an honest read on one CV vs one job, then the invite into the product.
export function renderCheckScorecard({ email, result } = {}) {
  const r = result || {};
  const role = r.role_title || "this role";
  const head = r.company ? `${role} at ${r.company}` : role;
  const vc = calloutColor(r.score);
  const scoreLine = `<div style="margin:0 0 16px;">
      <span style="font-family:${HEAD_FONT};font-size:26px;color:${vc};">${esc(r.score)}</span>
      <span style="font-family:${SANS};font-size:13px;color:${C.muted};">/100</span>
      ${r.verdict ? `<span style="font-family:${SANS};font-size:13px;font-weight:600;color:${vc};margin-left:8px;">${esc(r.verdict)}</span>` : ""}
    </div>`;
  const block = (labelText, color, bodyHtml) => `<div style="margin:0 0 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:10px;"><tbody><tr><td style="padding:13px 15px;">
        ${lead2(labelText, color)}${bodyHtml}
      </td></tr></tbody></table>
    </div>`;
  const content =
    lead("your honest read") +
    h1(head) +
    scoreLine +
    p(esc(r.fit || "")) +
    (r.strengths?.length ? `<div style="margin:0 0 16px;">${lead2("what lands", C.green)}${bullets(r.strengths.map(esc), C.green)}</div>` : "") +
    (r.gaps?.length ? `<div style="margin:0 0 16px;">${lead2("what's missing", C.amber)}${bullets(r.gaps.map(esc), C.amber)}</div>` : "") +
    (r.catch ? block("the one catch", C.amber, `<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};">${esc(r.catch)}</p>`) : "") +
    (r.lead_change ? block("change this first", C.coral, `<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};">${esc(r.lead_change)}</p>`) : "") +
    `<div style="margin:22px 0 0;border-top:1px solid ${C.line};padding:16px 0 0;">` +
    p(`That was one role. I can watch the whole market for you and only email you the ones that clear your bar, honest about the fit, and how to position yourself for each.`) +
    p(`Want that? Just reply with a line about what you're after (the kind of role, where, your pay floor) and attach your resume. That's the whole setup.`) +
    `</div>`;
  return {
    subject: `Your honest read: ${head}`,
    html: emailShell({ preheader: `${r.score}/100, ${r.verdict || "here's the honest read"}.`, title: "Your honest read", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `Your honest read on ${head}\n\n${r.score}/100  ${r.verdict || ""}\n\n${r.fit || ""}\n\nWhat lands:\n${(r.strengths || []).map((s) => `- ${s}`).join("\n")}\n\nWhat's missing:\n${(r.gaps || []).map((s) => `- ${s}`).join("\n")}\n\nThe one catch: ${r.catch || ""}\n\nChange this first: ${r.lead_change || ""}\n\nThat was one role. I can watch the whole market and only email you the ones worth your time, honest, with how to position yourself for each. Reply with what you're after and attach your resume to start.\n\nCharlie`,
  };
}

export function renderCheckNeedJob({ email } = {}) {
  const content =
    h1("Send me the job and I'll read you against it.") +
    p(`Reply with the job, paste the description or drop a link, and I'll give you the honest read: where you genuinely fit, what's missing, the one catch, and the single edit worth making.`);
  return {
    subject: "Send me the job and I'll take a look",
    html: emailShell({ preheader: "Paste the job description or a link and I'll score you against it.", title: "Send me the job", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `Reply with the job, paste the description or a link, and I'll give you the honest read on how you fit.\n\nCharlie`,
  };
}

export function renderCheckNeedResume({ email } = {}) {
  const content =
    h1("Attach your resume and I'll score you against it.") +
    p(`I've got the job. Reply with a resume, LinkedIn PDF, or Peerlist export attached and I'll give you the honest read on how you fit this one.`);
  return {
    subject: "One thing, send me your resume",
    html: emailShell({ preheader: "Attach your resume and I'll read you against this job.", title: "Attach your resume", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `I've got the job. Reply with a resume, LinkedIn PDF, or Peerlist export attached and I'll read you against it.\n\nCharlie`,
  };
}

// There is no prepare@ route: Charlie does not write your CV or your cover letter. That document is a
// commodity; the grounded match and the honest read on it are not.
// The warm intro (intro@) still attaches a tailored RESUME, deliberately: that is the document the
// person drags into the intro, and it is a different feature. See role-attachments.test.mjs.

// The early-user / day-after-signup vision note. User-facing: translates the thesis into what
// they experience, never exposes the mechanism (no "dossier", "model", "moat", "data").
export function renderThesisNewsletter({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, you` : "You";
  const content =
    lead("a note from charlie") +
    h1("You're one of the first. Here's where this goes.") +
    p(`Right now the whole job hunt is turning into machines talking to machines. People fire off hundreds of AI-written applications; companies filter them with AI. Somewhere in the middle, the real person, your actual work, your actual story, gets lost.`) +
    p(`${hi} are here because I'm built on the opposite bet. Not more applications. The one role that's genuinely worth your time, honest about the fit, and real help to win it. I only ever work from what's true about you. I never invent or inflate a thing.`) +
    p(`And winning, to me, isn't blasting your resume everywhere. It's getting seen by a real human, for a role you actually fit, and turning that into an offer you'd genuinely say yes to. That's what I'm here to help you do.`) +
    `<div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:8px 0 10px;">what's coming next</div>` +
    bullets([
      "Reading your <b style='font-weight:600;'>real work</b> (the things you've actually built), so you're matched on what you can do, not just keywords",
      "Telling you when a job is a <b style='font-weight:600;'>ghost</b>, so you never waste your time on a posting that isn't real",
      "Helping you get <b style='font-weight:600;'>seen</b>: the right person to reach for a warm intro, written in your words, for you to send",
      "When you hear back, getting you <b style='font-weight:600;'>ready to win the interview</b>",
      "Keeping track of where each application stands, right here in your inbox",
    ]) +
    p(`You're one of the first people using this, which means you're shaping it. If something's off, or something would help, just reply. It's all email, and I read every one.`) +
    p(`Thank you for being here early.`);
  return {
    subject: "You're one of the first, here's where this goes",
    html: emailShell({ preheader: "Not more applications. The one role worth your time, and real help to win it.", title: "Where Charlie is going", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `You're one of the first.\n\nThe job hunt is turning into machines talking to machines: people fire off hundreds of AI-written applications, companies filter them with AI, and the real person gets lost. I'm built on the opposite bet. Not more applications, the one role genuinely worth your time, honest about the fit, and real help to win it. I only work from what's true about you, and never invent or inflate anything.\n\nWinning isn't blasting your resume everywhere. It's getting seen by a real human, for a role you actually fit, and turning it into an offer you'd say yes to.\n\nComing next: reading your real work so you're matched on capability not keywords; flagging ghost jobs; helping you get seen via warm intros in your words; prepping you to win the interview when you hear back; and tracking every application right in your inbox.\n\nYou're shaping this. Just reply, it's all email and I read every one. Thank you for being here early.\n\nCharlie`,
  };
}

// Acknowledgement for a forwarded company reply (track@). Warm, honest, no mechanism exposed, and no
// offer of help that has no handler behind it.
export function renderTrackAck({ email, outcome, company = "", role = "" } = {}) {
  const co = company ? ` at ${esc(company)}` : "";
  let head, bodyHtml, subject, tag = "";
  if (outcome === "applied") {
    subject = "Tracked, you're in the running";
    head = "Tracked. You're in the running.";
    tag = "charlieapplied";
    // The address is named, not "forward me": every Charlie email is sent from charlie@, and tracking
    // is reachable only at track@.
    bodyHtml = p(`Got it, I've logged that you applied${co}. I'll keep an eye on it, and when you hear back, forward their reply to <b style='font-weight:600;'>track@mail.example.com</b> and I'll track that too.`);
  } else if (outcome === "interview") {
    subject = "An interview, let's win it";
    head = "An interview. Let's win it.";
    tag = "charlieinterviews";
    // No "reply prep me" offer here: there is no prep handler, so a reply at the highest-stakes moment
    // would get "Got it, noted." Do not add an offer until a prep path actually exists.
    bodyHtml = p(`Congratulations${co ? ` on the interview${co}` : ""}. This is the part that matters. Go and be the person they read about, and tell me how it goes.`);
  } else if (outcome === "offer") {
    subject = "An offer. Huge.";
    head = "An offer. Huge.";
    tag = "charlieoffers";
    // No offer to help think the offer through: at this stage it reads as an invitation to weigh the
    // number, and pay negotiation is a hard scope wall (prompts/interrogate.mjs). Charlie never coaches
    // a tactic or endorses a figure. Celebrate, and leave the door shut. Fenced by evals/salary-boundary.test.mjs.
    bodyHtml = p(`That's the whole point${co}. Genuinely, well done. Go and enjoy this one, you earned it.`);
  } else if (outcome === "rejected") {
    subject = "Noted, on to the next";
    head = "Noted. On to the next.";
    bodyHtml = p(`Logged${co}. Their loss, and honestly it sharpens what I look for next for you. I'll keep going.`);
  } else {
    subject = "Send me the company's reply";
    head = "Send me the company's reply.";
    bodyHtml = p(`I couldn't tell what stage this is. Forward the actual email you got from the company (their reply itself) to <b style='font-weight:600;'>track@mail.example.com</b>, and I'll track it, applied, heard back, interview, or offer.`);
  }
  return {
    subject,
    html: emailShell({ preheader: "Tracking your application.", title: "Tracking your application", contentHtml: h1(head) + bodyHtml, unsubUrl: unsubUrlFor(email), tag }),
    text: `${head}\n\n${bodyHtml.replace(/<[^>]+>/g, "")}\n\nCharlie`,
  };
}

// Feature announcement: the one-time Gmail label filter + application tracking via track@.
export function renderFitReadout({ email, company = "", role = "", cov = {} } = {}) {
  const co = company ? esc(company) : "this role";
  const STYLE = {
    met: { label: "&#10003; have it", fg: C.green, bg: C.greenbg },
    partial: { label: "~ partly", fg: C.amber, bg: C.amberbg },
    unknown: { label: "? not shown", fg: C.muted, bg: C.soft },
  };
  const rows = (cov.coverage || []).slice(0, 6).map((r) => {
    const st = STYLE[r.status] || STYLE.unknown;
    return `<tr>
        <td style="padding:8px 12px 8px 0;white-space:nowrap;vertical-align:top;"><span style="font-family:${SANS};font-size:11px;font-weight:600;color:${st.fg};background:${st.bg};border-radius:5px;padding:3px 8px;display:inline-block;">${st.label}</span></td>
        <td style="padding:8px 0;font-family:${SANS};font-size:13.5px;color:${C.text};line-height:1.45;border-top:1px solid ${C.line};">${esc(r.req)}</td>
      </tr>`;
  }).join("");
  const move = cov.topMove
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.signal_soft};border-radius:12px;margin:18px 0 4px;"><tbody><tr><td style="padding:14px 16px;">
        <div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 5px;">one move worth making</div>
        <p style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.ink};margin:0;">${esc(cov.topMove)}</p>
      </td></tr></tbody></table>`
    : "";
  const content =
    lead("your honest read") +
    h1(cov.reason || `Here's where you stand on ${co}.`) +
    `<p style="font-family:${SANS};font-size:12.5px;color:${C.muted};margin:0 0 16px;"><b style="color:${C.ink};font-weight:600;">${esc(String(cov.composite ?? ""))}/100</b>, ${esc(cov.caption || "my read of the posting, not their scoreboard")}. Confidence: ${esc(cov.confidence || "medium")}.</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 4px;"><tbody>${rows}</tbody></table>` +
    move +
    p(`This is my read of what the posting asks versus what your profile shows, not the employer's scoreboard. I can only see the posting, not their model.`);
  return {
    subject: `Your honest read on ${company || "this role"}`,
    html: emailShell({ preheader: `Where you genuinely stand on ${company || "this role"}, requirement by requirement, and the one move worth making.`, title: "Your honest read", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${cov.reason || `Where you stand on ${company || "this role"}`}\n\n${cov.composite ?? ""}/100 (${cov.caption || "my read, not their scoreboard"}), confidence ${cov.confidence || "medium"}.\n\n${(cov.coverage || []).slice(0, 6).map((r) => `[${r.status === "met" ? "have it" : r.status === "partial" ? "partly" : "not shown"}] ${r.req}`).join("\n")}\n\n${cov.topMove ? `One move worth making: ${cov.topMove}\n\n` : ""}This is my read of the posting vs your profile, not the employer's scoreboard.\n\nCharlie`,
  };
}

// Completeness nudge: no role has cleared the user's bar yet (usually thin input). Warm,
// honest, actionable. Dripped at 7 / 14 / 30 days after onboarding, at most 3 times, then it
// stops. `last` softens the final one so it never feels like nagging.
export function renderCompletenessNudge({ email, name = "", last = false } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    h1("I haven't found one worth sending yet.") +
    p(`${hi}I've been scanning every day, but nothing has cleared your bar so far. Usually that just means I don't have quite enough to go on yet.`) +
    p(`Reply and tell me a little more, and I'll sharpen what I look for:`) +
    bullets([
      "The kind of role you want (titles, seniority)",
      "Remote, a city, or either",
      "Your pay floor",
      "Anything you won't accept",
    ]) +
    p(`Or just send a fuller resume, that helps most of all. Even a line or two changes what I can find for you.`) +
    (last
      ? p(`This is the last nudge I'll send, I don't want to crowd your inbox. Reply whenever you're ready and I'll pick right back up.`)
      : "");
  return {
    subject: last ? "One last nudge, then I'll leave you be" : "I haven't found one worth sending yet",
    html: emailShell({ preheader: "Nothing has cleared your bar yet. A couple more details and I'll sharpen what I look for.", title: "Let's sharpen your matches", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${name ? `Hi ${name}, ` : "Hi, "}I've been scanning every day, but nothing has cleared your bar yet. Usually that means I don't have quite enough to go on.\n\nReply and tell me more and I'll sharpen it: the kind of role, remote or a city, your pay floor, anything you won't accept. Or send a fuller resume, that helps most.\n\n${last ? "This is the last nudge I'll send. Reply whenever you're ready and I'll pick right back up.\n\n" : ""}Charlie`,
  };
}

// Profile-completion nudge: they onboarded from a resume but a few high-signal details were
// never stated (target role, seniority, pay floor, location, or even their name). More signal =
// sharper matches, so this warmly invites them to fill the gaps. Framed as OPTIONAL — Charlie is
// already hunting either way — but honest that it lifts the odds. Grounded: it references only
// what the resume actually gave (headline verbatim), never invents. `missing` is the list of
// field keys genuinely absent for THIS person, so nobody is asked for something they already gave.
export function renderProfileNudge({ email, name = "", headline = "", missing = [] } = {}) {
  const ASK = {
    name: "What you'd like me to call you",
    role: "The kind of role you're aiming for, a title or two is plenty",
    seniority: "The level you're targeting, say senior, lead, or principal",
    pay: "Your pay floor, so I never send you anything below it",
    location: "Remote, a city, or either",
  };
  const asks = missing.map((k) => ASK[k]).filter(Boolean);
  if (!asks.length) return null; // nothing genuinely missing → don't send
  const one = asks.length === 1;
  const thing = one ? "one quick thing" : "a couple of quick things";
  const detail = one ? "one small thing" : "a few small things";
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const got = headline ? ` I've got the shape of your background already, ${esc(String(headline).replace(/\.$/, ""))}.` : "";
  // plaintext-safe variants for the `text` field: strip em dashes WITHOUT HTML-entity-encoding
  // (esc() would turn quotes/ampersands in a name or headline into entities in plain text).
  const hiText = name ? `Hi ${deDash(name)}, ` : "Hi, ";
  const content =
    lead("a quick tune-up") +
    h1(one ? "One detail and I'll hunt sharper for you." : "A couple of details and I'll hunt sharper for you.") +
    p(`${hi}you're all set and I'm already scanning every day for you.${got}`) +
    p(`If you've got a minute, ${detail} would make every match I send you land closer. Completely optional, but the more you tell me, the better I can aim, and the better your odds on the ones I do send:`) +
    bullets(asks) +
    p(`Just hit reply with whatever you've got, even a line. If you'd rather leave it, that's fine too, I'll keep hunting with what I have.`);
  return {
    subject: name ? `${esc(name)}, ${thing} and I'll match you sharper` : `${thing.charAt(0).toUpperCase()}${thing.slice(1)} and I'll match you sharper`,
    html: emailShell({ preheader: "You're all set and I'm already scanning. A couple of optional details would make every match land closer.", title: "Let's sharpen your matches", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hiText}you're all set and I'm already scanning every day for you.${headline ? ` I've got the shape of your background already, ${deDash(String(headline).replace(/\.$/, ""))}.` : ""}\n\nIf you've got a minute, ${detail} would make every match land closer. Completely optional, but the more you tell me, the better I can aim:\n${asks.map((a) => `- ${a}`).join("\n")}\n\nJust hit reply with whatever you've got, even a line. If you'd rather leave it, that's fine too, I'll keep hunting with what I have.\n\nCharlie`,
  };
}

// Check-in nudge: the UNBREAKABLE rule is never send the same role twice. When Charlie re-scans
// and the only thing still clearing this person's bar is a role already sent, it does NOT resend,
// it checks in instead, honestly: scanned across N boards again, nothing new cleared your bar, the
// strongest is still the one I sent, did you apply? Grounded (names the real last role), warm, and
// gives the two useful next steps (forward a reply to track, or tell me what to sharpen).
export function renderCheckInNudge({ email, name = "", company = "", role = "", boards = 1000 } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const roleLine = role ? (company ? `${esc(role)} at ${esc(company)}` : esc(role)) : (company ? `the role at ${esc(company)}` : "the last role I sent you");
  // plaintext-safe: strip em dashes WITHOUT HTML-entity-encoding (esc would turn quotes/ampersands
  // in a name/company/role into entities in plain text).
  const hiText = name ? `Hi ${deDash(name)}, ` : "Hi, ";
  const roleLineTxt = role ? (company ? `${deDash(role)} at ${deDash(company)}` : deDash(role)) : (company ? `the role at ${deDash(company)}` : "the last role I sent you");
  const boardsN = `${(Number(boards) || 1000).toLocaleString("en-US")}+`;
  const content =
    lead("just checking in") +
    h1("Still hunting, nothing new past your bar today.") +
    p(`${hi}I ran back across ${boardsN} company boards today. Nothing new has cleared your bar yet, the strongest match is still <b style='font-weight:600;'>${roleLine}</b>, the one I already sent you. I won't send you the same role twice.`) +
    p(`So this is really just a check-in: did you get a chance to apply?`) +
    bullets([
      "If you did, forward anything you hear back to track@mail.example.com and I'll follow it for you",
      "If it wasn't quite right, tell me what felt off and I'll sharpen what I look for",
    ]) +
    p(`Either way I'm still scanning every day, and the moment something new clears your bar, you'll hear from me.`);
  return {
    subject: name ? `${esc(name)}, quick check, did you apply?` : "Quick check, did you apply?",
    html: emailShell({ preheader: `Nothing new past your bar today. Just checking in on ${company || "your last role"}, did you get a chance to apply?`, title: "Just checking in", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieapplied" }),
    text: `${hiText}I ran back across ${boardsN} company boards today. Nothing new has cleared your bar yet, the strongest match is still ${roleLineTxt}, the one I already sent you. I won't send you the same role twice.\n\nSo this is really just a check-in: did you get a chance to apply?\n- If you did, forward anything you hear back to track@mail.example.com and I'll follow it for you\n- If it wasn't quite right, tell me what felt off and I'll sharpen what I look for\n\nEither way I'm still scanning every day, and the moment something new clears your bar, you'll hear from me.\n\nCharlie`,
  };
}

// The MARKET-GAP DROP (market-gap.mjs): the roles closest to what this person wants keep asking for
// ONE thing their profile hasn't shown. Break the silence with the grounded reason and an honest
// close — not a shame report, an opening. EVERY FACT IS CODE-RENDERED here (the gap label, the
// "N of M asked for it" count, the attributed market lines); the model-written `copy` only supplies
// warm connective prose and is optional — a grounded hand-written default is used for any missing
// field, so this template is correct with `copy` = null. Model fields may carry the literal `{{GAP}}`
// placeholder, substituted with the real gap here so the model can never alter or upgrade the term.
//   gap: { gap, key } (the grounded label) · count/total: the real "N of M" · kind: "share"|"pref"
//   stalled: acknowledges prior roles · research: { lines:[{claim,source}], pay:{median,label,area,source}|null }
export function renderMarketGap({ email, gap = {}, count = 0, total = 0, kind = "share", stalled = false, research = {}, copy = null } = {}) {
  // deDash the gap label ONCE, up front: a JD requirement can arrive with an en dash (fit-coverage
  // strips em dashes but not en dashes), and the label is rendered RAW into the plaintext stat line and
  // the subject. Without this, an en-dashed gap ("5-7 years" written with an en dash) trips the em-dash
  // lint and the whole drop fails closed. gEsc stays esc()'d (dash-safe too) for the HTML.
  const label = deDash(String(gap.gap || gap.key || "one thing").trim());
  const gEsc = esc(label);
  // esc first (leaves the `{{GAP}}` braces untouched), then substitute the real, escaped gap.
  const withGap = (s) => esc(String(s ?? "")).replaceAll("{{GAP}}", gEsc);

  // grounded hand-written defaults. VOICE: the absence is framed as an OPPORTUNITY from every angle,
  // never a deficiency, never penalizing. Charlie is a companion who has been in their corner the whole
  // time and spotted a door, not a gatekeeper listing what they lack. (No "you haven't shown", no
  // "that's why nothing lands".) Warm, on their side, they feel seen and supported.
  const openingDflt = stalled
    ? `You've seen a few from me, and I'm still on it every day. I keep noticing the same door across the roles that fit you best, so I wanted to point it out.`
    : `I've been reading the market for you every day, and I've found the one thing that would open the most doors.`;
  const framingDflt = `The roles you'd want most are built around {{GAP}}. That makes it the single most valuable thing you could put in front of me.`;
  const honestDflt = `If {{GAP}} is already part of your story, even a little, showing me opens this whole set of roles. And if it's something you're growing into, now you know exactly where to aim, and I'll be watching for it, with you.`;
  const closeDflt = kind === "pref"
    ? `Or if you'd rather aim somewhere else entirely, just say the word and I'll re-point the whole search.`
    : `Send me anything that shows it, a project, a story, a couple of lines, and I'll weave it into everything I look for from here.`;

  const opening = withGap(copy?.opening || openingDflt);
  const framing = withGap(copy?.gap_framing || framingDflt);
  const honest = withGap(copy?.honest_line || honestDflt);
  const close = withGap(copy?.close_line || closeDflt);
  const subjectRaw = String(copy?.subject || "the one thing that keeps opening doors for you").replaceAll("{{GAP}}", label);

  // THE CHART — the grounded evidence as a coral PIE (donut), opportunity not scoreboard: how much of
  // the nearby opportunity this one thing covers. Email-safe by design: a conic-gradient donut renders
  // the true slice in Apple Mail / modern clients; Gmail ignores conic-gradient and keeps the preceding
  // solid `background:${C.coral}` + `border-radius:50%`, so it degrades to a clean coral ring with the
  // "N/M" in the middle (never broken). Emphasis is COLOR + the pie, never bold weight (ceiling: the
  // 9.5px uppercase micro-labels are 600 here, no 700, no <b style='font-weight:600;'>). The caption carries the number in words.
  const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((count / total) * 100))) : 0;
  const chart = total > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border-radius:12px;margin:16px 0;"><tbody><tr><td align="center" style="padding:20px 18px;">
        <div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:0 0 14px;">where the doors are</div>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tbody><tr>
          <td width="108" height="108" align="center" valign="middle" style="width:108px;height:108px;background:${C.coral};background:conic-gradient(${C.coral} 0 ${pct}%,${C.line} ${pct}% 100%);border-radius:50%;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tbody><tr>
              <td width="70" height="70" align="center" valign="middle" style="width:70px;height:70px;background:${C.card};border-radius:50%;">
                <span style="font-family:${SANS};font-size:20px;font-weight:600;color:${C.ink};">${count}/${total}</span>
              </td>
            </tr></tbody></table>
          </td>
        </tr></tbody></table>
        <div style="font-family:${SANS};font-size:15px;font-weight:600;color:${C.ink};margin:14px 0 4px;">${gEsc}</div>
        <div style="font-family:${SANS};font-size:13px;color:${C.muted};margin:0;">Shows up in ${count} of the ${total} role${total === 1 ? "" : "s"} closest to you</div>
      </td></tr></tbody></table>`
    : "";

  // attributed market context — each line carries its real source; nothing is voiced as Charlie's own.
  const lines = Array.isArray(research?.lines) ? research.lines : [];
  const marketRows = lines.map((l) =>
    `<tr><td style="padding:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};">${esc(l.claim)} <a href="${esc(l.source)}" style="color:${C.muted};text-decoration:underline;">source</a></td></tr>`,
  ).join("");
  // require a real source URL before rendering the pay row — a "BLS" link pointing at "#" would assert
  // sourcing that isn't there (the moat's source affordance is load-bearing).
  const payHasSource = research?.pay && /^https?:\/\/\S+/i.test(String(research.pay.source || ""));
  const payRow = research?.pay && Number.isFinite(research.pay.median) && payHasSource
    ? `<tr><td style="padding:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};">Market pay for ${esc(research.pay.label || "this work")}${research.pay.area ? ` (${esc(research.pay.area)})` : ""} runs about $${Number(research.pay.median).toLocaleString("en-US")} median. <a href="${esc(research.pay.source)}" style="color:${C.muted};text-decoration:underline;">BLS</a></td></tr>`
    : "";
  const market = (marketRows || payRow)
    ? `<div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:6px 0 8px;">what the market says</div>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tbody>${marketRows}${payRow}</tbody></table>`
    : "";

  // the close, given warmth in a soft coral inset (matches the fit-Readout "one move" treatment).
  const closeBox = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.signal_soft};border-radius:12px;margin:18px 0 4px;"><tbody><tr><td style="padding:14px 16px;">
      <div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 5px;">${kind === "pref" ? "or point me somewhere new" : "one reply and it opens up"}</div>
      <p style="font-family:${SANS};font-size:14px;line-height:1.55;color:${C.ink};margin:0;">${close}</p>
    </td></tr></tbody></table>`;

  // top label at weight 600 (not lead()'s 700) — this email stays fully within the medium weight ceiling.
  const topLabel = `<p style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 10px;">on your side</p>`;
  const content =
    topLabel +
    h1("One thing keeps opening these doors.") +
    p(opening) +
    p(framing) +
    chart +
    market +
    p(honest) +
    closeBox;

  const marketTxt = [
    ...lines.map((l) => `- ${deDash(l.claim)} (source: ${l.source})`),
    research?.pay && Number.isFinite(research.pay.median) && payHasSource ? `- Market pay for ${deDash(research.pay.label || "this work")}${research.pay.area ? ` (${deDash(research.pay.area)})` : ""}: about $${Number(research.pay.median).toLocaleString("en-US")} median (BLS: ${research.pay.source})` : "",
  ].filter(Boolean).join("\n");
  const deGap = (s) => deDash(String(s ?? "")).replaceAll("{{GAP}}", label);
  const text = `${deGap(copy?.opening || openingDflt)}\n\n${deGap(copy?.gap_framing || framingDflt)}\n\n${total > 0 ? `${label} shows up in ${count} of the ${total} role${total === 1 ? "" : "s"} closest to you, that's where the doors are.\n\n` : ""}${marketTxt ? `${marketTxt}\n\n` : ""}${deGap(copy?.honest_line || honestDflt)}\n\n${deGap(copy?.close_line || closeDflt)}\n\nCharlie`;

  return {
    subject: cleanSubject(subjectRaw),
    html: emailShell({ preheader: `One thing keeps opening the roles closest to you. Here's the door, and how to reach for it, together.`, title: "One thing keeps opening these doors", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text,
  };
}

// Weekly digest: the near-misses the Quality Gate held back — roles that fit the person's profile
// but didn't clear the bar for a solo send (location not quite reachable, or the fit was below the
// floor). Honest, low-pressure, "worth a look". Each item names the ONE reason it's here, a
// verified-live apply link, and the warm-intro option. Capped upstream (top 5). Never sent empty.
export function renderWeeklyDigest({ email, name = "", items = [] } = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  // plaintext-safe: strip em dashes without HTML-entity-encoding (for the `text` field).
  const hiText = name ? `Hi ${deDash(name)}, ` : "Hi, ";
  const card = (it) => {
    const roleLine = it.company ? `${esc(it.role)} &middot; ${esc(it.company)}` : esc(it.role || "a role");
    const loc = it.location ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};margin:2px 0 0;">${esc(it.location)}</div>` : "";
    const note = it.note ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin:8px 0 0;">${esc(it.note)}</div>` : "";
    const apply = it.applyUrl ? `<a href="${esc(it.applyUrl)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.white};background:${C.green};text-decoration:none;padding:8px 16px;border-radius:8px;margin:12px 6px 0 0;">Apply &rarr;</a>` : "";
    const intro = it.introMailto ? `<a href="${esc(it.introMailto)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.coral};background:${C.card};text-decoration:none;padding:6.5px 14px;border-radius:8px;border:1.5px solid ${C.coral};margin:12px 0 0;">&#129309; warm intro</a>` : "";
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:12px;margin:0 0 12px;"><tbody><tr><td style="padding:15px 16px;">
        <div style="font-family:${HEAD_FONT};font-size:16px;font-weight:400;letter-spacing:-.01em;color:${C.ink};">${roleLine}</div>
        ${loc}${note}
        <div>${apply}${intro}</div>
      </td></tr></tbody></table>`;
  };
  const content =
    lead("worth a look this week") +
    h1("A few that fit you, if you're open on a thing or two.") +
    p(`${hi}these didn't clear the bar for me to send on their own, so I held them for a weekly note instead. But your profile genuinely fits, worth a look if you're open on location or a gap or two:`) +
    items.map(card).join("") +
    p(`These are lighter-touch than my daily one, which I keep rare and strong. Reply any time and I'll sharpen what I look for.`);
  return {
    subject: `${items.length} worth a look this week`,
    html: emailShell({ preheader: `A few roles that fit your profile but didn't clear the bar for a solo send, worth a look if you're flexible.`, title: "Worth a look this week", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hiText}these didn't clear the bar for me to send on their own, so I held them for a weekly note. Your profile fits, worth a look if you're open on location or a gap or two:\n\n${items.map((it) => `- ${deDash(it.role)}${it.company ? ` at ${deDash(it.company)}` : ""}${it.location ? ` (${deDash(it.location)})` : ""}\n  ${deDash(it.note || "")}${it.applyUrl ? `\n  apply: ${it.applyUrl}` : ""}`).join("\n\n")}\n\nThese are lighter-touch than my daily one, which I keep rare and strong. Reply any time and I'll sharpen what I look for.\n\nCharlie`,
  };
}

// Announcement: Charlie can now factor in a person's ACTUAL work, not just their resume, and match on
// what they've really done instead of keywords. The whole point of the ask is that it stays effortless:
// you can just write or scribble it, no polished portfolio required. One low-friction ask, framed as
// the payoff. Grounded: it only ever uses what's real, and never inflates.
// A hand-picked shortlist for someone Charlie has NO grounded profile for: they wrote in, said what
// they're after, and no resume ever arrived. It is deliberately NOT renderWeeklyDigest, whose copy
// says "your profile genuinely fits" and "these didn't clear the bar" — both are claims about the
// person's fit, and a fit claim needs a dossier. Here there is none, so this template makes ZERO
// claims about the reader. It states what the role is and what is wrong with it, and asks for the
// resume so the real thing can start.
//
// The honest catch is STRUCTURAL, not a convention: an item without `catch` is DROPPED, and if that
// empties the list the whole email returns null rather than sending. A role with no stated downside
// is what a job board sends, and the catch is the one thing that makes this Charlie. Enforcing it in
// code means a caller in a hurry cannot quietly omit it (prose is not enforcement).
// ── "I found these, and here is why I am holding some back" ──────────────────
// The honest counterpart to renderRolePicks. That template is for someone with NO profile yet, so it
// makes no claim about fit and asks for a resume. This one is for someone Charlie DOES know, where
// real roles surfaced and were held, and the reader deserves to see them plus the actual reason.
//
// Each item carries its own `held` reason in Charlie's words. Two reasons exist in practice and they
// are NOT the same thing, so the template never blurs them:
//   held: "preference" — it conflicts with something they told us (a city, a work model). Their call
//                        to change, and only they can make it.
//   held: "depth"      — the posting asks for things their profile does not evidence. Ours to fix,
//                        and it is fixed by them telling us more, not by us assuming.
// `open: true` marks a role with nothing in its way, so a genuinely available role is never buried
// under an explanation it does not need.
//
// Grounding: the template states no fit score and makes no claim about how well they match. It says
// only what the role asks and what we can or cannot see, which is the honest shape of the problem.
export function renderHeldRoles({ email, name = "", lookedFor = "", items = [], askDepth = true } = {}) {
  const picks = (Array.isArray(items) ? items : []).filter((it) => it && it.role && (it.open || String(it.held || "").trim()));
  if (!picks.length) return null;
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const hiText = name ? `Hi ${deDash(name)}, ` : "Hi, ";
  const card = (it) => {
    const roleLine = it.company ? `${esc(it.role)} &middot; ${esc(it.company)}` : esc(it.role);
    const loc = it.location ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};margin:2px 0 0;">${esc(it.location)}</div>` : "";
    const note = it.note ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin:8px 0 0;">${esc(it.note)}</div>` : "";
    const held = it.open
      ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.green};margin:6px 0 0;">Nothing in the way of this one.</div>`
      : `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};margin:6px 0 0;">Why I held it: ${esc(it.held)}</div>`;
    const apply = it.applyUrl
      ? `<a href="${esc(it.applyUrl)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.white};background:${C.green};text-decoration:none;padding:8px 16px;border-radius:8px;margin:12px 0 0;">See the role &rarr;</a>`
      : "";
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:12px;margin:0 0 12px;"><tbody><tr><td style="padding:15px 16px;">
        <div style="font-family:${HEAD_FONT};font-size:16px;font-weight:400;letter-spacing:-.01em;color:${C.ink};">${roleLine}</div>
        ${loc}${note}${held}
        <div>${apply}</div>
      </td></tr></tbody></table>`;
  };
  const depthAsk = askDepth
    ? p(`Some of these ask for depth I cannot see in your profile yet. Not because it is not there. Because all I have is where you have worked and for how long, not what you actually owned. Three or four lines would change that: what you own now and how big the team is, one thing you shipped that mattered and what changed because of it, and the same for an earlier role if you feel like it.`) +
      p(`You do not need to write a resume for me. On LinkedIn, open your profile, click More, then Save to PDF, and send me that file. I can read it.`)
    : "";
  const content =
    lead("what I found") +
    h1(`${picks.length === 1 ? "One role" : `${picks.length} roles`}, and the honest reason on each.`) +
    p(`${hi}${esc(lookedFor || "I went looking for you today.")}`) +
    picks.map(card).join("") +
    depthAsk +
    p(`If any of that is wrong, tell me. If you would consider something I have been filtering out, tell me that too and I will stop filtering it.`) +
    p(`Just reply here.`);
  return {
    subject: `${picks.length} ${picks.length === 1 ? "role" : "roles"} for you, and what is holding them`,
    html: emailShell({
      preheader: "What I found, why I held some back, and the one thing that would let me aim sharper.",
      title: "What I found",
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
    }),
    text: `${hiText}${deDash(lookedFor || "I went looking for you today.")}\n\n${picks
      .map(
        (it) =>
          `- ${deDash(it.role)}${it.company ? ` at ${deDash(it.company)}` : ""}${it.location ? ` (${deDash(it.location)})` : ""}${it.note ? `\n  ${deDash(it.note)}` : ""}\n  ${it.open ? "Nothing in the way of this one." : `Why I held it: ${deDash(it.held)}`}${it.applyUrl ? `\n  ${it.applyUrl}` : ""}`,
      )
      .join("\n\n")}\n\n${
      askDepth
        ? `Some of these ask for depth I cannot see in your profile yet. Not because it is not there. Because all I have is where you have worked and for how long, not what you actually owned. Three or four lines would change that: what you own now and how big the team is, one thing you shipped that mattered and what changed because of it, and the same for an earlier role if you feel like it.\n\nYou do not need to write a resume for me. On LinkedIn, open your profile, click More, then Save to PDF, and send me that file. I can read it.\n\n`
        : ""
    }If any of that is wrong, tell me. If you would consider something I have been filtering out, tell me that too and I will stop filtering it.\n\nJust reply here.\n\nCharlie`,
  };
}

export function renderRolePicks({ email, name = "", intro = "", items = [] } = {}) {
  const picks = (Array.isArray(items) ? items : []).filter((it) => it && it.role && String(it.catch || "").trim());
  if (!picks.length) return null;
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const hiText = name ? `Hi ${deDash(name)}, ` : "Hi, ";
  const card = (it) => {
    const roleLine = it.company ? `${esc(it.role)} &middot; ${esc(it.company)}` : esc(it.role);
    const loc = it.location ? `<div style="font-family:${SANS};font-size:12px;color:${C.muted};margin:2px 0 0;">${esc(it.location)}</div>` : "";
    const note = it.note ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin:8px 0 0;">${esc(it.note)}</div>` : "";
    const flaw = `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};margin:6px 0 0;">The catch: ${esc(it.catch)}</div>`;
    const apply = it.applyUrl ? `<a href="${esc(it.applyUrl)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${C.white};background:${C.green};text-decoration:none;padding:8px 16px;border-radius:8px;margin:12px 0 0;">Apply &rarr;</a>` : "";
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:12px;margin:0 0 12px;"><tbody><tr><td style="padding:15px 16px;">
        <div style="font-family:${HEAD_FONT};font-size:16px;font-weight:400;letter-spacing:-.01em;color:${C.ink};">${roleLine}</div>
        ${loc}${note}${flaw}
        <div>${apply}</div>
      </td></tr></tbody></table>`;
  };
  const content =
    lead("open right now") +
    h1(`${picks.length === 1 ? "One role" : `${picks.length} roles`}, open now.`) +
    p(`${hi}${esc(intro || "here's what's open right now.")}`) +
    picks.map(card).join("") +
    p(`To keep this going, reply to this email with a resume, LinkedIn PDF, or Peerlist export attached. Then I can look properly every day, and only write when something clears your bar.`);
  return {
    subject: `${picks.length} ${picks.length === 1 ? "role" : "roles"}, open now`,
    html: emailShell({ preheader: "A few that are open right now, with the catch on each. Reply with your resume and I'll keep going.", title: "Open now", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hiText}${deDash(intro || "here's what's open right now.")}\n\n${picks.map((it) => `- ${deDash(it.role)}${it.company ? ` at ${deDash(it.company)}` : ""}${it.location ? ` (${deDash(it.location)})` : ""}${it.note ? `\n  ${deDash(it.note)}` : ""}\n  The catch: ${deDash(it.catch)}${it.applyUrl ? `\n  apply: ${it.applyUrl}` : ""}`).join("\n\n")}\n\nTo keep this going, reply to this email with a resume, LinkedIn PDF, or Peerlist export attached. Then I can look properly every day, and only write when something clears your bar.\n\nCharlie`,
  };
}

export function renderWorkDumpAnnounce({ email, name = "" } = {}) {
  const hi = name ? `Hi ${esc(name)}, ` : "Hi, ";
  const content =
    lead("what's new") +
    h1("Now you can show me your real work, not just keywords.") +
    p(`${hi}here's what's new. Most job tools scan your resume for the right words, and scan the posting for the same words, and if they line up, they call it a match. Everyone figured out which words the robots want, so everyone stuffs them in, and now the words barely mean anything.`) +
    p(`So here's the new thing you can do with me: show me what you've actually <b style='font-weight:600;'>done</b>, and I'll read it against what a role really needs, point by point, what you clearly have, what's partial, what the posting just doesn't say. Your real work, not your keyword game.`) +
    p(`To switch it on for you, just tell me about something you've done. And I mean <b style='font-weight:600;'>just tell me</b>, in whatever form you've got:`) +
    bullets([
      "Write a few lines, or honestly, scribble it. A rough sentence is fine",
      "Paste a link if you have one (a repo, a live thing, a portfolio)",
      "Or attach a doc, a case study, anything",
    ]) +
    p(`You do <b style='font-weight:600;'>not</b> need a polished portfolio or case studies. If all you've got is "I built the payments thing at X and it cut checkout time in half," that is genuinely enough. I'll take it from there.`) +
    p(`And the one promise underneath all of it: I only ever use what's real, and I never inflate it. What you show me is what I work with, exactly as it is.`) +
    p(`Just reply whenever you've got a minute.`);
  return {
    subject: name ? `${esc(name)}, show me your real work, not just keywords` : "Show me your real work, not just keywords",
    html: emailShell({ preheader: "Show me what you've actually done, even just a scribble, and I'll read it against the role instead of counting keywords.", title: "Now you can show me your real work", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `${hi}here's what's new. Most job tools scan your resume for the right words and match on those, and everyone games that, so the words stopped meaning much.\n\nSo here's the new thing you can do with me: show me what you've actually DONE, and I'll read it against what a role really needs, point by point, what you clearly have, what's partial, what the posting just doesn't say. Your real work, not your keyword game.\n\nTo switch it on, just tell me about something you've done, in whatever form you've got:\n- Write a few lines, or honestly just scribble it, a rough sentence is fine\n- Paste a link if you have one (a repo, a live thing, a portfolio)\n- Or attach a doc, a case study, anything\n\nYou do NOT need a polished portfolio or case studies. If all you've got is "I built the payments thing at X and it cut checkout time in half," that's genuinely enough.\n\nAnd the promise underneath it: I only ever use what's real, and I never inflate it.\n\nJust reply whenever you've got a minute.\n\nCharlie`,
  };
}

// Announcement: the warm-intro finder is now on every role email. Sent once to current users
// (--all) and dripped to new onboarders a day or so in. One-time, unthreaded, one-click unsub.
export function renderReferralAnnounce({ email, name = "" } = {}) {
  const hi = name ? `${esc(name)}, applying` : "Applying";
  const sub = (t) => `<div style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:14px 0 9px;">${esc(t)}</div>`;
  const content =
    lead("what's new") +
    h1("Now I find you a way in, not just the door.") +
    p(`${hi} cold is the worst part of a job search. So here's what's new: on every role I send you, there's now a small link, <b style='font-weight:600;'>&#129309; find me a warm intro</b>.`) +
    p(`Tap it and I'll find a real person at that company worth reaching out to, and hand you a short note to send them, so you're a name, not one more application in the pile.`) +
    sub("what one tap gives you") +
    bullets([
      "A real, verified contact, their <b style='font-weight:600;'>name, title, and LinkedIn</b>",
      "A short, honest intro written from <b style='font-weight:600;'>your own background</b> (and your portfolio, if you have one)",
      "It opens right in your inbox, on your phone or laptop",
      "<b style='font-weight:600;'>You</b> read it and send it, from your own email. I never message anyone for you.",
    ]) +
    p(`Nothing to set up, it's already on every role. Next time one lands, look for the <b style='font-weight:600;'>&#129309;</b> link just under the role and give it a tap.`);
  return {
    subject: "New: a real person to reach out to, with every role",
    html: emailShell({ preheader: "Every role now comes with a warm intro: a real contact, and a note I've drafted for you to send.", title: "A warm intro with every role", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `Applying cold is the worst part of a job search. So here's what's new: on every role I send you, there's now a link, "find me a warm intro."\n\nTap it and I'll find a real person at that company worth reaching out to, and hand you a short note to send them:\n- a real, verified contact: name, title, and LinkedIn\n- a short, honest intro written from your own background (and portfolio if you have one)\n- it opens right in your inbox, phone or laptop\n- you read it and send it yourself. I never message anyone for you.\n\nNothing to set up, it's already on every role. Next time one lands, look for the link just under the role.\n\nCharlie`,
  };
}

// Ack for the "track this application" button (a self-initiated tracking start, not a company reply).
export function renderTrackStarted({ email, role } = {}) {
  const r = role ? esc(role) : "this one";
  const content =
    h1("Got it, I'm tracking it.") +
    p(`I'll keep an eye on <b style='font-weight:600;'>${r}</b> for you. Whenever you hear anything back, just forward that email to <b style='font-weight:600;'>track@mail.example.com</b> and I'll follow where it goes, applied, heard back, interview, offer.`) +
    p(`No dashboard, no logging in. I'll only nudge you if something needs you.`);
  return {
    subject: `Got it, I'm tracking ${role || "this one"}`,
    html: emailShell({ preheader: "I'm tracking this application, forward any reply and I'll follow it.", title: "Tracking started", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieapplied" }),
    text: `Got it, I'm tracking ${role || "this application"}. Whenever you hear back, forward that email to track@mail.example.com and I'll follow where it goes.\n\nCharlie`,
  };
}

// The warm-intro finder found a person: show who they are and a one-tap "send intro" that
// opens a pre-written note in the USER'S OWN mail app (mailto, native, no browser), with an
// "open in Gmail" alternative. Charlie never emails the contact. `mailtoUrl` = the native
// compose to the person; `gmailUrl` = the Gmail-web alternative; `hasResume` announces the
// tailored resume attached to THIS email (mailto can't attach, so the user drags it in).
export function renderReferralFound({ email, contact = {}, company = "", roleTitle = "", mailtoUrl = "#", gmailUrl = "", hasResume = false } = {}) {
  const co = company ? esc(company) : "the company";
  // plaintext-safe: strip em dashes (external contact data) WITHOUT HTML-escaping & < > "
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.frame};border-radius:10px;margin:2px 0 6px;"><tbody><tr><td style="padding:15px 16px;">
      <div style="font-family:${HEAD_FONT};font-size:16px;font-weight:400;color:${C.ink};margin:0 0 3px;letter-spacing:-.01em;">${esc(contact.name || "someone at " + co)}</div>
      ${contact.position ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};margin:0 0 3px;">${esc(contact.position)}${company ? ` &middot; ${co}` : ""}</div>` : ""}
      ${contact.email ? `<div style="font-family:${SANS};font-size:13px;color:${C.muted};">${esc(contact.email)}</div>` : ""}
      ${contact.linkedin ? `<div style="margin-top:9px;"><a href="${esc(contact.linkedin)}" target="_blank" style="font-family:${SANS};font-size:12.5px;color:${C.coral};text-decoration:none;font-weight:600;">View on LinkedIn</a></div>` : ""}
    </td></tr></tbody></table>`;
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:20px auto 4px;"><tbody><tr>
      <td bgcolor="${C.coral}" style="border-radius:8px;">
        <a href="${esc(mailtoUrl)}" target="_blank" style="display:inline-block;font-family:${SANS};font-size:14.5px;font-weight:600;color:${C.white};text-decoration:none;padding:13px 26px;border-radius:8px;">&#9993;&#65039; Send intro &rarr;</a>
      </td>
    </tr></tbody></table>`;
  const alt = gmailUrl
    ? `<div style="text-align:center;margin:0 0 4px;"><a href="${esc(gmailUrl)}" target="_blank" style="font-family:${SANS};font-size:11.5px;color:${C.muted};text-decoration:underline;">or open it in Gmail</a></div>`
    : "";
  const resumeLine = hasResume
    ? p(`Your resume, tailored to this role, is <b style='font-weight:600;'>attached to this email</b>. Drag it into the message before you send.`)
    : "";
  const content =
    lead("a warm intro") +
    h1(`Someone who could get you noticed at ${co}.`) +
    p(`Before you apply cold, here's a real person worth a quick hello. I've drafted a short, honest intro from you, tap below and it opens right in your mail app, ready to read over and send.`) +
    card +
    p(`This is my best read on the right person to reach, give it a glance before you send. And to be clear: <b style='font-weight:600;'>you</b> send it, from your inbox. I never email them for you.`) +
    resumeLine +
    button +
    alt;
  return {
    subject: `A warm intro at ${company || "the company"}${roleTitle ? `, for the ${roleTitle}` : ""}`,
    html: emailShell({ preheader: `${contact.name || "Someone"} at ${company || "the company"} could get you noticed. I've drafted the intro, you send it.`, title: "A warm intro", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieintros" }),
    text: `Before you apply cold at ${deDash(company) || "the company"}, here's a real person worth a hello:\n\n${deDash(contact.name) || "(name)"}${contact.position ? `, ${deDash(contact.position)}` : ""}\n${deDash(contact.email) || ""}${contact.linkedin ? `\n${deDash(contact.linkedin)}` : ""}\n\nI've drafted a short, honest intro from you. Open it in your own mail app here, read it over, and send it yourself (I never email them for you):\n\n${mailtoUrl}\n\n${hasResume ? "Your tailored resume is attached to this email, drag it into the message before you send.\n\n" : ""}Charlie`,
  };
}

// The finder came up empty (no named contact, or we couldn't verify one). Honest, no filler.
export function renderReferralNone({ email, company = "" } = {}) {
  const co = company ? esc(company) : "that company";
  const content =
    h1(`I couldn't find a warm intro at ${co}.`) +
    p(`I looked for a real person there worth reaching out to, but I couldn't find one I'm confident about right now, so I'd rather tell you straight than send you to the wrong inbox.`) +
    p(`Applying directly is still a solid move, the role's in your last email. If you want, forward any reply you get to <b style='font-weight:600;'>track@mail.example.com</b> and I'll track where it goes.`);
  return {
    subject: `No warm intro I'm sure of at ${company || "that company"}`,
    html: emailShell({ preheader: "I couldn't find a contact I'm confident about, applying directly is still solid.", title: "No warm intro yet", contentHtml: content, unsubUrl: unsubUrlFor(email) }),
    text: `I looked for a real person at ${company || "that company"} worth reaching out to, but couldn't find one I'm confident about right now, so I'd rather say so than send you to the wrong inbox.\n\nApplying directly is still a solid move, the role's in your last email. Forward any reply to track@mail.example.com and I'll track it.\n\nCharlie`,
  };
}

// The signed link for the warm-intro finder → GET /warm-intro/<token>. Carries the user +
// the role it was sent for; the page does the lookup on open (so quota is spent only on a tap).
export function warmIntroUrl(email, findId) {
  return `${BASE}/warm-intro/${signEvent({ e: String(email || "").toLowerCase(), f: findId || null, v: "referral" })}`;
}

// The single, mobile-first page the 🤝 button opens. A static branded shell that, on load,
// fetches <path>/find and renders the contact + the drafted intro inline, with a native
// "send intro" (mailto, no tab pileup) and an "open in Gmail" fallback. One tab, no 2nd email.
// All contact/draft values are injected via textContent / href in JS, never string-built HTML.
export function warmIntroPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONT_LINK}<title>Charlie · warm intro</title>
<style>
  :root{--ink:${C.ink};--muted:${C.muted};--faint:${C.faint};--blue:${C.coral};--line:${C.line};--soft:${C.soft};--frame:${C.frame};--text:${C.text};--body:${C.body}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--body);font-family:${SANS};color:var(--ink);-webkit-font-smoothing:antialiased}
  .wrap{max-width:520px;margin:0 auto;padding:28px 18px 60px}
  .head{text-align:center;margin:6px 0 18px}
  .head img{width:32px;height:32px;vertical-align:middle}
  .card{background:${C.card};border:1px solid var(--line);border-radius:16px;padding:22px 20px}
  h1{font-family:${HEAD_FONT};font-weight:400;font-size:22px;line-height:1.25;letter-spacing:-.01em;margin:0 0 10px}
  p{font-size:14.5px;line-height:1.6;color:var(--text);margin:0 0 12px}
  .lead{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--blue);margin:0 0 10px}
  .who{background:var(--frame);border-radius:10px;padding:14px 15px;margin:2px 0 14px}
  .who .nm{font-family:${HEAD_FONT};font-size:17px;color:var(--ink);margin:0 0 3px;letter-spacing:-.01em}
  .who .ti{font-size:13px;color:var(--text);margin:0 0 3px}
  .who .em{font-size:13px;color:var(--muted);word-break:break-all}
  .who .li{display:inline-block;margin-top:8px;font-size:13px;color:var(--blue);text-decoration:none;font-weight:600}
  .draft{background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px 15px;margin:0 0 16px;white-space:pre-wrap;font-size:13.5px;line-height:1.6;color:var(--text)}
  .btn{display:block;text-align:center;background:var(--blue);color:${C.white};text-decoration:none;font-weight:600;font-size:15px;padding:14px 22px;border-radius:8px;margin:0 0 10px}
  .alt{display:block;text-align:center;color:var(--muted);text-decoration:underline;font-size:12.5px;margin:0 0 4px}
  .note{font-size:12px;color:var(--faint);text-align:center;margin:14px 0 0}
  .spin{width:26px;height:26px;border:3px solid var(--line);border-top-color:var(--blue);border-radius:50%;animation:s 0.8s linear infinite;margin:8px auto 14px}
  @keyframes s{to{transform:rotate(360deg)}}
  .center{text-align:center}
</style></head>
<body><div class="wrap">
  <div class="head"><img src="${HAND}" alt="Charlie"></div>
  <div class="card" id="card">
    <div class="center"><div class="spin"></div><p class="center" style="color:var(--muted)">Finding someone who could get you noticed, one sec…</p></div>
  </div>
  <div class="note">You send it, from your own inbox. I never email them for you.</div>
</div>
<script>
(function(){
  var card=document.getElementById('card');
  function el(t,c,txt){var e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e;}
  function render(d){
    card.innerHTML='';
    if(!d||d.none||!d.contact){
      card.appendChild(el('h1',null,'No warm intro I\\'m sure of'+(d&&d.company?(' at '+d.company):'')+'.'));
      card.appendChild(el('p',null,'I looked for a real person there worth reaching out to, but couldn\\'t find one I\\'m confident about right now. Applying directly is still a solid move, the role\\'s in your email.'));
      return;
    }
    var c=d.contact;
    card.appendChild(el('div','lead','a warm intro'+(d.company?(' at '+d.company):'')));
    card.appendChild(el('h1',null,'Here\\'s someone worth a hello.'));
    card.appendChild(el('p',null,'Before you apply cold, reach out to a real person. I drafted a short, honest intro from you, read it over and send it yourself.'));
    var who=el('div','who');
    who.appendChild(el('div','nm',c.name||'Someone'));
    if(c.position)who.appendChild(el('div','ti',c.position+(d.company?(' · '+d.company):'')));
    if(c.email)who.appendChild(el('div','em',c.email));
    if(c.linkedin){var a=el('a','li','› Connect on LinkedIn');a.href=c.linkedin;a.target='_blank';a.rel='noopener';who.appendChild(a);}
    card.appendChild(who);
    card.appendChild(el('div','draft',d.body||''));
    var send=el('a','btn','✉️ Send intro');send.href=d.mailto||'#';card.appendChild(send);
    if(d.gmail){var g=el('a','alt','Open it in Gmail instead');g.href=d.gmail;g.target='_blank';g.rel='noopener';card.appendChild(g);}
    card.appendChild(el('p','note','Give it a glance before you send.'));
  }
  fetch(location.pathname.replace(/\\/$/,'')+'/find',{headers:{'accept':'application/json'}})
    .then(function(r){return r.json();}).then(render)
    .catch(function(){
      card.innerHTML='';
      card.appendChild(el('h1',null,'That didn\\'t load.'));
      card.appendChild(el('p',null,'Something hiccuped finding a contact. Try opening the link again from your email in a minute.'));
    });
})();
</script>
</body></html>`;
}

// a tiny branded page shown after a one-click feedback tap (served by GET /e/<token>)
export function feedbackPage(message, ok = true) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONT_LINK}<title>Charlie</title></head>
<body style="margin:0;background:${C.body};font-family:${SANS};color:${C.ink};">
  <div style="max-width:440px;margin:0 auto;padding:18vh 24px 0;text-align:center;">
    <img src="${HAND}" width="34" height="34" alt="Charlie">
    <h1 style="font-family:${HEAD_FONT};font-weight:400;font-size:22px;letter-spacing:-.01em;color:${C.ink};margin:18px 0 8px;">${ok ? "Got it." : "Hmm."}</h1>
    <p style="font-size:14px;line-height:1.6;color:${C.text};margin:0;">${esc(message)}</p>
    <p style="font-size:12px;color:${C.faint};margin:22px 0 0;">You can close this tab.</p>
  </div>
</body></html>`;
}

// The gift landing page (served by GET /g/<token>): what a friend sees after tapping a referral link.
// Email is Charlie's only door, so this page does NOT sign anyone up — it hands off to start@ with a
// prefilled email carrying the ref marker, and the friend sends it themselves (consent = their send).
// The desktop-webmail fallback (a plain start@ address + instruction) exists because a mailto that
// opens nothing must still leave a way in. `token` is the giver's signed code; it rides in the body as
// [fref:<token>] so /inbound attributes the signup back to the giver + their A/B variant.
export function giftLandingPage({ token = "", giverName = "" } = {}) {
  // grounded FIRST name only, guarded against a junk ALL-CAPS section-header name (the renderOutOfMarket
  // guard) landing in the name slot; else a warm generic. Never invents a name.
  const clean = /[a-z]/.test(String(giverName)) && String(giverName).trim().split(/\s+/).length <= 3 ? String(giverName).trim() : "";
  const who = clean ? clean.split(/\s+/)[0] : "A friend";
  const title = `${who} gave you Charlie.`;
  const start = process.env.CHARLIE_START_ADDR || "start@mail.example.com";
  const subject = "A friend sent me to Charlie";
  const bodyText = `Hi Charlie, a friend pointed me your way.\n\nI'm attaching my resume. A couple of lines on what I'm after:\n- the kind of role I want:\n- remote, a city, or either:\n- my pay floor:\n\n(please keep this line so my friend gets the credit: [fref:${token}])`;
  const mailto = `mailto:${start}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="Charlie">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="A friend put Charlie in your corner. Honest about the job hunt, and only reaches out when a role is actually worth your time. No spam, ever.">
<meta property="og:image" content="${SITE}/charlie-og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="A friend put Charlie in your corner. An honest career agent for the job hunt."><meta name="twitter:image" content="${SITE}/charlie-og.png">
${FONT_LINK}<title>Charlie · a gift from a friend</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${C.body};font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased}
  .wrap{max-width:480px;margin:0 auto;padding:32px 20px 60px}
  .head{text-align:center;margin:6px 0 20px}
  .head img{width:34px;height:34px}
  .card{background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:26px 24px}
  .lead{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 10px;text-align:center}
  h1{font-family:${HEAD_FONT};font-weight:400;font-size:26px;line-height:1.2;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;text-align:center}
  p{font-size:15px;line-height:1.6;color:${C.text};margin:0 0 14px}
  .btn{display:block;text-align:center;background:${C.green};color:${C.white};text-decoration:none;font-weight:600;font-size:15px;padding:15px 22px;border-radius:10px;margin:20px 0 12px}
  .fallback{font-size:12.5px;line-height:1.6;color:${C.muted};text-align:center;margin:8px 0 0}
  .fallback b{color:${C.text}}
</style></head>
<body><div class="wrap">
  <div class="head"><img src="${HAND}" alt="Charlie"></div>
  <div class="card">
    <div class="lead">a gift from a friend</div>
    <h1>${esc(title)}</h1>
    <p>${esc(who)} has been using Charlie to job hunt, and thought of you. It reads the market every day and only reaches out when a role is actually worth your time. No spam, ever.</p>
    <p>Want in? One email starts it. Attach your resume and a line on what you're after, and Charlie takes it from there.</p>
    <a class="btn" href="${esc(mailto)}">Start with Charlie</a>
    <p class="fallback">Button not opening? Email <b style='font-weight:600;'>${esc(start)}</b> yourself with your resume attached, and you're in.</p>
  </div>
</div></body></html>`;
}

// The fit-check landing (served by GET /j/<token>): a friend tapped a gifted role. Its ONLY job is the
// unfurl card + one button, "See if you're a fit", which hands off to check@ with the role + ref marker.
// Email is still the only door: the friend sends the mail themselves (consent = their send), attaches a
// resume, and gets Charlie's HONEST read on this exact role (the check@ scorecard), which invites them
// in. `token` = signEvent({e:giver, j:jobId}); it rides in the mailto body as [fref:<token>] so check@
// resolves the role + attributes the referral. Name-aware ("<Giver> flagged this for you"), OG unfurl.
export function fitCheckPage({ token = "", giverName = "", role = {} } = {}) {
  const clean = /[a-z]/.test(String(giverName)) && String(giverName).trim().split(/\s+/).length <= 3 ? String(giverName).trim() : "";
  const who = clean ? clean.split(/\s+/)[0] : "A friend";
  const title = role.title || "this role";
  const company = role.company || "";
  const loc = role.location || "";
  const coline = [company, loc].filter(Boolean).join(" · ");
  const roleLine = `${title}${company ? ` at ${company}` : ""}`;
  const check = (process.env.CHARLIE_START_ADDR || "start@mail.example.com").replace(/^[^@]+@/, "check@");
  const subject = `Am I a fit? ${roleLine}`;
  const bodyText = `Hi Charlie, ${who} sent me this role and I'd like to know if I fit.\n\nI'm attaching my resume.\n\n(please keep this line so my friend gets the credit: [fref:${token}])`;
  const mailto = `mailto:${check}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  const ogDesc = `${who} flagged this role for you. See Charlie's honest read on whether you fit, in one reply.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:type" content="website"><meta property="og:site_name" content="Charlie">
<meta property="og:title" content="${esc(roleLine)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:image" content="${SITE}/charlie-og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(roleLine)}"><meta name="twitter:description" content="${esc(ogDesc)}"><meta name="twitter:image" content="${SITE}/charlie-og.png">
${FONT_LINK}<title>Charlie · ${esc(roleLine)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${C.body};font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased}
  .wrap{max-width:480px;margin:0 auto;padding:32px 20px 60px}
  .head{text-align:center;margin:6px 0 20px}
  .head img{width:34px;height:34px}
  .card{background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:26px 24px;text-align:center}
  .lead{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.coral};margin:0 0 10px}
  h1{font-family:${HEAD_FONT};font-weight:400;font-size:25px;line-height:1.2;letter-spacing:-.01em;color:${C.ink};margin:0 0 5px}
  .co{font-size:14px;color:${C.muted};margin:0 0 16px}
  p{font-size:15px;line-height:1.6;color:${C.text};margin:0 0 18px}
  .btn{display:inline-block;background:${C.green};color:${C.white};text-decoration:none;font-weight:600;font-size:15px;padding:14px 26px;border-radius:11px}
  .fallback{font-size:12.5px;line-height:1.6;color:${C.muted};margin:14px 0 0}
  .fallback b{color:${C.text}}
</style></head>
<body><div class="wrap">
  <div class="head"><img src="${HAND}" alt="Charlie"></div>
  <div class="card">
    <div class="lead">${esc(who)} flagged this for you</div>
    <h1>${esc(title)}</h1>
    ${coline ? `<div class="co">${esc(coline)}</div>` : ""}
    <p>Want to know if you actually fit? Attach your resume and I'll send you a straight read on this exact role. One email, no account.</p>
    <a class="btn" href="${esc(mailto)}">See if you're a fit</a>
    <p class="fallback">Button not opening? Email <b style='font-weight:600;'>${esc(check)}</b> yourself with your resume attached.</p>
  </div>
</div></body></html>`;
}

// a small branded HTML page for the unsubscribe confirmation (served by GET /unsubscribe)
export function unsubscribePage(message, ok = true) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONT_LINK}<title>Charlie</title></head>
<body style="margin:0;background:${C.body};font-family:${SANS};color:${C.ink};">
  <div style="max-width:440px;margin:0 auto;padding:18vh 24px 0;text-align:center;">
    <img src="${HAND}" width="34" height="34" alt="Charlie">
    <h1 style="font-family:${HEAD_FONT};font-weight:400;font-size:22px;letter-spacing:-.01em;color:${C.ink};margin:18px 0 8px;">${ok ? "You're unsubscribed." : "Hm, that didn't work."}</h1>
    <p style="font-size:14px;line-height:1.6;color:${C.text};margin:0;">${esc(message)}</p>
    <p style="font-size:12px;color:${C.faint};margin:22px 0 0;">Changed your mind? Just email start@mail.example.com and I'll pick things back up.</p>
  </div>
</body></html>`;
}

// The GET /unsubscribe landing: a ONE-TAP confirm, not an automatic unsubscribe. Mail-security
// scanners fetch (GET) every link in an email to check it, so a GET that unsubscribes on load will
// silently opt out engaged people the moment a scanner touches their welcome. The real unsubscribe
// is the POST this button submits (which is also where Gmail's RFC 8058 one-click already lands).
// `token` is the same signed `t` the email carried; it rides through to the POST unchanged.
export function unsubscribeConfirmPage(token) {
  const action = `/unsubscribe?t=${encodeURIComponent(String(token || ""))}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${FONT_LINK}<title>Charlie</title></head>
<body style="margin:0;background:${C.body};font-family:${SANS};color:${C.ink};">
  <div style="max-width:440px;margin:0 auto;padding:18vh 24px 0;text-align:center;">
    <img src="${HAND}" width="34" height="34" alt="Charlie">
    <h1 style="font-family:${HEAD_FONT};font-weight:400;font-size:22px;letter-spacing:-.01em;color:${C.ink};margin:18px 0 8px;">Stop emails from Charlie?</h1>
    <p style="font-size:14px;line-height:1.6;color:${C.text};margin:0 0 22px;">Tap once to confirm and Charlie won't email you anymore.</p>
    <form method="post" action="${action}" style="margin:0;">
      <button type="submit" style="font-family:${SANS};font-size:15px;font-weight:600;color:#fff;background:${C.green};border:none;border-radius:10px;padding:13px 26px;cursor:pointer;">Yes, unsubscribe me</button>
    </form>
    <p style="font-size:12px;color:${C.faint};margin:22px 0 0;">Didn't mean to? Just close this tab. Nothing happens unless you tap.</p>
  </div>
</body></html>`;
}


// ── THE REPRESENT EMAILS ─────────────────────────────────────────────────────
// Three outcomes for somebody who applied to a role Charlie posted, and all three are an answer. A
// person who filled in a form and hears nothing has been treated worse than a person who is told no.
//
// THE COMPANY IS NAMED ONLY IN THE OFFER. The posting was anonymised; naming it in a rejection turns
// our no into a direct-apply lead for somebody else's pipeline.

// charlieBlock carries no "what charlie is" paragraph. A person who applied months ago and has heard
// nothing does not need to be told what we sell; they need to be told what happened. HTML-only content
// is also invisible in any review of the `text` half, so emails/html-text-parity.test.mjs fails when
// the two halves diverge.
//
// The divider stays: it is the visual close of every mail and the unsubscribe sits under it.
const charlieBlock = () =>
  `<div style="border-top:1px solid ${C.line};margin:26px 0 0;padding:20px 0 0;"></div>`;

const storyCard = (story) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;"><tbody><tr>
    <td style="background:${C.soft};border-radius:10px;padding:18px 20px;">
      <p style="font-family:${SANS};font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${C.muted};margin:0 0 10px;">the story I would send with your name</p>
      <p style="font-family:${SANS};font-size:15px;line-height:1.62;color:${C.ink};margin:0;">${esc(story)}</p>
    </td>
  </tr></tbody></table>`;

const primaryBtn = (url, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 10px;"><tbody><tr>
    <td style="background:${C.ink};border-radius:8px;">
      <a href="${esc(url)}" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.white};text-decoration:none;padding:12px 22px;">${esc(label)} &rarr;</a>
    </td>
  </tr></tbody></table>`;

/** One line under a button. Small, muted, and never a second sentence. */
const caption = (text) =>
  `<p style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};margin:-4px 0 18px;">${text}</p>`;

const secondaryBtn = (url, label) =>
  `<div style="margin:0 0 16px;"><a href="${esc(url)}" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.ink};text-decoration:none;border:1px solid ${C.line};border-radius:8px;padding:11px 20px;">${esc(label)} &rarr;</a></div>`;

/**
 * A. You are one of the shortlist. Names the company, hands over the story, offers two doors.
 *
 * TWO DOORS ON PURPOSE. The introduction is the thing only we can do, but making it the only route
 * turns Charlie into a gate. Applying directly costs us nothing and is often faster for them.
 */
export function renderRepresentOffer({ email, name = "", company = "", roleTitle = "", story = "", fitPoints = [], referralUrl = "", introUrl = "", jdUrl = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("your update") +
    h1(`The company is ${company}.`) +
    p(`${nm ? `Hi${nm}, here` : "Here"}'s where your application landed. The role is <b style="color:${C.ink};font-weight:600;">${esc(roleTitle)}</b> at <b style="color:${C.ink};font-weight:600;">${esc(company)}</b>, and you are on the short list I am putting forward.`) +
    p(`Rather than tell you that you are a strong fit, here is the thing I would actually send with your name. Every line of it comes from what you wrote.`) +
    storyCard(story) +
    (fitPoints.length ? lead("what earned it") + bullets(fitPoints.map((f) => `<b style="color:${C.ink};font-weight:600;">${esc(f.label)}.</b> ${esc(f.quote)}`)) : "") +
    // TWO BUTTONS, NOT THREE PARAGRAPHS. The first draft explained the referral mechanism, the
    // recommendation offer and the limits of both, in about ninety words. Nobody reads ninety words to
    // find out what to click. Each action gets a button and one line under it, and the mechanism is
    // implied by the line rather than described.
    //
    // AND NOT IN THE FIRST PERSON SINGULAR. "My referral link", "referred by me", "I can attach a
    // recommendation": three sentences that made the offer about the person sending it. The applicant
    // does not care whose link it is, and the copy reads as a favour being described rather than an
    // action being offered.
    p(`Two ways forward. Either is fine, and nothing reaches ${esc(company)} until you pick one.`) +
    (referralUrl ? primaryBtn(referralUrl, `Apply to ${company}`) : "") +
    caption(`Applies through Charlie, so you arrive referred rather than cold.`) +
    (introUrl ? secondaryBtn(introUrl, "Ask for an intro") : "") +
    caption(`Your story goes to ${esc(company)} directly, with a recommendation attached.`) +
    (jdUrl ? p(`<a href="${esc(jdUrl)}" style="color:${C.coral};text-decoration:none;font-weight:600;">The full brief</a>, if you want to read it again before you do.`) : "") +
    charlieBlock();
  return {
    subject: `Your update: the company is ${company}`,
    html: emailShell({ preheader: `You are on the short list. Here is the story I would send with your name.`, title: "Your update", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresent" }),
    text: `Here's where your application landed. The role is ${roleTitle} at ${company}, and you are on the short list I am putting forward.\n\nRather than tell you that you are a strong fit, here is what I would send with your name. Every line comes from what you wrote.\n\n"${deDash(story)}"\n\nTwo ways forward. Either is fine, and nothing reaches ${company} until you pick one.\n\nApply to ${company}: ${referralUrl}\n  You arrive referred rather than cold.\n\nAsk for an intro: reply to this email.\n  Your story goes to ${company} directly, with a recommendation attached.\n\nMost hiring reads a resume for keywords and a score. I read what you have actually done and write the story of it, in your own words, with the evidence attached. That story is the only thing I put in front of a company.\n\nCharlie`,
  };
}

/**
 * B. A complete application, and a plain no.
 *
 * DELIBERATELY NOT SPECIFIC. It does not name the shortlist size or the exact requirement the person
 * fell short on: the count is nobody's business but ours, and an itemised reason invites an argument
 * about the wrong thing.
 *
 * Four sentences. Their name, the role, and the fact. No score, no count, no list of what they
 * lacked. The "you are on my list" line appears ONLY for somebody who opted in, because to anyone
 * else it is a promise we have no permission to keep.
 */
/**
 * Charlie replied to somebody with the wrong conversation, and owes them a correction.
 *
 * Shaped like renderRoleCorrection: the template lives here so the locked design system is inherited,
 * and every sentence is passed in by a hand-run script, because a correction is a person deciding to
 * say a specific thing to a specific person and is never model-generated.
 *
 * It opens by naming what was wrong in one sentence and then gets on with the real answer. A
 * correction that spends four paragraphs apologising makes the reader carry the mistake for us.
 */
export function renderAskCorrection({ email, name = "", wrong = "", answer = "", next = "", either = "", promise = "" } = {}) {
  const content =
    lead("a correction") +
    h1("That last reply was wrong.") +
    (name ? p(`Hi ${esc(name.split(" ")[0])},`) : "") +
    p(esc(wrong)) +
    p(`Here is the real answer.`) +
    p(esc(answer)) +
    p(esc(next)) +
    (either ? p(esc(either)) : "") +
    (promise ? p(esc(promise)) : "") +
    charlieBlock();
  return {
    subject: "About that last reply, and where this actually stands",
    html: emailShell({ preheader: "That reply was wrong. Here is the real answer.", title: "About that last reply", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieaskcorrection" }),
    text: `${name ? `Hi ${name.split(" ")[0]},\n\n` : ""}${deDash(wrong)}\n\nHere is the real answer.\n\n${deDash(answer)}\n\n${deDash(next)}${either ? `\n\n${deDash(either)}` : ""}${promise ? `\n\n${deDash(promise)}` : ""}\n\nCharlie`,
  };
}

/**
 * They answered the question we asked. Say so, and do not pretend to know what happens next.
 *
 * WHY. Answered with the generic preference acknowledgement, the person would be told which profile
 * fields changed and asked what kind of role they want, minutes after being told about a specific one.
 * This is what goes instead, and its whole job is to be true.
 *
 * IT PROMISES NOTHING, because there may be nothing to promise: an informal brief and no confirmed
 * process. Inventing "the team will review within a week" is what every other
 * recruiter does and it is the sentence that makes the rest worthless. It commits to exactly one
 * thing, which is coming back either way, including with a no.
 */
export function renderAskAnswerAck({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("noted") +
    h1("Got it, thank you.") +
    p(`${nm ? `Thanks${nm}, that` : "That"} is exactly what I needed, and it is on your record now so I do not have to ask twice.`) +
    p(`Where this honestly stands: I am taking the shape of your background to the hiring side, without your name on it, and I will come back to you with what I hear. That includes coming back to say it went nowhere, if that is the answer. I would rather tell you that than leave you waiting on an email that never arrives.`) +
    p(`Nothing with your name on it moves until you tell me it can.`) +
    charlieBlock();
  return {
    subject: "Got it, thank you",
    html: emailShell({ preheader: "Noted, and I will come back either way.", title: "Got it", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieaskack" }),
    text: `${name ? `Thanks ${name.split(" ")[0]}, that` : "That"} is exactly what I needed, and it is on your record now so I do not have to ask twice.\n\nWhere this honestly stands: I am taking the shape of your background to the hiring side, without your name on it, and I will come back to you with what I hear. That includes coming back to say it went nowhere, if that is the answer. I would rather tell you that than leave you waiting on an email that never arrives.\n\nNothing with your name on it moves until you tell me it can.\n\nCharlie`,
  };
}

/**
 * One question, because one answer decides whether they can be put forward at all.
 *
 * The brief is two to four years and these people left the years question blank on the form. Reading
 * a number off their resume and then filtering on that reading is how somebody gets rejected on our
 * arithmetic rather than their own: a resume that reads as 4.9 years can be recorded as 4, and the
 * person is filtered on a number they never gave. So the person who knows the answer is asked for it.
 *
 * IT SAYS WHY, AND IT SAYS THE BAND. Somebody who is outside two to four should be able to work that
 * out from this email and not bother replying, rather than answer and then be turned down for the
 * thing they were just asked about.
 */
export function renderYearsAsk({ email, name = "", roleTitle = "", band = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("one question") +
    h1("One thing before I put you forward.") +
    p(`${nm ? `Hi${nm}, your` : "Your"} application for the ${esc(roleTitle)} role reads well, and there is one box on the form you left blank: how many years of professional cloud or infrastructure experience you have.`) +
    p(`I need it because the role is ${esc(band)}, and I am not going to guess a number off your resume and then filter you on my own guess.`) +
    p(`Reply with the number. That is the whole reply, and it is the only thing standing between this and going to the hiring managers.`) +
    charlieBlock();
  return {
    subject: "One question before I put you forward",
    html: emailShell({ preheader: "How many years of cloud or infrastructure experience? That is the whole question.", title: "One question", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieyearsask" }),
    text: `${name ? `Hi ${name.split(" ")[0]}, your` : "Your"} application for the ${roleTitle} role reads well, and there is one box on the form you left blank: how many years of professional cloud or infrastructure experience you have.\n\nI need it because the role is ${band}, and I am not going to guess a number off your resume and then filter you on my own guess.\n\nReply with the number. That is the whole reply, and it is the only thing standing between this and going to the hiring managers.\n\nCharlie`,
  };
}

/**
 * You are through, and your profile is going to the hiring manager. The shortest thing that can be
 * said honestly.
 *
 * IT DOES NOT ASK THEM TO DO ANYTHING. We forward the profile ourselves, so the only correct next
 * line is that there is nothing for them to do.
 *
 * NO STORY BLOCK, NO SCORECARD, NO FIT POINTS. They applied for one role at one company and the
 * useful facts are: you are through, here is where it is going, here is the job, here is what
 * happens next. Everything else is us admiring our own process in somebody's inbox.
 *
 * THE PERMISSION IS THE APPLICATION ITSELF. This form has no consent questions of any kind, so it
 * carries no permission to write to these people about other roles, and nothing here implies one.
 * Being put forward for the role they applied to is what applying means.
 */
export function renderRoleForward({ email, name = "", company = "", roleTitle = "", roleFacts = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("your application") +
    h1("You are through.") +
    p(`${nm ? `Hi${nm}, your` : "Your"} profile is going to the hiring managers at ${esc(company)}, for the ${esc(roleTitle)} role.`) +
    (roleFacts ? p(esc(roleFacts)) : "") +
    p(`You do not need to do anything now. If they want to talk, I will come back to you with the details.`) +
    charlieBlock();
  return {
    subject: "You are through",
    html: emailShell({ preheader: `Your profile is going to ${company}.`, title: "You are through", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieroleforward" }),
    text: `${name ? `Hi ${name.split(" ")[0]}, your` : "Your"} profile is going to the hiring managers at ${company}, for the ${roleTitle} role.\n\n${roleFacts ? deDash(roleFacts) + "\n\n" : ""}You do not need to do anything now. If they want to talk, I will come back to you with the details.\n\nCharlie`,
  };
}

/**
 * One nudge on the studio ask, for the people who have not answered.
 *
 * IT IS EASY TO IGNORE, ON PURPOSE. A reminder that leans on somebody is a reminder that earns an
 * unsubscribe, and the drip-removal rule here is explicit: Charlie sends roles, the market read,
 * information gathering, confirmations and replies, and nothing else. This is information gathering
 * about one real role, sent once, and it says plainly that silence is a complete answer.
 *
 * IT REPEATS THE FACTS RATHER THAN THE ASK. Somebody who did not reply may simply not remember the
 * email, so the numbers are restated. It adds no new question: a reminder that grows a second set of
 * questions is a new ask wearing a reminder's clothes.
 */
export function renderStudioReminder({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("one nudge") +
    h1("Still worth a minute?") +
    p(`${nm ? `Hi${nm}, I` : "I"} wrote a few days ago about a design lead role and did not hear back, which is completely fine. This is the only time I will nudge you about it.`) +
    p(`The facts again, in case the first one got buried: a consultancy that designs apps for its clients, in Kolkata, hybrid rather than remote, seven years or more, and the budget goes up to 32 lakhs. The work is design alongside planning the work, coaching the junior designers, and presenting to clients yourself.`) +
    p(`If it is interesting, two things I still do not know about you:`) +
    bullets([
      "Would you work onsite in Kolkata for this? If you are not there now, would you move?",
      "Does the budget work for you?",
    ]) +
    p(`If it is not for you, saying nothing is a complete answer and I will leave this one alone. It does not affect anything else I send you.`) +
    p(`Nothing about you goes to any company until you tell me it can.`) +
    charlieBlock();
  return {
    subject: "One nudge on that Kolkata design lead role",
    html: emailShell({ preheader: "Kolkata, hybrid, up to 32 lakhs. The only time I will ask.", title: "Still worth a minute?", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliestudioreminder" }),
    text: `${name ? `Hi ${name.split(" ")[0]}, I` : "I"} wrote a few days ago about a design lead role and did not hear back, which is completely fine. This is the only time I will nudge you about it.\n\nThe facts again, in case the first one got buried: a consultancy that designs apps for its clients, in Kolkata, hybrid rather than remote, seven years or more, and the budget goes up to 32 lakhs. The work is design alongside planning the work, coaching the junior designers, and presenting to clients yourself.\n\nIf it is interesting, two things I still do not know about you:\n\n- Would you work onsite in Kolkata for this? If you are not there now, would you move?\n- Does the budget work for you?\n\nIf it is not for you, saying nothing is a complete answer and I will leave this one alone. It does not affect anything else I send you.\n\nNothing about you goes to any company until you tell me it can.\n\nCharlie`,
  };
}

/**
 * A specific role, and the two things we do not know about the person.
 *
 * WHY IT ASKS INSTEAD OF MATCHING. Two fields decide this role and we hold neither for a single
 * designer in the pool: whether they would work onsite in Kolkata, and what they need to earn.
 * The designer form is the only one of the four that never asked either. Filtering on data we do not
 * have would silently drop people who would have said yes, which is the same failure as dropping
 * applicants over a consent they had actually given.
 *
 * IT ASKS ONLY WHEN THERE IS A ROLE. A speculative "please complete your profile" note has no payoff
 * for the person, earns no reply, and teaches them that mail from here is admin. A named role with
 * real numbers and two short questions is worth their minute, and the answers enrich the record
 * permanently whether or not this particular role goes anywhere.
 *
 * THE REPLY IS THE CONSENT. Nobody in this group has been asked whether their profile may go to an
 * employer, because that question does not exist on their form. So the copy promises that nothing
 * moves until they say it can, and their answer is what makes it true.
 *
 * The company is deliberately unnamed: we do not have permission to name it, and saying so is more
 * honest than a vague description that implies we are hiding something worse.
 */
export function renderStudioAsk({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("a role, and two questions") +
    h1("A design lead role in Kolkata.") +
    p(`${nm ? `Hi${nm}, a` : "A"} consultancy that designs apps for its clients is hiring a design lead, and I think it is worth your minute.`) +
    p(`What I know: it is in Kolkata, and it is hybrid rather than remote. Seven years or more. The budget goes up to 32 lakhs. The work is design alongside three other things: planning the work, coaching the junior designers, and presenting to clients yourself.`) +
    p(`That last part is the real question. It is a consultancy rather than a product company, so you would be in front of clients, not only in front of a product. Some designers want exactly that and some would hate it.`) +
    p(`I have not named the company because I do not have permission to yet. If it sounds interesting, there are two things I do not know about you:`) +
    bullets([
      "Would you work onsite in Kolkata for this? If you are not there now, would you move?",
      "Does the budget work for you?",
    ]) +
    p(`Reply and tell me. If it is a no on either, say that too and I will keep looking rather than waste your time.`) +
    p(`Nothing about you goes to any company until you tell me it can.`) +
    charlieBlock();
  return {
    subject: "A design lead role in Kolkata, and two questions",
    html: emailShell({ preheader: "Kolkata, hybrid, up to 32 lakhs. Two questions I cannot answer for you.", title: "A role, and two questions", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliestudioask" }),
    text: `${name ? `Hi ${name.split(" ")[0]}, a` : "A"} consultancy that designs apps for its clients is hiring a design lead, and I think it is worth your minute.\n\nWhat I know: it is in Kolkata, and it is hybrid rather than remote. Seven years or more. The budget goes up to 32 lakhs. The work is design alongside three other things: planning the work, coaching the junior designers, and presenting to clients yourself.\n\nThat last part is the real question. It is a consultancy rather than a product company, so you would be in front of clients, not only in front of a product.\n\nI have not named the company because I do not have permission to yet. If it sounds interesting, there are two things I do not know about you:\n\n- Would you work onsite in Kolkata for this? If you are not there now, would you move?\n- Does the budget work for you?\n\nReply and tell me. If it is a no on either, say that too and I will keep looking.\n\nNothing about you goes to any company until you tell me it can.\n\nCharlie`,
  };
}

export function renderRepresentNo({ email, name = "", roleTitle = "", optedIn = false } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("your update") +
    h1("Not this one.") +
    p(`${nm ? `Hi${nm}, your` : "Your"} application for the ${esc(roleTitle)} role did not go forward this time. I'd rather tell you that plainly than leave you waiting on an email that never comes.`) +
    p(`It did not meet the bar this company set, and that is the whole of it. It says something about one brief in one week, and nothing about your work.`) +
    (optedIn
      ? p(`You are on my list. When a role comes up where what you have actually done is the requirement rather than half of it, I will write to you.`)
      : "") +
    p(`Thanks for the time you put into it.`) +
    charlieBlock();
  return {
    subject: `Your update on the ${roleTitle} role`,
    html: emailShell({ preheader: optedIn ? "Not this one. You stay on the list." : "Not this one.", title: "Your update", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresentno" }),
    text: `${name ? `Hi ${name.split(" ")[0]}, your` : "Your"} application for the ${roleTitle} role did not go forward this time. I'd rather tell you that plainly than leave you waiting on an email that never comes.\n\nIt did not meet the bar this company set, and that is the whole of it. It says something about one brief in one week, and nothing about your work.\n\n${optedIn ? "You are on my list. When a role comes up where what you have actually done is the requirement rather than half of it, I will write to you.\n\n" : ""}Thanks for the time you put into it.\n\nCharlie`,
  };
}

/**
 * C. An incomplete application. A no on process, with the exact questions quoted back.
 *
 * `missing` is the real question titles from the form, not internal names, because being told "your
 * submission was incomplete" is a form letter and being told which question you skipped is a
 * conversation. The line about this role not reopening is deliberate: without it the email implies
 * finishing the form gets them reconsidered, and it does not.
 */
export function renderRepresentIncomplete({ email, name = "", roleTitle = "", missing = [], formUrl = "", optedIn = false } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("your update") +
    h1("I could not put you forward.") +
    p(`${nm ? `Hi${nm}, here` : "Here"}'s your update on the ${esc(roleTitle)} role, and it is a no, for a reason I would rather say plainly than dress up.`) +
    p(`The list I send is short, and what I put in front of a company is a person's story. I could not build yours, because the form came back incomplete. These are the questions you skipped:`) +
    bullets(missing.map((m) => esc(m))) +
    p(`That is not a judgement on your work. I never got far enough to have one. It is that I had nothing to show, and I will not pad a story to fill a gap.`) +
    (formUrl ? p(`<b style="color:${C.ink};font-weight:600;">You can finish it in three minutes.</b> Everything you already wrote is still there.`) + primaryBtn(formUrl, "Complete your answers") : "") +
    p(`It will not reopen this role, which closes with the list already going out. It means the next one is a real possibility rather than the same no.`) +
    (optedIn
      ? p(`You are on my list either way, and I will write when something fits.`)
      : p(`You did not ask me to write about other roles, so I won't. Finish the form or reply here and that changes.`)) +
    charlieBlock();
  return {
    subject: "Your update: I could not put you forward",
    html: emailShell({ preheader: `Nothing to do with your work. There ${missing.length === 1 ? "was one answer" : `were ${missing.length} answers`} missing.`, title: "Your update", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresentincomplete" }),
    text: `Here's your update on the ${roleTitle} role, and it is a no, for a reason I would rather say plainly.\n\nThe list I send is short, and what I put in front of a company is a person's story. I could not build yours, because the form came back incomplete. These are the questions you skipped:\n\n${missing.map((m) => `- ${deDash(m)}`).join("\n")}\n\nThat is not a judgement on your work. I never got far enough to have one.\n\nYou can finish it in three minutes: ${formUrl}\n\nIt will not reopen this role. It means the next one is a real possibility.\n\nCharlie`,
  };
}


/**
 * The heads-up: the hiring manager is about to read your story.
 *
 * WHY IT EXISTS. They consented to be represented, so this is not asking permission; it is telling
 * them before it happens. That costs one email and is the whole difference between being represented
 * and being processed.
 *
 * NOT A NUDGE. It does not chase them to apply, and there is no second one. A person who wants out
 * says so and is out, which is the only reason the first sentence is believable.
 */
export function renderRepresentHeadsUp({ email, name = "", company = "", roleTitle = "", referralUrl = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content =
    lead("before it happens") +
    h1(`Your story goes to ${esc(company)} this week.`) +
    p(`${nm ? `Hi${nm}, I` : "I"} said nothing would reach ${esc(company)} until you picked one of the two doors, so I am telling you before it does.`) +
    p(`Their hiring lead is reading the short list this week, and yours is on it: the story I wrote from your own words, and the work behind it. Nothing else, and nothing I made up.`) +
    p(`<b style="color:${C.ink};font-weight:600;">If you would rather I did not, reply "leave me out" and that is the end of it.</b> No explanation needed and it costs you nothing with me.`) +
    (referralUrl ? p(`If you have not applied yet, this is the moment. It takes a minute and you arrive referred rather than cold.`) + primaryBtn(referralUrl, `Apply to ${company}`) : "") +
    charlieBlock();
  return {
    subject: `Before it happens: your story goes to ${company}`,
    html: emailShell({ preheader: `You are on the short list their hiring lead reads this week. Reply "leave me out" if you would rather not.`, title: "Before it happens", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresentheadsup" }),
    text: `I said nothing would reach ${company} until you picked one of the two doors, so I am telling you before it does.\n\nTheir hiring lead is reading the short list this week, and yours is on it: the story I wrote from your own words, and the work behind it. Nothing else, and nothing I made up.\n\nIf you would rather I did not, reply "leave me out" and that is the end of it. No explanation needed.\n\nIf you have not applied yet, this is the moment. It takes a minute and you arrive referred rather than cold: ${referralUrl}\n\nCharlie`,
  };
}


/**
 * Somebody asked a question. Answer it, or say plainly that a person will.
 *
 * WHY THIS TEMPLATE EXISTS. Without it a question falls through to the preference writer, which
 * replies by confirming what it changed about their profile ("has my application been sent" would get
 * "I've noted you're looking for Senior roles") and could write a fact into their record that they
 * never stated. This is the branch that catches it.
 *
 * TWO SHAPES, AND ONLY TWO. `answer` is filled ONLY for the one question with an answer that is the
 * same for everybody and depends on no fact about them: no, Charlie does not submit applications.
 * Everything else says a person will come back, because guessing at somebody's question is the
 * same mistake one layer up.
 */
export function renderQuestionAck({ email, name = "", answer = "", applyUrl = "" } = {}) {
  const nm = name ? ` ${esc(name.split(" ")[0])}` : "";
  const content = answer === "applied"
    ? lead("answering you") +
      h1("No, it has not been sent.") +
      p(`${nm ? `Hi${nm}, to` : "To"} answer directly: I have not submitted anything on your behalf, and I will not. The application has to come from you.`) +
      (applyUrl ? p(`Use this link and you arrive referred rather than cold. It takes a minute.`) + primaryBtn(applyUrl, "Apply") : "") +
      p(`Once you have, reply and say so, and I will put your story in front of them alongside it. That part is mine to do.`)
    : lead("got it") +
      h1("A person will answer this.") +
      p(`${nm ? `Hi${nm}, you` : "You"} asked me something I would rather answer properly than guess at, so I have passed it to a human. You will hear back.`) +
      p(`Nothing about your profile changed because you asked. A question is a question.`);
  return {
    subject: answer === "applied" ? "No, it has not been sent yet" : "Passing this to a person",
    html: emailShell({ preheader: answer === "applied" ? "The application has to come from you. Here is the link." : "A person will come back to you on this.",
      title: "Answering you", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliequestion" }),
    text: answer === "applied"
      ? `To answer directly: I have not submitted anything on your behalf, and I will not. The application has to come from you.\n\nUse this link and you arrive referred rather than cold: ${applyUrl}\n\nOnce you have, reply and say so, and I will put your story in front of them alongside it.\n\nCharlie`
      : `You asked me something I would rather answer properly than guess at, so I have passed it to a human. You will hear back.\n\nNothing about your profile changed because you asked. A question is a question.\n\nCharlie`,
  };
}

// The applicant-pool represent ask. NO ROLE, NO COMPANY, NO AGENCY NAMED.
//
// WHY IT NAMES NO OPENING. Tying this to one job turns an honest request for somebody's own material
// into a pitch, and it would also be untrue: this is so that the NEXT time something fits, the answer
// is their words rather than a guess. renderRepresent (the email-product version) is a two-step,
// offer-then-ask, because it goes to people who never applied to anything. This one is a single step:
// these people have a live application with us, so asking what we need to put them forward properly
// is inside the thing they already started, not a new thing being sold to them.
//
// THE BLANKS ARE THEIRS. `missing` comes from poolMissing(their row), so nobody is asked for a link we
// already hold. The last two asks go to everyone because nobody has ever been asked them, and they are
// the two a company reads first: a piece of work in their own words, and what they actually want next.
export function renderRepresentPoolAsk({ email, name = "", missing = [] } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const LABEL = {
    portfolio: "A link to your work. A portfolio, a site, case studies, a deck. Anything I can open.",
    pay: "What you are expecting on pay.",
    notice: "How soon you could start, counting your notice.",
  };
  const asks = (missing || []).map((k) => LABEL[k]).filter(Boolean).concat([
    "One piece of work you are proud of, in your own words. What it was, what you did, and what changed because of it.",
    "What you actually want next. The kind of company, where you want to be based, and the work itself.",
  ]);
  const content =
    lead("so I can put you forward properly") +
    h1("A few things I am missing about you.") +
    p(`${nm ? `Hi${nm}, when` : "When"} I put you in front of a company, I can only hand over what you have actually given me. Anything I do not have I either leave out or I fill in myself, and a guess about you is worse than a blank.`) +
    p(`Here is what I cannot answer for you right now:`) +
    bullets(asks) +
    p(`One reply with whatever you have is plenty, and partial is fine. If something on that list is none of my business, say so and I will stop asking for it.`) +
    p(`There is nothing to apply to here and this is not about one job. It is so that when something does fit you, I am working from your words.`) +
    p(`Nothing with your name on it goes to any company until you tell me it can.`) +
    charlieBlock();
  return {
    subject: cleanSubject("A few things I am missing about you"),
    html: emailShell({ preheader: "So that when something fits, I am working from your words rather than a guess.", title: "A few things I am missing", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresentpoolask" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, when` : "When"} I put you in front of a company, I can only hand over what you have actually given me. Anything I do not have I either leave out or I fill in myself, and a guess about you is worse than a blank.\n\nHere is what I cannot answer for you right now:\n\n${asks.map((a) => `- ${deDash(a)}`).join("\n")}\n\nOne reply with whatever you have is plenty, and partial is fine. If something on that list is none of my business, say so and I will stop asking for it.\n\nThere is nothing to apply to here and this is not about one job. It is so that when something does fit you, I am working from your words.\n\nNothing with your name on it goes to any company until you tell me it can.\n\nCharlie`,
  };
}

// The evidence ask. The sibling of renderRepresentPoolAsk, for everyone who is NOT a
// designer, and it differs in one way that matters: the ask is written in the language of THEIR work.
//
// WHY CONTEXTUAL RATHER THAN ONE EMAIL FOR EVERYONE. "Send me a piece of work you are proud of" is
// answerable by a designer, who has artefacts, and close to meaningless to a customer success manager,
// who has accounts and renewals and nothing to attach. A generic ask gets generic answers, and a
// generic answer is exactly what cannot be handed to a company. So `evidence` is the question in the
// vocabulary of the person's own role, passed in by the caller from their stored role family.
//
// THE FRAME IS THE HONEST REASON, NOT A BENEFIT. Companies ask for evidence. Without it a person is a
// title and a number of years, which is the shape of every other application in the pile. With it
// there is something to actually say about them. That is worth stating plainly rather than dressing
// up as an opportunity, and it is also why the email promises nothing about speed or outcome.
export function renderEvidenceAsk({ email, name = "", evidence = "", alsoAsk = [] } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const LABEL = {
    pay: "What you are expecting on pay.",
    notice: "How soon you could start, counting your notice.",
  };
  const asks = [esc(evidence)].filter(Boolean).concat((alsoAsk || []).map((k) => LABEL[k]).filter(Boolean));
  const content =
    lead("so I have something to say about you") +
    h1("Send me the evidence.") +
    p(`${nm ? `Hi${nm}, every` : "Every"} company I talk to asks the same thing, and it is never your title. It is what you actually did, and how they can tell.`) +
    p(`Right now, for you, I do not have that. Without it you are a job title and a number of years, which is what every other name on the pile looks like too. With it I have something to say about you that nobody else can say.`) +
    bullets(asks) +
    p(`Rough is fine. A paragraph you typed once, a link, an old deck, a number you remember. I would rather have it messy than not have it.`) +
    p(`I will not promise this makes anything faster. It makes you legible, and that is the part I can actually do something with.`) +
    p(`Nothing with your name on it goes to any company until you tell me it can.`) +
    charlieBlock();
  return {
    subject: cleanSubject("Send me the evidence"),
    html: emailShell({ preheader: "Every company asks what you actually did. Right now I cannot answer that for you.", title: "Send me the evidence", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieevidenceask" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, every` : "Every"} company I talk to asks the same thing, and it is never your title. It is what you actually did, and how they can tell.\n\nRight now, for you, I do not have that. Without it you are a job title and a number of years, which is what every other name on the pile looks like too. With it I have something to say about you that nobody else can say.\n\n${asks.map((a) => `- ${deDash(a)}`).join("\n")}\n\nRough is fine. A paragraph you typed once, a link, an old deck, a number you remember. I would rather have it messy than not have it.\n\nI will not promise this makes anything faster. It makes you legible, and that is the part I can actually do something with.\n\nNothing with your name on it goes to any company until you tell me it can.\n\nCharlie`,
  };
}

// "It has actually happened." The follow-through on renderRoleForward, and it only exists because
// that email used the future tense: "your profile IS GOING to the hiring managers." This one says it
// went, on the day it went, which is the difference between a promise and a report.
//
// WHY IT IS WORTH A SEND AT ALL. Every other recruiter goes quiet here, and the silence is what
// people describe when they say applying feels like shouting into a well. The person can do nothing
// with this news, which is exactly why it lands: it is the first message in the process that asks
// them for nothing and tells them something true.
//
// IT PROMISES NO OUTCOME AND NO DATE. We do not control the client's timeline and saying otherwise
// would be the first outcome claim this product has made. What is promised is the one thing we can
// actually deliver: that they will hear either way, including the day it goes nowhere.
export function renderWithHiringTeam({ email, name = "", company = "", roleTitle = "" } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const co = esc(company);
  const content =
    lead("your application") +
    h1(`It is with ${co} now.`) +
    p(`${nm ? `Hi${nm}, your` : "Your"} profile went to the hiring team at <b style="color:${C.ink};font-weight:600;">${co}</b> for the ${esc(roleTitle)} role. Not queued, not pending. It is in front of them.`) +
    p(`What happens next is theirs, not mine. I do not set their timeline and I am not going to invent one for you.`) +
    p(`I am watching it, and I will tell you what I hear. That includes hearing nothing, which I will also tell you rather than leave you guessing.`) +
    p(`Nothing is needed from you.`) +
    charlieBlock();
  return {
    subject: cleanSubject(`Your profile is in front of ${company}`),
    html: emailShell({ preheader: `It went to the hiring team. I will tell you what I hear, either way.`, title: `It is with ${company} now`, contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliewithhiringteam" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, your` : "Your"} profile went to the hiring team at ${deDash(company)} for the ${deDash(roleTitle)} role. Not queued, not pending. It is in front of them.\n\nWhat happens next is theirs, not mine. I do not set their timeline and I am not going to invent one for you.\n\nI am watching it, and I will tell you what I hear. That includes hearing nothing, which I will also tell you rather than leave you guessing.\n\nNothing is needed from you.\n\nCharlie`,
  };
}

// The permission ask. Charlie has found somebody a role it believes they fit, and this
// is the email that asks whether it may put them forward. It is NOT a representation notice.
//
// THE SEQUENCE THIS PROTECTS. renderRoleForward says "your profile is going to the hiring managers"
// and renderWithHiringTeam says it went. Both are statements of fact about something already done.
// Nothing may say either until the person has said yes, and this is the email that gets the yes.
//
// IT SAYS WHY THEM, IN ONE LINE, FROM THEIR OWN WORK. `because` is passed in by the caller and comes
// from what they wrote and what we can see. It is the difference between a role alert and somebody
// having read you. It must never be flattery and never a claim they did not make.
//
// EVERY FACT ABOUT THE ROLE IS PASSED IN. The template states nothing about the job on its own, so a
// detail the brief never gave cannot originate here.
export function renderRepresentPermission({ email, name = "", roleTitle = "", where = "", band = "", because = "", studio = "" } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const content =
    lead("one role, and a question") +
    h1(`A ${esc(roleTitle)} role in ${esc(where)}.`) +
    p(`${nm ? `Hi${nm}, a` : "A"} ${esc(studio)} is hiring a <b style="color:${C.ink};font-weight:600;">${esc(roleTitle)}</b>, ${esc(band)}, on site in ${esc(where)}.`) +
    (because ? p(`I am writing to you specifically because ${esc(because)}`) : "") +
    p(`I have not sent them anything about you, and I will not unless you tell me to. That is the whole reason for this email.`) +
    p(`<b style="color:${C.ink};font-weight:600;">If you want me to put you forward, reply and say so.</b> If it is a no, say that instead and I will stop. Either answer is a useful one and neither costs you anything.`) +
    p(`I have not named the company because I do not have permission to yet. If you say yes, I will tell you who it is before anything with your name on it moves.`) +
    charlieBlock();
  return {
    subject: cleanSubject(`A ${roleTitle} role in ${String(where).split(",")[0]}, if you want it`),
    html: emailShell({ preheader: `${band}, on site in ${where}. Nothing goes anywhere until you say so.`, title: `A ${roleTitle} role in ${where}`, contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierepresentpermission" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, a` : "A"} ${deDash(studio)} is hiring a ${deDash(roleTitle)}, ${deDash(band)}, on site in ${deDash(where)}.\n\n${because ? `I am writing to you specifically because ${deDash(because)}\n\n` : ""}I have not sent them anything about you, and I will not unless you tell me to. That is the whole reason for this email.\n\nIf you want me to put you forward, reply and say so. If it is a no, say that instead and I will stop. Either answer is a useful one and neither costs you anything.\n\nI have not named the company because I do not have permission to yet. If you say yes, I will tell you who it is before anything with your name on it moves.\n\nCharlie`,
  };
}

// The yes, acknowledged. Somebody answered renderRepresentPermission with a yes, and
// this confirms what happens with it. It sits between "may I?" and "it is in front of them".
//
// IT SAYS INTEREST, NOT PROFILE. What goes to the hiring side at this moment is that this person is
// interested and what shape they are. Their profile has not moved, and renderWithHiringTeam is the
// only email allowed to say it has. Collapsing the two would mean telling somebody they are in front
// of a company before they are.
//
// `answered` carries anything they asked for in their reply, in one line, so a person who asked a
// question does not have to wonder whether it was read. It is passed in by the caller from their own
// words and is never invented.
export function renderYesNoted({ email, name = "", roleTitle = "", where = "", answered = "" } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const content =
    lead("noted") +
    h1("Passing your interest on.") +
    p(`${nm ? `Hi${nm}, thank` : "Thank"} you. I am passing on that you are interested in the ${esc(roleTitle)} role in ${esc(where)}, and the shape of your background, to the hiring manager.`) +
    (answered ? p(esc(answered)) : "") +
    p(`I will come back to you as soon as I have something real, and that includes the day it turns out to be nothing. I would rather tell you that than leave you waiting on a maybe.`) +
    p(`Nothing else is needed from you for now.`) +
    charlieBlock();
  return {
    subject: cleanSubject(`Passing your interest on`),
    html: emailShell({ preheader: `Going to the hiring manager, and I will tell you what comes back.`, title: "Passing your interest on", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieyesnoted" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, thank` : "Thank"} you. I am passing on that you are interested in the ${deDash(roleTitle)} role in ${deDash(where)}, and the shape of your background, to the hiring manager.\n\n${answered ? deDash(answered) + "\n\n" : ""}I will come back to you as soon as I have something real, and that includes the day it turns out to be nothing. I would rather tell you that than leave you waiting on a maybe.\n\nNothing else is needed from you for now.\n\nCharlie`,
  };
}

// "Has anyone called?" Sent to people whose profile actually went to a named company, asking the one
// thing we have no other way to learn.
//
// WHY THIS IS NOT AN OUTCOME PROBE. Charlie never asks people, on a schedule, to report a rejection
// on an application they made alone. This asks after something CHARLIE DID FOR THEM, of somebody who
// agreed to it, about a company we named to them, and the honest reason for asking is in the email:
// there is no dashboard, no tracker, and no back channel. If they do not tell us, we do not find out.
//
// IT MUST NOT READ AS PRESSURE. A "no" is the expected answer and the copy says so before the
// question, because somebody two days into a wait should not feel behind. Nothing is asked of them
// beyond a word, and saying nothing is explicitly fine.
//
// NO TIMELINE IS INVENTED AND NO OUTCOME IS PROMISED, same as every email in this sequence.
export function renderAnyCalls({ email, name = "", company = "", roleTitle = "", askStage = false } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const co = esc(company);
  // `askStage` adds the second question, for people who were told weeks ago rather than days ago.
  // OFF BY DEFAULT so the original send is untouched: asking "which round are you in" of somebody who
  // heard about the role on Tuesday reads as pressure, which is the one thing this email must not do.
  const WHY = `The whole point of this is to get you in front of somebody who can actually say yes, and that part has happened. What I cannot see is what happened next.`;
  const STAGE = `And if they have been in touch, where has it got to? A first call, a technical round, an offer, or a no. Any of those helps me, and a no helps as much as a yes.`;
  const content =
    lead("one question") +
    h1("Has anyone been in touch?") +
    p(`${nm ? `Hi${nm}, your` : "Your"} profile went to <b style="color:${C.ink};font-weight:600;">${co}</b> for the ${esc(roleTitle)} role. Has anybody from there contacted you yet?`) +
    (askStage ? p(WHY) : "") +
    p(`If the answer is no, that is the normal answer this early and it is not a sign of anything. Hiring is slow in a way that has nothing to do with you. Sit tight.`) +
    p(`If they do get in touch, at any point, I would like to know. A line is plenty.`) +
    (askStage ? p(STAGE) : "") +
    p(`I am asking because I genuinely cannot see it. I am not a job board. There is no tracker, no dashboard, and nobody feeding me updates from the inside. What I have is what you tell me, and I would rather ask you than guess.`) +
    p(`If you would rather not, that is completely fine and I will not ask again.`) +
    charlieBlock();
  return {
    subject: cleanSubject(`Has ${company} been in touch?`),
    html: emailShell({ preheader: `One question, and no is the normal answer this early.`, title: "Has anyone been in touch?", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieanycalls" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, your` : "Your"} profile went to ${deDash(company)} for the ${deDash(roleTitle)} role. Has anybody from there contacted you yet?\n\n${askStage ? deDash(WHY) + "\n\n" : ""}If the answer is no, that is the normal answer this early and it is not a sign of anything. Hiring is slow in a way that has nothing to do with you. Sit tight.\n\nIf they do get in touch, at any point, I would like to know. A line is plenty.\n\n${askStage ? deDash(STAGE) + "\n\n" : ""}I am asking because I genuinely cannot see it. I am not a job board. There is no tracker, no dashboard, and nobody feeding me updates from the inside. What I have is what you tell me, and I would rather ask you than guess.\n\nIf you would rather not, that is completely fine and I will not ask again.\n\nCharlie`,
  };
}

/**
 * The answer to somebody answering "has anyone been in touch?".
 *
 * IT DOES NOT SAY WHICH WAY THEY ANSWERED, on purpose. A reply here can be "no, nothing", "yes, a
 * first call", or "yes, I have an offer", and an ack that asserts one of those is wrong for the other
 * two. Nothing in this template classifies their message or repeats it back, so it cannot be wrong
 * about it. The words themselves go on their record, verbatim, and to a human.
 *
 * IT PROMISES NOTHING AND ASKS FOR NOTHING FURTHER. They have already done the thing that was asked.
 */
export function renderCheckinNoted({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const LINES = [
    `Thanks${nm}. Noted, and that is exactly what I asked for. It is useful either way, and a no is as useful to me as a yes.`,
    `Nothing is needed from you now. If anything moves at any point, tell me and I will do what I can with it.`,
    `I will come back to you the moment I have something real from their side, including if what I hear turns out to be nothing.`,
  ];
  const content = lead("noted") + h1("Got it, thank you.") + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject("Got it, thank you"),
    html: emailShell({
      preheader: "Noted. I will tell you when I have something real.",
      title: "Got it", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliecheckinnoted",
    }),
    text: `${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

// The correction owed for a templated reply. HAND-WRITTEN, never model-generated: a wrong correction
// is worse than the original miss, so a person writes these words and a person approves the send.
//
// THE CASE. Somebody answers a direct question ("has anyone been in touch?") and gets a generic
// acknowledgement offering to change their settings. They answered a question and were offered a
// settings menu.
//
// THE CORRECTION QUOTES THEM. `theirWords` is what they actually wrote, passed in verbatim, because
// the whole failure was a reply that could have been sent to anybody. A correction that is itself
// generic would prove the complaint rather than answer it.
export function renderReplyCorrection({ email, name = "", theirWords = "", company = "" } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const content =
    lead("my mistake") +
    h1("That reply was wrong.") +
    p(`${nm ? `Hi${nm}, you` : "You"} told me <b style="color:${C.ink};font-weight:600;">${esc(theirWords)}</b> and I sent you back a note about changing your pay floor. You had answered my question and I replied as though you had not.`) +
    p(`So, properly: noted. ${esc(company)} has not been in touch with you. That is the useful answer and it is the one I asked for.`) +
    p(`It changes nothing about where you stand. You are still with them, and I will tell you the moment I hear anything, including if the answer turns out to be nothing.`) +
    p(`Nothing is needed from you. If they do call, I would still like to know.`) +
    charlieBlock();
  return {
    subject: cleanSubject("That reply was wrong, and here is the real one"),
    html: emailShell({ preheader: "You answered my question and I replied as if you had not.", title: "That reply was wrong", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliereplycorrection" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, you` : "You"} told me ${deDash(theirWords)} and I sent you back a note about changing your pay floor. You had answered my question and I replied as though you had not.\n\nSo, properly: noted. ${deDash(company)} has not been in touch with you. That is the useful answer and it is the one I asked for.\n\nIt changes nothing about where you stand. You are still with them, and I will tell you the moment I hear anything, including if the answer turns out to be nothing.\n\nNothing is needed from you. If they do call, I would still like to know.\n\nCharlie`,
  };
}

// The correction owed to somebody who said YES and was answered with a form letter.
// HAND-WRITTEN, never model-generated.
//
// THE CASE. They answered renderRepresentPermission with a yes (perhaps twice, with a direct question)
// and each time got a generic acknowledgement instead of an answer.
//
// IT IS ONE EMAIL, NOT TWO. They are owed a correction and an answer, and sending those separately
// would add yet another email to an exchange that has already cost them two.
export function renderYesCorrection({ email, name = "", theirWords = "", roleTitle = "", where = "" } = {}) {
  const nm = name ? ` ${esc(String(name).split(" ")[0])}` : "";
  const content =
    lead("my mistake") +
    h1("You said yes and I sent you a form letter.") +
    p(`${nm ? `Hi${nm}, you` : "You"} told me <b style="color:${C.ink};font-weight:600;">${esc(theirWords)}</b> and asked me to share the role. What came back was a note about changing your pay floor, twice. That was wrong and it was my fault, not a misunderstanding of what you wrote.`) +
    p(`So, properly. Yes, noted. I am passing on that you are interested in the ${esc(roleTitle)} role in ${esc(where)}, and the shape of your background, to the hiring manager.`) +
    p(`You asked me to share the role. I cannot name the company yet because I do not have permission to, and the moment I do you will have it along with everything else I know. That was the promise in my first email and it still stands.`) +
    p(`Nothing else is needed from you. I will come back when I have something real, including if it turns out to be nothing.`) +
    charlieBlock();
  return {
    subject: cleanSubject("You said yes, and I answered badly"),
    html: emailShell({ preheader: "Correcting that, and answering what you actually asked.", title: "You said yes", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieyescorrection" }),
    text: `${name ? `Hi ${deDash(String(name).split(" ")[0])}, you` : "You"} told me ${deDash(theirWords)} and asked me to share the role. What came back was a note about changing your pay floor, twice. That was wrong and it was my fault, not a misunderstanding of what you wrote.\n\nSo, properly. Yes, noted. I am passing on that you are interested in the ${deDash(roleTitle)} role in ${deDash(where)}, and the shape of your background, to the hiring manager.\n\nYou asked me to share the role. I cannot name the company yet because I do not have permission to, and the moment I do you will have it along with everything else I know. That was the promise in my first email and it still stands.\n\nNothing else is needed from you. I will come back when I have something real, including if it turns out to be nothing.\n\nCharlie`,
  };
}

/**
 * Somebody replied to a client-status mail, and their words have been filed. This answers them.
 *
 * IT EXISTS BECAUSE THE ALTERNATIVE WAS A LIE. Without its own terminal branch, a reply from one of
 * these applicants falls through to `renderAck`, which offers to change the reader's PAY FLOOR and
 * promises to email them a role "the moment one's worth your time". They applied to one role through
 * a form; they are not enrolled in the matching product. Sending that letter would describe a
 * relationship they do not have, to their face, in reply to something they took trouble over.
 *
 * `filed` IS THE GROUNDING, NOT A TONE SETTING. It reports where their words ACTUALLY went, and the
 * caller passes what happened rather than what it hoped would happen:
 *
 *   "board"  — appended to the page the client reads. Only then may this mail say so.
 *   "record" — on their own record, but no board row matched or Notion was unreachable.
 *   "none"   — nothing was filed, because a two-word "thanks!" is below the floor. Then this mail
 *              claims NOTHING. An ack that says "it is on your file" when it is not is the same
 *              defect as every other one this month: a step stopped working and kept reporting success.
 *
 * IT PROMISES NOTHING. Same rule as renderClientStatus: the only commitment is negative and therefore
 * keepable.
 */
export function renderClientReplyAck({ email, name = "", filed = "none" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const WHERE = {
    board: `I have put it with your application, word for word, where the hiring team reads it. Not summarised and not scored, just added to what they already have from you.`,
    record: `It is on your file now, word for word. Not summarised and not scored.`,
    none: "",
  };
  const where = WHERE[filed] || "";
  // The closing sentence assumes something was filed. With nothing filed there is nothing for the
  // hiring side to have read, so that paragraph goes too.
  const consequence = where
    ? p(`It does not change the decision, and it is not a second application. They read what you sent, they pick who they speak to, and I cannot speed that up.`)
    : "";

  const content =
    lead("noted") +
    h1("Got it, thank you.") +
    p(`Thanks${nm}.`) +
    (where ? p(where) : "") +
    consequence +
    p(`If something moves, you will hear from me. I will not send you updates that say nothing.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  const first = name ? ` ${String(name).trim().split(/\s+/)[0]}` : "";
  return {
    subject: cleanSubject("Got it, thank you"),
    html: emailShell({
      preheader: where ? "Filed with your application. I will tell you when something moves." : "Noted. I will tell you when something moves.",
      title: "Got it",
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charlieclientreplyack",
    }),
    text: [
      `Thanks${t(first)}.`,
      ...(where ? ["", t(where)] : []),
      ...(where ? ["", `It does not change the decision, and it is not a second application. They read what you sent, they pick who they speak to, and I cannot speed that up.`] : []),
      "",
      `If something moves, you will hear from me. I will not send you updates that say nothing.`,
      "",
      `Charlie`,
    ].join("\n"),
  };
}

// The client status update. Somebody applied to a role Charlie is recruiting for, their
// application has gone to that client's hiring team, and this tells them so.
//
// TWO STATES, ONE TEMPLATE, AND THE DIFFERENCE IS A FACT NOT A FLOURISH. `reviewing` is true only
// when a human on the client side has actually marked that person as being looked at. It changes one
// sentence. It must never be set to make an email feel warmer, because "someone is reading it" is a
// claim about another company's behaviour and the person will act on it.
//
// `pointer` IS WHAT THEY THEMSELVES SUBMITTED, passed in by the caller: the repo or link they told us
// to look at. It is the whole reason this is not a form letter. When somebody submitted nothing
// usable the caller passes "" and the line disappears rather than being invented, because a
// fabricated detail in a status email is worse than a shorter status email.
//
// IT PROMISES NOTHING AND PREDICTS NOTHING. No timeline, no likelihood, no encouragement about their
// chances. The one commitment made is negative and therefore keepable: no updates that say nothing.
export function renderClientStatus({ email, name = "", company = "", roleTitle = "", pointer = "", reviewing = false, repliedOn = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const co = esc(company);
  const role = esc(roleTitle);
  const ptr = String(pointer || "").trim();
  // Some of these people were asked one follow-up question and answered it, and their answer is on
  // the page the client reads. Telling them so is the difference between "we filed your form" and
  // "the thing you took the trouble to write is in front of them". Pre-formatted by the caller
  // ("20 August"), so the template does no date arithmetic and cannot render a wrong one.
  const rep = String(repliedOn || "").trim();

  const opener = reviewing
    ? p(`Good news. Your application for the ${role} role at <b style="color:${C.ink};font-weight:600;">${co}</b> is with their hiring team, and they have started going through yours.`)
    : p(`Good news. Your application for the ${role} role at <b style="color:${C.ink};font-weight:600;">${co}</b> is now in front of their hiring team.`);

  const carried = [
    ptr ? `the ${esc(ptr)} you pointed us at` : "",
    rep ? `the answer you wrote me on ${esc(rep)}` : "",
  ].filter(Boolean);
  const pointerLine = carried.length
    ? p(`Everything you sent went across, including ${carried.join(" and ")}.`)
    : p(`Everything you sent went across with it.`);

  const middle = reviewing
    ? p(`That is where it genuinely is right now. It is not a decision, and I do not know which way it goes. But someone is reading it.`)
    : "";

  const content =
    lead("your application") +
    h1(reviewing ? `${co} are reading it.` : `It is with ${co} now.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    opener +
    pointerLine +
    middle +
    p(`What happens next is up to ${co}. They pick who they speak to, and I cannot speed that up. If they want to talk, they will come to you directly.`) +
    p(`I will not send you updates that say nothing. If something moves, you will hear from me.`) +
    p(`Thanks for taking the time with it.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  const textLines = [
    first ? `Hi ${t(first)}.` : `Hi.`,
    "",
    reviewing
      ? `Good news. Your application for the ${t(roleTitle)} role at ${t(company)} is with their hiring team, and they have started going through yours.`
      : `Good news. Your application for the ${t(roleTitle)} role at ${t(company)} is now in front of their hiring team.`,
    "",
    carried.length
      ? `Everything you sent went across, including ${[
          ptr ? `the ${t(ptr)} you pointed us at` : "",
          rep ? `the answer you wrote me on ${t(rep)}` : "",
        ].filter(Boolean).join(" and ")}.`
      : `Everything you sent went across with it.`,
    "",
    ...(reviewing ? [`That is where it genuinely is right now. It is not a decision, and I do not know which way it goes. But someone is reading it.`, ""] : []),
    `What happens next is up to ${t(company)}. They pick who they speak to, and I cannot speed that up. If they want to talk, they will come to you directly.`,
    "",
    `I will not send you updates that say nothing. If something moves, you will hear from me.`,
    "",
    `Thanks for taking the time with it.`,
    "",
    `Charlie`,
  ];

  return {
    subject: cleanSubject(reviewing ? `${company} are looking at your application` : `Your ${company} application is with the hiring team`),
    html: emailShell({
      preheader: reviewing ? `It is with their hiring team and someone has started reading it.` : `It went to their hiring team. I will tell you when something moves.`,
      title: reviewing ? `${company} are reading it` : `It is with ${company} now`,
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charlieclientstatus",
    }),
    text: textLines.join("\n"),
  };
}

// The CV request. When an application form for a client mandate has no upload field, people apply
// without ever being offered somewhere to attach a CV, and the client reads CVs.
//
// IT DOES NOT APOLOGISE AND IT DOES NOT FLATTER. Grovelling makes the reader feel worse about a
// thing that was never their problem, and "the employer is asking a select few" would be a claim
// about their status that is not true of everybody on the list, and a false signal about progress is
// the cruellest possible error in a job search. The copy states the fact, gives the
// link, and stops.
//
// `formUrl` IS THE ONLY THING THE READER MUST ACT ON, so the one instruction that carries weight is
// to reuse the address they applied with. That address is the join key; a CV that arrives under a
// different one cannot be matched to anybody and becomes a file with no owner.
//
// SAYING NO IS MADE EASY ON PURPOSE. Somebody who does not want to send a CV should not be left
// feeling their application is now weaker for it, so the last line says plainly that it is not.
/**
 * The one question a candidate can answer that speeds up a real decision.
 *
 * WHAT IT MAY ASK, AND NOTHING ELSE. `missing` is the label of a MUST-HAVE criterion the person's own
 * application said nothing at all about — not "weak", not "we were unconvinced", but silent. That is
 * the only honest ask: we genuinely do not know, and one reply settles it. Passing anything the review
 * did not produce would be manufacturing a deficiency in a real person.
 *
 * It throws without a `missing`. An email that cannot say what it is asking about would be a chase.
 *
 * IT PROMISES NOTHING. Not a shortlist, not an interview, not that answering helps. It says where the
 * application is, names the gap as OURS to close rather than a flaw of theirs, and leaves the decision
 * where it belongs.
 */
/**
 * Breaking the silence — one mail to the whole pool.
 *
 * WHY IT GOES TO EVERYONE. Most people here have heard nothing since they applied, and silence from a
 * job service reads as rejection. It is not: it is that Charlie only writes when there is something
 * real to say. That is worth saying once, plainly, to all of them.
 *
 * TWO SHAPES, ONE MAIL. Somebody whose evidence is already on file is told exactly that and asked for
 * NOTHING. That is not politeness, it is the thing that makes the ask credible for everyone else: a
 * pool that chases every person for the same thing every time is a pool nobody answers. `ask` false
 * means the no-ask shape.
 *
 * IT SHOWS RATHER THAN EXPLAINS. It never opens by saying what Charlie is not; the number makes the
 * point without claiming it, and a person who has been ignored for weeks did not write in for a
 * positioning statement.
 *
 * THE ASK IS THEIR BEST WORK, AND IT IS THE SAME FOR EVERYONE. A templated question per role family
 * reads as a form even when it is accurate, and it puts words in a person's mouth about what their
 * best work ought to be. Asking somebody what they are proudest of cannot be wrong about them, and the
 * answer is the thing worth carrying to a hiring manager. One ask, no templating, nothing guessed.
 *
 * THE NUMBER IS PASSED IN, NEVER HARDCODED. `putForward` is measured at send time from the pool, so
 * which is what happened. NOT "placed": a candidate who later learns nobody was placed remembers
 * being told otherwise.
 */
export function renderBreakingSilence({ email, name = "", ask = false, putForward = 0, mandates = 0, share = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const n = Number(putForward) || 0;
  if (!n) throw new Error("renderBreakingSilence: `putForward` is required — the mail's one claim cannot be blank");
  const q = Boolean(ask);
  const frac = String(share || "").trim();

  // The SHARE carries the claim, not the raw count: it speaks to the reader's own odds rather than our
  // volume. The caller floors the percentage (27.6 becomes 27, never 28), because the one number in
  // this mail must never round in our favour.
  const proof = frac
    ? p(`That has happened for <b style="color:${C.ink};font-weight:600;">${esc(frac)} of the people here</b>, across ${esc(String(mandates))} mandates.`)
    : p(`That has happened for <b style="color:${C.ink};font-weight:600;">${n} people here</b>, across ${esc(String(mandates))} mandates.`);

  const close = q
    ? p(`From you I am missing one thing: <b style="color:${C.ink};font-weight:600;">your best work so far.</b> Whatever you are proudest of. What it was, what you did, and what changed because of it.`)
      + p(`Without it you are a title and a number of years, which is what every other name looks like. A few lines is enough, and a link beats a paragraph.`)
    : p(`Yours is already on file, so there is nothing to do. When something fits, I already know what to say about you.`);

  const content =
    lead("breaking the silence") +
    h1(`Why you have not heard from me.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    p(`It has been quiet from my side, and you should know why.`) +
    p(`I work direct with companies and headhunters, and I put people in front of the hiring manager <b style="color:${C.ink};font-weight:600;">with their story</b>, not a CV into a queue.`) +
    proof +
    close +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject("Breaking the silence"),
    html: emailShell({
      preheader: q ? `Why it has been quiet, and the one thing I am missing from you.` : `Why it has been quiet. Nothing needed from you.`,
      title: "Breaking the silence",
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charliebreakingsilence",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      `It has been quiet from my side, and you should know why.`, "",
      `I work direct with companies and headhunters, and I put people in front of the hiring manager with their story, not a CV into a queue.`, "",
      frac ? `That has happened for ${t(frac)} of the people here, across ${t(mandates)} mandates.`
           : `That has happened for ${n} people here, across ${t(mandates)} mandates.`, "",
      ...(q
        ? [`From you I am missing one thing: your best work so far. Whatever you are proudest of. What it was, what you did, and what changed because of it.`, "",
           `Without it you are a title and a number of years, which is what every other name looks like. A few lines is enough, and a link beats a paragraph.`, ""]
        : [`Yours is already on file, so there is nothing to do. When something fits, I already know what to say about you.`, ""]),
      `Charlie`,
    ].join("\n"),
  };
}

export function renderDecisionAsk({ email, name = "", company = "", roleTitle = "", missing = "", alsoMissing = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const co = esc(company);
  const role = esc(roleTitle);
  const one = String(missing || "").trim();
  if (!one) throw new Error("renderDecisionAsk: `missing` is required — without it there is nothing true to ask");
  const two = String(alsoMissing || "").trim();

  const ask = two
    ? p(`Two things your application does not mention, which they will want to know: <b style="color:${C.ink};font-weight:600;">${esc(one)}</b>, and <b style="color:${C.ink};font-weight:600;">${esc(two)}</b>.`)
    : p(`One thing your application does not mention, which they will want to know: <b style="color:${C.ink};font-weight:600;">${esc(one)}</b>.`);

  const content =
    lead("your application") +
    h1(`One question, and it goes straight to ${co}.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    p(`Your application for the ${role} role is with <b style="color:${C.ink};font-weight:600;">${co}</b>'s hiring team.`) +
    ask +
    p(`That is not a mark against you. It is a blank on our side, and a blank is the slowest thing for someone deciding who to call.`) +
    p(`Just reply to this email. A few lines is plenty, and a link to something real beats a paragraph. If it is not something you have done, say so plainly, and that is a useful answer too.`) +
    p(`Whatever you send goes across as you wrote it. If you would rather not, your application still stands on what you already sent.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(`One question before ${company} decides`),
    html: emailShell({
      preheader: two ? `Two things your application does not mention.` : `One thing your application does not mention.`,
      title: `One question before ${company} decides`,
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charliedecisionask",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      `Your application for the ${t(roleTitle)} role is with ${t(company)}'s hiring team.`, "",
      two
        ? `Two things your application does not mention, which they will want to know: ${t(one)}, and ${t(two)}.`
        : `One thing your application does not mention, which they will want to know: ${t(one)}.`, "",
      `That is not a mark against you. It is a blank on our side, and a blank is the slowest thing for someone deciding who to call.`, "",
      `Just reply to this email. A few lines is plenty, and a link to something real beats a paragraph. If it is not something you have done, say so plainly, and that is a useful answer too.`, "",
      `Whatever you send goes across as you wrote it. If you would rather not, your application still stands on what you already sent.`, "",
      `Charlie`,
    ].join("\n"),
  };
}

/**
 * A role title inside a sentence (sentence case). Ordinary title-case words are lowercased;
 * a word with more than one capital or a digit is an acronym or a name and stays as written:
 * "Senior J2EE Developer" -> "senior J2EE developer", "AI Product Manager" -> "AI product manager".
 * (A one-capital name like "Java" cannot be told from an ordinary word and is lowercased.)
 */
export function roleInSentence(role) {
  return String(role || "").split(/(\s+|-)/).map((w) => (/^[A-Z][a-z']*$/.test(w) ? w.toLowerCase() : w)).join("");
}

/**
 * A role in the pool, offered to somebody who did not apply to it, answerable with one word.
 *
 * WHO GETS THIS. Only people whose `consent_pool` is true: they told us in their own words that we
 * could write to them about roles other than the one they came in for. Anyone else has not agreed to
 * hear from us about this and never appears in the queue.
 *
 * IT DESCRIBES THE ROLE AND NEVER THE PERSON. There is no "your work in X made me think of you", no
 * score, no readout, nothing derived about them at all. A mail that describes somebody back to
 * themselves and gets it wrong is the worst failure, and the cheapest way to never do that is to have
 * nothing in the template capable of it. The person already knows who they are. What they do not know
 * is what the job is.
 *
 * THE COMPANY IS NOT NAMED, and the copy says so rather than working around it. `company` is not a
 * parameter here: a template with nowhere to put a name cannot leak one, which is the same reasoning
 * as assertNameable in lib/mandates.mjs but enforced by the shape of the function instead of a throw.
 *
 * IT PROMISES NOTHING. Not a shortlist, not an interview, not that saying yes improves anything. It
 * says what a yes actually causes, which is that what they have already sent us goes in front of the
 * client, and the client decides.
 */
export function renderRoleInvite({ email, name = "", roleTitle = "", city = "", years = "", whatItIs = "", pending = false, alreadyHeardToday = false } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const role = String(roleTitle || "").trim();
  const place = String(city || "").trim();
  const band = String(years || "").trim();
  const what = String(whatItIs || "").trim();
  // No role, no city, no description: refuse rather than send a vague invitation nobody can answer.
  // A person cannot say yes or no to a job they have not been told anything about, and asking them to
  // is worse than not writing at all.
  if (!role) throw new Error("renderRoleInvite: roleTitle is required");
  if (!place) throw new Error("renderRoleInvite: city is required — the answer depends on where it is");
  if (!what) throw new Error("renderRoleInvite: whatItIs is required — there is nothing to say yes to");

  const content =
    lead("a role") +
    h1(`A ${esc(roleInSentence(role))} role in ${esc(place)}.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    (alreadyHeardToday
      ? p(`Second time from me today, which is not how I usually work. A different role came up that fits you just as well, so you get to decide rather than me deciding for you.`)
      : p(`You told me I could send you roles beyond the one you came to me for. This is one of those.`)) +
    p(esc(what)) +
    (band ? p(`They are looking for ${esc(band)} of experience, and the job is on site in <b style="color:${C.ink};font-weight:600;">${esc(place)}</b>. If that does not work for you, no is the right answer and it costs you nothing.`) : p(`The job is on site in <b style="color:${C.ink};font-weight:600;">${esc(place)}</b>. If that does not work for you, no is the right answer and it costs you nothing.`)) +
    // WHY THE NAME IS WITHHELD IS A FACT ABOUT THE CLIENT, so it cannot be the same sentence in both
    // cases. "They asked us not to" is true of a confidential mandate and a LIE about a company we
    // have merely not squared it with yet. Inventing a client instruction to a candidate is the same
    // class of error as inventing a salary.
    (pending
      ? p(`I am not naming them yet, because I have not squared it with them. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point if you would rather.`)
      : p(`I am not naming the company here. They asked us not to while the search is open. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point if you would rather.`)) +
    p(`So, one question: <b style="color:${C.ink};font-weight:600;">would you like me to put you forward?</b> Reply yes or no. That is the whole ask, and one word is a complete answer.`) +
    // WHAT A YES ACTUALLY CAUSES, and it is not the same sentence in both cases. `pending` is for a
    // company we have approached and not heard back from: promising to put somebody in front of them
    // is a promise we cannot keep yet, and a candidate who believes they are being submitted when
    // they are being queued has been misled. Say "asked", not "will".
    (pending
      ? p(`Straight with you about where this stands: I have written to them and I am waiting to hear back. A yes from you means that if they take candidates from me, you are the first name I send. If they never reply, I will tell you that too.`)
      : p(`A yes is not an application and it is not a shortlist. It means I take what you have already sent me and put it in front of them, and they decide. There is nothing else for you to fill in.`)) +
    p(`If I do not hear back, nothing happens and nothing is held against you.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(`A ${roleInSentence(role)} role in ${place}, and one question`),
    html: emailShell({
      preheader: `Reply yes or no. That is the whole ask.`,
      title: `A ${roleInSentence(role)} role in ${place}`,
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charlieroleinvite",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      alreadyHeardToday
        ? `Second time from me today, which is not how I usually work. A different role came up that fits you just as well, so you get to decide rather than me deciding for you.`
        : `You told me I could send you roles beyond the one you came to me for. This is one of those.`, "",
      t(what), "",
      band
        ? `They are looking for ${t(band)} of experience, and the job is on site in ${t(place)}. If that does not work for you, no is the right answer and it costs you nothing.`
        : `The job is on site in ${t(place)}. If that does not work for you, no is the right answer and it costs you nothing.`, "",
      pending
        ? `I am not naming them yet, because I have not squared it with them. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point if you would rather.`
        : `I am not naming the company here. They asked us not to while the search is open. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point if you would rather.`, "",
      `So, one question: would you like me to put you forward? Reply yes or no. That is the whole ask, and one word is a complete answer.`, "",
      pending
        ? `Straight with you about where this stands: I have written to them and I am waiting to hear back. A yes from you means that if they take candidates from me, you are the first name I send. If they never reply, I will tell you that too.`
        : `A yes is not an application and it is not a shortlist. It means I take what you have already sent me and put it in front of them, and they decide. There is nothing else for you to fill in.`, "",
      `If I do not hear back, nothing happens and nothing is held against you.`, "",
      `Charlie`,
    ].join("\n"),
  };
}

/**
 * The answer to somebody who replied to a role invitation. THREE OUTCOMES, ONE PER REPLY THEY GAVE.
 *
 * WHY THIS EXISTS AT ALL. Without it a reply to `role-invite` falls through to renderAskAnswerAck,
 * which says "I am taking the shape of your background to the hiring side... I will come back to you
 * with what I hear". Sent to somebody who wrote "no thanks", that is a broken promise answering a
 * person who did exactly what was asked: the invitation told them "no is the right answer and it
 * costs you nothing", and the ack would tell them it cost them exactly the thing they declined.
 * `client-checkin` needed its own terminal reply for the same reason and got renderCheckinNoted.
 *
 * A NO GETS THE WARMEST OF THE THREE, deliberately. Declining is a completed, useful answer and the
 * mail should read that way, not like a door closing.
 *
 * AN UNCLEAR ANSWER IS NEVER GUESSED AT. "Yes, but only if it is remote" is not a yes to an on-site
 * job. That person is told a human is reading it, which is true, rather than being filed as either
 * answer and finding out later which one we picked for them.
 */
export function renderInviteAnswer({ email, name = "", answer = "unclear" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const a = ["yes", "no", "unclear"].includes(String(answer)) ? String(answer) : "unclear";

  const LINES = {
    yes: [
      `Thanks${nm}. That is all I needed.`,
      `I will put what you have already sent me in front of them, in your own words, with your work attached. There is nothing else for you to fill in.`,
      `They decide, not me, and I will come back to you either way. That includes coming back to say it went nowhere, because I would rather tell you that than leave you waiting.`,
    ],
    no: [
      `Thanks${nm}. Noted, and that is a complete answer.`,
      `Nothing moves, and nothing is held against you. A no now is worth more to me than a maybe I have to guess at later.`,
      `You are still on my list for anything else that fits, unless you would rather I stopped, in which case say so and I will.`,
    ],
    unclear: [
      `Thanks${nm}. I have read this and I would rather a person answered it than have me guess.`,
      `You asked something, or your answer came with a condition on it, and either way filing you as a yes or a no would be me deciding something you did not say.`,
      `Someone will come back to you on it shortly. Nothing has moved in the meantime.`,
    ],
  }[a];

  const TITLE = { yes: "Got it, thank you.", no: "Got it, thank you.", unclear: "Let me get you a proper answer." }[a];
  const PRE = {
    yes: "Noted. I will come back to you either way.",
    no: "Noted. Nothing moves.",
    unclear: "A person is reading this.",
  }[a];

  const content = lead("noted") + h1(TITLE) + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject(a === "unclear" ? "Let me get you a proper answer" : "Got it, thank you"),
    html: emailShell({
      preheader: PRE, title: TITLE.replace(/\.$/, ""), contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlieinviteanswer",
    }),
    text: `${LINES.map((l) => deDash(l.replace(/<[^>]+>/g, ""))).join("\n\n")}\n\nCharlie`,
  };
}

/**
 * A role put to one person in the pool, with the reason it was them, asking whether they want it
 * BEFORE anything harder is asked of them.
 *
 * HOW IT DIFFERS FROM renderRoleInvite, AND WHY THAT IS A SEPARATE TEMPLATE. The invitation says a
 * yes puts what they already sent in front of the client. That is only true of somebody who has been
 * read against the brief and cleared it. This one goes to people whose record is SILENT on a
 * must-have, so a yes cannot cause a submission, and saying it does would be a promise that either
 * gets broken or gets somebody put forward below the client's bar. Here a yes causes questions.
 *
 * `because` IS THEIR OWN RECORD OR THE MAIL IS NOT SENT. It is required, it is passed in by the
 * caller from what the person wrote, and the copy tells them that is where it came from so a wrong
 * line is one they can correct. It states what they did. It never says how well, and never says what
 * is missing. No true line for somebody means no email for them.
 *
 * EVERY FACT ABOUT THE JOB IS PASSED IN, so a detail the brief never gave cannot originate here.
 *
 * THE COMPANY IS NOT NAMED AND NO REASON IS GIVEN FOR THAT. "They asked us not to" is a claim about
 * the client and is only sometimes true. What is always true is what the copy says: they will know
 * who it is before their name moves.
 */
export function renderRoleIntent({ email, name = "", roleTitle = "", city = "", whatItIs = "", because = "", facts = [], bar = "", questionCount = "", proof = "", source = "your own CV" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const role = String(roleTitle || "").trim();
  const place = String(city || "").trim();
  const what = String(whatItIs || "").trim();
  const why = String(because || "").trim().replace(/[.\s]+$/, "");
  const list = (facts || []).map((f) => String(f || "").trim()).filter(Boolean);
  // Refuse rather than send something nobody can answer, or a "why you" with nothing behind it.
  if (!role) throw new Error("renderRoleIntent: roleTitle is required");
  if (!place) throw new Error("renderRoleIntent: city is required — the answer depends on where it is");
  if (!what) throw new Error("renderRoleIntent: whatItIs is required — there is nothing to say yes to");
  if (!why) throw new Error("renderRoleIntent: because is required — no true reason means no email");
  // WHAT THE CLIENT IS STRICT ABOUT IS A FACT ABOUT THE BRIEF, so it is passed in. Copy like "deal
  // size and targets" is true of a sales brief and wrong for a designer. No default: a sentence about the wrong job is worse than no mail.
  const strict = String(bar || "").trim();
  const count = String(questionCount || "").trim();
  const backing = String(proof || "").trim();
  const from = String(source || "").trim();
  if (!strict) throw new Error("renderRoleIntent: bar is required — what the company is strict about comes from the brief");
  if (!count) throw new Error("renderRoleIntent: questionCount is required — it must match the questions that follow a yes");
  if (!backing) throw new Error("renderRoleIntent: proof is required — what a person is backed with comes from the brief");
  if (!from) throw new Error("renderRoleIntent: source is required — say where the reason came from");
  const NEXT = `The next step is not your name going to them. They have set a high bar on ${strict}, so I would come back with ${count} specific questions first. I only put someone forward when I can back them with ${backing}, and I will tell you straight if I cannot.`;
  const WHY = `I thought of you because ${why}. That is from ${from}, not a guess of mine.`;

  const article = /^[aeiou]/i.test(role) ? "An" : "A";
  const headline = `${article} ${roleInSentence(role)} role in ${place}`;
  const QUESTIONS = [
    "1. Are you looking at the moment?",
    "2. Does this role interest you?",
    "3. If yes to both, may I take the next step with you?",
  ];

  const content =
    lead("a role, and why you") +
    h1(`${headline}.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    p(`You told me I could send you roles beyond the one you came to me for. This is one of those.`) +
    p(esc(what)) +
    p(esc(WHY)) +
    (list.length ? p(`The facts that usually decide it:`) + bullets(list.map((f) => esc(f))) : "") +
    p(`Three questions, and short answers are fine:`) +
    QUESTIONS.map((q) => p(`<b style="color:${C.ink};font-weight:600;">${esc(q)}</b>`)).join("") +
    p(esc(NEXT)) +
    p(`I am not naming the company in this email. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point.`) +
    p(`If it is a no, say so and that is the end of it. If I do not hear back, nothing happens and nothing is held against you.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(`${headline}, and why I thought of you`),
    html: emailShell({
      preheader: `Three short questions. Nothing about you goes anywhere until you say so.`,
      title: headline, contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieroleintent",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      `You told me I could send you roles beyond the one you came to me for. This is one of those.`, "",
      t(what), "",
      t(WHY), "",
      ...(list.length ? [`The facts that usually decide it:`, "", ...list.map((f) => `- ${t(f)}`), ""] : []),
      `Three questions, and short answers are fine:`, "",
      ...QUESTIONS, "",
      t(NEXT), "",
      `I am not naming the company in this email. You will know exactly who it is before your name goes anywhere near them, and you can stop at that point.`, "",
      `If it is a no, say so and that is the end of it. If I do not hear back, nothing happens and nothing is held against you.`, "",
      `Charlie`,
    ].join("\n"),
  };
}

/**
 * What anybody who answers renderRoleIntent gets back. ONE COPY, FOR EVERY ANSWER, ON PURPOSE.
 *
 * The mail asked three questions, so a reply is rarely one word and often mixed: "looking, yes, but
 * not five days on site". Sorting that into yes or no by pattern would file a condition as consent.
 * So nothing is classified here. Every sentence below is true whichever way they answered, and a
 * person reads their words and acts on them.
 *
 * WHY NOT renderAskAnswerAck. It says their background is going to the hiring side. Said to somebody
 * who has just declined, that is the opposite of what they were promised.
 */
export function renderIntentAnswer({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const LINES = [
    `Thanks${nm}. I have your answer, and a person is reading it rather than a filter.`,
    `If it was a yes, the next thing you hear from me is the questions I mentioned. Nothing about you has gone to the company, and nothing will until you know who they are and have said so.`,
    `If it was a no, nothing moves and nothing is held against you.`,
  ];
  const content = lead("noted") + h1("Got it, thank you.") + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject("Got it, thank you"),
    html: emailShell({
      preheader: "Noted. Nothing about you has gone anywhere.", title: "Got it, thank you", contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlieintentanswer",
    }),
    text: `${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

/**
 * The questions that follow a yes to renderRoleIntent: one per thing the client's brief requires
 * and the person's record does not mention.
 *
 * WHO GETS THIS. Only somebody who answered the first mail and said they want the role. It is never
 * a first contact: the hard questions are what a yes costs, and asking them of somebody who has not
 * said yes is asking a stranger to justify themselves.
 *
 * THE QUESTIONS ARE PASSED IN, written by a human from the brief's own must-haves. The template
 * states nothing about the job and nothing about the person, so neither a requirement the client
 * never made nor a gap the person does not have can originate here.
 *
 * "NOT SOMETHING I HAVE DONE" IS INVITED, IN THOSE WORDS. A question that only accepts a good
 * answer produces inflated ones, and an inflated answer passed to a client is ours to explain.
 *
 * IT PROMISES A STRAIGHT ANSWER AND NOTHING ELSE. Not that they will be put forward, not a date.
 */
export function renderIntentQuestions({ email, name = "", roleTitle = "", city = "", questions = [] } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const role = String(roleTitle || "").trim();
  const place = String(city || "").trim();
  const list = (questions || []).map((q) => String(q || "").trim()).filter(Boolean);
  if (!role) throw new Error("renderIntentQuestions: roleTitle is required");
  if (!place) throw new Error("renderIntentQuestions: city is required");
  if (!list.length) throw new Error("renderIntentQuestions: at least one question is required — there is nothing to ask");
  if (list.length > 5) throw new Error("renderIntentQuestions: five questions at most — more than that is a form, not a mail");

  const COUNT = ["", "One question", "Two questions", "Three questions", "Four questions", "Five questions"][list.length];
  const numbered = list.map((q, i) => `${i + 1}. ${q}`);
  const title = `${COUNT} before I put you forward`;

  const content =
    lead("your yes, and what comes next") +
    h1(`${title}.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    p(`Thank you for saying yes to the ${esc(roleInSentence(role))} role in ${esc(place)}.`) +
    p(`The company has been specific about what they need, so I would rather ask you straight than guess from your CV. Short answers are fine, and rough numbers are fine.`) +
    numbered.map((q) => p(`<b style="color:${C.ink};font-weight:600;">${esc(q)}</b>`)).join("") +
    p(`If something here is not something you have done, say so plainly. That is a useful answer, and it is better for both of us than a generous one.`) +
    p(`Once I have your answers I will tell you straight whether I am putting you forward. If I am, you will know who the company is first, and nothing moves until you say so.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(title),
    html: emailShell({
      preheader: `Short answers are fine. Nothing about you has gone to the company.`,
      title, contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlieintentquestions",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      `Thank you for saying yes to the ${t(roleInSentence(role))} role in ${t(place)}.`, "",
      `The company has been specific about what they need, so I would rather ask you straight than guess from your CV. Short answers are fine, and rough numbers are fine.`, "",
      ...numbered.flatMap((q) => [t(q), ""]),
      `If something here is not something you have done, say so plainly. That is a useful answer, and it is better for both of us than a generous one.`, "",
      `Once I have your answers I will tell you straight whether I am putting you forward. If I am, you will know who the company is first, and nothing moves until you say so.`, "",
      `Charlie`,
    ].join("\n"),
  };
}

/**
 * What somebody who answers renderIntentQuestions gets back. One copy, and it decides nothing.
 *
 * Whether they are put forward is a person's call after reading the answers against the brief, so
 * this cannot say yes and must not imply it. It says the answers arrived, who reads them, and what
 * has not happened.
 */
export function renderQuestionsAnswer({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const LINES = [
    `Thanks${nm}. I have your answers, and a person is reading them against what the company asked for.`,
    `I will come back to you with a straight answer on whether I am putting you forward. If I am, you will know who the company is first.`,
    `Nothing about you has gone to them, and nothing will until you have said so.`,
  ];
  const content = lead("noted") + h1("Got them, thank you.") + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject("Got them, thank you"),
    html: emailShell({
      preheader: "Your answers are being read. Nothing about you has gone anywhere.", title: "Got them, thank you", contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charliequestionsanswer",
    }),
    text: `${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

/**
 * Where things stand, for somebody who replied to a role and is now waiting on the company.
 *
 * SENT WHEN THE COMPANY'S SIDE HAS GONE QUIET and the honest position is "I am holding what you gave
 * me and I do not control their timing". It names no company, states no deadline, claims no
 * submission and makes one promise, which is the one the first mail made: if anything moves, they
 * hear from me, and they know who the company is before their name goes anywhere.
 *
 * WHAT IT MUST NEVER SAY. "Your application is submitted" when nothing has been submitted; "the
 * client withdrew" when that is not ours to announce; any date. A reassuring sentence that is not
 * true costs more than the silence it replaces.
 *
 * IT ASKS NOTHING and says so. A reply to it is still read by a person: it is in ASK_TEMPLATES so
 * that a "thank you" is not answered with the questions mail's acknowledgement.
 */
export function renderRoleHold({ email, name = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const LINES = [
    `Thank you. I have what I need from you for now, and I am holding your answers and your profile.`,
    `The next step sits with the company, and I do not control their timing, so I would rather not guess at a date. If anything moves, you will hear from me, and you will know exactly who the company is before your name goes to them.`,
    `Nothing is needed from you. Nothing with your name on it has gone anywhere, and that is still your call.`,
  ];
  const content =
    lead("where this stands") +
    h1("Holding what you gave me.") +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    LINES.map((l) => p(l)).join("") +
    charlieBlock();
  return {
    subject: cleanSubject("Where this stands"),
    html: emailShell({
      preheader: "Nothing is needed from you. If anything moves, you will hear from me.",
      title: "Where this stands", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charlierolehold",
    }),
    text: `${first ? `Hi ${deDash(first)}.` : "Hi."}\n\n${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

/**
 * What somebody who writes back to renderRoleHold gets. It told them nothing was needed, so most
 * replies are a thank-you or a question, and a person reads them. This says that and nothing more.
 */
export function renderHoldAnswer({ email, name = "" } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const LINES = [
    `Thanks${nm}. I have read this, and a person has it rather than a filter.`,
    `Nothing more is needed from you. If anything moves, you will hear from me.`,
  ];
  const content = lead("noted") + h1("Got it, thank you.") + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject("Got it, thank you"),
    html: emailShell({
      preheader: "Noted. Nothing more is needed from you.", title: "Got it, thank you", contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlieholdanswer",
    }),
    text: `${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

/**
 * A direct answer to a question about the role they are already discussing.
 *
 * ONE PARAGRAPH, AND THE ANSWER IS THE WHOLE OF IT. `text` is built field by field from the stored
 * record in lib/role-answer.mjs; nothing here adds to it, softens it, or wraps it in an explanation.
 * That is the point: a person who asks "is that in Nagpur?" gets "Yes, it's in Nagpur", not a
 * note about how Charlie works.
 *
 * NO EYEBROW, NO HEADLINE OF ITS OWN BEYOND THE ANSWER. Every other template opens by announcing what
 * kind of message it is. A reply in a thread somebody is already in does not need announcing, and the
 * announcement is what makes a short answer feel like a form letter.
 */
export function renderRoleAnswer({ email, text = "", replySubject = "" } = {}) {
  const answer = String(text || "").trim();
  // ANSWER UNDER THE SUBJECT THEY WROTE UNDER. The send helper already threads on In-Reply-To, so a
  // new subject would still group; it would just read as a different conversation to anyone scanning
  // their inbox. A recruiter's reply keeps the subject. Falls back only when we have none.
  const theirs = String(replySubject || "").trim().replace(/^\s*(re:\s*)+/i, "");
  // No answer, no email. A blank here would send a person an empty reply, which is worse than the
  // human fallback this is supposed to beat.
  if (!answer) throw new Error("renderRoleAnswer: text is required");
  const content = p(esc(answer)) + charlieBlock();
  return {
    subject: cleanSubject(theirs ? `Re: ${theirs}` : "Answering that"),
    html: emailShell({
      preheader: answer.slice(0, 90),
      title: "Answering that", contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlieroleanswer",
    }),
    text: `${deDash(answer)}\n\nCharlie`,
  };
}

/**
 * A role Charlie did not source and cannot put anybody forward for: a public posting, sent to one
 * person because it genuinely fits them, with the things they should weigh before applying.
 *
 * IT SAYS WHAT IT IS NOT. Every other role Charlie sends comes with "reply yes and I'll put you
 * forward", because that is a thing Charlie does. This one goes direct to the company's own form,
 * so the copy says so plainly. A person who thinks they arrived referred, and did not, has been
 * misled by omission.
 *
 * THE FLAWS ARE THE POINT, NOT A DISCLAIMER. `thingsToKnow` carries what the posting itself admits:
 * the days, the intensity, the pay. They are quoted from the source and never softened. Sending
 * somebody a role without them is how you spend their week for them.
 *
 * `whyYou` IS GROUNDED OR IT IS ABSENT. It comes from a screen against their own written evidence,
 * and the caller passes it or omits it. Nothing here generates a reason.
 */
export function renderPublicRole({ email, name = "", company = "", roleLine = "", whyYou = "", thingsToKnow = [], applyUrl = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const co = String(company || "").trim();
  const line = String(roleLine || "").trim();
  const url = String(applyUrl || "").trim();
  // No company, no role, no link: refuse. A role email somebody cannot act on is worse than none.
  if (!co) throw new Error("renderPublicRole: company is required");
  if (!line) throw new Error("renderPublicRole: roleLine is required");
  if (!url) throw new Error("renderPublicRole: applyUrl is required");

  const facts = (thingsToKnow || []).map((t) => String(t || "").trim()).filter(Boolean);
  const factsHtml = facts.length
    ? p(`Things they've said plainly, worth weighing before you apply:`) +
      facts.map((f) => p(`<span style="color:${C.ink};">&bull;</span> ${esc(f)}`)).join("")
    : "";

  const content =
    lead("a role") +
    h1(`${esc(co)} are hiring, and this one fits you.`) +
    p(`${first ? `${first},` : "Hi."}`) +
    p(esc(line)) +
    (whyYou ? p(`Why you: ${esc(String(whyYou).trim())}`) : "") +
    factsHtml +
    p(`If that reads as your kind of thing, their form is here.`) +
    primaryBtn(url, "See the role") +
    p(`I'm not putting you forward on this one. It goes direct to them, and I get nothing either way. I just thought you should see it.`) +
    charlieBlock();

  const t = (x) => deDash(String(x || ""));
  return {
    subject: cleanSubject(`${co} are hiring, and it fits you`),
    html: emailShell({
      preheader: line.slice(0, 90),
      title: `${co} are hiring`, contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charliepublicrole",
    }),
    // Blocks, joined by a blank line. Built by pushing rather than filtering: filtering empty
    // strings to drop optional blocks would strip every paragraph break with them.
    text: (() => {
      const B = [];
      B.push(first ? `${t(first)},` : `Hi.`);
      B.push(t(line));
      if (whyYou) B.push(`Why you: ${t(whyYou)}`);
      if (facts.length) B.push(`Things they've said plainly, worth weighing before you apply:\n${facts.map((f) => `- ${t(f)}`).join("\n")}`);
      B.push(`If that reads as your kind of thing, their form is here:\n${url}`);
      B.push(`I'm not putting you forward on this one. It goes direct to them, and I get nothing either way. I just thought you should see it.`);
      B.push(`Charlie`);
      return B.join("\n\n");
    })(),
  };
}

/**
 * One role, to one person, with the reason in their own words, and two questions in the footer.
 *
 * THE QUOTE COMES BEFORE THE ROLE, and that ordering is the product. Every job alert in the world
 * leads with the job. Leading with what they told us is the only part a person cannot get anywhere
 * else, and it is the thing that earns the next thirty seconds.
 *
 * NO QUOTE, NO EMAIL. `quote` and `why` are required and the caller has already checked the quote
 * appears verbatim in the person's own material. A "why" we cannot trace is
 * the thing this product exists not to send, and dropping those people is the feature.
 *
 * THE TWO ASKS ARE THE POINT, NOT A FOOTER. Liveness is what the pool is missing: `seeking_status`
 * carries no date, so an "active seeker" from three months ago reads the same as one from
 * this morning. And the offer question is the line no job board asks, which shortens a hiring
 * manager's decision from weeks to days. Both are framed as useful to THEM, because they are.
 */
export function renderRoleMatch({ email, name = "", quote = "", why = "", subject = "", job = {}, companyInfo = null } = {}) {
  const first = esc(greetingName(name));
  const q = String(quote || "").trim();
  const w = String(why || "").trim();
  const title = String(job?.title || "").trim();
  const company = String(job?.company || "").trim();
  const where = String(job?.location || "").trim();
  const url = String(job?.apply_url || "").trim();
  // Every one of these is required. A role email missing any of them is one the person cannot act on
  // or cannot trust, and both are worse than not sending.
  if (!q) throw new Error("renderRoleMatch: quote is required — no citation, no email");
  if (!w) throw new Error("renderRoleMatch: why is required");
  if (!title || !company) throw new Error("renderRoleMatch: the role needs a title and a company");
  if (!url) throw new Error("renderRoleMatch: applyUrl is required");
  // "2026-08-20" is a timestamp. A person reads a date.
  const posted = (() => {
    const d = new Date(String(job?.posted_at || ""));
    if (!Number.isFinite(d.getTime())) return "";
    return `posted ${d.getUTCDate()} ${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getUTCMonth()]}`;
  })();

  // THE WHOLE OFFER IN ONE BLOCK. The role, the reason, the company and the link live together on a
  // C.soft card; the person's own quote sits OUTSIDE it as the setup. So the email reads as one
  // sentence with an attachment: you said this, so I looked for that, and here it is.
  //
  // Before this the role was a bold line and the reason a paragraph, separated by a button, and a
  // reader scanning on a phone met four unrelated blocks instead of one offer.
  const line2 = [company, where, posted].filter(Boolean).map((x) => esc(x)).join(" &middot; ");
  // THESE FIELDS ARE NOT ALL STRINGS. Ashby returns compensation as an object, several boards return
  // remote as a boolean, and String() on either produces "[object Object]" and "true". Anything not
  // readable as a phrase is dropped rather than printed.
  const compText = (() => {
    const c = job?.compensation;
    if (typeof c === "string") return c.trim();
    if (c && typeof c === "object") return String(c.compensationTierSummary || "").trim();
    return "";
  })()
    // A dash between two numbers is a RANGE. deDash turns it into a comma further down, and
    // "$120K, $150K" reads as two figures rather than one band. Say the word instead.
    .replace(/(\d\s*[A-Za-z]*)\s*[\u2010-\u2015-]\s*(?=[$\u20B9\d])/g, "$1 to ").replace(/\s+/g, " ").trim();
  const remoteText = (() => {
    const r = job?.remote;
    if (typeof r === "string") return r.trim();
    if (r === true) return "remote";
    return "";
  })();
  // "FullTime", "full_time", "Full-time Employment" all mean the same thing to a reader.
  const etText = String(job?.employment_type || "").replace(/[_-]+/g, " ").replace(/\bfulltime\b/i, "full time")
    .replace(/\s+Employment$/i, "").trim().toLowerCase();
  const meta = [compText, remoteText, etText]
    .map((x) => String(x).trim()).filter((x) => x && x !== "null" && x !== "true")
    .map((x) => esc(x)).join(" &middot; ");
  const about = String(companyInfo?.what || "").trim();
  const stage = [companyInfo?.stage, companyInfo?.size].filter(Boolean).map((x) => esc(x)).join(" &middot; ");

  const offerCard =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;"><tbody><tr>` +
    `<td style="background:${C.soft};border-radius:14px;padding:20px 22px;">` +
      `<div style="font-family:${HEAD_FONT};font-weight:400;font-size:20px;line-height:1.3;color:${C.ink};margin:0 0 4px;">${esc(title)}</div>` +
      `<div style="font-family:${SANS};font-size:14px;line-height:1.5;color:${C.text};margin:0 0 ${meta ? "3px" : "14px"};">${line2}</div>` +
      (meta ? `<div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.mute};margin:0 0 14px;">${meta}</div>` : "") +
      `<div style="font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.text};margin:0 0 ${about ? "14px" : "16px"};">${esc(w)}</div>` +
      (about
        ? `<div style="border-top:1px solid ${C.line};padding:13px 0 0;margin:0 0 16px;">` +
          `<div style="font-family:${SANS};font-size:13px;line-height:1.55;color:${C.mute};">${esc(about)}${stage ? `<br>${stage}` : ""}</div>` +
          `</div>`
        : "") +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>` +
      `<td style="background:${C.ink};border-radius:8px;">` +
      `<a href="${esc(url)}" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.white};text-decoration:none;padding:12px 22px;">See the role &rarr;</a>` +
      `</td></tr></tbody></table>` +
    `</td></tr></tbody></table>`;

  // The headline is the first sentence and the body is the rest, so the reader is not told the same
  // thing twice. When there is only one sentence it carries the headline and repeats below it, which
  // is the least bad option for a one-sentence reason.
  const wParts = w.split(/(?<=\.)\s+/);
  const wHead = wParts[0] || w;
  const wRest = wParts.slice(1).join(" ").trim();

  // THE QUOTE IS PROOF, NOT COPY. It is still required, still checked against their own words, and
  // the person is still dropped when it cannot be found. It is simply no longer printed at them:
  // opening an email by quoting somebody's own application back to them reads like a machine playing
  // a record, and it made the reason look like a filter explaining itself.
  //
  // ONE ASK, NOT THREE. The old footer stacked "reply open" + "got an offer?" + "wrong role?", all
  // three of them about OUR bookkeeping, under a heading about what we would do with the answer.
  // A person who has just been shown a job has one thing on their mind and it is the job.
  const content =
    lead("one role") +
    h1(esc(wHead)) +
    p(`${first ? `${first},` : "Hi."}`) +
    p(esc(wRest || wHead)) +
    offerCard +
    p(`If you&rsquo;re still looking, reply and say so. I&rsquo;ll keep going. If you&rsquo;ve stopped, or this one is wrong, say that instead and I&rsquo;ll stop or aim better.`) +
    charlieBlock();

  const t = (x) => deDash(String(x || ""));
  return {
    // The model writes the subject because "Senior Product Designer at Dispatch" is a job board and
    // this email is not one. It falls back to the job-board line rather than sending nothing.
    subject: cleanSubject(String(subject || "").trim() || `${title} at ${company}`),
    html: emailShell({
      preheader: `${title} at ${company}.`,
      title: `${title} at ${company}`, contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlierolematch",
    }),
    text: [
      first ? `${t(first)},` : `Hi.`,
      t(w),
      [`${t(title)}`, [company, where, posted].filter(Boolean).map(t).join(" · "),
       [compText, remoteText, etText].filter(Boolean).map(t).join(" · ")].filter(Boolean).join("\n"),
      about ? `${t(about)}${stage ? `\n${[companyInfo?.stage, companyInfo?.size].filter(Boolean).map(t).join(" · ")}` : ""}` : "",
      url,
      `If you're still looking, reply and say so. I'll keep going. If you've stopped, or this one is wrong, say that instead and I'll stop or aim better.`,
      `Charlie`,
    ].filter((x) => String(x).trim()).join("\n\n"),
  };
}

/**
 * The answer to somebody who told us where they stand.
 *
 * FOUR OUTCOMES, BECAUSE FOUR THINGS CAN BE SAID. An "open" and a "stop" are opposite facts about a
 * person and cannot share a sentence. An offer changes what we do next. And an unreadable reply gets
 * told a human is looking, which is true, rather than being filed as either.
 *
 * A STOP IS ANSWERED WARMLY AND WITHOUT FRICTION. Somebody who tells us they have stopped looking
 * has done us a favour: it is the single hardest fact for this product to learn, and the pool is full
 * of people whose silence we have been guessing at. Nothing here asks them to reconsider.
 */
export function renderSeekingNoted({ email, name = "", open = false, stop = false, offer = false, unclear = false } = {}) {
  const nm = name ? ` ${esc(String(name).trim().split(/\s+/)[0])}` : "";
  const LINES = unclear
    ? [`Thanks${nm}. I have read this and I would rather a person answered it than have me guess, so someone will come back to you shortly.`,
       `Nothing has changed on your side in the meantime.`]
    : stop
      ? [`Thanks${nm}, noted. I have stopped sending you roles.`,
         `That is genuinely useful to me and it is not a door closing. Tell me whenever you want them again and I will pick straight back up.`]
      : [`Thanks${nm}. You are marked as looking for the next 30 days, and I will check with you before that runs out.`,
         offer
           ? `I have also noted the offer. That matters: when I put you in front of someone I can tell them your timeline is real, and that tends to shorten it on their side too.`
           : `If an offer turns up anywhere, tell me. It is the one thing that gets a hiring manager to move in days rather than weeks.`,
         `Nothing else needed from you.`];

  const title = unclear ? "Let me get you a proper answer." : stop ? "Got it, stopped." : "Noted, thank you.";
  const content = lead("noted") + h1(title) + LINES.map((l) => p(l)).join("") + charlieBlock();
  return {
    subject: cleanSubject(unclear ? "Let me get you a proper answer" : stop ? "Stopped, thank you" : "Noted, thank you"),
    html: emailShell({
      preheader: unclear ? "A person is reading this." : stop ? "No more roles from me." : "Marked as looking for 30 days.",
      title: title.replace(/[.]$/, ""), contentHtml: content,
      unsubUrl: unsubUrlFor(email), tag: "charlieseekingnoted",
    }),
    text: `${LINES.map((l) => deDash(l)).join("\n\n")}\n\nCharlie`,
  };
}

export function renderCvRequest({ email, name = "", company = "", roleTitle = "", formUrl = "" } = {}) {
  const first = name ? esc(String(name).trim().split(/\s+/)[0]) : "";
  const co = esc(company);
  const role = esc(roleTitle);
  const url = String(formUrl || "").trim();
  if (!url) throw new Error("renderCvRequest: formUrl is required"); // no link, no email

  const content =
    lead("your application") +
    h1(`${co} would like your CV.`) +
    p(`${first ? `Hi ${first}.` : "Hi."}`) +
    p(`Your application for the ${role} role is with <b style="color:${C.ink};font-weight:600;">${co}</b>'s hiring team.`) +
    p(`They read CVs alongside everything you wrote, and our form had nowhere to attach one. So if you would like yours in front of them, this is where it goes:`) +
    p(`<a href="${esc(url)}" style="color:${C.coral};font-weight:600;">${esc(url)}</a>`) +
    p(`Ten seconds. Use the same email you applied with, attach the file, done.`) +
    p(`If you would rather not, your application still stands on what you already sent.`) +
    charlieBlock();

  const t = (s) => deDash(String(s || ""));
  return {
    subject: cleanSubject(`${company} would like to see your CV`),
    html: emailShell({
      preheader: `Our form had nowhere to attach one. Here is where it goes.`,
      title: `${company} would like your CV`,
      contentHtml: content,
      unsubUrl: unsubUrlFor(email),
      tag: "charliecvrequest",
    }),
    text: [
      first ? `Hi ${t(first)}.` : `Hi.`, "",
      `Your application for the ${t(roleTitle)} role is with ${t(company)}'s hiring team.`, "",
      `They read CVs alongside everything you wrote, and our form had nowhere to attach one. So if you would like yours in front of them, this is where it goes:`, "",
      url, "",
      `Ten seconds. Use the same email you applied with, attach the file, done.`, "",
      `If you would rather not, your application still stands on what you already sent.`, "",
      `Charlie`,
    ].join("\n"),
  };
}

// ── the shell the Qualify & Submit emails share ─────────────────────────────────────────────────────

function mandateEmail({ preheader, title, lines, list = null, unsubUrl, tag }) {
  const html = lines.map((l, i) => (list && i === list.after ? p(esc(l)) + `<ol style="font-family:${SANS};font-size:14.5px;line-height:1.62;color:${C.text};margin:0 0 14px;padding-left:22px;">${list.items.map((q) => `<li style="margin:0 0 6px;">${esc(q)}</li>`).join("")}</ol>` : p(esc(l)))).join("");
  const text = lines.map((l, i) => (list && i === list.after ? `${deDash(l)}\n\n${list.items.map((q, n) => `${n + 1}. ${deDash(q)}`).join("\n")}` : deDash(l))).join("\n\n");
  return {
    html: emailShell({ preheader, title, contentHtml: html + charlieBlock(), unsubUrl, tag }),
    text: `${text}\n\nCharlie`,
  };
}
const mFirst = (name) => (name ? String(name).trim().split(/\s+/)[0] : "");
// ── the Qualify & Submit agent's emails (lib/qualify/agent.mjs) ───────────────────────────────────
//
// One sequence for every employer connection. The words about the job (role, company, city, the partner it goes
// through) are passed in; the
// questions are the ones lib/qualify/fields.mjs chose for this person. A connection may override the opening
// and closing lines; lib/qualify/copy.mjs fills and checks them before they arrive here. Nothing here describes
// the person, and nothing promises an outcome: the employer decides.

const qArticle = (role) => (/^[aeiou]/i.test(String(role || "").trim()) ? "an" : "a");

/** Q1. Verify: may I put you forward, and only the questions their record leaves open. */
export function renderQualifyVerify({ name = "", role = "", company = "", city = "", partner = "", questions = [], intro = null, closing = null, unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderQualifyVerify: role and company are required");
  if (!questions.length) throw new Error("renderQualifyVerify: questions are required");
  const lines = [
    `Hi ${mFirst(name) || "there"}.`,
    intro || `${company} is hiring for ${qArticle(role)} ${role} role${city ? ` in ${city}` : ""}${partner ? `, and I can put you forward through ${partner}` : ""}. I think you could fit it, and before your name goes anywhere I want to check a few things with you.`,
    `Short answers are fine. Just reply to this email:`,
    closing || `Nothing about you goes to ${company} unless you say yes to the first question. If it is a no, say so and I won't write about this role again.`,
  ];
  const title = `${role} at ${company}`;
  return { subject: cleanSubject(`${title}: may I put you forward?`), ...mandateEmail({ preheader: `A few quick questions first. Nothing goes to ${company} without your yes.`, title, lines, list: { after: 2, items: questions }, unsubUrl, tag: "charliequalifyverify" }) };
}

/** Q2. The one reminder, 48 hours after an unanswered verify email. */
export function renderQualifyReminder({ name = "", role = "", company = "", unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderQualifyReminder: role and company are required");
  const lines = [
    `Hi ${mFirst(name) || "there"}, a quick nudge about the ${role} role at ${company} I wrote about two days ago.`,
    `If you are interested, reply to that email with your answers. If not, there is nothing to do and I won't write again.`,
  ];
  return { subject: cleanSubject(`Still open: ${role} at ${company}`), ...mandateEmail({ preheader: lines[1], title: `Still open: ${role}`, lines, unsubUrl, tag: "charliequalifyreminder" }) };
}

/**
 * Q2b. The final confirm, before anything is submitted: exactly what will be sent, and a reply of
 * just YES. The person checks our reading of them (pay, notice, the CV file) before it goes; a correction is filed
 * and confirmed again. Nothing here judges them; every value is theirs.
 */
export function renderQualifyConfirm({ name = "", role = "", company = "", city = "", partner = "", facts = [], again = false, unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderQualifyConfirm: role and company are required");
  if (!facts.length) throw new Error("renderQualifyConfirm: facts are required");
  const lines = [
    `Hi ${mFirst(name) || "there"}.`,
    ...(again ? ["Here are your details again, with the latest you sent. I put you forward only on a reply that is just the word YES, so nothing has been sent yet."] : []),
    `Here is exactly what I will send to ${company}${partner ? ` through ${partner}` : ""} for the ${role} role${city ? ` in ${city}` : ""}:`,
    `If all of this is right, reply with just YES and I will put you forward. If anything is wrong, reply with the correction, and nothing is sent until it is right.`,
  ];
  return { subject: cleanSubject(`Reply YES to be put forward to ${company}`), ...mandateEmail({ preheader: "Check the details, then reply with just YES.", title: `Ready for ${company}`, lines, list: { after: again ? 2 : 1, items: facts }, unsubUrl, tag: "charliequalifyconfirm" }) };
}

/** Q3. Put forward: they said yes, and their details went to the employer. */
export function renderQualifyPutForward({ name = "", role = "", company = "", partner = "", unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderQualifyPutForward: role and company are required");
  const lines = [
    `Hi ${mFirst(name) || "there"}.`,
    `As you agreed, I have put you forward to ${company} for the ${role} role${partner ? `, through ${partner}` : ""}.`,
    `What happens next is theirs to decide, and they may contact you directly.`,
  ];
  return { subject: cleanSubject(`I have put you forward to ${company}`), ...mandateEmail({ preheader: lines[2], title: `Put forward to ${company}`, lines, unsubUrl, tag: "charliequalifyputforward" }) };
}

/**
 * Q5. The hand-off by email: the pack to the employer's hiring contact, sent only after the person
 * said YES to exactly these facts. The facts are the confirmed lines, unchanged; only the note's label is addressed to
 * the employer instead of to the person. Replies are not read (Charlie leaves the room), so it says where to write.
 */
export function renderQualifyHandoff({ org = "", name = "", candidateEmail = "", role = "", company = "", contact = "", facts = [], unsubUrl = "#" } = {}) {
  if (!role || !company || !name || !candidateEmail) throw new Error("renderQualifyHandoff: name, candidateEmail, role and company are required");
  if (!Array.isArray(facts) || !facts.length) throw new Error("renderQualifyHandoff: the confirmed facts are required");
  const items = facts.map((f) => String(f).replace(/^What I will say about you: /, "About them: "));
  const lines = [
    `Hi ${mFirst(contact) || "there"}.`,
    org ? `On behalf of ${org}, I am introducing ${name} for the ${role} role at ${company}.` : `I am introducing ${name} for the ${role} role at ${company}.`,
    `They confirmed every detail below and agreed to be put forward to ${company}. Their CV is attached.`,
    `Replies here don't reach me, so please write to ${mFirst(name)} directly at ${candidateEmail}.`,
  ];
  return { subject: cleanSubject(`Introducing ${name} for ${role}`), ...mandateEmail({ preheader: `${name} for the ${role} role, with their CV.`, title: `Introducing ${name}`, lines, list: { after: 2, items }, unsubUrl, tag: "charliequalifyhandoff" }) };
}

export function renderQualifyClosed({ name = "", role = "", company = "", noYes = false, unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderQualifyClosed: role and company are required");
  // noYes: the details were confirmed twice without a reply of just YES. Said plainly, never "you said no"
  const lines = [
    `Thanks for your reply${mFirst(name) ? `, ${mFirst(name)}` : ""}.`,
    noYes
      ? `I didn't get a reply of just YES, so I haven't put you forward for the ${role} role at ${company}, and nothing was sent to them.`
      : `I won't put you forward for the ${role} role at ${company}, and I won't write about it again.`,
  ];
  return { subject: "Thank you for your reply", ...mandateEmail({ preheader: lines[1], title: "Thank you for your reply", lines, unsubUrl, tag: "charliequalifyclosed" }) };
}

// ── Pieworks 2call activation (lib/pieworks-activation.mjs) ──────────────────────────────────────
//
// Pieworks pushes people who have sat in its 2call stage for a week; Charlie asks each one, once, whether they are still
// interested, and a yes moves them to interested in Pieworks. The role, company and city come from Pieworks' active
// roles (the company is public: Pieworks publishes it with the role). Nothing here describes the person, and nothing
// promises an outcome: Pieworks and the company decide what happens next.
// The candidate emails carry no Gmail-filter tag (the shell's hidden anchor): a candidate has no such filter, and the
// tag would show as a stray word in their inbox preview. The owner's stats email keeps its tag.

/**
 * P1. The ask: still interested? Personal, and every line is a fact Pieworks gave us: whether they were referred, the
 * role's fixed pay, its years band (their own years only when inside it, so it never points at a gap) and the role's
 * first responsibility. Each fact line is optional: lib/pieworks-activation.mjs leaves out anything it could not read
 * cleanly, and this never fills one in.
 */
export function renderPieworksAsk({ name = "", role = "", company = "", city = "", referred = false, pay = "", years = "", line = "", unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderPieworksAsk: role and company are required");
  const first = mFirst(name);
  const where = `the ${role} role at ${company}${city ? ` in ${city}` : ""}`;
  const lines = [
    `Hi ${first || "there"},`,
    referred ? `You were referred to Pieworks for ${where}, and you're on their shortlist.` : `You're on Pieworks' shortlist for ${where}.`,
    ...(pay ? [`Pay: ${pay}`] : []),
    ...(years ? [`Experience: ${years}`] : []),
    ...(line ? [`The role: ${line}`] : []),
    `Still interested? Reply YES and I'll pass it straight to the Pieworks team so they can take the next step with you. If it's not right, reply NO and I won't write about it again.`,
  ];
  const lead = referred ? "you were referred for" : "you're on the shortlist for";
  const subject = first ? `${first}, ${lead} ${role} at ${company}` : `${lead.charAt(0).toUpperCase()}${lead.slice(1)} ${role} at ${company}`;
  return { subject: cleanSubject(subject), ...mandateEmail({ preheader: "Reply YES or NO. That's all I need.", title: `${role} at ${company}`, lines, unsubUrl, tag: "" }) };
}

/** P2. The one reminder, 48 hours after an unanswered ask. */
export function renderPieworksReminder({ name = "", role = "", company = "", referred = false, unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderPieworksReminder: role and company are required");
  const lines = [
    `Hi ${mFirst(name) || "there"}, a quick nudge about the ${role} role at ${company}${referred ? " you were referred for" : ""}. I wrote about it two days ago.`,
    `If you're still interested, reply YES and I'll pass it straight to the Pieworks team. If not, there's nothing to do and I won't write again.`,
  ];
  return { subject: cleanSubject(`Still open: ${role} at ${company}`), ...mandateEmail({ preheader: lines[1], title: `Still open: ${role}`, lines, unsubUrl, tag: "" }) };
}

/** P3. Once, when a reply could not be read as a yes or a no. */
export function renderPieworksClarify({ name = "", role = "", company = "", unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderPieworksClarify: role and company are required");
  const lines = [
    `Thanks for getting back to me${mFirst(name) ? `, ${mFirst(name)}` : ""}.`,
    `So I pass on the right answer: are you interested in the ${role} role at ${company}? A one-word reply is perfect, YES or NO.`,
  ];
  return { subject: cleanSubject(`Quick check: ${role} at ${company}`), ...mandateEmail({ preheader: "A one-word reply is perfect, YES or NO.", title: `Quick check: ${role}`, lines, unsubUrl, tag: "" }) };
}

/** P4. After a yes, once Pieworks has it (sent only after Pieworks accepted the move, so the line is true). */
export function renderPieworksNoted({ name = "", role = "", company = "", unsubUrl = "#" } = {}) {
  if (!role || !company) throw new Error("renderPieworksNoted: role and company are required");
  const lines = [
    `Thanks${mFirst(name) ? `, ${mFirst(name)}` : ""}. I've passed your interest in the ${role} role at ${company} to the Pieworks team, so they can take the next step with you.`,
    `Nothing else to do for now.`,
  ];
  return { subject: cleanSubject(`Done: ${role} at ${company}`), ...mandateEmail({ preheader: lines[0], title: "Passed to the Pieworks team", lines, unsubUrl, tag: "" }) };
}

/** P5. The owner's weekly count: how many were emailed, and how many moved to interested. Owner-only. */
export function renderPieworksStats({ week = {}, all = {}, unsubUrl = "#" } = {}) {
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const pct = (a, b) => (n(b) ? `${Math.round((100 * n(a)) / n(b))}%` : "no one emailed yet");
  const lines = [
    `This week: ${n(week.emailed)} emailed, ${n(week.interested)} moved to interested (${pct(week.interested, week.emailed)}).`,
    `All time: ${n(all.emailed)} emailed, ${n(all.interested)} moved to interested (${pct(all.interested, all.emailed)}).`,
    `Of everyone emailed so far: ${n(all.declined)} said no, ${n(all.waiting)} have not answered yet, ${n(all.closed)} never answered.${n(all.pending) ? ` ${n(all.pending)} said yes but Pieworks has not accepted the update yet; I keep trying.` : ""}`,
  ];
  return { subject: cleanSubject(`Pieworks: ${n(week.emailed)} emailed, ${n(week.interested)} moved to interested this week`), ...mandateEmail({ preheader: lines[0], title: "Pieworks this week", lines, unsubUrl, tag: "charliepieworksstats" }) };
}
