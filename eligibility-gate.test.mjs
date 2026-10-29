// eligibility-gate.test.mjs — the KNOCKOUT floor regression fence (run: node eligibility-gate.test.mjs).
// The headline is T1: a student seeking an internship must be knocked out of a role requiring 2 years
// of professional experience (offering it would be a false offer). Also proves the FAIL-OPEN cases (unknown → no knockout) so the gate
// can never over-block on missing data.
import { knockouts } from "./eligibility-gate.mjs";
import { extractMinYears, normalizeEmploymentType, extractRoleReqs, _clearRoleReqsCache } from "./role-reqs.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

// unique ids so the per-job cache never bleeds between cases
let n = 0;
const job = (o) => ({ id: `t:${n++}`, title: "", description: "", employment_type: null, ...o });
const student = { professional_years: 0, preferences: { mode: "internship", dealbreakers: [] } };

// ── extraction unit checks ─────────────────────────────────────────────────────────────────────
ok("min_years: '5+ years of experience' -> 5", extractMinYears("Requires 5+ years of experience") === 5);
ok("min_years: '3-5 years experience' -> 3 (floor is the minimum)", extractMinYears("3-5 years experience in design") === 3);
ok("min_years: 'minimum 2 years' -> 2", extractMinYears("Minimum 2 years in a product role") === 2);
ok("min_years: prose '10 years' with no experience context -> null", extractMinYears("Over the past 10 years we have grown fast") === null);
ok("min_years: unstated -> null (never invent a floor)", extractMinYears("We are hiring a designer to own the system") === null);
ok("emp_type: 'Full time - fixed term' -> contract", normalizeEmploymentType({ employment_type: "Full time - fixed term" }) === "contract");
ok("emp_type: 'Full time - permanent' -> full_time", normalizeEmploymentType({ employment_type: "Full time - permanent" }) === "full_time");
ok("emp_type: 'Intern' -> intern", normalizeEmploymentType({ employment_type: "Intern" }) === "intern");
ok("emp_type: 'Contractor' -> contract", normalizeEmploymentType({ employment_type: "Contractor" }) === "contract");
ok("emp_type: unknown -> null", normalizeEmploymentType({ employment_type: "" }) === null);

// ── T1 — the student / internship case (MUST knock out) ─────────────────────────────────────────
{
  const role = job({ title: "Product Designer", employment_type: "Full Time", description: "You have 2+ years of professional product design experience." });
  const ko = knockouts(role, student);
  ok("T1: student (internship, 0y) × '2+ years required' full-time -> KNOCKED OUT", ko.length > 0);
  ok("T1: reason names the experience floor", ko.some((r) => /experience-floor/.test(r)));
}

// ── T1b — a VAGUE full-time role for an internship seeker still knocks on type (K5c) ─────────────
{
  const role = job({ title: "Marketing Associate", employment_type: "Full Time", description: "Join our growing team." });
  ok("T1b: internship seeker × full-time typed role (no years) -> knocked on employment-type", knockouts(role, student).some((r) => /employment-type/.test(r)));
}

// ── T5 — wants contract × permanent full-time (MUST knock out) ──────────────────────────────────
{
  const contractor = { professional_years: 8, preferences: { employment_type_wanted: "contract", dealbreakers: [] } };
  const role = job({ title: "Staff Engineer", employment_type: "Full time - permanent", description: "Permanent full-time role." });
  ok("T5: wants contract × permanent full-time -> KNOCKED OUT", knockouts(role, contractor).some((r) => /employment-type/.test(r)));
}

// ── T8 — dealbreaker in the JD BODY (gated behind KNOCKOUT_DEALBREAKER_BODY, default OFF) ─────────
{
  const person = { professional_years: 7, preferences: { dealbreakers: ["crypto"], mode: "active_switch" } };
  const role = job({ title: "Senior Engineer", location: "Remote", description: "Building our crypto exchange trading engine." });
  // default OFF: a body-only dealbreaker does NOT knock (it over-blocks on mere mentions; matcher covers it)
  delete process.env.KNOCKOUT_DEALBREAKER_BODY;
  ok("T8: body-dealbreaker is OFF by default (no over-block)", knockouts(role, person).length === 0);
  // turned ON: it fires
  process.env.KNOCKOUT_DEALBREAKER_BODY = "on";
  ok("T8: with KNOCKOUT_DEALBREAKER_BODY=on, 'crypto' in JD body -> KNOCKED OUT", knockouts(role, person).some((r) => /dealbreaker/.test(r)));
  // and even ON it must NOT false-positive on a substring (title deliberately free of the word "sales")
  const role2 = job({ title: "Backend Engineer", description: "Own our Salesforce integration end to end." });
  const salesAverse = { professional_years: 5, preferences: { dealbreakers: ["sales"] } };
  ok("T8: 'sales' dealbreaker does NOT hit 'Salesforce' (word boundary)", knockouts(role2, salesAverse).length === 0);
  delete process.env.KNOCKOUT_DEALBREAKER_BODY;
}

// ── NON-firing / FAIL-OPEN cases (must NOT knock out) ───────────────────────────────────────────
{
  const senior = { professional_years: 6, preferences: { mode: "active_switch", dealbreakers: [] } };
  ok("experienced person (6y) × '5+ years' role -> NOT knocked (normal stretch)", knockouts(job({ description: "5+ years of experience required" }), senior).length === 0);
  ok("experienced person (6y) × '8 years' role -> NOT knocked (gap within tolerance)", knockouts(job({ description: "8 years of experience" }), senior).length === 0);
  ok("K2b: 3y person × '8+ years' role -> KNOCKED (large gap)", knockouts(job({ description: "8+ years of experience" }), { professional_years: 3, preferences: {} }).length > 0);

  const legacyUser = { preferences: {} }; // no mode, no professional_years (an older dossier)
  ok("existing user (mode+years unknown) × '2+ years' role -> NOT knocked (fail-open)", knockouts(job({ description: "2+ years of professional experience" }), legacyUser).length === 0);
  ok("student × role with NO stated floor/type -> NOT knocked (never invent a requirement)", knockouts(job({ description: "Come help us build." }), student).length === 0);
  ok("knockouts never throws on a garbage job -> []", Array.isArray(knockouts(null, student)));
}

// ── caching: same id returns the cached reqs ────────────────────────────────────────────────────
{
  _clearRoleReqsCache();
  const j = { id: "cache:1", description: "5+ years of experience" };
  const a = extractRoleReqs(j);
  const b = extractRoleReqs({ id: "cache:1", description: "totally different, 12+ years" });
  ok("extractRoleReqs caches by id (second call ignores changed body)", a.min_years === 5 && b.min_years === 5);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
