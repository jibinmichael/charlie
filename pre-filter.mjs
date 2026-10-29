// pre-filter.mjs — Charlie's cheap pre-filter (no model calls).
//
//   node pre-filter.mjs
//
// Sits between the scanner and the matcher. Drops obvious non-fits using plain
// rules read off the dossier — title role-type, seniority sanity, remote vs the
// dossier's remote preference, and a dealbreaker keyword scan — so only real
// candidates reach the (paid) Claude matcher. Reads jobs.json + dossier.out.json,
// writes jobs.matchable.json, and prints the funnel.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DOSSIER_PATH = join(here, "dossier.out.json");
const JOBS_PATH = join(here, "jobs.json");
const OUT_PATH = join(here, "jobs.matchable.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── rule patterns ───────────────────────────────────────────────────────────
// A real product-design / design-engineer role (the dossier's target family).
const DESIGN_POSITIVE =
  /(product design|product designer|\bux\b|\bui\b|design engineer|design lead|lead designer|head of design|founding designer|design system|principal designer|staff designer|senior designer|interaction design|experience design|design technologist)/i;

// Product-management titles — only a fit if the dossier actually wants PM.
const PM_POSITIVE = /(\bproduct manager\b|product management|\bgroup pm\b|\bpm\b)/i;

// "design" titles that are NOT product design (hardware / EE / non-product craft).
const ROLE_NONPRODUCT =
  /(verification|hardware|mechanical|electrical|\bchip\b|\basic\b|\brtl\b|\bpcb\b|\bcad\b|silicon|analog|firmware|microarchitect|actuator|audiovisual|robotic|mechatronic|optical|interior|industrial design|instructional|sound design|game design|level design|packaging|technical artist|\bqa\b|validation|landscape)/i;

// Junior / not-senior signals (dossier seniority is "senior").
const JUNIOR = /(intern\b|internship|\bjunior\b|\bjr\.?\b|\bentry\b|new ?grad|graduate program|apprentice|\bassociate\b|early career|working student|trainee)/i;

// Exec / heavy people-management (kept only when dossier flags people-mgmt as a
// dealbreaker). "Head of Design" is intentionally NOT dropped — it reads founding.
const EXEC = /(\bvp\b|vice president|\bsvp\b|\bdirector\b|\bchief\b|\bcto\b|\bcpo\b|head of product|head of engineering)/i;
const PEOPLE_MGR = /\bmanager\b/i; // a manager title that isn't "product manager"

// Pure brand / visual-only craft (dossier dealbreaker).
const VISUAL_ONLY = /(brand designer|visual designer|graphic designer|marketing designer|motion designer|illustrat|presentation designer|communications designer|\bweb designer\b|3d designer|game designer)/i;

// Clear onsite-only signal (dossier prefers remote).
const ONSITE = /(on-?site|in-office|in office)/i;

function has(re, ...vals) {
  return vals.some((v) => v && re.test(String(v)));
}

function main() {
  let dossier;
  let jobs;
  try {
    dossier = JSON.parse(readFileSync(DOSSIER_PATH, "utf8"));
    jobs = JSON.parse(readFileSync(JOBS_PATH, "utf8"));
    if (!Array.isArray(jobs)) throw new Error("jobs.json must be an array");
  } catch (err) {
    fail(`could not read an input file: ${err.message} — run the scanner first.`);
  }

  // derive the rules we apply from the dossier, so this stays "against the dossier".
  const prefs = dossier.preferences ?? {};
  const role = (prefs.role ?? "").toLowerCase();
  const dealbreakers = (prefs.dealbreakers ?? []).join(" ").toLowerCase();
  const wantsDesign = /design/.test(role) || role === "";
  const wantsPM = /product manager|product management|\bpm\b/.test(role);
  const wantsRemote = /remote/i.test(prefs.remote ?? "");
  const dropPeopleMgmt = /people-?management|people management|management/.test(dealbreakers);
  const dropVisualOnly = /brand|visual/.test(dealbreakers);

  const counts = { role: 0, seniority: 0, remote: 0, dealbreaker: 0 };
  const survivors = [];

  for (const job of jobs) {
    const title = job.title ?? "";
    const loc = job.location ?? "";
    const isPM = PM_POSITIVE.test(title);
    const isDesign = DESIGN_POSITIVE.test(title);

    // 1. role-type, tied to the dossier's target role: keep design roles (when the
    //    dossier wants design) and/or PM roles (when it wants PM); drop the rest,
    //    and drop "design" titles that are really hardware/EE/non-product craft.
    const roleFits = (wantsDesign && isDesign) || (wantsPM && isPM);
    if (!roleFits || (isDesign && ROLE_NONPRODUCT.test(title))) {
      counts.role++;
      continue;
    }

    // 2. seniority sanity: drop clearly-junior; drop execs / people-managers.
    if (JUNIOR.test(title) || EXEC.test(title)) {
      counts.seniority++;
      continue;
    }
    if (dropPeopleMgmt && PEOPLE_MGR.test(title) && !isPM) {
      counts.seniority++;
      continue;
    }

    // 3. remote vs preference: drop only on a clear onsite signal.
    if (wantsRemote && (job.remote === false || (has(ONSITE, title, loc) && !/remote/i.test(`${title} ${loc}`)))) {
      counts.remote++;
      continue;
    }

    // 4. dealbreaker keyword scan: pure brand / visual-only craft.
    if (dropVisualOnly && VISUAL_ONLY.test(title) && !isPM) {
      counts.dealbreaker++;
      continue;
    }

    survivors.push(job);
  }

  writeFileSync(OUT_PATH, JSON.stringify(survivors, null, 2) + "\n");

  const dropped = counts.role + counts.seniority + counts.remote + counts.dealbreaker;
  console.log("— pre-filter (no model calls) —");
  console.log(`in (jobs.json):          ${jobs.length}`);
  console.log(`dropped · role-type:     ${counts.role}`);
  console.log(`dropped · seniority:     ${counts.seniority}`);
  console.log(`dropped · remote:        ${counts.remote}`);
  console.log(`dropped · dealbreaker:   ${counts.dealbreaker}`);
  console.log(`dropped (total):         ${dropped}`);
  console.log(`survivors -> matcher:    ${survivors.length}  (= model calls)`);
  console.log(`written to jobs.matchable.json`);
}

main();
