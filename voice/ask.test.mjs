// voice/ask.test.mjs — a question becomes a rule or a refusal; never a guess, never a row.
import { describe, it, expect } from "vitest";
import { askBoard } from "./ask.mjs";
import { VV_ASK_SYSTEM } from "../prompts/vv-ask.mjs";

const clientAnswering = (out) => ({
  calls: [],
  messages: { create: async (req) => { clientAnswering.last = req; return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] }; } },
});

describe("askBoard", () => {
  it("returns a validated rule, and the request carries the question and the catalogue but no rows", async () => {
    const client = clientAnswering({ filters: [{ field: "role_family", op: "eq", value: "sales" }, { field: "total_years", op: "gte", value: 3 }], sort: { field: "applied_at", dir: "desc" }, columns: null, aggregate: null, explanation: "Sales people with 3 or more years, newest first.", refused: null });
    const r = await askBoard({ client, model: "stub", question: "sales people with 3+ years, newest first", log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.query.filters).toHaveLength(2);
    expect(r.query.sort).toEqual({ field: "applied_at", dir: "desc" });
    expect(clientAnswering.last.system).toBe(VV_ASK_SYSTEM);
    expect(JSON.stringify(clientAnswering.last.messages)).toContain("sales people with 3+ years");
    expect(clientAnswering.last.system).toContain("role_family (enum");
  });
  it("refuses an answer that names a field the table does not have, rather than applying the rest", async () => {
    const client = clientAnswering({ filters: [{ field: "iq", op: "gte", value: 120 }], sort: null, columns: null, aggregate: null, explanation: "", refused: null });
    const r = await askBoard({ client, model: "stub", question: "smart people", log: () => {} });
    expect(r).toMatchObject({ ok: false, query: null });
    expect(r.refused).toMatch(/could not be turned into a rule/);
  });
  it("passes the model's own refusal through in its words", async () => {
    const client = clientAnswering({ filters: [], sort: null, columns: null, aggregate: null, explanation: "", refused: "The table holds no interview scores." });
    const r = await askBoard({ client, model: "stub", question: "who did best in interviews", log: () => {} });
    expect(r).toMatchObject({ ok: false, refused: "The table holds no interview scores." });
  });
  it("refuses when nothing is configured or the answer is not JSON, with no exception", async () => {
    expect((await askBoard({ client: clientAnswering("nope"), model: "", question: "x", log: () => {} })).ok).toBe(false);
    expect((await askBoard({ client: clientAnswering("not json"), model: "stub", question: "x", log: () => {} })).refused).toMatch(/rule over the columns/);
  });
});
