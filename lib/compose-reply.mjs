// compose-reply.mjs — the conversational turn: what they said, what we said, what is true, one reply.
//
// THE SHAPE OF THE SAFETY, because it is not "we told the model not to hallucinate":
//
//   1. A DETERMINISTIC PRE-GATE decides whether this turn may be composed at all. A request to search
//      for jobs, or for anything about another person, never reaches the model.
//   2. THE FACT SHEET IS THE ONLY WORLD. Fields are copied from the resolved role and marked KNOWN or
//      UNKNOWN. There is no retrieval and no tool: the model cannot reach anything not handed to it.
//   3. THE OUTPUT IS PARSED (InboundReply) and then MECHANICALLY CHECKED: every number in the reply
//      must appear on the fact sheet, an UNKNOWN field may not be asserted, and a list of promises
//      Charlie cannot keep is refused outright.
//   4. A REJECTED REPLY FALLS TO THE DETERMINISTIC SENTENCE (lib/role-answer.mjs), and if that has
//      nothing either, to the human fallback that was always there.
//
// Layers 1, 2 and 3 are code. The prompt is a request; these are the wall. That distinction is the
// whole reason a model is allowed near a candidate's inbox at all.
//
// COST: one Haiku call per conversational turn, and only for the small share of inbound mail that is a
// question. It is bounded by the pre-gate rather than by the size of the inbox.

import Anthropic from "@anthropic-ai/sdk";
import { INBOUND_REPLY_SYSTEM, buildReplyMessages } from "../prompts/inbound-reply.mjs";
import { InboundReply } from "./schemas/inbound-reply.mjs";
import { answerAboutRole } from "./role-answer.mjs";

const MODEL = process.env.INBOUND_REPLY_MODEL || "claude-haiku-4-5-20251001";

/** Fields of a role a candidate may be told about. Nothing else on the job record is exposed. */
const PERMITTED = [
  ["title", "Role title"], ["company", "Company"], ["location", "Location"],
  ["remote", "Remote, hybrid or on-site"], ["compensation", "Published pay"],
  ["employment_type", "Employment type"],
];

/**
 * Asking us to DO something we do not do, or to reveal somebody else.
 *
 * Deterministic and checked before the model sees anything, because "do not initiate a search" is a
 * boundary and a boundary that lives only in a prompt is a suggestion. Everything matched here goes
 * to the human fallback untouched.
 */
export function outOfBounds(text) {
  const t = String(text || "").toLowerCase();
  // The gap is deliberate and bounded: the noun need not follow the article immediately, so "can you
  // find me a remote Java job?" is caught. Adjectives are exactly where a request like this hides.
  if (/\b(find|search|look)\s+(?:me\s+|for\s+|up\s+)?(?:a|an|another|other|some|any)?\s*(?:[a-z-]+\s+){0,4}(job|jobs|role|roles|opening|openings|position|positions|vacanc)/.test(t)) return "asks us to search";
  if (/\b(other|another|any) (candidate|applicant|people|person)|who else (applied|is applying)|how many (people|candidates|applicants)\b/.test(t)) return "asks about other people";
  if (/\b(my (data|profile) |delete|gdpr|legal|lawyer|sue)\b/.test(t)) return "needs a person";
  return null;
}

/** A short acceptance or refusal of something we just offered. Never a preference change. */
export function isContinuation(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t || t.split(" ").length > 8) return false;
  return /^(yes|yeah|yep|yup|sure|ok|okay|alright|please|please do|go ahead|do it|sounds good|no|nope|not interested|no thanks|never ?mind|forget it|thanks|thank you|cheers)\b/i.test(t);
}

/** The fact sheet, and the set of values a reply is allowed to contain. */
export function factSheet(job = {}) {
  const known = [];
  const lines = [];
  for (const [key, label] of PERMITTED) {
    const v = String(job?.[key] ?? "").trim();
    if (v) { lines.push(`${label}: KNOWN — ${v}`); known.push(v); }
    else lines.push(`${label}: UNKNOWN — we do not know this. Say so and offer to ask.`);
  }
  lines.push(`What you can do: put them forward for this role, or ask the employer a question.`);
  lines.push(`What you cannot do: search for other roles, promise an interview, a decision or a date.`);
  return { text: lines.join("\n"), known, unknown: PERMITTED.filter(([k]) => !String(job?.[k] ?? "").trim()).map(([k]) => k) };
}

const UNCERTAIN = /(doesn'?t say|does not say|not (published|stated|listed)|haven'?t published|i can ask|i'?ll ask|not sure)/i;
/** Promises Charlie cannot keep, and words that imply an outcome nobody has decided. */
const FORBIDDEN = /\b(interview|shortlist(ed)?|guarantee[ds]?|they (liked|said|want|think)|hired|offer letter|by (next|this) (week|month)|within \d+ (day|week)|i'?ll (find|search|look for)|we'?ll (find|search))\b/i;

/**
 * Is every fact in this reply on the sheet?
 * @returns {{ok: boolean, why: string}}
 */
export function groundingOk(reply, sheet) {
  const t = String(reply || "").trim();
  if (!t) return { ok: false, why: "empty" };
  if (t.split(/\s+/).length > 60) return { ok: false, why: "too long" };
  if (t.includes("@")) return { ok: false, why: "contains an address" };
  if (FORBIDDEN.test(t)) return { ok: false, why: `promises something we cannot keep: ${(t.match(FORBIDDEN) || [])[0]}` };

  // EVERY NUMBER MUST BE ON THE SHEET. A salary, a headcount, a date, a percentage: if it is not in a
  // known value it was invented, whatever it looks like.
  const haystack = sheet.known.join(" | ").replace(/[^0-9]/g, "");
  for (const n of t.match(/\d[\d,.]*/g) || []) {
    const digits = n.replace(/[^0-9]/g, "");
    if (digits && !haystack.includes(digits)) return { ok: false, why: `number not on the fact sheet: ${n}` };
  }

  // AN UNKNOWN FIELD MAY NOT BE ASSERTED. Saying "it's on-site" when `remote` is null invents a
  // working arrangement for a real job, so the claim is only allowed alongside an admission.
  if (sheet.unknown.includes("remote") && /\b(on-?site|onsite|remote|hybrid|work from home)\b/i.test(t) && !UNCERTAIN.test(t)) {
    return { ok: false, why: "states a working arrangement we do not know" };
  }
  if (sheet.unknown.includes("compensation") && /(inr|rs\.?|₹|\$|lpa|lakh|crore|salary of)/i.test(t) && !UNCERTAIN.test(t)) {
    return { ok: false, why: "states pay we do not know" };
  }
  return { ok: true, why: "" };
}

/** Their words and ours, oldest first. Both halves, because "yes" means nothing without our offer. */
export function transcriptFrom({ inbound = [], sends = [], limit = 6 } = {}) {
  const theirs = (inbound || []).map((m) => ({ at: String(m?.received_at || ""), who: "them", text: String(m?.body || "") }));
  const ours = (sends || [])
    .filter((m) => String(m?.body_text || "").trim())
    .map((m) => ({ at: String(m?.sent_at || ""), who: "charlie", text: String(m?.body_text || "") }));
  return [...theirs, ...ours]
    .filter((m) => m.at && m.text.trim())
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-limit)
    .map(({ who, text }) => ({ who, text }));
}

/**
 * Compose the next reply, or say we cannot.
 *
 * @returns {Promise<{reply: string|null, kind: string, why: string}>}
 *   reply null with kind "cannot" means the caller runs the existing human fallback.
 *   reply null with kind "none" means say nothing to them (a human is still told).
 */
export async function composeReply({ message, job, transcript = [], client, log = () => {} } = {}) {
  const msg = String(message || "").trim();
  const blocked = outOfBounds(msg);
  if (blocked) return { reply: null, kind: "cannot", why: blocked };
  if (!job?.title) return { reply: null, kind: "cannot", why: "no role resolved" };

  const sheet = factSheet(job);
  // The deterministic answer for this exact question, if there is one. It is both the fallback and
  // the proof that a fact was available at all.
  const fallback = answerAboutRole({ question: msg, job });

  if (!process.env.ANTHROPIC_API_KEY) {
    return fallback ? { reply: fallback.text, kind: "answer", why: "no api key, used the deterministic answer" }
                    : { reply: null, kind: "cannot", why: "no api key and no deterministic answer" };
  }

  try {
    const c = client || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await c.messages.create({
      model: MODEL, max_tokens: 300, temperature: 0,
      system: INBOUND_REPLY_SYSTEM,
      messages: buildReplyMessages({ transcript, facts: sheet.text, message: msg }),
    });
    const raw = (res.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?|```$/g, "");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("reply was not JSON"); }
    const ok = InboundReply.safeParse(parsed);
    if (!ok.success) throw new Error("reply did not match the schema");

    const { kind, reply } = ok.data;
    if (kind === "none") return { reply: null, kind: "none", why: "nothing needed" };
    if (kind === "cannot") return { reply: null, kind: "cannot", why: "the model could not answer it from the sheet" };

    const gate = groundingOk(reply, sheet);
    if (!gate.ok) {
      log(`[compose] rejected: ${gate.why}`);
      return fallback ? { reply: fallback.text, kind: "answer", why: `rejected (${gate.why}), used the deterministic answer` }
                      : { reply: null, kind: "cannot", why: `rejected (${gate.why}) and nothing deterministic to fall back to` };
    }
    return { reply, kind, why: "composed" };
  } catch (e) {
    log(`[compose] failed: ${e.message}`);
    return fallback ? { reply: fallback.text, kind: "answer", why: `compose failed (${e.message}), used the deterministic answer` }
                    : { reply: null, kind: "cannot", why: `compose failed: ${e.message}` };
  }
}
