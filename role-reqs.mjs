// role-reqs.mjs — deterministic extraction of a role's HARD requirements from its ATS fields + JD text,
// the input to the knockout gate (eligibility-gate.mjs). NO model call, ~0 cost. Cached by job.id (the
// JD is identical across users, so we parse each posting once per run).
//
// The whole discipline: UNSTATED → null, NEVER a guessed floor. A JD that names no experience minimum
// gets min_years null, which means the experience knockout can never fire on it. We would rather miss a
// knockout than invent a requirement and drop a real role (an over-block silently buries a role; the
// normal gate still judges anything we don't knock out). Validated with RoleReqs; on ANY failure we
// return all-null reqs (fail-open on extraction).
import { RoleReqs } from "./lib/schemas/role-reqs.mjs";

const _cache = new Map(); // job.id -> validated RoleReqs (per-process; the pool is re-parsed each run)

// A number adjacent to "years" ONLY in an experience context (never a stray "past 10 years" in prose).
// Two shapes: "5+ years of experience" / "3-5 years experience" and "experience: 5 years" / "minimum 3 years".
const YRS_AFTER = /(\d{1,2})\s*\+?\s*(?:-|to|–|—)?\s*\d{0,2}\s*years?(?:\s+of)?\s+(?:experience|exp\b|professional|industry|relevant|hands[- ]?on|work)/gi;
const YRS_BEFORE = /(?:experience|minimum|at least|min\.?|require[sd]?|require\b)[^.\n]{0,24}?(\d{1,2})\s*\+?\s*years?/gi;

// Smallest experience-floor number the JD states, or null. The FLOOR is the minimum, so we take the min
// across all matches ("3-5 years" → 3). Sanity cap at 40 so a stray big number never becomes a floor.
export function extractMinYears(text) {
  const t = String(text || "");
  const found = [];
  for (const re of [YRS_AFTER, YRS_BEFORE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 40) found.push(n);
    }
  }
  return found.length ? Math.min(...found) : null;
}

// Normalize the (messy) ATS employment_type string, falling back to the title/JD. Order matters:
// intern and part-time and contract/temporary/fixed-term are checked BEFORE full-time/permanent, so
// "Full time - fixed term" reads as contract (a fixed term is not a permanent role) and only a clean
// "Full time"/"permanent" reads as full_time. null when nothing is clear.
export function normalizeEmploymentType(job) {
  const raw = String(job?.employment_type || "");
  const hay = `${raw} ${job?.title || ""}`.toLowerCase();
  if (/\bintern(ship)?\b/.test(hay)) return "intern";
  if (/\bpart[- ]?time\b/.test(hay)) return "part_time";
  if (/\bcontract(or)?\b|\btemporary\b|\bfixed[- ]?term\b|\bfreelance\b|\bfixed term\b/.test(hay)) return "contract";
  if (/\bfull[- ]?time\b|\bfulltime\b|\bpermanent\b/.test(hay)) return "full_time";
  // last resort: an "internship" only mentioned in the JD body (not the title/type field)
  if (/\binternship\b/.test(String(job?.description || "").toLowerCase().slice(0, 400))) return "intern";
  return null;
}

// Extract the role's hard requirements. Comp is intentionally left null in v1 (the ATS `compensation`
// object is almost always empty and JD comp-regex is fragile; the comp knockout stays dormant until a
// reliable comp source lands — documented in eligibility-gate.mjs). Cached by job.id.
export function extractRoleReqs(job) {
  const id = job?.id;
  if (id && _cache.has(id)) return _cache.get(id);
  let reqs;
  try {
    const raw = {
      min_years: extractMinYears(`${job?.title || ""}. ${job?.description || ""}`),
      employment_type: normalizeEmploymentType(job),
      comp_min: null,
      comp_max: null,
      comp_currency: null,
    };
    const parsed = RoleReqs.safeParse(raw);
    // fail-open on a broken parse: all-null reqs means no axis knocks out (never drop a real role).
    reqs = parsed.success ? parsed.data : { min_years: null, employment_type: null, comp_min: null, comp_max: null, comp_currency: null };
  } catch {
    reqs = { min_years: null, employment_type: null, comp_min: null, comp_max: null, comp_currency: null };
  }
  if (id) _cache.set(id, reqs);
  return reqs;
}

// Test/observability hook: clear the per-process cache.
export function _clearRoleReqsCache() {
  _cache.clear();
}
