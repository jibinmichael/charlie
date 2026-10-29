// seed-us-testers.mjs — seed two distinct US test candidates (grounded dossiers built from sample US
// resumes) as active users, so the daily cron matches and emails them and the US-only role-email
// enrichment (pay / momentum / reviews / warm intro) can be checked end to end.
//
//   node scripts/seed-us-testers.mjs          # build + save both
//   node scripts/seed-us-testers.mjs --wipe   # delete both test candidates
//
// Replace the placeholder addresses below with +aliases of an inbox you control before running, or
// the cron's emails go nowhere. Region is forced to US (comp_currency USD) so homeRegion(dossier) ===
// "us". Needs Supabase + ANTHROPIC.

import { loadEnv, uploadResume, saveDossier, deleteCandidate } from "../charlie-store.mjs";
import { buildDossier } from "../dossier-build.mjs";
import { homeRegion } from "../quality-gate.mjs";

loadEnv();

const TESTERS = [
  {
    email: "tester+us1@example.com",
    resume: `Maya Chen
Senior Product Designer — New York, NY

EXPERIENCE
Lumen (fintech, Series C), New York — Senior Product Designer, 2021–present
- Took the business banking dashboard from 0 to 1: research, flows, shipped product used by 12,000 businesses.
- Built and owned the design system (components, tokens, contribution model) adopted by 4 product teams.
- Led motion and prototyping standards; cut design-to-build handoff time by a third.

Braid (B2B SaaS), Remote — Product Designer, 2018–2021
- Designed onboarding and billing flows for a payments product.
- Ran the first accessibility pass to WCAG AA across the core app.

SKILLS
Product design, design systems, prototyping (Figma, ProtoPie), user research, motion.

EDUCATION
BFA, Design — Rhode Island School of Design`,
  },
  {
    email: "tester+us2@example.com",
    resume: `David Park
Senior Software Engineer — San Francisco, CA

EXPERIENCE
Northwind (infrastructure, Series D), San Francisco — Senior Software Engineer, 2020–present
- Built and scaled a distributed job-processing service handling 40M events/day on Go and Postgres.
- Led the migration from a monolith to services; reduced p99 latency by 45%.
- Mentored 3 engineers; owned on-call and reliability for the data platform.

Cadence (B2B SaaS), Remote — Software Engineer, 2017–2020
- Shipped the public REST + webhook API used by 800 integrations.
- Built the billing and metering pipeline.

SKILLS
Go, TypeScript, Postgres, distributed systems, AWS, API design.

EDUCATION
BS, Computer Science — UC Berkeley`,
  },
];

const wipe = process.argv.includes("--wipe");

for (const t of TESTERS) {
  if (wipe) {
    await deleteCandidate(t.email).catch(() => {});
    console.log(`wiped ${t.email}`);
    continue;
  }
  console.log(`\n=== seeding ${t.email} ===`);
  await uploadResume(t.email, t.resume);
  const dossier = await buildDossier(t.resume);
  dossier.preferences = dossier.preferences || {};
  dossier.preferences.comp_currency = "USD"; // force US region (homeRegion checks this first)
  await saveDossier(t.email, dossier, "active");
  console.log(`  name: ${dossier.name} | region: ${homeRegion(dossier)} | role: ${dossier.preferences?.role || "?"} | active`);
}
console.log(wipe ? "\ndone (wiped)." : "\ndone. verify: node scripts/check-candidate.mjs <email>");
