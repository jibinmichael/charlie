// lib/agents/agents.test.mjs — the agent engine: the runner's rules (off, not built, quiet hours, daily limit,
// overlap, failure recorded), drafts approved exactly once, and the lineup.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { configOf, inQuietHours, istDayStart, AGENTS, AGENT_IDS } from "./registry.mjs";
import { runAgent, approveDraft, rejectDraft } from "./engine.mjs";

/** A fake agents store with the same contract as lib/agents/store.mjs. */
function fakeStore(cfgOver = {}) {
  const runs = [], drafts = [];
  let n = 0;
  return {
    runs_: runs, drafts_: drafts,
    async config(id) { return { ...configOf(id, null), ...cfgOver, settings: { ...configOf(id, null).settings, ...(cfgOver.settings ?? {}) } }; },
    async usedToday() { return runs.reduce((a, r) => a + (r.counts?.sent || 0) + (r.counts?.drafted || 0), 0); },
    async startRun(r) { const id = `run-${++n}`; runs.push({ id, ...r, status: "running" }); return id; },
    async finishRun(id, r) { Object.assign(runs.find((x) => x.id === id), r); },
    async skippedRun(r) { const id = `run-${++n}`; runs.push({ id, ...r, status: "skipped" }); return id; },
    async addDraft(d) { if (drafts.some((x) => x.email === d.email && x.kind === d.kind && x.mandate === d.mandate && x.agent === d.agent)) return false; drafts.push({ id: `d-${drafts.length + 1}`, status: "pending", ...d }); return true; },
    async draft(id) { return drafts.find((d) => d.id === id) ?? null; },
    async decideDraft(id, { status, result }) { const d = drafts.find((x) => x.id === id && x.status === "pending"); if (!d) return false; Object.assign(d, { status, result }); return true; },
    async finishDraft(id, result) { Object.assign(drafts.find((x) => x.id === id), { status: result === "sent" ? "sent" : "failed", result }); },
  };
}

function deps({ sendStatus = "sent", store = fakeStore() } = {}) {
  const sent = [];
  return {
    sent, store,
    sendGuarded: async (a) => { sent.push(a); return { status: sendStatus }; },
    resend: {}, from: "Charlie <hi@x>", replyTo: "start@x",
    preflight: async () => {},
    validate: () => true,
    log: () => {},
  };
}

describe("the runner", () => {
  const wf = { outreach: async () => ({ counts: { sent: 1, failed: 0 }, items: [], needsReview: false }) };
  const NOON = Date.parse("2026-10-07T06:30:00Z"); // 12:00 India time

  it("off is off, quiet hours wait; a manual run records why it did nothing", async () => {
    const s = fakeStore({ mode: "off" });
    expect(await runAgent({ id: "outreach", trigger: "manual", now: NOON, store: s, workflows: wf, deps: {} })).toMatchObject({ status: "skipped", note: "this agent is off" });
    expect(s.runs_).toHaveLength(1);
    expect(await runAgent({ id: "outreach", trigger: "schedule", now: Date.parse("2026-10-07T17:00:00Z"), store: fakeStore(), workflows: wf, deps: {} })).toMatchObject({ status: "skipped", note: expect.stringMatching(/quiet hours/) });
  });

  it("the daily limit, a recorded failure, and never two runs at once", async () => {
    const s = fakeStore({ settings: { daily_cap: 1 } });
    expect((await runAgent({ id: "outreach", trigger: "schedule", now: NOON, store: s, workflows: wf, deps: {} })).status).toBe("ok");
    expect(await runAgent({ id: "outreach", trigger: "schedule", now: NOON, store: s, workflows: wf, deps: {} })).toMatchObject({ status: "skipped", note: expect.stringMatching(/limit of 1/) });
    const boom = { outreach: async () => { throw new Error("db down"); } };
    const s2 = fakeStore();
    expect(await runAgent({ id: "outreach", trigger: "schedule", now: NOON, store: s2, workflows: boom, deps: {} })).toMatchObject({ status: "failed" });
    expect(s2.runs_[0]).toMatchObject({ status: "failed", error: "db down" });
    let release;
    const slow = { outreach: () => new Promise((r) => { release = () => r({ counts: {}, items: [] }); }) };
    const first = runAgent({ id: "outreach", trigger: "schedule", now: NOON, store: fakeStore(), workflows: slow, deps: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(await runAgent({ id: "outreach", trigger: "schedule", now: NOON, store: fakeStore(), workflows: slow, deps: {} })).toMatchObject({ note: "the previous run is still going" });
    release();
    await first;
  });
});

describe("drafts", () => {
  it("approved exactly once, sent through the guard; a failed send ends failed, never sent; rejected stays unsent", async () => {
    const d = deps();
    await d.store.addDraft({ agent: "outreach", mandate: "m", email: "a@example.com", kind: "followup", subject: "Re: x", body_text: "Hi", send: { template: "role-intent", dedupeKey: "m:followup", html: "<p/>" } });
    expect(await approveDraft({ id: "d-1", by: "Priya", deps: d })).toMatchObject({ ok: true });
    expect(await approveDraft({ id: "d-1", by: "Priya", deps: d })).toMatchObject({ ok: false, reason: "this draft is already sent" });
    expect(d.sent).toHaveLength(1);
    const f = deps({ sendStatus: "suppressed" });
    await f.store.addDraft({ agent: "outreach", mandate: "m", email: "b@example.com", kind: "followup", subject: "s", body_text: "t", send: { template: "role-intent", dedupeKey: "k", html: "" } });
    await approveDraft({ id: "d-1", by: "J", deps: f });
    expect(f.store.drafts_[0]).toMatchObject({ status: "failed", result: "not sent: suppressed" });
    const r = deps();
    await r.store.addDraft({ agent: "outreach", mandate: "m", email: "c@example.com", kind: "followup", subject: "s", body_text: "t", send: { template: "role-intent", dedupeKey: "k", html: "" } });
    expect(await rejectDraft({ id: "d-1", by: "J", store: r.store })).toEqual({ ok: true });
    expect(r.sent).toHaveLength(0);
  });
});

describe("shared rules", () => {
  it("quiet hours wrap midnight in India time; the India day starts at 18:30 UTC", () => {
    expect(inQuietHours(Date.parse("2026-10-07T16:00:00Z"), 21, 9)).toBe(true); // 21:30 IST
    expect(inQuietHours(Date.parse("2026-10-07T02:00:00Z"), 21, 9)).toBe(true); // 07:30 IST
    expect(inQuietHours(Date.parse("2026-10-07T06:30:00Z"), 21, 9)).toBe(false); // 12:00 IST
    expect(istDayStart(Date.parse("2026-10-07T06:30:00Z"))).toBe("2026-10-06T18:30:00.000Z");
  });

  it("out of the box: one agent, Qualify & Submit; nobody claims to be built who is not", () => {
    expect(AGENT_IDS.map((id) => [AGENTS[id].name, AGENTS[id].built])).toEqual([["Qualify & Submit", true]]);
    expect(AGENT_IDS).toEqual(["outreach"]);
    for (const gone of ["followup", "qualifier", "rediscovery"]) {
      expect(AGENTS[gone]).toBeUndefined();
      expect(() => configOf(gone, null)).toThrow(/unknown agent/);
    }
    expect(configOf("outreach", null)).toMatchObject({ name: "Qualify & Submit", label: "White-label", mode: "auto", built: true, modes: ["off", "auto"] });
    // a stored mode the agent does not have falls back to its default
    expect(configOf("outreach", { mode: "draft" }).mode).toBe("auto");
    expect(configOf("outreach", { enabled: false, settings: { daily_cap: 5 } })).toMatchObject({ enabled: false, settings: { daily_cap: 5 } });
  });

  it("only lib/agents/store.mjs writes the agent tables", () => {
    const root = new URL("../../", import.meta.url);
    const files = [];
    for (const d of ["lib", "lib/agents", "server", "scripts"]) for (const f of readdirSync(new URL(`${d}/`, root))) if (/\.(mjs|ts)$/.test(f) && !/\.test\./.test(f)) files.push(`${d}/${f}`);
    const writers = files.filter((f) => /from\("hire_agent(s|_runs|_drafts)"\)[\s\S]{0,120}\.(insert|upsert|update|delete)\(/.test(readFileSync(new URL(f, root), "utf8")));
    expect(writers).toEqual(["lib/agents/store.mjs"]);
  });
});

describe("approving a draft re-checks it now (moved from the retired Sourcing & Outreach tests)", () => {
  const draftDeps = (recheck) => {
    const d = { id: "d1", status: "pending", email: "a@x.com", subject: "s", body_text: "t", send: { template: "role-intent", dedupeKey: "k", html: "<p/>" } };
    let sends = 0;
    return {
      get sends() { return sends; }, d,
      deps: { store: { draft: async () => d, decideDraft: async () => true, finishDraft: async () => {} }, sendGuarded: async () => { sends++; return { status: "sent" }; }, resend: {}, from: "Charlie <c@x.com>", replyTo: "r@x.com", preflight: async () => {}, validate: () => true, recheck },
    };
  };
  it("sends nothing when the re-check says no or throws, and the draft stays pending", async () => {
    const no = draftDeps(async () => ({ ok: false, reason: "they no longer agree to hear about other roles" }));
    expect(await approveDraft({ id: "d1", by: "t", deps: no.deps })).toEqual({ ok: false, reason: "they no longer agree to hear about other roles" });
    expect(no.sends).toBe(0);
    expect(no.d.status).toBe("pending");
    const boom = draftDeps(async () => { throw new Error("db down"); });
    expect((await approveDraft({ id: "d1", by: "t", deps: boom.deps })).reason).toMatch(/could not re-check.*db down/);
    expect(boom.sends).toBe(0);
    const yes = draftDeps(async () => ({ ok: true }));
    expect(await approveDraft({ id: "d1", by: "t", deps: yes.deps })).toEqual({ ok: true, reason: "sent" });
  });
});
