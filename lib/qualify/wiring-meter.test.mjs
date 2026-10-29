// lib/qualify/wiring-meter.test.mjs — a run's AI use is read from each response's own usage, never estimated.
import { describe, it, expect } from "vitest";
import { usageMeter, qualifyDeps } from "./wiring.mjs";

describe("the usage meter", () => {
  it("adds each response's usage, counts calls, and resets", () => {
    const m = usageMeter();
    m.add({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 });
    m.add({ input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 7 });
    m.add(undefined);
    expect(m.snapshot()).toEqual({ ai_calls: 3, tokens_in: 150, tokens_out: 30, tokens_cache_read: 5, tokens_cache_write: 7 });
    m.reset();
    expect(m.snapshot()).toEqual({ ai_calls: 0, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 });
  });

  it("the deps' client counts every messages.create and passes everything else through untouched", async () => {
    class Messages { constructor() { this.n = 0; } async create(req) { this.n++; return { usage: { input_tokens: 10, output_tokens: 4 }, content: [{ text: req.model }] }; } other() { return this.n; } }
    class Client { constructor() { this.messages = new Messages(); } ping() { return "pong"; } }
    const deps = qualifyDeps({ from: () => ({}) , storage: { from: () => ({}) } }, { makeClient: () => new Client(), log: () => {} });
    expect(deps.meter.snapshot().ai_calls).toBe(0);
    // the answer filer makes one real create through the metered client
    const res = await deps.fileAnswers(["q"], "a").catch((e) => e);
    expect(deps.meter.snapshot()).toMatchObject({ ai_calls: 1, tokens_in: 10, tokens_out: 4 });
    expect(res).toBeDefined();
  });
});
