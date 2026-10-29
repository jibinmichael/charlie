// lib/edge-match.test.mjs — the "Rare find" send-time signal (Edge Engine, dark).
//
// The gate is a model judgement that fails closed. These tests inject a fake client — no network, no
// key, no cost — and guard the properties that actually matter:
//
//   1. the CHEAP GATES short-circuit BEFORE the model (flag off / no edge / not high / empty strong_in /
//      empty job). That is both the cost story and the dark-switch guarantee: a person with no edge must
//      never cost an API call, and a flipped-off flag must never light the label.
//   2. FAIL CLOSED on every unhappy path — model throws, unreadable text, schema drift, a hedge — is NOT
//      a rare find. Uncertainty must never earn the loud claim.
//   3. only an explicit affirmative turns it on.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { edgeHit, edgeEligible, rareFindSubject, RARE_FIND_LABEL } from "./edge-match.mjs";

const EDGE = {
  combo: "architecture degree + UX design for indoor navigation",
  strong_in: ["indoor maps / wayfinding product design", "venue navigation tools"],
  generic_in: ["general enterprise SaaS product design"],
  confidence: "high",
};
const dossierWith = (edge) => ({ headline: "product designer", edge });
const wayfindingJob = { title: "Product Designer, Indoor Navigation", company: "Waypost Maps", description: "Design indoor maps and turn-by-turn wayfinding for airports, malls and transit hubs." };

// An Anthropic-shaped fake. `reply` is the raw text the model "returns".
const fakeClient = (reply) => ({ messages: { create: vi.fn(async () => ({ content: [{ type: "text", text: reply }] })) } });
const throwingClient = () => ({ messages: { create: vi.fn(async () => { throw new Error("upstream 529"); }) } });

const ENV = process.env.EDGE_ENGINE;
beforeEach(() => { process.env.EDGE_ENGINE = "on"; });
afterEach(() => { if (ENV === undefined) delete process.env.EDGE_ENGINE; else process.env.EDGE_ENGINE = ENV; });

describe("edgeEligible — the cheap gates that run BEFORE any model call", () => {
  it("passes for a high-confidence edge on a real job", () => {
    expect(edgeEligible(dossierWith(EDGE), wayfindingJob)).toBe(true);
  });

  it("dark switch: EDGE_ENGINE off is never eligible, even on a perfect edge", () => {
    delete process.env.EDGE_ENGINE;
    expect(edgeEligible(dossierWith(EDGE), wayfindingJob)).toBe(false);
  });

  it("no edge / null edge → not eligible", () => {
    expect(edgeEligible({ headline: "x" }, wayfindingJob)).toBe(false);
    expect(edgeEligible(dossierWith(null), wayfindingJob)).toBe(false);
  });

  it("a non-high-confidence edge does not earn the badge", () => {
    expect(edgeEligible(dossierWith({ ...EDGE, confidence: "medium" }), wayfindingJob)).toBe(false);
    expect(edgeEligible(dossierWith({ ...EDGE, confidence: "low" }), wayfindingJob)).toBe(false);
  });

  it("empty strong_in → not eligible", () => {
    expect(edgeEligible(dossierWith({ ...EDGE, strong_in: [] }), wayfindingJob)).toBe(false);
  });

  it("never throws on missing job/dossier", () => {
    expect(edgeEligible(null, null)).toBe(false);
    expect(edgeEligible(dossierWith(EDGE), {})).toBe(false);
  });
});

describe("edgeHit — the model is only consulted once the cheap gates pass (the cost + dark guarantee)", () => {
  it("does NOT call the model when the flag is off", async () => {
    delete process.env.EDGE_ENGINE;
    const c = fakeClient('{"rare_fit":true}');
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: c })).toBe(false);
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("does NOT call the model without a high-confidence edge (so the majority of users cost nothing)", async () => {
    const c = fakeClient('{"rare_fit":true}');
    expect(await edgeHit({ headline: "x" }, wayfindingJob, { client: c })).toBe(false);
    expect(await edgeHit(dossierWith({ ...EDGE, confidence: "medium" }), wayfindingJob, { client: c })).toBe(false);
    expect(c.messages.create).not.toHaveBeenCalled();
  });
});

describe("edgeHit — the verdict", () => {
  it("an explicit affirmative is a rare find", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('{"rare_fit":true,"reason":"indoor wayfinding design; both halves do work"}') })).toBe(true);
  });

  it("an explicit false is not", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('{"rare_fit":false,"reason":"shares vocabulary only"}') })).toBe(false);
  });

  it("tolerates fenced JSON (models add backticks)", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('```json\n{"rare_fit":true}\n```') })).toBe(true);
  });

  it("accepts the string form of true — drift reaches the normalizer, not the parser", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('{"rare_fit":"true"}') })).toBe(true);
  });

  it("sends the VERIFIED edge + the role, and nothing else about the person", async () => {
    const c = fakeClient('{"rare_fit":false}');
    await edgeHit({ ...dossierWith(EDGE), name: "Priya", proof_points: ["a private proof"] }, wayfindingJob, { client: c });
    const sent = JSON.parse(c.messages.create.mock.calls[0][0].messages[0].content);
    expect(sent.edge.combo).toBe(EDGE.combo);
    expect(sent.role.title).toBe(wayfindingJob.title);
    // It judges the ROLE against the DOMAIN; it has no business seeing the rest of the dossier.
    expect(JSON.stringify(sent)).not.toMatch(/private proof|Priya/);
  });
});

describe("edgeHit — FAILS CLOSED (uncertainty never earns 'rare')", () => {
  it("a model error is not a rare find (the role still sends, as a plain Best match)", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: throwingClient() })).toBe(false);
  });

  it("unreadable output is not a rare find", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient("sure, I think so!") })).toBe(false);
  });

  it("a hedge is not a rare find — only an explicit affirmative counts", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('{"rare_fit":"maybe"}') })).toBe(false);
  });

  it("a missing verdict field is not a rare find", async () => {
    expect(await edgeHit(dossierWith(EDGE), wayfindingJob, { client: fakeClient('{"reason":"forgot the verdict"}') })).toBe(false);
  });

  it("never throws, whatever the model returns", async () => {
    const weird = { messages: { create: async () => ({ content: null }) } };
    await expect(edgeHit(dossierWith(EDGE), wayfindingJob, { client: weird })).resolves.toBe(false);
  });
});

describe("rareFindSubject + label", () => {
  it("names the real role and company, no em dash", () => {
    const s = rareFindSubject({ roleTitle: "Product Designer", company: "MedForm" });
    expect(s).toContain("Product Designer");
    expect(s).toContain("MedForm");
    expect(s).not.toContain("—");
  });
  it("degrades gracefully without a company", () => {
    expect(rareFindSubject({ roleTitle: "Product Designer" })).toBe("A rare fit for your background: Product Designer");
  });
  it("the label matches the existing Title-case badge set", () => {
    expect(RARE_FIND_LABEL).toBe("Rare find");
  });
});
