// lib/agents/ai-use.test.mjs — a run's AI use reaches its row (also when it fails), and the success metric sums every
// measured run, never a guess and never a run that did not measure.
import { describe, it, expect, vi, afterEach } from "vitest";
import { sumAiUse } from "./store.mjs";
import { runAgent } from "./engine.mjs";
import { WORKFLOWS } from "../../server/agents.ts";
import { configOf } from "./registry.mjs";
import { qualifyDeps, usageMeter } from "../qualify/wiring.mjs";

afterEach(() => vi.unstubAllEnvs());

const fakeStore = () => {
  const finished = [];
  return {
    finished,
    async config(id) { return configOf(id, { id, enabled: true, mode: "shadow", settings: { quiet_from: 0, quiet_to: 0 } }); },
    async runs() { return []; },
    async usedToday() { return 0; },
    async startRun() { return "run-1"; },
    async finishRun(id, p) { finished.push(p); },
  };
};
const meterAt = (usage) => { const m = usageMeter(); return { ...m, reset() { m.reset(); m.add(usage); } }; };
const qualify = (meter, connections) => ({ meter, cstore: { connections, openEmails: async () => [] }, hire: {}, adapters: {}, log: () => {} });

describe("a Qualify & Submit run's AI use", () => {
  it("lands in the run's counts", async () => {
    const store = fakeStore();
    const out = await runAgent({ id: "outreach", trigger: "manual", now: Date.parse("2026-10-06T06:30:00Z"), store, workflows: WORKFLOWS, deps: { qualify: qualify(meterAt({ input_tokens: 120, output_tokens: 30 }), async () => []) }, log: () => {} });
    expect(out.status).not.toBe("failed");
    expect(store.finished[0].counts).toMatchObject({ ai_calls: 1, tokens_in: 120, tokens_out: 30 });
  });

  it("a run that fails keeps what it spent", async () => {
    const store = fakeStore();
    const out = await runAgent({ id: "outreach", trigger: "manual", now: Date.parse("2026-10-06T06:30:00Z"), store, workflows: WORKFLOWS, deps: { qualify: qualify(meterAt({ input_tokens: 7, output_tokens: 3 }), async () => { throw new Error("db down"); }) }, log: () => {} });
    expect(out.status).toBe("failed");
    expect(store.finished[0]).toMatchObject({ status: "failed", counts: { ai_calls: 1, tokens_in: 7, tokens_out: 3 } });
  });

  it("the note's grounding check is metered too, not a fresh unmetered client", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const note = "They wrote that they ran the sales team for the north region and built the partner programme from nothing, and they say they handled every renewal with the largest clients themselves.";
    let call = 0;
    const client = { messages: { async create() { call++; return { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: call === 1 ? JSON.stringify({ justification: note, evidence_ids: ["q1"] }) : JSON.stringify({ ok: true, severity: "none", violations: [] }) }] }; } } };
    const deps = qualifyDeps({ from: () => ({}), storage: { from: () => ({}) } }, { makeClient: () => client, log: () => {} });
    await deps.writeJustification({ roleTitle: "AE", firstName: "Asha", items: [{ requirement: "Sales", quotes: [{ id: "q1", quote: note }] }] });
    expect(deps.meter.snapshot().ai_calls).toBe(2);
  });
});

describe("the success metric's sums", () => {
  it("every measured run counts; a run before metering is left out, never read as zero", () => {
    expect(sumAiUse([
      { started_at: "2026-10-05T00:00:00.000Z", counts: { submitted: 4 } },
      { started_at: "2026-10-07T00:00:00.000Z", counts: { ai_calls: 2, tokens_in: 100, tokens_out: 20, tokens_cache_read: 5, tokens_cache_write: 1, submitted: 1 } },
      { started_at: "2026-10-06T00:00:00.000Z", counts: { ai_calls: 0, submitted: 0 } },
    ])).toEqual({ runs: 2, since: "2026-10-06T00:00:00.000Z", ai_calls: 2, tokens: 126, submitted: 1 });
    expect(sumAiUse([])).toEqual({ runs: 0, since: null, ai_calls: 0, tokens: 0, submitted: 0 });
  });
});
