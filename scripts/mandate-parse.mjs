// mandate-parse.mjs — turn a job description into a requirement matrix. NO SEND. NO CANDIDATE.
//
//   node --env-file=.env.local scripts/mandate-parse.mjs --file jd.txt
//   node --env-file=.env.local scripts/mandate-parse.mjs --file jd.txt --json out.json
//   cat jd.txt | node --env-file=.env.local scripts/mandate-parse.mjs
//
// WHAT IT IS FOR. Before anybody is read against a mandate, a human should be able to argue with the
// mandate. Typing a config from a PDF by hand lets a stated must-have become an unscored fact, or a
// line from the responsibilities become a scored must-have, with neither judgement written down
// anywhere it could be checked. This produces the matrix to review before lib/mandates.mjs is edited.
//
// THE QUOTE CHECK IS THE POINT. The model returns a verbatim quote per requirement and this drops
// any requirement whose quote is not in the source text. That is what makes "it cannot invent a hard
// constraint" true rather than requested. Dropped items are REPORTED, never silently removed: a
// silent drop and a clean parse look identical.
//
// IT SCORES NOBODY. No candidate is read, no shortlist is produced, nothing is written to any table.
// COST: one Sonnet call per JD, about $0.02.

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../charlie-store.mjs";
import { MANDATE_PARSE_SYSTEM, buildMandateParseMessages } from "../prompts/mandate-parse.mjs";
import { MandateParse } from "../lib/schemas/mandate-parse.mjs";
import { verifyQuotes, renderMatrix } from "../lib/mandate-parse.mjs";

loadEnv();
const MODEL = process.env.MANDATE_PARSE_MODEL || "claude-sonnet-4-6";
const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || d) : d; };

async function readJd() {
  const file = flag("--file");
  if (file) return { text: fs.readFileSync(file, "utf8"), name: file };
  if (process.stdin.isTTY) return { text: "", name: "" };
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return { text: Buffer.concat(chunks).toString("utf8"), name: "(stdin)" };
}

async function main() {
  const { text: jd, name } = await readJd();
  if (!jd.trim()) { console.error("no job description. Use --file <path> or pipe one in."); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(1); }

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL, max_tokens: 4000, temperature: 0,
    system: MANDATE_PARSE_SYSTEM, messages: buildMandateParseMessages({ jd, sourceName: name }),
  });
  const raw = (res.content || []).map((b) => b.text || "").join("").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

  let parsed;
  try { parsed = JSON.parse(raw); } catch { console.error("the model did not return JSON. Nothing was written."); process.exit(1); }
  const ok = MandateParse.safeParse(parsed);
  if (!ok.success) {
    console.error(`the reply did not match the schema, so nothing is reported:\n  ${ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
    process.exit(1);
  }

  const { kept, dropped } = verifyQuotes(ok.data, jd);
  console.log(renderMatrix(kept, dropped, name));

  const out = flag("--json");
  if (out) { fs.writeFileSync(out, JSON.stringify({ source: name, mandate: kept, dropped }, null, 2)); console.error(`\nwritten to ${out}`); }
}

main().catch((e) => { console.error(`[mandate-parse] fatal: ${e.message}`); process.exit(1); });
