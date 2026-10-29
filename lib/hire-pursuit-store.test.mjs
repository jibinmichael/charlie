// lib/hire-pursuit-store.test.mjs — one identity per person, and the pursuit tables.
// The database below is an in-memory fake whose two RPCs mirror hire_pursuit_create / hire_pursuit_apply
// (seq lock, one event per change, globally unique reply keys). The triggers need a real Postgres and are
// not covered here.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { identityKeys, resolvePerson } from "./hire-people.mjs";
import { pursuitStore, rowOf, pursuitOf, lifecycleJob } from "./hire-pursuit-store.mjs";
import { createPursuit, transition, ENGAGEMENT, CONSENT, SCREENING, HANDOFF, ASKS, SOURCES, RULES } from "./hire-lifecycle.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-10-05T09:00:00Z");
const JOB = { id: "job-a", client: "Acme", lifecycle: "active" };
const ASHA = { email: "asha@example.com", consent_pool: true, suppressed: false };

function fakeDb() {
  const t = { hire_people: [], hire_pursuits: [], hire_pursuit_keys: [], hire_pursuit_events: [] };
  let n = 0, tick = 0;
  const q = (table) => {
    let rows = null, filters = [], order = null, op = "select", payload = null, single = false, maybe = false, returning = false;
    const run = () => {
      try {
        if (op === "insert") {
          const row = { id: payload.id ?? `${table}-${++n}`, created_at: new Date(T0 + ++tick).toISOString(), ...payload };
          for (const k of ["linkedin_key", "email"]) if (row[k] && t[table].some((r) => r[k] === row[k])) return { data: null, error: { message: `duplicate ${k}` } };
          t[table].push(row);
          return { data: returning ? (single ? row : [row]) : null, error: null };
        }
        let out = t[table].filter((r) => filters.every(([k, v]) => r[k] === v));
        if (op === "update") { out.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
        if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? -1 : 1));
        out = structuredClone(out);
        if (single || maybe) return out.length > 1 ? { data: null, error: { message: "many rows" } } : { data: out[0] ?? null, error: single && !out.length ? { message: "no row" } : null };
        return { data: out, error: null };
      } catch (e) { return { data: null, error: { message: e.message } }; }
    };
    const b = {
      select() { if (op === "insert") returning = true; return b; },
      eq(k, v) { filters.push([k, v]); return b; },
      order(k) { order = k; return b; },
      insert(p) { op = "insert"; payload = p; return b; },
      update(p) { op = "update"; payload = p; return b; },
      single() { single = true; return b; },
      maybeSingle() { maybe = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  };
  const rpc = async (name, a) => {
    if (name === "hire_pursuit_create") {
      t.hire_pursuits.push({ ...structuredClone(a.p_row), seq: 0 });
      t.hire_pursuit_events.push({ pursuit_id: a.p_row.id, seq: 0, ...structuredClone(a.p_event), from_state: null, to_state: null, effects: [] });
      return { data: a.p_row.id, error: null };
    }
    if (name === "hire_pursuit_apply") {
      const row = t.hire_pursuits.find((r) => r.id === a.p_id && r.seq === a.p_expected_seq);
      if (!row) return { data: null, error: { message: `${a.p_id} moved since it was read (expected seq ${a.p_expected_seq})` } };
      if (a.p_new_keys.some((k) => t.hire_pursuit_keys.some((x) => x.key === k))) return { data: null, error: { message: "duplicate key" } };
      const keep = { id: row.id, job_id: row.job_id, person_id: row.person_id, employer: row.employer, source: row.source, source_at: row.source_at, discovery_run: row.discovery_run, outreach_type: row.outreach_type };
      Object.assign(row, structuredClone(a.p_row), keep, { seq: a.p_expected_seq + 1 }); // apply never moves the identity columns
      const { from, to, ...ev } = structuredClone(a.p_event);
      t.hire_pursuit_events.push({ pursuit_id: a.p_id, seq: a.p_expected_seq + 1, ...ev, from_state: from, to_state: to });
      for (const k of a.p_new_keys) t.hire_pursuit_keys.push({ key: k, pursuit_id: a.p_id, created_at: new Date(T0 + ++tick).toISOString() });
      return { data: a.p_expected_seq + 1, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${name}` } };
  };
  return { from: q, rpc, t };
}

const ctx = (assessment = { eligibility_status: "ELIGIBLE", disposition: "EVIDENCE_SUPPORTED", open: [], employer_review: "NONE" }) => ({ job: lifecycleJob(JOB), assessment, person: ASHA });
const ev = (type, at, extra = {}) => ({ type, actor: RULES[type].actors[0], at, ...extra });

describe("one identity per person", () => {
  it("normalises the keys: LinkedIn to its profile, email lower-cased, a non-address dropped", () => {
    expect(identityKeys({ linkedin_url: "https://www.LinkedIn.com/in/Asha-K/?trk=x", email: " Asha@Example.com " })).toEqual({ linkedin_key: "linkedin.com/in/asha-k", email: "asha@example.com" });
    expect(identityKeys({ email: "not an email" }).email).toBeNull();
  });

  it("two records with the same LinkedIn are one person, and the address one of them lacks is added", () => {
    const pool = { id: "p1", linkedin_key: "linkedin.com/in/asha-k", email: null };
    expect(resolvePerson(identityKeys({ email: "asha@example.com", linkedin_url: "linkedin.com/in/asha-k" }), [pool])).toEqual({ action: "existing", id: "p1", fill: { email: "asha@example.com" } });
  });

  it("keys that point at two different people, or disagree, are a conflict for a person to settle, never merged", () => {
    const a = { id: "p1", linkedin_key: "linkedin.com/in/asha-k" }, b = { id: "p2", email: "asha@example.com" };
    expect(resolvePerson(identityKeys({ linkedin_url: "linkedin.com/in/asha-k", email: "asha@example.com" }), [a, b])).toMatchObject({ action: "conflict", ids: ["p1", "p2"] });
    const c = { id: "p3", email: "asha@example.com", linkedin_key: "linkedin.com/in/someone-else" };
    expect(resolvePerson(identityKeys({ linkedin_url: "linkedin.com/in/asha-k", email: "asha@example.com" }), [c])).toMatchObject({ action: "conflict", reason: expect.stringMatching(/different linkedin_key/) });
    expect(resolvePerson(identityKeys({}), [])).toMatchObject({ action: "conflict", reason: "no identity key at all" });
  });

  it("through the store: new, then the same person found again from the other source", async () => {
    const s = pursuitStore(fakeDb());
    const first = await s.person({ email: "asha@example.com", full_name: "Asha K" });
    const again = await s.person({ linkedin_url: "linkedin.com/in/asha-k", email: "ASHA@example.com" });
    expect(first.action).toBe("new");
    expect(again).toEqual({ action: "existing", id: first.id });
  });
});

describe("the pursuit tables", () => {
  it("a job with no client cannot have pursuits: the employer must be named", () => {
    expect(() => lifecycleJob({ id: "j", client: "  " })).toThrow(/name the employer/);
    expect(lifecycleJob(JOB)).toEqual({ id: "job-a", employer_id: "Acme", company: "Acme", lifecycle: "active", cold_outreach: false });
  });

  it("row and history round-trip to the same pursuit the model made", () => {
    const p = createPursuit({ id: "pu-1", job: lifecycleJob(JOB), person: { id: "person-1" }, source: "sourced", source_at: T0 - H, discovery_run: "run-1", open_gaps: ["g"], at: T0 });
    const row = { ...rowOf(p), seq: 0 };
    const events = [{ seq: 0, type: "pursuit.created", actor: "charlie", at: new Date(T0).toISOString(), ref: "run-1", version: p.version }];
    const back = pursuitOf(row, events, []);
    const { seq, ...rest } = back;
    expect(seq).toBe(0);
    expect(rest).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it("a history that does not account for the row is refused", () => {
    const p = createPursuit({ id: "pu-1", job: lifecycleJob(JOB), person: { id: "x" }, source: "pool", open_gaps: [], at: T0 });
    expect(() => pursuitOf({ ...rowOf(p), seq: 2 }, [{ seq: 0, type: "pursuit.created", actor: "charlie", at: new Date(T0).toISOString() }], [])).toThrow(/does not explain the row/);
  });

  it("applying events stores exactly what the model decides, one event per change, keys recorded", async () => {
    const db = fakeDb();
    const s = pursuitStore(db);
    const who = await s.person({ email: ASHA.email });
    let p = await s.create({ id: "pu-1", job: JOB, person_id: who.id, person: ASHA, source: "pool", open_gaps: [], at: T0 });
    let model = createPursuit({ id: "pu-1", job: lifecycleJob(JOB), person: { id: who.id }, source: "pool", open_gaps: [], at: T0 });
    const c = ctx();
    const steps = [
      ev("outreach.sent", T0 + H, { ask_id: "k1", sent_to: ASHA.email }),
      ev("candidate.interested", T0 + 2 * H, { ask_id: "k1", ref: "m1" }),
      ev("disclosure.requested", T0 + 3 * H, { ask_id: "k3", job_id: "job-a", employer_id: "Acme", company_shown: "Acme", wording_version: "dc-v1" }),
      ev("disclosure.granted", T0 + 4 * H, { ask_id: "k3", ref: "m3" }),
      ev("handoff.sent", T0 + 5 * H, { ask_id: "kh" }),
    ];
    for (const e of steps) {
      const r = await s.apply("pu-1", e, c);
      expect(r.ok, `${e.type}: ${r.reason}`).toBe(true);
      model = transition(model, e, c).pursuit;
      p = r.pursuit;
      expect(rowOf(p)).toEqual(rowOf(model));
    }
    expect(db.t.hire_pursuit_events.map((x) => x.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(db.t.hire_pursuit_keys.map((x) => x.key)).toEqual(["k1", "k3", "kh"]);
    expect(db.t.hire_pursuits[0]).toMatchObject({ handoff: "HANDED_OFF", waiting_for: "EMPLOYER_FEEDBACK", due_at: new Date(T0 + 5 * H + 7 * 24 * H).toISOString(), seq: 5 });
    expect(p.history.at(-1)).toMatchObject({ type: "handoff.sent", actor: "operator", from: { handoff: "NOT_HANDED_OFF" }, to: { handoff: "HANDED_OFF" } });
  });

  it("a refused event writes nothing at all", async () => {
    const db = fakeDb();
    const s = pursuitStore(db);
    await s.create({ id: "pu-1", job: JOB, person_id: "person-1", person: ASHA, source: "pool", open_gaps: [], at: T0 });
    const before = JSON.stringify(db.t);
    const r = await s.apply("pu-1", ev("handoff.sent", T0 + H, { ask_id: "kh" }), ctx());
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/not employer-ready/) });
    expect(JSON.stringify(db.t)).toBe(before);
  });

  it("two writers racing on the same pursuit: the second is refused, nothing is recorded twice", async () => {
    const db = fakeDb();
    const s = pursuitStore(db);
    await s.create({ id: "pu-1", job: JOB, person_id: "person-1", person: ASHA, source: "pool", open_gaps: [], at: T0 });
    const stale = await s.load("pu-1");
    await s.apply("pu-1", ev("outreach.sent", T0 + H, { ask_id: "k1", sent_to: ASHA.email }), ctx());
    const r = transition(stale, ev("outreach.sent", T0 + H, { ask_id: "k2", sent_to: ASHA.email }), ctx());
    const res = await db.rpc("hire_pursuit_apply", { p_id: "pu-1", p_expected_seq: stale.seq, p_row: rowOf(r.pursuit), p_event: { type: "outreach.sent" }, p_new_keys: ["k2"] });
    expect(res.error.message).toMatch(/moved since it was read/);
    expect(db.t.hire_pursuit_events).toHaveLength(2);
    expect(db.t.hire_pursuit_keys.map((k) => k.key)).toEqual(["k1"]);
  });

  it("a reply key belongs to exactly one pursuit across every job", async () => {
    const db = fakeDb();
    const s = pursuitStore(db);
    for (const id of ["pu-a", "pu-b"]) await s.create({ id, job: { ...JOB, id: id === "pu-a" ? "job-a" : "job-b" }, person_id: `person-${id}`, person: ASHA, source: "pool", open_gaps: [], at: T0 });
    await s.apply("pu-a", ev("outreach.sent", T0 + H, { ask_id: "same", sent_to: ASHA.email }), ctx());
    const cb = { ...ctx(), job: lifecycleJob({ ...JOB, id: "job-b" }) };
    await expect(s.apply("pu-b", ev("outreach.sent", T0 + H, { ask_id: "same", sent_to: ASHA.email }), cb)).rejects.toThrow(/duplicate key/);
  });
});

describe("the migration agrees with the code", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261005130000_hire_pursuits.sql", import.meta.url), "utf8");
  const list = (re) => { const m = sql.match(re); expect(m, String(re)).not.toBeNull(); return [...m[1].matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]); };

  it("every CHECK list equals the lifecycle's own states", () => {
    expect(list(/check \(engagement in \(([^)]*)\)\)/)).toEqual(ENGAGEMENT);
    expect(list(/check \(screening_consent->>'state' in \(([^)]*)\)\)/)).toEqual(CONSENT);
    expect(list(/check \(disclosure->>'state' in \(([^)]*)\)\)/)).toEqual(CONSENT);
    expect(list(/check \(screening->>'state' in \(([^)]*)\)\)/)).toEqual(SCREENING);
    expect(list(/check \(handoff in \(([^)]*)\)\)/)).toEqual(HANDOFF);
    expect(list(/check \(waiting_for in \(([^)]*)\)\)/)).toEqual(Object.keys(ASKS));
    expect(list(/check \(source in \(([^)]*)\)\)/)).toEqual(SOURCES);
    // the actor list was widened by a later migration (agent); the
    // latest definition of the constraint is the one the database holds
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const actorDefs = readdirSync(dir).sort().filter((f) => /hire_pursuit_events_actor_check/.test(readFileSync(new URL(f, dir), "utf8")));
    const actorSql = actorDefs.length ? readFileSync(new URL(actorDefs.at(-1), dir), "utf8").replace(/--.*$/gm, "") : sql;
    const actors = [...(actorSql.match(/check \(actor in \(([^)]*)\)\)/)?.[1] ?? "").matchAll(/'([A-Za-z_]+)'/g)].map((x) => x[1]);
    expect(new Set(actors)).toEqual(new Set(Object.values(RULES).flatMap((r) => r.actors).concat("charlie")));
  });

  it("apply writes only the state columns, never who, which job, which employer or which source", () => {
    const body = sql.slice(sql.indexOf("function hire_pursuit_apply"), sql.indexOf("alter table hire_people enable"));
    for (const col of ["job_id =", "person_id =", "employer =", "source =", "outreach_type ="]) expect(body).not.toContain(col);
    expect(body).toMatch(/where id = p_id and seq = p_expected_seq/);
  });

  it("the database itself refuses a handoff without this job's and this employer's consent, and edits to history", () => {
    expect(sql).toMatch(/new\.handoff in \('HANDED_OFF', 'EMPLOYER_PROGRESSING'\)[\s\S]*disclosure->>'job_id' is distinct from new\.job_id::text[\s\S]*disclosure->>'employer_id' is distinct from new\.employer/);
    expect(sql).toMatch(/before update or delete on hire_pursuit_events/);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/hire_assessments|talent_pool|alter table ci_/); // code, not the header that names them
  });

  it("the live definition of hire_pursuit_apply refuses with a plain error, never 40001 (which the API retries until it times out)", () => {
    const dir = new URL("../supabase/migrations/", import.meta.url);
    const defs = readdirSync(dir).sort().filter((f) => readFileSync(new URL(f, dir), "utf8").includes("function hire_pursuit_apply"));
    const latest = readFileSync(new URL(defs.at(-1), dir), "utf8").replace(/--.*$/gm, ""); // the SQL, not the comments
    expect(latest).toMatch(/moved since it was read/);
    expect(latest).not.toMatch(/40001/);
  });

  it("only lib/hire-pursuit-store.mjs writes the pursuit tables", () => {
    const files = [];
    for (const d of ["lib", "server", "scripts"]) for (const f of readdirSync(new URL(`../${d}/`, import.meta.url))) if (/\.(mjs|ts)$/.test(f) && !/\.test\./.test(f)) files.push(`${d}/${f}`);
    const writers = files.filter((f) => /from\("hire_(people|pursuits|pursuit_keys|pursuit_events)"\)[\s\S]{0,80}\.(insert|upsert|update|delete)\(|rpc\("hire_pursuit_/.test(readFileSync(new URL(`../${f}`, import.meta.url), "utf8")));
    expect(writers).toEqual(["lib/hire-pursuit-store.mjs"]);
  });
});
