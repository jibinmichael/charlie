// match-jobs.mjs — Charlie's matcher step.
//
//   node match-jobs.mjs
//
// Scores each scanned job (jobs.json) against the candidate's dossier, loaded from
// the per-user `candidates` store by CHARLIE_USER_EMAIL, and decides which clear
// the bar. The scoring rubric lives in matcher.md and is read at runtime, so you
// tune scoring by editing that file — not this code.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv, userEmail, getDossier } from "./charlie-store.mjs";
import { buildScoringMessages } from "./prompts/match-scoring.mjs"; // versioned prompt — see prompts/

// Load .env.local before constructing the Anthropic client (it reads
// ANTHROPIC_API_KEY at construction) and before any Supabase call.
loadEnv();

// Sonnet 4.6 is the default. Bump to claude-opus-4-8 for final tuning — scoring
// calibration is the whole point of this step.
const MODEL = "claude-sonnet-4-6";

// What clears the bar: keep jobs scoring at least this AND with no dealbreaker hit.
const BAR = 70;

// Small concurrency to respect rate limits while not taking forever.
const CONCURRENCY = 3;

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, "matcher.md");
// Prefer the cheap pre-filter's survivors (jobs.matchable.json); fall back to the
// raw scanner output if the pre-filter step wasn't run.
const MATCHABLE_PATH = join(here, "jobs.matchable.json");
const RAW_JOBS_PATH = join(here, "jobs.json");
const JOBS_PATH = existsSync(MATCHABLE_PATH) ? MATCHABLE_PATH : RAW_JOBS_PATH;
const OUT_PATH = join(here, "matched-jobs.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function stripFences(text) {
  let t = (text ?? "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  return t.trim();
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

async function scoreJob(systemPrompt, dossierText, job) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1000,
    ...buildScoringMessages({ matcherText: systemPrompt, dossierText, job, todayLine: null }),
  });

  const reply = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return JSON.parse(stripFences(reply));
}

// Run an async mapper over items with a small fixed concurrency, preserving order.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function main() {
  const email = userEmail();

  let systemPrompt;
  let jobs;
  try {
    systemPrompt = readFileSync(PROMPT_PATH, "utf8");
    jobs = JSON.parse(readFileSync(JOBS_PATH, "utf8"));
    if (!Array.isArray(jobs)) throw new Error("jobs.json must be an array");
  } catch (err) {
    fail(`could not read an input file: ${err.message}`);
  }

  // The dossier comes from the per-user store; the matcher receives it as a JSON string.
  let dossier;
  try {
    dossier = await getDossier(email);
  } catch (err) {
    fail(err.message);
  }
  if (!dossier) {
    fail(`no dossier in candidates for ${email} — onboard this address first`);
  }
  const dossierText = JSON.stringify(dossier, null, 2);

  if (jobs.length === 0) fail("jobs.json is empty — run the scanner first.");

  const scored = await mapWithConcurrency(jobs, CONCURRENCY, async (job, i) => {
    let match;
    try {
      match = await scoreJob(systemPrompt, dossierText, job);
    } catch (err) {
      // one bad job must not crash the whole run
      match = {
        score: 0,
        verdict: "skip",
        chips: [],
        why_you: "",
        flag: `could not score this job: ${err.message}`,
        dealbreaker_hit: false,
        error: true,
      };
      console.error(`! ${job.company} · ${job.title} — scoring failed: ${err.message}`);
    }
    const score = typeof match.score === "number" ? match.score : 0;
    const passed_bar = score >= BAR && match.dealbreaker_hit !== true;
    process.stderr.write(`scored ${i + 1}/${jobs.length}\r`);
    return { ...job, match, passed_bar };
  });
  process.stderr.write("\n");

  const above = scored
    .filter((j) => j.passed_bar)
    .sort((a, b) => (b.match.score ?? 0) - (a.match.score ?? 0));
  const below = scored
    .filter((j) => !j.passed_bar)
    .sort((a, b) => (b.match.score ?? 0) - (a.match.score ?? 0));

  writeFileSync(OUT_PATH, JSON.stringify(scored, null, 2) + "\n");

  const line = (j) => {
    const m = j.match || {};
    const flag = m.flag ? `  ⚠ ${m.flag}` : "";
    const score = String(m.score ?? 0).padStart(3, " ");
    return `${score} ${m.verdict ?? "skip"} · ${j.company} · ${j.title}${flag}`;
  };

  console.log(`\nabove the bar (score >= ${BAR}, no dealbreaker):\n`);
  if (above.length) above.forEach((j) => console.log(line(j)));
  else console.log("  (none)");

  console.log("\n────────────────────────────────────────");
  console.log("below the bar:\n");
  below.forEach((j) => console.log(line(j)));

  console.log(`\n${scored.length} scored · ${above.length} above bar`);
  console.log(`written to matched-jobs.json`);
}

main();
