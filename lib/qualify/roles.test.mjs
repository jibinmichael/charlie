// lib/qualify/roles.test.mjs — an employer system's roles become workspace jobs, briefed only from the role's
// own fields. In memory; no database, no network.
import { describe, it, expect } from "vitest";
import { skillLines, briefFromRole, lifecycleFor, syncRoles } from "./roles.mjs";

const ROLE = {
  id: 1000101, role: "Support Engineer", clientName: "Northwind Labs", location: "Pune", status: "Hot",
  minExperience: 1.0, maxExperience: 3.0, minCtc: 5.0, maxCtc: 8.0,
  mandatorySkill: "1-3 years in customer support for a software productGood written English & ticket triage skillsWorking knowledge of a helpdesk and knowledge-base tool (e.g., Zendesk)",
  okr: "Resolve customer tickets for the billing product.Write help articles for issues that repeat across accounts.",
};

describe("the brief, from the role alone", () => {
  it("one must-have per mandatory skill, quoted; camel-cased names are never split; numbers kept", () => {
    expect(skillLines(ROLE.mandatorySkill)).toEqual([
      "1-3 years in customer support for a software product",
      "Good written English & ticket triage skills",
      "Working knowledge of a helpdesk and knowledge-base tool (e.g., Zendesk)",
    ]);
    expect(skillLines("JavaScript and TypeScript on GitHub; LinkedIn ads")).toEqual(["JavaScript and TypeScript on GitHub", "LinkedIn ads"]);
  });

  it("builds a brief and job: must-haves only, the years band from the role, the client as the employer", () => {
    const b = briefFromRole(ROLE);
    expect(b.ok).toBe(true);
    expect(b.job).toMatchObject({ title: "Support Engineer", client: "Northwind Labs" });
    expect(b.spec.criteria.map((c) => [c.ref, c.kind, c.authored_by])).toEqual([["c1", "must_have", "employer"], ["c2", "must_have", "employer"], ["c3", "must_have", "employer"]]);
    expect(b.spec.criteria[1].quote).toBe("Good written English & ticket triage skills");
    expect(b.spec.experience).toEqual({ min: 1, max: 3 });
    expect(b.spec.mission).toBe("Resolve customer tickets for the billing product.");
    expect(b.job.jd_text).toMatch(/Experience: 1 to 3 years\./);
  });

  it("refuses to brief a role with no mandatory skills (never guesses one)", () => {
    expect(briefFromRole({ ...ROLE, mandatorySkill: "" })).toEqual({ ok: false, reason: "the role lists no mandatory skills" });
  });

  it("an open-ended band is 'at least'; a nonsense band is left out, not invented", () => {
    expect(briefFromRole({ ...ROLE, maxExperience: null }).spec.experience).toEqual({ min: 1, max: null });
    expect(briefFromRole({ ...ROLE, minExperience: 5, maxExperience: 2 }).spec.experience).toBeNull();
  });

  it("only the connection's statuses keep a job active", () => {
    expect(lifecycleFor("Hot", ["Hot", "Warm"])).toBe("active");
    expect(lifecycleFor("warm", ["Hot", "Warm"])).toBe("active");
    expect(lifecycleFor("Cold", ["Hot", "Warm"])).toBe("paused");
  });
});

function fakes(knownRoles = []) {
  const rows = new Map(knownRoles.map((r) => [r.external_id, r]));
  const jobs = new Map(), updates = [];
  let n = 0;
  return {
    rows, jobs, updates,
    store: { roles: async () => [...rows.values()], upsertRole: async (r) => { rows.set(r.external_id, { ...rows.get(r.external_id), ...r }); return r; } },
    hire: {
      createJob: async (j) => { const job = { id: `job-${++n}`, lifecycle: "active", status: "approved", ...j }; jobs.set(job.id, job); return job; },
      updateJob: async (id, j) => { updates.push(id); Object.assign(jobs.get(id), j); },
      getJob: async (id) => (jobs.has(id) ? { job: jobs.get(id) } : null),
      setLifecycle: async (id, l) => { jobs.get(id).lifecycle = l; },
    },
  };
}
const CONN = { id: "conn-1", key: "pieworks", source: { statuses: ["Hot", "Warm"] } };

describe("syncing roles", () => {
  it("creates a job for a Hot role; leaves a Cold one out; reports a role it cannot brief", async () => {
    const f = fakes();
    const listRoles = async () => ({ roles: [ROLE, { ...ROLE, id: 2, status: "Cold" }, { ...ROLE, id: 3, mandatorySkill: "" }], skipped: [{ id: 9, issue: "clientName: too short" }] });
    const out = await syncRoles({ connection: CONN, deps: { ...f, listRoles } });
    expect(out).toMatchObject({ created: 1, skipped: 3, failed: 0 });
    expect([...f.jobs.values()]).toEqual([expect.objectContaining({ title: "Support Engineer", client: "Northwind Labs", jd_source: "pieworks:1000101", status: "approved" })]);
    expect(f.rows.get("1000101").job_id).toBe("job-1");
  });

  it("a second sync of the same role changes nothing; a status change pauses; a role gone from the list is closed", async () => {
    const f = fakes();
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [] }) } });
    expect(await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [] }) } })).toMatchObject({ unchanged: 1, created: 0, rebriefed: 0 });
    expect(f.updates).toHaveLength(0);
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, status: "Hold" }], skipped: [] }) } });
    expect(f.jobs.get("job-1").lifecycle).toBe("paused");
    // closed only when the source still lists roles and this one is not among them (an empty listing closes
    // nothing)
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, id: 777 }], skipped: [], total: 1 }) } });
    expect(f.jobs.get("job-1").lifecycle).toBe("closed");
  });

  it("a change to the role's skills updates the job (the brief is rebuilt from the stored role)", async () => {
    const f = fakes();
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [] }) } });
    const out = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, mandatorySkill: "Zendesk macros for billing tickets" }], skipped: [] }) } });
    expect(out.rebriefed).toBe(1);
    expect(f.updates).toEqual(["job-1"]);
    expect(f.jobs.get("job-1").jd_text).toMatch(/Zendesk macros for billing tickets/);
  });

  it("one role failing does not stop the next", async () => {
    const f = fakes();
    let first = true;
    const orig = f.hire.createJob;
    f.hire.createJob = async (j) => { if (first) { first = false; throw new Error("db hiccup"); } return orig(j); };
    const out = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE, { ...ROLE, id: 5 }], skipped: [] }) } });
    expect(out).toMatchObject({ failed: 1, created: 1 });
  });
});


describe("the source failing never closes live roles", () => {
  it("a role that did not parse is not closed, and an empty listing closes nothing", async () => {
    const f = fakes();
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [] }) } });
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [], skipped: [{ id: 1000101, issue: "clientName: too short" }] }) } });
    expect(f.jobs.get("job-1").lifecycle).toBe("active");
    const out = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [], skipped: [] }) } });
    expect(f.jobs.get("job-1").lifecycle).toBe("active");
    expect(out.held).toMatch(/nothing was closed/);
  });
});


describe("a listing shorter than the source says closes nothing", () => {
  it("roles + skipped below the stated total: nothing is closed", async () => {
    const f = fakes();
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [], total: 1 }) } });
    const out = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, id: 777 }], skipped: [], total: 5 }) } });
    expect(f.jobs.get("job-1").lifecycle).toBe("active");
    expect(out.held).toMatch(/1 of 5 roles/);
  });
});


describe("closing needs a complete, distinct listing that states its total", () => {
  it("a listing with no total, or with repeated rows, closes nothing", async () => {
    const f = fakes();
    await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [ROLE], skipped: [], total: 1 }) } });
    const noTotal = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, id: 777 }], skipped: [] }) } });
    expect(noTotal.held).toMatch(/did not say/);
    const repeated = await syncRoles({ connection: CONN, deps: { ...f, listRoles: async () => ({ roles: [{ ...ROLE, id: 777 }, { ...ROLE, id: 777 }], skipped: [], total: 2 }) } });
    expect(repeated.held).toMatch(/1 of 2/);
    expect(f.jobs.get("job-1").lifecycle).toBe("active");
  });
});
