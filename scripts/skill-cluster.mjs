// skill-cluster.mjs — build the skill alias map. NO SEND. NO WRITES TO ANY RECORD.
//
//   node --env-file=.env.local scripts/skill-cluster.mjs --buckets b.json --out aliases.json [--limit N]
//
// Writes a FILE for a human to read. Merging a skill is a claim about everyone who wrote it, so the
// map is reviewed before anything applies it.
//
// Buckets are processed LARGEST FIRST and a name is claimed once. "llm integration" appears in the
// "llm" bucket and the "integration" bucket; without the claim, two buckets could merge it two ways
// and the result would depend on iteration order.
//
// COST: one Haiku call per bucket, about $0.0025.

import { readFileSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { loadEnv } from "../charlie-store.mjs";
import { SKILL_CLUSTER_SYSTEM, buildSkillClusterMessages } from "../prompts/skill-cluster.mjs";
import { coerceClusters } from "../lib/schemas/skill-cluster.mjs";

loadEnv();
const MODEL = "claude-haiku-4-5-20251001";
const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] || "") : ""; };
const IN = flag("--buckets"), OUT = flag("--out"), LIMIT = Number(flag("--limit")) || 0;
if (!IN || !OUT) { console.error("need --buckets <b.json> --out <aliases.json>"); process.exit(1); }

let buckets = JSON.parse(readFileSync(IN, "utf8")).sort((a, b) => b.names.length - a.names.length);
if (LIMIT) buckets = buckets.slice(0, LIMIT);

const client = new Anthropic();
const claimed = new Set();          // a name may be merged by one bucket only
const alias = {};                   // member -> canonical
const groups = [];
let calls = 0, dropped = 0, failed = 0, skipped = 0;

for (const [i, b] of buckets.entries()) {
  if (i && i % 50 === 0) console.log(`  ...${i}/${buckets.length}  merged=${Object.keys(alias).length} dropped=${dropped}`);
  const names = b.names.filter((n) => !claimed.has(n.k));
  if (names.length < 3) { skipped++; continue; }
  const offered = new Set(names.map((n) => n.k));
  try {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 1600, temperature: 0,
      system: SKILL_CLUSTER_SYSTEM, messages: buildSkillClusterMessages({ token: b.token, names }),
    });
    calls++;
    const raw = (res.content || []).map((c) => c.text || "").join("").trim();
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s < 0) throw new Error("no JSON");
    const c = coerceClusters(JSON.parse(raw.slice(s, e + 1)), offered);
    dropped += c.dropped;
    for (const g of c.groups) {
      const members = g.members.filter((m) => !claimed.has(m));
      if (members.length < 2 || !members.includes(g.canonical)) continue;
      members.forEach((m) => claimed.add(m));
      for (const m of members) if (m !== g.canonical) alias[m] = g.canonical;
      groups.push({ token: b.token, canonical: g.canonical, members });
    }
  } catch (err) { failed++; console.error(`  ERR ${b.token}: ${String(err.message).slice(0, 90)}`); }
}

writeFileSync(OUT, JSON.stringify({ alias, groups }, null, 2));
console.log(`\nbuckets read      : ${calls}   (skipped as too small after claiming: ${skipped})`);
console.log(`groups accepted   : ${groups.length}`);
console.log(`names merged away : ${Object.keys(alias).length}`);
console.log(`groups dropped (invented or unusable name): ${dropped}`);
console.log(`errored           : ${failed}`);
console.log(`\nwritten to ${OUT}. Nothing applied.`);
