// voice/text-mode.mjs — the typed transport: the whole controller, no model, no voice.
//
//   npm run voice:text -- [--plan plan.json] [--seconds-per-turn 20] [--next-step "sentence"]
//
// Type an answer and press enter. Commands: /hint a,b,c  (simulate a judge hint naming present
// elements)  /off  (simulate a hint saying the answer was off topic)  /unusable  (simulate an
// unusable audio turn)  /drop  (simulate a dropped connection and a resume)  /quit.
//
// runScripted() is the same loop with the answers supplied up front; the CI personas
// (evals/vv/personas/*.json) drive it, so what CI checks is the transport a human can type through.
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { decide, markResume, itemStatuses } from "./controller.mjs";
import { sortItems } from "./policy.mjs";

/**
 * Run a scripted persona through the controller.
 * @param {object} plan
 * @param {{turns:Array<{say?:string, unusable?:boolean, hint?:object, drop?:boolean}>}} persona
 * @param {{withHints?:boolean, secondsPerTurn?:number, context?:object}} [opts]
 */
export function runScripted(plan, persona, { withHints = true, secondsPerTurn = 20, context = {} } = {}) {
  const decisions = [];
  let cursor = null;
  let turnIndex = 0;
  let d = decide({ plan, cursor, latestTurn: null, elapsed: 0, context });
  decisions.push(d); cursor = d.cursor;
  for (const t of persona.turns) {
    if (d.end) break;
    if (t.drop) { cursor = markResume(cursor); d = decide({ plan, cursor, latestTurn: null, elapsed: turnIndex * secondsPerTurn, context }); decisions.push(d); cursor = d.cursor; continue; }
    turnIndex++;
    const latestTurn = t.unusable ? { text: "", unusable: true } : { text: t.say || "" };
    d = decide({ plan, cursor, latestTurn, hint: withHints ? t.hint : undefined, elapsed: turnIndex * secondsPerTurn, context });
    decisions.push(d); cursor = d.cursor;
  }
  const probes = {};
  for (const it of plan.items) if (cursor.items[it.id]) probes[it.ref] = cursor.items[it.id].probesAsked;
  return {
    moves: decisions.map((x) => x.move),
    texts: decisions.map((x) => x.text),
    decisions,
    cursor,
    endReason: cursor.endReason,
    ended: Boolean(d.end),
    statuses: itemStatuses(plan, cursor),
    probes,
    itemsReached: Object.keys(cursor.items).length,
  };
}

async function runInteractive({ plan, secondsPerTurn, context }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  let cursor = null, turnIndex = 0;
  let d = decide({ plan, cursor, latestTurn: null, elapsed: 0, context });
  cursor = d.cursor;
  console.log(`\n[${d.move}] Charlie: ${d.text}\n`);
  while (!d.end) {
    const line = (await ask("you: ")).trim();
    let latestTurn = { text: line }, hint;
    if (line === "/quit") break;
    if (line === "/drop") { cursor = markResume(cursor); d = decide({ plan, cursor, latestTurn: null, elapsed: turnIndex * secondsPerTurn, context }); cursor = d.cursor; console.log(`\n[${d.move}] Charlie: ${d.text}\n`); continue; }
    if (line === "/unusable") latestTurn = { text: "", unusable: true };
    else if (line.startsWith("/hint ")) { hint = { present: line.slice(6).split(",").map((s) => s.trim()).filter(Boolean) }; latestTurn = { text: await ask("   (your answer): ") }; }
    else if (line === "/off") { hint = { present: [], relevant: false }; latestTurn = { text: await ask("   (your answer): ") }; }
    turnIndex++;
    d = decide({ plan, cursor, latestTurn, hint, elapsed: turnIndex * secondsPerTurn, context });
    cursor = d.cursor;
    const st = d.itemId ? cursor.items[d.itemId] : null;
    console.log(`\n[${d.move}${st ? ` · item ${plan.items.find((i) => i.id === d.itemId)?.ref} · probes ${st.probesAsked} · present ${st.present.join(",") || "-"}` : ""}] Charlie: ${d.text}\n`);
  }
  rl.close();
  console.log("\nitem statuses:", itemStatuses(plan, cursor), "\nend reason:", cursor.endReason);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = (n, d = "") => { const i = process.argv.indexOf(n); return i > -1 ? String(process.argv[i + 1] ?? d) : d; };
  const file = flag("--plan", "evals/vv/test-plan.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const plan = raw.plan || raw;
  plan.items = sortItems(plan.items);
  runInteractive({ plan, secondsPerTurn: Number(flag("--seconds-per-turn", "20")), context: { nextStepText: flag("--next-step") || null } })
    .catch((e) => { console.error(`[voice:text] ${e.message}`); process.exit(1); });
}
