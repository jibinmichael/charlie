// consent-drift.mjs — has any live form stopped asking a consent question it used to ask?
// NO SEND. NO MODEL. $0. READ ONLY: it writes nothing but the baseline, and only when asked.
//
//   node --env-file=.env.local scripts/consent-drift.mjs            # check; non-zero exit on regression
//   node --env-file=.env.local scripts/consent-drift.mjs --update   # accept the current state as the baseline
//
// WHY. A new form can invent a wording, and a form's title can be EDITED after people have answered
// it, so a form that used to match silently stops. `lib/consent-baseline.json` records what each form
// was last seen asking, and this compares the live forms against it.
//
// EXITS NON-ZERO ON A REGRESSION, on purpose, so it can be run on a schedule or before an ingest and
// actually stop something. A form that never asked is not a regression; see lib/consent-drift.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../charlie-store.mjs";
import { TallySubmissionsPage, TallyFormsPage } from "../lib/schemas/tally.mjs";
import { POOL_Q, SHARE_Q } from "../lib/consent-questions.mjs";
import { compareToBaseline, detectOn } from "../lib/consent-drift.mjs";

loadEnv();
const UPDATE = process.argv.includes("--update");
const BASELINE = new URL("../lib/consent-baseline.json", import.meta.url);

async function main() {
  if (!process.env.TALLY_API_KEY) { console.error("TALLY_API_KEY not set"); process.exit(1); }
  const H = { Authorization: `Bearer ${process.env.TALLY_API_KEY}` };

  const res = await fetch("https://api.tally.so/forms?limit=100", { headers: H });
  if (!res.ok) throw new Error(`Tally forms list failed: ${res.status}`); // fail closed
  const forms = TallyFormsPage.safeParse(await res.json());
  if (!forms.success) throw new Error("Tally forms list did not match the schema");
  if (!forms.data.length) throw new Error("Tally returned no forms"); // never re-baseline to empty

  const observed = {};
  for (const f of forms.data) {
    const r = await fetch(`https://api.tally.so/forms/${f.id}/submissions?limit=1&page=1`, { headers: H });
    if (!r.ok) throw new Error(`Tally ${r.status} on ${f.id}`); // a form we cannot read is not a form that asks nothing
    const p = TallySubmissionsPage.safeParse(await r.json());
    if (!p.success) throw new Error(`${f.id} did not match the schema`);
    observed[f.id] = detectOn(p.data.questions, POOL_Q, SHARE_Q);
  }

  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const { regressions, recovered, unknown, gone } = compareToBaseline(baseline, observed);

  console.error(`\nchecked ${Object.keys(observed).length} live form(s) against ${Object.keys(baseline).length} in the baseline\n`);
  for (const r of recovered) console.error(`  changed   ${r.form}  ${r.field}\n              was ${JSON.stringify(r.was)}\n              now ${JSON.stringify(r.now)}`);
  for (const f of unknown) console.error(`  NEW FORM  ${f}  pool=${observed[f].pool ? "found" : "NOT FOUND"} share=${observed[f].share ? "found" : "NOT FOUND"}  <- open the form and confirm before ingesting`);
  for (const f of gone) console.error(`  gone      ${f}  in the baseline, not in Tally any more`);

  if (regressions.length) {
    console.error(`\n${"!".repeat(70)}`);
    for (const r of regressions) {
      console.error(`REGRESSION  ${r.form}  ${r.field} consent is no longer detected.`);
      console.error(`  it used to be: ${JSON.stringify(r.was)}`);
      console.error(`  Everyone ingested from this form now stores that permission as FALSE, which is`);
      console.error(`  indistinguishable from a refusal. Fix lib/consent-questions.mjs, or confirm the`);
      console.error(`  question really was removed and re-run with --update.`);
    }
    console.error(`${"!".repeat(70)}\n`);
    process.exit(1); // fail closed
  }

  if (UPDATE) {
    writeFileSync(BASELINE, JSON.stringify(observed, null, 2) + "\n");
    console.error(`baseline updated: ${Object.keys(observed).length} forms\n`);
  } else {
    console.error(`no regressions.\n`);
  }
}

main().catch((e) => { console.error("[consent-drift] fatal:", e.message); process.exit(1); });
