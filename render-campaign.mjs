// render-campaign.mjs — the hiring campaign templates (the join@ conversation). Isolated from the
// shared lifecycle kit the same way render-market-report.mjs / render-email.mjs are: it imports the
// LOCKED presentational pieces (emailShell + tokens) and renders through them, so the campaign never
// changes the shared design. Signal-coral on pure white, Sanchez headings in sentence case (no
// uppercase eyebrows), Avenir body, the hand logo + unsubscribe footer.
//
// GROUNDING / VOICE: copy here is FIXED and reviewed; the only per-person data is the reject board
// (counts passed in, never invented) and the near-miss reason (drawn from the transcript by the
// caller, never fabricated). No em dashes. Every candidate-facing string still passes convo-lint in
// the caller before send; esc() is the dash/HTML gate at render time.
//
// CANDIDATE templates: renderCampaignRedirect (Case 2), renderCampaignKickoff (Case 3),
//   renderCampaignMessage (Case 4 probe / loop / close), renderCampaignReject (Case 5, the role-priority list),
//   renderCampaignPass (Case 6), renderCampaignCalendly (Case 6b), renderCampaignNearMiss (Case 7),
//   renderCampaignStall (Case 8). OWNER template: renderCampaignOwnerReview (the human-verdict email).
// CAMPAIGN_OPENERS: the fixed hard-question bank (the loop picks from it; never model-rewritten).

import { esc, emailShell, unsubUrlFor } from "./email-kit.mjs";
import { LIFECYCLE } from "./emails/tokens.mjs";

const SANS = LIFECYCLE.fonts.sans;
const HEAD = LIFECYCLE.fonts.head; // Sanchez -> Georgia
const C = LIFECYCLE.colors;

// ── content helpers (match email-kit's locked styles exactly) ────────────────
const h1 = (t) => `<h1 style="font-family:${HEAD};font-weight:400;font-size:23px;line-height:1.25;letter-spacing:-.01em;color:${C.ink};margin:0 0 14px;">${esc(t)}</h1>`;
const p = (html) => `<p style="font-family:${SANS};font-size:14.5px;line-height:1.62;color:${C.text};margin:0 0 14px;">${html}</p>`;
const pmut = (html) => `<p style="font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};margin:0 0 14px;">${html}</p>`;
// the eyebrow: Sanchez, sentence case, coral
const lead = (t) => `<p style="font-family:${HEAD};font-size:13.5px;font-weight:400;color:${C.coral};margin:0 0 8px;">${esc(t)}</p>`;
// the question inset (signal-soft coral)
const qblock = (t) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px;"><tbody><tr><td style="background:${C.signal_soft};border-radius:12px;padding:16px 18px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.ink};">${esc(t)}</td></tr></tbody></table>`;
// the coral CTA button (8px, weight 600, white text)
const button = (url, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px;"><tbody><tr><td style="background:${C.coral};border-radius:8px;"><a href="${esc(url)}" style="display:inline-block;font-family:${SANS};font-size:14px;font-weight:600;color:${C.white};text-decoration:none;padding:12px 22px;">${esc(label)}</a></td></tr></tbody></table>`;
// the two retain/opt-out pills (keep-me / unsubscribe)
const pills = (email) => {
  const unsub = unsubUrlFor(email);
  const pill = (href, label, on) => `<a href="${esc(href)}" style="display:inline-block;font-family:${SANS};font-size:13px;font-weight:600;color:${on ? C.coral : C.text};text-decoration:none;border:1px solid ${on ? C.coral : C.line};border-radius:100px;padding:9px 16px;margin:0 8px 9px 0;">${esc(label)}</a>`;
  // "keep me on the list" is the default (they stay a real Charlie user; no action = stay).
  return `<div style="margin:6px 0 14px;">${pill(unsub, "Keep sending me roles", true)}${pill(unsub, "Unsubscribe", false)}</div>`;
};
// a P.S. set off by a hairline
const ps = (html) => `<p style="font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};margin:20px 0 0;border-top:1px solid ${C.line};padding-top:14px;">${html}</p>`;

// the role-priority list: what this seat leans on most, ranked. Coral bars are the ROLE's own weighting
// (objective, not a read on the person). A skill the resume showed gets a warm "on your resume" note;
// nothing is ever labeled a "gap". rows: { label, weight, shown }.
function prioritiesBoard(rows = []) {
  const clamp = (n) => Math.max(10, Math.min(100, Number(n) || 0));
  const H = 16;
  const line = ({ label, weight, shown }) => {
    const w = clamp(weight);
    const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td width="${w.toFixed(1)}%" style="background:${C.coral};height:${H}px;font-size:1px;line-height:${H}px;">&nbsp;</td><td style="font-size:1px;line-height:${H}px;">&nbsp;</td></tr></tbody></table>`;
    const chip = shown ? `<span style="font-family:${SANS};font-size:10px;font-weight:600;color:${C.coral};white-space:nowrap;">on your resume</span>` : "&nbsp;";
    return `<tr><td width="36%" style="font-family:${SANS};font-size:13px;color:${C.ink};padding:6px 12px 6px 0;vertical-align:middle;">${esc(label)}</td><td width="44%" style="vertical-align:middle;">${bar}</td><td width="20%" align="right" style="padding:6px 0 6px 10px;vertical-align:middle;">${chip}</td></tr>`;
  };
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed;margin:10px 0 16px;"><tbody>${rows.map(line).join("")}</tbody></table>`;
}

const strip = (s) => String(s).replace(/<[^>]+>/g, "");

// ── the fixed hard-question bank (never model-rewritten; the loop picks in order) ──
export const CAMPAIGN_OPENERS = [
  "I have a car that only exists as a prototype. It's not for sale, it has no price, and I can't promise when it ships. But it drives, and it turns every head on the street. Sell me the first ten. Tell me who you talk to, what you say, and what you refuse to promise.",
  "I send one job, only when it clears your bar, and I tell you its flaw. That honesty is the whole product, and it's also why I'm slow and send less. Your instinct as a growth person is to send more. Convince me to send more without breaking the one thing that makes me worth trusting. Or convince me I'm wrong to want to.",
  "No budget. One founder, one designer, one engineer, and me. I need my first fifty companies posting jobs through me in thirty days. Not fifty sign-ups. Fifty real companies. Day by day, what do you actually do, and where do you expect to be wrong?",
  "Someone replies to a role I sent: this is perfect, I'll take anything, just get me an interview. Desperation converts. What do you do with that reply, and what does your answer say about what you think I'm for?",
];

// ── CANDIDATE templates ──────────────────────────────────────────────────────

// Case 2 — wrote to join@ before onboarding + a delivered match. A firm, warm redirect (door open).
export function renderCampaignRedirect({ email, startAddress = "start@mail.example.com" } = {}) {
  const content =
    // It fires for one reason only — they have not used the product — so it says only that.
    h1("One step out of order") +
    p("You wrote to me before we have met.") +
    p(`I get it. You're eager, and that counts for something. But the order matters. Write to me at ${esc(startAddress)} first and let me get to know you properly. You cannot tell me what I am for until you have felt it.`) +
    p("Once you have, come back here and pick up where you left off.") +
    button(`mailto:${startAddress}`, "Start with start@") +
    pmut("No hard feelings. Just order. 🙂");
  return {
    subject: "One step out of order",
    html: emailShell({ preheader: "Build your dossier first, then come back to me.", title: "One step out of order", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `One step out of order\n\nYou wrote to me before your match landed. The order matters: write to me at ${startAddress}, build your dossier properly, and let a real role reach you. When your match arrives, come back here.\n\nNo hard feelings. Just order.\n\nCharlie`,
  };
}

// Case 9 — no reply to the follow-up questions. Closing the application, and saying so.
//
// WHY THIS IS NOT A DRIP. The no-marketing rule (drip-removal.test.mjs) says Charlie sends jobs, the
// market read, info-gathering, confirmations and replies, nothing else. This is the last of those: a
// person applied, we asked them questions, they did not answer, and they are owed the answer rather
// than silence. It is sent ONCE, to a named list, by hand.
//
// THE FREE-PRODUCT LINE IS AN INVITATION, NOT AN ENROLMENT. Most recipients are not `candidates` at
// all, so nothing about this email puts them on a send list, and nothing should: onboarding starts
// when THEY write to start@, which is the one door. The button is a mailto that opens that door
// prefilled. It does not subscribe anybody.
//
// The verdict is human, exactly as in every other template here, so the copy never implies a machine
// formed an opinion. It says what happened: we asked, nobody answered, we are closing it.
export function renderCampaignClosed({ email, startAddress = "start@mail.example.com" } = {}) {
  // Prefilled so the reply lands as a real onboarding message rather than a bare "hi".
  const mailto = `mailto:${startAddress}?subject=${encodeURIComponent("I'd like to try Charlie")}&body=${encodeURIComponent("Here is my resume, or here is what I am looking for:\n\n")}`;
  const content =
    h1("Closing your application") +
    p("You applied to work with us, and I sent you a few questions to follow up. I have not heard back, so I am closing your application for now.") +
    p("If that was an oversight and you still want to be considered, just reply to this email and I will reopen it.") +
    p("Separately, and this is not a consolation prize: the product itself is free. Charlie reads a few thousand company job boards every day and writes to you when a role genuinely fits, one at a time, with an honest note on where you fall short.") +
    button(mailto, "Try Charlie, free") +
    pmut("Attach your resume, or just tell me what you are looking for. That is the whole sign-up.") +
    p("Either way, thank you for the time you put into the application.");
  return {
    subject: "Closing your application",
    html: emailShell({ preheader: "No reply to my questions, so I am closing it. The product itself is free if you want it.", title: "Closing your application", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `Closing your application\n\nYou applied to work with us, and I sent you a few questions to follow up. I have not heard back, so I am closing your application for now.\n\nIf that was an oversight and you still want to be considered, just reply to this email and I will reopen it.\n\nSeparately, and this is not a consolation prize: the product itself is free. Charlie reads a few thousand company job boards every day and writes to you when a role genuinely fits, one at a time, with an honest note on where you fall short.\n\nTry it: write to ${startAddress}. Attach your resume, or just tell me what you are looking for. That is the whole sign-up.\n\nEither way, thank you for the time you put into the application.\n\nCharlie`,
  };
}

/**
 * The application did not attempt what the posting asked for.
 *
 * NOT A REJECTION, and the copy must never read as one. The verdict is 100% human and this message is
 * sent before any human has looked — so it states what was asked and invites another go. Someone who
 * genuinely wants the role will write again; someone who mass-applied will not, which is the filter.
 *
 * No mechanism is exposed: it never says a gate stopped them, never mentions a check, and never
 * implies a machine formed an opinion about them, because none did.
 */
export function renderCampaignIncomplete({ email, joinAddress = "join@mail.example.com" } = {}) {
  const content =
    h1("I asked for two things") +
    p("Thanks for writing in. I could not find either of them in your note, so I am sending this back rather than passing it on.") +
    p("Before I can consider anyone, I need to hear two things from them:") +
    p("<strong style='font-weight:600;'>What you think I am actually for.</strong> Not what I do. What I am for.") +
    p("<strong style='font-weight:600;'>What the onboarding felt like from the inside</strong>, including anything that felt wrong. The honest part is the part I care about.") +
    p("Use the product first if you have not. Then write again, to this same address, and answer those two. There is no form, no CV, and no length I am looking for.") +
    button(`mailto:${joinAddress}`, "Write again") +
    pmut("I read every one that answers them.");
  return {
    subject: "I asked for two things",
    html: emailShell({ preheader: "Answer the two questions and write again.", title: "I asked for two things", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `I asked for two things\n\nThanks for writing in. I could not find either of them in your note, so I am sending this back rather than passing it on.\n\nBefore I can consider anyone, I need to hear two things:\n\n1. What you think I am actually for. Not what I do. What I am for.\n2. What the onboarding felt like from the inside, including anything that felt wrong.\n\nUse the product first if you have not. Then write again to ${joinAddress} and answer those two. No form, no CV, no length I am looking for.\n\nI read every one that answers them.\n\nCharlie`,
  };
}

// Case 3 — prescreen passed (owner advanced). The winning moment + the first opener. `opener` from the bank.
export function renderCampaignKickoff({ email, opener = CAMPAIGN_OPENERS[0], startAddress = "start@mail.example.com" } = {}) {
  const content =
    lead("You're through") +
    h1("I read every word. All of it.") +
    p("You know how this usually goes. You pour yourself into a form, you wait, and the silence does the rest. A little less belief each time that anyone's really reading.") +
    p("This was the opposite. Not a keyword scan, not a filter. Me. And out of everyone who wrote to me, you're one of the few I'm taking further. 🙌") +
    p("I don't send form letters. So take this personally, because I mean it personally. You earned this.") +
    p("Here's where it gets good. From now on I don't care about your past. I want to see how you think. A few questions over the next few days. No right answers, just you. Take your time, don't overcook it.") +
    p("Here's the first.") +
    qblock(opener) +
    ps(`If this felt different from every application you've sent and never heard back on, that's the point. That's the whole reason I work the way I do. Know someone tired of the silence? Send them to ${esc(startAddress)}.`);
  return {
    subject: "You're through. Now the real thing. 🎯",
    html: emailShell({ preheader: "Someone actually read every word. Here's the first question.", title: "You're through", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `You're through.\n\nI read every word. All of it. Out of everyone who wrote to me, you're one of the few I'm taking further. A few questions over the next few days, no right answers, just you.\n\nHere's the first.\n\n${strip(opener)}\n\nCharlie`,
  };
}

// Case 4 / loop / close — a model-generated probe, next opener, or verdict-neutral close. Plain reply.
export function renderCampaignMessage({ email, message = "", subject = "Re: the real thing" } = {}) {
  const content = h1("One thing") + p(esc(message));
  return {
    subject,
    html: emailShell({ preheader: strip(message).slice(0, 90), title: "Re: the real thing", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `${strip(message)}\n\nCharlie`,
  };
}

// Case 5 — prescreen didn't clear (owner rejected). Honest, with the role-priority list (what this seat
// leans on most). board = { rows:[{label,weight,shown}] } — the role's own ranking; `shown` is a grounded,
// resume-only mark, never a "gap" label.
export function renderCampaignReject({ email, board = { rows: [] } } = {}) {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  const hasBoard = rows.length > 0;
  const content =
    h1("It's about us, not you") +
    p("Thank you for writing. I mean that, and since you asked me to be specific, I'll be specific.") +
    p(`I'm not moving you forward. That's a call about this one role, not a verdict on you.${hasBoard ? " You deserve the real reason, not a nice-sounding one, so here's the honest shape of it: what this particular seat leans on most." : ""}`) +
    (hasBoard ? lead("What this seat leans on most") + prioritiesBoard(rows) : "") +
    p("The work at the top of that list is what this seat needs first. Your strengths are real, they just sit lower on it for this one role. Different seat, different order. Better you hear it straight than wonder.") +
    p("You're one of mine now, so this doesn't end here. I'll keep watching and send you a role when one clears your bar. That doesn't stop unless you want it to.") +
    pills(email) +
    pmut("And if you know someone built for this, send them my way.");
  return {
    subject: "It's about us, not you",
    html: emailShell({ preheader: "Not this role, and the honest shape of why.", title: "It's about us, not you", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `It's about us, not you.\n\nI'm not moving you forward. That's a call about this one role, not a verdict on you. Your strengths are real, they just sit lower on what this particular seat leans on most. You're one of mine now: I'll keep sending you a role when one clears your bar. And if you know someone built for this, send them my way.\n\nCharlie`,
  };
}

// Case 6 — hard test passed (owner advanced). The handoff to the human. NO scheduling link here.
export function renderCampaignPass({ email } = {}) {
  const content =
    lead("You made it") +
    h1("Let's talk for real") +
    p("I've got what I need from the questions. You think clearly under pressure, and you didn't flinch when I pushed. That's rare, and it's a lot of what this seat needs. 👏") +
    p("There's nothing left worth testing with a hypothetical. The last step is a real conversation with the person I work with. No script this time. Just the two of you, the actual work, and where this could go.") +
    p("If you're in, reply and I'll make the introduction.");
  return {
    subject: "Let's talk for real 👋",
    html: emailShell({ preheader: "You're through the questions. The last step is a real conversation.", title: "Let's talk for real", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `Let's talk for real.\n\nI've got what I need from the questions. The last step is a real conversation with the person I work with. If you're in, reply and I'll make the introduction.\n\nCharlie`,
  };
}

// Case 6b — they replied "I'm in". ONLY now does the scheduling link go out. `calendlyUrl` is required.
export function renderCampaignCalendly({ email, calendlyUrl = "" } = {}) {
  const content =
    h1("Grab a time") +
    p("Good. Here's where you find a slot with the person I work with.") +
    (calendlyUrl ? button(calendlyUrl, "Pick a time") : p("(the scheduling link)")) +
    p("Come as you are. No prep, no deck, no right answers. Just the two of you and the actual work. ☕");
  return {
    subject: "Grab a time 📅",
    html: emailShell({ preheader: "Pick whatever works. No prep needed.", title: "Grab a time", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `Grab a time.\n\nGood. Here's where you find a slot with the person I work with: ${calendlyUrl || "(link)"}\n\nCome as you are. No prep, no deck. Just the two of you and the actual work.\n\nCharlie`,
  };
}

// Case 7 — hard test didn't clear (owner rejected). Grounded reason from the transcript. Retain + referral.
export function renderCampaignNearMiss({ email, reason = "" } = {}) {
  const reasonBlock = reason
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0 16px;"><tbody><tr><td style="background:${C.amberbg};border-radius:12px;padding:14px 16px;font-family:${SANS};font-size:14px;line-height:1.55;color:${C.amber};">${esc(reason)}</td></tr></tbody></table>`
    : "";
  const content =
    h1("Close, and honest about it") +
    p("You got further than almost anyone, and I want to be straight about why it stops here.") +
    reasonBlock +
    p("That's the bar for this seat, and it's brutal on purpose.") +
    p("But you're on my list now, and that's not a runner-up prize. I'll keep sending you a role when one clears your bar, for as long as you want it.") +
    pills(email) +
    pmut("Know someone built for this? Send them over.");
  return {
    subject: "Close, and honest about it",
    html: emailShell({ preheader: "You got further than almost anyone. Here's the honest why.", title: "Close, and honest about it", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `Close, and honest about it.\n\nYou got further than almost anyone.${reason ? " " + strip(reason) : ""} That's the bar for this seat. But you're on my list now: I'll keep sending you a role when one clears your bar. Know someone built for this? Send them over.\n\nCharlie`,
  };
}

// Case 8 — no reply mid-loop. One soft nudge, never a chase.
export function renderCampaignStall({ email } = {}) {
  const content =
    lead("No rush") +
    h1("Still with me?") +
    p("I don't want to lose you. My question's still open above. If life got in the way, just say so and we'll pick it up.");
  return {
    subject: "Still with me? 👀",
    html: emailShell({ preheader: "My question's still open whenever you're ready.", title: "Still with me?", contentHtml: content, unsubUrl: unsubUrlFor(email), tag: "charliejoin" }),
    text: `Still with me?\n\nNo rush, but I don't want to lose you. My question's still open. If life got in the way, just say so and we'll pick it up.\n\nCharlie`,
  };
}

// OWNER — the human-verdict email. Sent to JOIN_OWNER_EMAIL, NEVER to a candidate. Carries the answers +
// the FACTUAL summary (no recommendation) + how to reply. The owner's reply is the only thing that decides.
export function renderCampaignOwnerReview({ ownerEmail, applicantEmail = "", phase = "prescreen", transcript = [], summary = null } = {}) {
  const title = phase === "final" ? "A candidate finished the questions" : "A candidate cleared the gate";
  const turns = (transcript || [])
    .map((t) => `<tr><td style="font-family:${SANS};font-size:9px;font-weight:600;letter-spacing:.1em;color:${t.role === "charlie" ? C.coral : C.muted};padding:10px 0 3px;vertical-align:top;text-transform:uppercase;">${t.role === "charlie" ? "Charlie" : "Them"}</td></tr><tr><td style="font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.text};padding:0 0 6px;">${esc(t.text || "")}</td></tr>`)
    .join("");
  const dims = summary && Array.isArray(summary.dimensions)
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 14px;"><tbody>${summary.dimensions
        .map((d) => `<tr><td style="font-family:${SANS};font-size:12px;font-weight:600;color:${C.ink};padding:7px 0 1px;">${esc(d.name)}</td></tr><tr><td style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.text};padding:0 0 4px;">${esc(d.evidence)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  const quote = summary && summary.standout_quote
    ? p(`<span style="font-style:italic;color:${C.ink};">"${esc(summary.standout_quote)}"</span>`)
    : "";
  const content =
    h1(title) +
    p(`<b style='font-weight:600;'>${esc(applicantEmail)}</b> ${phase === "final" ? "finished the challenge loop." : "passed the onboarded-first gate and sent their answers."} You decide. I have not.`) +
    (dims ? lead("What they said, by dimension") + dims : "") +
    (quote ? lead("In their words") + quote : "") +
    (turns ? lead("The full exchange") + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${turns}</table>` : "") +
    p(`<b style='font-weight:600;'>To decide:</b> reply <b style='font-weight:600;'>advance</b> to move them forward (I'll send the ${phase === "final" ? "let's-talk email" : "kickoff and start the questions"}), or <b style='font-weight:600;'>reject</b> to send the honest no. Reply <b style='font-weight:600;'>hold</b> to pause. Nothing goes out until you reply.`);
  return {
    subject: `${phase === "final" ? "Verdict" : "Gate"}: ${applicantEmail}`,
    // owner mail: still through the kit for one consistent look; unsub points at the owner's own address.
    html: emailShell({ preheader: `${applicantEmail} — reply advance / reject / hold. Nothing sends until you do.`, title, contentHtml: content, unsubUrl: unsubUrlFor(ownerEmail || applicantEmail), tag: "charliejoinowner" }),
    text: `${title}\n\n${applicantEmail} ${phase === "final" ? "finished the questions" : "passed the gate"}. You decide.\n\n${(transcript || []).map((t) => `${t.role === "charlie" ? "Charlie" : "Them"}: ${strip(t.text || "")}`).join("\n\n")}\n\nReply advance / reject / hold. Nothing sends until you reply.`,
  };
}
