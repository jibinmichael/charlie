// lib/qualify/roles.mjs — an employer system's roles become jobs (the first step of Qualify & Submit).
//
// THE BRIEF IS BUILT ONLY FROM THE ROLE'S OWN FIELDS. No model writes a must-have: each line of the
// role's mandatory skills becomes one must-have, quoted verbatim. The brief is not stored: it is rebuilt from the
// role's stored payload whenever it is needed (lib/qualify/wiring.mjs briefOf), so it can never drift from the role.
// Who fits is the pluggable scorer's call (lib/scoring/index.mjs), not this file's.
//
// WHAT A ROLE'S STATUS DOES. Statuses the connection lists (Pieworks: Hot, Warm) keep the job active; a role
// that is still listed with any other status is paused; a role no longer listed at all is closed. A change to
// what the brief is built from (title, skills, responsibilities, experience) makes a new approved version.
import { hashOf } from "./store.mjs";

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(n * 0.6))).trim();
};

/** Words that open a requirement. Pieworks runs its bullets together ("a software productGood written"); a run is split
 *  only before one of these, so a camel-cased name (JavaScript, GitHub, LinkedIn) is never cut in two. */
const OPENERS = "Strong|Working|Experience|Experienced|Excellent|Good|Knowledge|Proficiency|Proficient|Hands|Ability|Familiarity|Familiar|Understanding|Must|Should|Exposure|Bachelor|Bachelors|Master|Minimum|Solid|Deep|Proven|Prior|Basic|Advanced|Expertise|Expert|Background|Degree|Certification|Comfortable|Demonstrated|Track";
const RUN_ON = new RegExp(`([a-z0-9)\\]])(?=(?:${OPENERS})\\b)`, "g");

/** The role's mandatory-skills text as separate requirements. Pure. */
export function skillLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(RUN_ON, "$1\n")
    .split(/\n|•|·|;|•/)
    .map((l) => l.replace(/^\s*(?:[-–*]|\d{1,2}[.)])\s+/, "").trim())
    .filter((l) => l.length >= 4);
}

const sentences = (text) => String(text || "").split(/(?<=[.!?])\s*(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length >= 8);

/** What the brief is built from; a change here means a new brief version. Pure. */
export const briefHash = (r) => hashOf({ role: r.role, clientName: r.clientName, mandatorySkill: r.mandatorySkill ?? null, okr: r.okr ?? null, minExperience: r.minExperience ?? null, maxExperience: r.maxExperience ?? null, location: r.location ?? null });

/**
 * A Pieworks role as a workspace job and its brief. Pure. Returns null with a reason when no brief can be built
 * from the role alone (no mandatory skills): that role is reported, never briefed by guesswork.
 */
export function briefFromRole(r) {
  const lines = skillLines(r.mandatorySkill).slice(0, 12);
  if (!lines.length) return { ok: false, reason: "the role lists no mandatory skills" };
  if (!String(r.role || "").trim() || !String(r.clientName || "").trim()) return { ok: false, reason: "the role has no title or no company" };
  // the role's own must-haves, verbatim: what the verify email may ask about and what a justification answers to
  const criteria = lines.map((line, i) => ({ ref: `c${i + 1}`, kind: "must_have", label: clip(line, 120), quote: clip(line, 400), authored_by: "employer" }));
  const min = Number(r.minExperience), max = r.maxExperience == null ? null : Number(r.maxExperience);
  const band = Number.isFinite(min) && min >= 0 && (max == null || (Number.isFinite(max) && max >= min)) ? { min, max } : null;
  const okr = sentences(r.okr);
  const spec = {
    role: clip(r.role, 120),
    mission: okr[0] ? clip(okr[0], 300) : null,
    outcomes: okr.slice(0, 6).map((s) => clip(s, 200)),
    criteria,
    experience: band,
    location: r.location ? String(r.location).trim() : null,
  };
  const ctc = r.minCtc != null || r.maxCtc != null ? `${r.minCtc ?? "?"} to ${r.maxCtc ?? "?"} lakh fixed` : null;
  const jd = [
    `${r.role} at ${r.clientName}${r.location ? `, ${r.location}` : ""}.`,
    band ? `Experience: ${max == null ? `${min}+` : `${min} to ${max}`} years.` : null,
    ctc ? `Pay: ${ctc}.` : null,
    `Mandatory skills: ${lines.join("; ")}.`,
    r.okr ? `Responsibilities: ${String(r.okr).trim()}` : null,
  ].filter(Boolean).join("\n");
  return { ok: true, job: { title: clip(r.role, 120), client: String(r.clientName).trim(), jd_text: jd }, spec };
}

/** The job's lifecycle for a role's status. Pure. */
export function lifecycleFor(status, activeStatuses) {
  return (activeStatuses || []).map((s) => s.toLowerCase()).includes(String(status || "").toLowerCase()) ? "active" : "paused";
}

/**
 * Bring one connection's roles into the workspace. Impure. Each role is isolated: one failure is reported and the
 * rest go on. Shadow and live both write jobs (a job is not an email); nothing here contacts anyone.
 * deps: { store (lib/qualify/store.mjs), hire (lib/qualify/jobs.mjs: createJob, getJob, setLifecycle), listRoles: () => {roles, skipped, total}, log }
 * @returns {{ created, rebriefed, unchanged, paused, closed, reopened, skipped, failed, items }}
 */
export async function syncRoles({ connection, deps }) {
  const { store, hire, listRoles, log = () => {} } = deps;
  const counts = { created: 0, rebriefed: 0, unchanged: 0, paused: 0, closed: 0, reopened: 0, skipped: 0, failed: 0 };
  const items = [];
  const statuses = connection.source?.statuses || [];
  const { roles, skipped, total = null } = await listRoles();
  // A role that did not parse is still LISTED: it is never closed for our failure to read it (one malformed role or
  // an empty page must not close live roles and their threads).
  const listed = new Set(skipped.map((s) => String(s.id ?? "")).filter(Boolean));
  for (const s of skipped) { counts.skipped++; items.push({ role: String(s.id ?? "?"), result: "skipped", reason: `did not parse: ${s.issue}` }); }
  const known = new Map((await store.roles(connection.id)).map((r) => [r.external_id, r]));
  for (const r of roles) {
    const ext = String(r.id);
    listed.add(ext);
    try {
      const prev = known.get(ext);
      const life = lifecycleFor(r.status, statuses);
      const bh = briefHash(r);
      if (!prev?.job_id) {
        if (life !== "active") { counts.skipped++; items.push({ role: r.role, result: "not taken", reason: `status ${r.status}` }); await store.upsertRole({ connection_id: connection.id, external_id: ext, job_id: null, external_status: r.status, payload: r, payload_hash: bh }); continue; }
        const b = briefFromRole(r);
        if (!b.ok) { counts.skipped++; items.push({ role: r.role, result: "not taken", reason: b.reason }); await store.upsertRole({ connection_id: connection.id, external_id: ext, job_id: null, external_status: r.status, payload: r, payload_hash: bh }); continue; }
        const job = await hire.createJob({ ...b.job, jd_source: `${connection.key}:${ext}` });
        await store.upsertRole({ connection_id: connection.id, external_id: ext, job_id: job.id, external_status: r.status, payload: r, payload_hash: bh });
        counts.created++; items.push({ role: r.role, result: "created", reason: `${r.clientName}, ${r.status}` });
        continue;
      }
      const job = (await hire.getJob(prev.job_id))?.job;
      if (!job) { counts.failed++; items.push({ role: r.role, result: "failed", reason: "its job no longer exists" }); continue; }
      if (prev.payload_hash !== bh) {
        // the brief is rebuilt from the stored payload when it is read, so storing the new payload below is the update
        const b = briefFromRole(r);
        if (b.ok) {
          if (hire.updateJob) await hire.updateJob(job.id, b.job);
          counts.rebriefed++; items.push({ role: r.role, result: "brief updated", reason: "the role changed on the source" });
        }
      } else counts.unchanged++;
      if (job.lifecycle !== life) {
        await hire.setLifecycle(job.id, life);
        if (life === "paused") { counts.paused++; items.push({ role: r.role, result: "paused", reason: `status ${r.status}` }); }
        else { counts.reopened++; items.push({ role: r.role, result: "reopened", reason: `status ${r.status}` }); }
      }
      await store.upsertRole({ connection_id: connection.id, external_id: ext, job_id: job.id, external_status: r.status, payload: r, payload_hash: bh });
    } catch (e) {
      counts.failed++; items.push({ role: r.role, result: "failed", reason: String(e?.message || e).slice(0, 160) });
      log(`[qualify-roles:${connection.key}] role ${ext}: ${e?.message || e}`);
    }
  }
  // no longer listed as active on the source: the role is closed. A listing with nothing in it closes nothing:
  // an empty answer from the source is far likelier to be its failure than every role ending at once.
  if (!roles.length && !skipped.length) return { ...counts, held: "the source listed no roles; nothing was closed", items };
  // Closing needs a COMPLETE listing: the source must say how many roles it has, and we must have that many DISTINCT
  // roles (rows repeated or skipped while paging are not complete). Anything less closes nothing.
  const distinct = new Set([...roles.map((r) => String(r.id)), ...skipped.map((x) => String(x.id ?? ""))].filter(Boolean)).size;
  if (!Number.isFinite(total)) return { ...counts, held: "the source did not say how many roles it has; nothing was closed", items };
  if (distinct < total) return { ...counts, held: `the source listed ${distinct} of ${total} roles; nothing was closed`, items };
  for (const [ext, prev] of known) {
    if (listed.has(ext) || !prev.job_id) continue;
    try {
      const job = (await hire.getJob(prev.job_id))?.job;
      if (job && job.lifecycle !== "closed") { await hire.setLifecycle(job.id, "closed"); counts.closed++; items.push({ role: job.title, result: "closed", reason: "no longer listed on the source" }); }
    } catch (e) {
      counts.failed++; items.push({ role: ext, result: "failed", reason: String(e?.message || e).slice(0, 160) });
    }
  }
  return { ...counts, items };
}
