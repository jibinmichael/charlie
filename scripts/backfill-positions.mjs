// backfill-positions.mjs — compute the POSITION statement for each active user and store it on the
// dossier. Store only: nothing renders or sends it.
//
//   node --env-file=.env.local scripts/backfill-positions.mjs --limit 10          # DRY, prints, writes nothing
//   node --env-file=.env.local scripts/backfill-positions.mjs --only a@b.com,c@d.com
//   node --env-file=.env.local scripts/backfill-positions.mjs --apply             # writes the field
//
// It writes ONE additive field to the dossier, and position.test.mjs asserts no email path reads it.
//
// ADDITIVE BY CONSTRUCTION: the merge is `{ ...c.dossier, position }`, so every other key on the
// stored dossier survives byte for byte. Proof points a person built up in conversation cannot be
// reproduced by a rebuild and must never be overwritten.
//
// `saveDossier(email, dossier, status = "screening")` DEFAULTS the status. Omitting the third
// argument flips an active user to `screening`, which removes them from listActiveCandidates and
// silently stops their email. Every call here passes "active" explicitly (see the save below), and
// position.test.mjs asserts it.
//
// COST. One Opus build + one Haiku verify per person, once. Dry by default, --limit bounded, and it
// aborts if the running spend crosses --max-usd (default $15) — the same discipline as
// MAX_RUN_COST_USD on the engine.

import { loadEnv, listActiveCandidates, saveDossier, store } from "../charlie-store.mjs";
import { willInvalidate, invalidationWarning } from "../lib/dossier-write-cost.mjs";
import { buildPosition, hasEnoughToPosition } from "../lib/position.mjs";

loadEnv();

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", "0")) || 0;
const ONLY = String(arg("--only", "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_USD = Number(arg("--max-usd", "15"));

// Published price tiers, per MTok. Used ONLY to stop a runaway; the printed total is an estimate and
// says so, rather than pretending to be a bill.
const PRICE = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};
const costOf = (model, u) => {
  const p = PRICE[model];
  if (!p || !u) return 0;
  return ((u.input_tokens || 0) / 1e6) * p.in + ((u.output_tokens || 0) / 1e6) * p.out;
};

async function main() {
  let cands = await listActiveCandidates();
  if (ONLY.length) cands = cands.filter((c) => ONLY.includes(String(c.email).toLowerCase()));
  // IDEMPOTENT: somebody who already has a position costs nothing on a re-run, so an interrupted
  // --apply can be resumed without re-billing the people already done.
  const already = cands.filter((c) => c.dossier?.position?.statement).length;
  const eligible = cands.filter((c) => hasEnoughToPosition(c.dossier) && !c.dossier?.position?.statement);
  const work = LIMIT ? eligible.slice(0, LIMIT) : eligible;

  console.error(`\nactive ${cands.length} · already positioned ${already} (skipped, $0) · enough facts to try ${eligible.length} · this run ${work.length}`);

  // WHAT THE NEXT RUN WILL PAY. Writing to a dossier changes its match-cache key, so the next engine
  // run re-scores that person's cached verdicts. This measures that collateral cost against the real
  // scoring projection on a real row (lib/dossier-write-cost.mjs) and prints it beside this script's
  // own spend.
  if (work.length) {
    const sample = work[0];
    const invalidates = willInvalidate(sample.dossier, { ...sample.dossier, position: { statement: "probe", evidence: [{ claim: "probe" }] } });
    let verdicts = 0;
    if (invalidates) {
      const emails = work.map((c) => c.email);
      for (let i = 0; i < emails.length; i += 50) {
        const { count } = await store().from("match_verdicts").select("cache_key", { count: "exact", head: true }).in("email", emails.slice(i, i + 50));
        verdicts += count || 0;
      }
    }
    console.error(invalidationWarning({ invalidates, people: work.length, verdicts }));
  }

  console.error(APPLY ? `MODE: APPLY (writes dossier.position)\n` : `MODE: DRY RUN (writes nothing)\n`);

  let spend = 0, made = 0, dropped = 0, failed = 0;
  const reasons = {};
  for (const c of work) {
    if (spend > MAX_USD) { console.error(`\nSTOPPING: estimated spend $${spend.toFixed(2)} passed the $${MAX_USD} ceiling.`); break; }
    try {
      const { position, reason, usage } = await buildPosition(c.dossier, { log: (m) => console.error(`   [${c.email}] ${m}`) });
      spend += costOf("claude-opus-4-8", usage.build) + costOf("claude-haiku-4-5", usage.verify);
      reasons[reason] = (reasons[reason] || 0) + 1;

      if (!position) { dropped++; console.error(`— ${c.email}\n   DROPPED: ${reason}`); continue; }
      made++;
      console.error(`\n★ ${c.email}`);
      console.error(`   "${position.statement}"`);
      position.evidence.forEach((e) => console.error(`     · ${String(e.claim).replace(/\s+/g, " ").slice(0, 150)}`));

      if (APPLY) {
        // The status is a CONSTANT, not read from the row: listActiveCandidates does not select the
        // `status` column, so the row's status would be undefined, and an undefined argument takes
        // saveDossier's "screening" default, silently removing the person from every send. Every
        // row here came from listActiveCandidates (`.eq("status", "active")`), so "active" is
        // correct by construction.
        await saveDossier(c.email, { ...c.dossier, position }, "active");
        console.error(`   saved`);
      }
    } catch (e) {
      failed++;
      console.error(`— ${c.email}\n   FAILED, continuing: ${e.message}`); // per-record isolation
    }
  }

  console.error(`\n${"─".repeat(60)}`);
  console.error(`positions written  ${made}`);
  console.error(`dropped            ${dropped}   ${JSON.stringify(reasons)}`);
  console.error(`errored            ${failed}`);
  console.error(`estimated spend    ~$${spend.toFixed(2)}  (price-tier estimate, not a bill)`);
  if (!APPLY) console.error(`\nDRY RUN — nothing was written. Re-run with --apply.\n`);
}

main().catch((e) => { console.error("[backfill-positions] fatal:", e.message); process.exit(1); });
