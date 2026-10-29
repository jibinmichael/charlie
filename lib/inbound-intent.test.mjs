// inbound-intent.test.mjs — the default for an inbound message is NOT a write.
//
// Treating every unmatched message as an instruction to rewrite the person's profile files a consent
// grant as a preference change, a disputed rejection as a preference change, and answers Charlie's
// own question with a different question.
//
// The property under test is one predicate: nothing writes unless the message was clearly an
// instruction, and every way of failing lands on a human. The model is stubbed; these assert OUR
// logic, not Anthropic's output.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor() { this.messages = { create }; } } }));

const { classifyInbound, mayWritePreferences } = await import("./inbound-intent.mjs");

const reply = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const run = (o) => { create.mockResolvedValueOnce(reply(o)); return classifyInbound({ subject: "s", body: "some words" }); };

beforeEach(() => { create.mockReset(); process.env.ANTHROPIC_API_KEY = "sk-ant-test"; });

describe("only a confident instruction may write", () => {
  it("allows a high-confidence preference change", async () => {
    expect(mayWritePreferences(await run({ intent: "preference_change", confidence: "high", why: "w", quote: "q" }))).toBe(true);
  });

  it("refuses a LOW-confidence preference change", async () => {
    // "Could be read another way" is exactly when a write is most likely to be wrong about somebody.
    expect(mayWritePreferences(await run({ intent: "preference_change", confidence: "low", why: "w", quote: "" }))).toBe(false);
  });

  it("refuses every other intent, including the valuable ones", async () => {
    for (const intent of ["consent_grant", "dispute", "status_update", "question", "answer", "off_topic", "other"]) {
      expect(mayWritePreferences(await run({ intent, confidence: "high", why: "w", quote: "q" }))).toBe(false);
    }
  });
});

describe("every failure lands on a human, never on a write", () => {
  const cannotWrite = (r) => { expect(r.intent).toBe("other"); expect(mayWritePreferences(r)).toBe(false); };

  it("unparseable JSON", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "sorry, I cannot" }] });
    cannotWrite(await classifyInbound({ body: "hi" }));
  });

  it("a thrown API error", async () => {
    create.mockRejectedValueOnce(new Error("503"));
    cannotWrite(await classifyInbound({ body: "hi", log: () => {} }));
  });

  it("an empty message", async () => cannotWrite(await classifyInbound({ body: "   " })));

  it("a missing API key, which must not mean 'nothing to see here'", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    cannotWrite(await classifyInbound({ body: "actually make it remote only" }));
  });

  it("an invented intent label degrades to other rather than failing the parse", async () => {
    cannotWrite(await run({ intent: "definitely_write_this", confidence: "high", why: "w", quote: "q" }));
  });

  it("a missing confidence field is treated as low", async () => {
    const r = await run({ intent: "preference_change", why: "w", quote: "q" });
    expect(r.confidence).toBe("low");
    expect(mayWritePreferences(r)).toBe(false);
  });
});

describe("the handler is wired to it", () => {
  const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");

  it("classifies BEFORE the preference writer", () => {
    expect(SRC.indexOf("classifyInbound({")).toBeLessThan(SRC.indexOf("applyEmailChange(from"));
  });

  it("returns without writing when the message is not an instruction", () => {
    const block = SRC.slice(SRC.indexOf("classifyInbound({"), SRC.indexOf("applyEmailChange(from"));
    expect(block).toContain("if (!mayWritePreferences(intent))");
    expect(block).toContain("return;");
    expect(block).not.toContain("applyEmailChange(");
  });

  it("tells a person, and marks the two that need acting on today", () => {
    const block = SRC.slice(SRC.indexOf("classifyInbound({"), SRC.indexOf("applyEmailChange(from"));
    expect(block).toMatch(/ALERT_EMAIL|ALERT_TO\(\)/); // forwarded to the operator
    expect(block).toContain('"consent_grant"');
    expect(block).toContain('"dispute"');
  });

  it("keeps the guards that came before it", () => {
    // The classifier replaces the DEFAULT, not the specific routes. Each of these handles a case the
    // classifier must not swallow, and none of them should be unreachable.
    for (const g of ["openAskFor(from", "looksLikeQuestion(ownWords)", "renderRepresentAsk", "renderPaused"]) {
      expect(SRC).toContain(g);
    }
    expect(SRC.indexOf("openAskFor(from")).toBeLessThan(SRC.indexOf("classifyInbound({"));
    expect(SRC.indexOf("looksLikeQuestion(ownWords)")).toBeLessThan(SRC.indexOf("classifyInbound({"));
  });
});

describe("the prompt is code", () => {
  const P = readFileSync(new URL("../prompts/inbound-intent.mjs", import.meta.url), "utf8");

  it("carries a header saying what it is", () => {
    expect(P).toMatch(/^\/\/ prompts\/inbound-intent\.mjs — /);
  });

  it("tells the model that admitting uncertainty is free and guessing is not", () => {
    expect(P).toContain("PREFER \"other\" OVER A GUESS");
  });

  it("is not written inline in the caller", () => {
    const SRC = readFileSync(new URL("../server/charlie-remote.ts", import.meta.url), "utf8");
    expect(SRC).not.toContain("You read one email a person sent");
  });
});
