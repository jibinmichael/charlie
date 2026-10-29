// resume-build.mjs — produce a TAILORED, grounded resume + cover letter for one role.
//
// Source of truth is the person's ORIGINAL resume text (real companies, titles, dates,
// bullets); the dossier adds emphasis; the job says what to foreground. The model only
// REORDERS and REFRAMES the truth to fit the role — it never invents an employer, title,
// date, metric, or skill. Output is structured JSON the PDF template renders. Same
// no-invention contract as the rest of Charlie.

import Anthropic from "@anthropic-ai/sdk";
import { RESUME_BUILD_SYSTEM } from "./prompts/resume-build.mjs"; // versioned prompt — see prompts/

const MODEL = process.env.RESUME_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 4000;

const SYSTEM = RESUME_BUILD_SYSTEM;

function stripFences(t) {
  let s = (t ?? "").trim();
  if (s.startsWith("```")) s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return s.trim();
}
function sliceOutermost(s) {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}
function extractJson(text) {
  const t = stripFences(text);
  for (const cand of [t, sliceOutermost(t)].filter(Boolean)) {
    try { return JSON.parse(cand); } catch { /* try repaired */ }
    try { return JSON.parse(cand.replace(/,(\s*[}\]])/g, "$1")); } catch { /* next */ }
  }
  throw new Error("resume tailor: model did not return valid JSON");
}

export async function buildTailoredDocs(resumeText, dossier, job) {
  const client = new Anthropic();
  const user =
    `## ORIGINAL RESUME (source of truth for every fact)\n\n${resumeText || "(none on file — use the profile, and never invent)"}\n\n` +
    `## PROFILE (for emphasis only; still only real facts)\n\n${JSON.stringify(dossier ?? {})}\n\n` +
    `## JOB\n\n${JSON.stringify({ title: job?.title ?? null, company: job?.company ?? null, location: job?.location ?? null, description: job?.description ?? null }, null, 2)}`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const d = extractJson(text);
  // shape guarantees so the template never crashes
  d.contact = d.contact && typeof d.contact === "object" ? d.contact : {};
  d.contact.links = Array.isArray(d.contact.links) ? d.contact.links : [];
  d.summary = typeof d.summary === "string" ? d.summary : "";
  d.experience = Array.isArray(d.experience) ? d.experience.map((e) => ({ ...e, bullets: Array.isArray(e.bullets) ? e.bullets : [] })) : [];
  d.skills = Array.isArray(d.skills) ? d.skills : [];
  d.education = Array.isArray(d.education) ? d.education : [];
  d.cover = typeof d.cover === "string" ? d.cover : "";
  return d;
}
