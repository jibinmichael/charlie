// cv-check.mjs — the email-native "honest read" on a CV against one job.
//
// The growth wedge: someone forwards a job (a link or a pasted description) to check@, and
// Charlie replies with a grounded, honest scorecard, what genuinely lands, what's missing,
// the one catch, the single highest-leverage edit, then invites them into the real product
// (watch the whole market, only email what clears the bar). The check needs a resume (stored
// for an existing user, or attached) and a job. It mirrors Charlie's non-negotiable: nothing
// is invented or upgraded. Strengths must trace to the resume; gaps and the catch are real.

import Anthropic from "@anthropic-ai/sdk";
import { safeFetch } from "./safe-fetch.mjs";
import { CV_CHECK_SYSTEM } from "./prompts/cv-check.mjs"; // versioned prompt — see prompts/

const MODEL = process.env.CHECK_MODEL || "claude-sonnet-4-6";

const SYSTEM = CV_CHECK_SYSTEM;

function stripFences(s) {
  let t = (s || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.trim();
}

// Pull the best job text we can from what they sent: fetch a URL if there is one (best-effort),
// otherwise use the pasted text. Returns { text, url }.
export async function fetchJobText(input) {
  const raw = String(input || "");
  const url = (raw.match(/https?:\/\/[^\s<>"')]+/) || [])[0] || null;
  if (url) {
    try {
      const r = await safeFetch(url, { timeoutMs: 9000, headers: { "user-agent": "Mozilla/5.0 CharlieBot" } }); // SSRF-guarded
      if (r.ok) {
        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > 220) return { text: text.slice(0, 7000), url };
      }
    } catch { /* fall back to pasted text */ }
  }
  // no usable URL fetch: use the pasted body, minus the bare link
  const text = raw.replace(/https?:\/\/[^\s<>"')]+/g, " ").replace(/\s+/g, " ").trim();
  return { text, url };
}

// One grounded LLM pass: resume + job -> honest scorecard.
export async function runCvCheck(resumeText, jobText) {
  if (!resumeText || !resumeText.trim() || !jobText || jobText.trim().length < 80) return null;
  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1100,
    system: SYSTEM,
    messages: [{ role: "user", content: `## TODAY\n\n${new Date().toISOString().slice(0, 10)} (judge tenure and recency against this; a past date is not "future")\n\n## RESUME\n\n${String(resumeText).slice(0, 12000)}\n\n## JOB\n\n${String(jobText).slice(0, 7000)}` }],
  });
  const t = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let j;
  try { j = JSON.parse(stripFences(t)); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  // shape guards
  j.score = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0)));
  j.strengths = Array.isArray(j.strengths) ? j.strengths.slice(0, 3) : [];
  j.gaps = Array.isArray(j.gaps) ? j.gaps.slice(0, 3) : [];
  return j;
}
