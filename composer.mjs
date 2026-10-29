// composer.mjs — Charlie's email-composer step.
//
//   node composer.mjs <dossier.json> <job.(txt|json)>
//
// Exposes composeEmailFields() (the model call -> the email's parsed fields) and
// lookupCompany() (a web-search lookup for the verified company block), both reused
// by run-charlie.mjs. The CLI writes composed-email.json. The voice + field rules
// live in composer.md and are read at runtime, so you tune the email by editing
// that file, not this code.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { getCachedCompany, putCachedCompany } from "./charlie-store.mjs";
import { loadComposerPrompt, buildComposerUserContent } from "./prompts/composer.mjs"; // versioned prompt — see prompts/
import { COMPANY_RESEARCH_SYSTEM, buildCompanyResearchAsk } from "./prompts/company-research.mjs"; // versioned prompt — see prompts/

// The compose model. Composer feeds the live daily send, so a model swap is env-gated
// (COMPOSE_MODEL) and should follow a compose-eval run showing the voice is unchanged or better.
// The default is the current production model.
const MODEL = process.env.COMPOSE_MODEL || "claude-sonnet-4-6";
// Thinking is held OFF on compose (both calls below): Sonnet 5 defaults adaptive-ON when `thinking`
// is omitted, and long reasoning chains hurt warmth / over-hedge on the "writes to you" step
// (an inverted-U effect). Setting it explicitly keeps voice identical whichever model is selected.
const NO_THINKING = { type: "disabled" };

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, "composer.md");
const JSON_OUT = "composed-email.json";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Strip a ```json ... ``` (or bare ``` ... ```) fence if the model wrapped its reply.
function stripFences(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t.trim();
}

// Pull the JSON object out of a reply that may carry prose around it (common when
// a tool-using model narrates before answering). Falls back to the first balanced
// {...} span if a clean parse fails.
function parseJsonLoose(text) {
  const t = stripFences(text);
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error("no JSON object found in reply");
  }
}

function textOf(response) {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// Web-search lookup for the company block. Returns { name, what, stage, raised,
// size, sources[] } with EVERY non-null stat backed by a real source url, or any
// field set to null when it can't be verified. Returns null (and never throws) if
// the whole thing fails, so a flaky lookup can never block the email. The model is
// told to guess nothing — unverifiable facts come back null and the email shows
// "not found" rather than a fabricated number.
export async function lookupCompany(companyName, { jobHint } = {}) {
  if (!companyName) return null;
  // Cache hit → skip the web_search entirely (the same companies recur across users and days).
  const cached = await getCachedCompany(companyName).catch(() => null);
  if (cached) return cached;
  const client = new Anthropic();
  const system = COMPANY_RESEARCH_SYSTEM;
  const ask = buildCompanyResearchAsk({ companyName, jobHint });
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: NO_THINKING,
      system,
      // 3 focused searches suffice for what/stage/raised/size; unverifiable fields already fall
      // back to null, so fewer searches can only drop a stat, never fabricate one. (Was 7.)
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: Number(process.env.COMPANY_SEARCH_MAX || 3) }],
      messages: [{ role: "user", content: ask }],
    });
    const obj = parseJsonLoose(textOf(response));
    if (!obj || typeof obj !== "object") return null;
    obj.name = obj.name || companyName;
    if (!Array.isArray(obj.sources)) obj.sources = [];
    // a stat with no source at all is not trustworthy — drop it to null.
    if (!obj.sources.length) {
      obj.stage = obj.raised = obj.size = null;
    }
    // Persist for the next matched user / next day (best-effort, fire-and-forget).
    putCachedCompany(companyName, obj).catch(() => {});
    return obj;
  } catch (err) {
    console.warn(`company lookup failed (email will show "not found"): ${err.message}`);
    return null;
  }
}

// Reusable: call the model with composer.md as system and return the parsed email
// fields. extras carries the matcher verdict (score/verdict/chips, copied through)
// and the company lookup (copied into company_insight). Used by the CLI and by
// run-charlie.mjs.
// Strip the edge's MARKET judgments (strong_in / generic_in) from the dossier the composer sees. They are
// where the combo is rare/common in the market, NOT things the person did (lib/schemas/dossier.mjs consumer
// contract). If the composer sees them inside the dossier it can restate a market domain as their
// experience, and the send-time grounding verifier can't catch it (the phrase IS in the source). So they
// never reach compose. Defensive: on any non-JSON input, return the text unchanged (no worse than before).
// Desire-led copy (dark behind DESIRE_COPY, default off). The composer may LEAD the why_you with a
// person's STATED motivation only when the flag is on; otherwise motivation/admired are stripped from the
// dossier the composer sees, so the composer.md desire rule finds nothing to reflect and the copy is
// byte-identical to before. Grounded either way — motivation is the person's own words; this only controls
// whether the composer is allowed to lead with it. Mirrors stripEdgeMarketJudgments.
export function desireCopyOn() {
  return String(process.env.DESIRE_COPY || "off").toLowerCase() === "on";
}
export function stripDesire(dossierText) {
  if (desireCopyOn()) return dossierText;
  try {
    const d = JSON.parse(dossierText);
    if (d && d.preferences && typeof d.preferences === "object") {
      const { motivation, admired, ...rest } = d.preferences; // hide desire from the composer when dark
      void motivation; void admired;
      d.preferences = rest;
      return JSON.stringify(d, null, 2);
    }
    return dossierText;
  } catch {
    return dossierText;
  }
}

export function stripEdgeMarketJudgments(dossierText) {
  try {
    const d = JSON.parse(dossierText);
    if (d && d.edge && typeof d.edge === "object") {
      const { strong_in, generic_in, ...rest } = d.edge; // drop the two market-judgment arrays
      void strong_in; void generic_in;
      d.edge = rest;
      return JSON.stringify(d, null, 2);
    }
    return dossierText;
  } catch {
    return dossierText;
  }
}

export async function composeEmailFields(dossierText, jobText, extras = {}) {
  const { match = null, companyInsight = null, edge = null, screen = null } = extras;
  const systemPrompt = loadComposerPrompt();
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  const today = new Date().toISOString().slice(0, 10);
  // The composer never sees strong_in/generic_in (market judgments) — not in the dossier block, not in the
  // edge block — so it cannot restate a market domain as the person's experience.
  const content = buildComposerUserContent({ dossierText: stripDesire(stripEdgeMarketJudgments(dossierText)), jobText, match, companyInsight, edge, today, screen });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2600, // headroom for Sonnet 5's tokenizer (~30% more tokens than 4.6 for the same text)
    thinking: NO_THINKING,
    system: systemPrompt,
    messages: [{ role: "user", content }],
  });
  const reply = textOf(response);
  try {
    return parseJsonLoose(reply);
  } catch {
    const err = new Error("model did not return valid JSON");
    err.raw = reply;
    throw err;
  }
}

async function main() {
  const [dossierPath, jobPath] = process.argv.slice(2);
  if (!dossierPath || !jobPath) {
    fail("usage: node composer.mjs <dossier.json> <job.(txt|json)>");
  }

  let dossier;
  let job;
  try {
    dossier = readFileSync(dossierPath, "utf8");
    job = readFileSync(jobPath, "utf8"); // plain pasted JD text is fine — not parsed
  } catch (err) {
    fail(`could not read an input file: ${err.message}`);
  }

  // If the job is JSON, pull the company + matcher block so the CLI can do the
  // same web lookup and verdict pass-through that run-charlie does.
  let jobObj = null;
  try {
    jobObj = JSON.parse(job);
  } catch {
    /* plain JD text — no structured company/match to read */
  }
  let companyInsight = null;
  if (jobObj?.company) {
    companyInsight = await lookupCompany(jobObj.company, { jobHint: jobObj.title });
  }

  let email;
  try {
    email = await composeEmailFields(dossier, job, {
      match: jobObj?.match || null,
      companyInsight,
    });
  } catch (err) {
    if (err.raw) {
      console.error("the model did not return valid JSON. raw reply below — tune composer.md and rerun:\n");
      console.error(err.raw);
      process.exit(1);
    }
    fail(
      `the model call failed: ${err.message}\n` +
        "check that ANTHROPIC_API_KEY is set, then try again.",
    );
  }

  writeFileSync(JSON_OUT, JSON.stringify(email, null, 2) + "\n");
  console.log(resolve(JSON_OUT));
}

// Only run the CLI when invoked directly (node composer.mjs ...), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
