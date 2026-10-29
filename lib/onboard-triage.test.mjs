// lib/onboard-triage.test.mjs — the cheap read in front of the expensive one.
//
// The asymmetry that shapes every case below: refusing a real job seeker is UNRECOVERABLE (they wrote
// once and will not write again), while building a dossier on spam costs about fifty cents. So every
// failure mode must land on "seeker", and these tests exist mainly to prove that it does.
import { describe, it, expect, afterEach } from "vitest";
import { triageInbound, triageMode } from "./onboard-triage.mjs";

const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const stub = (impl) => ({ messages: { create: impl } });

describe("triageMode", () => {
  afterEach(() => { delete process.env.ONBOARD_TRIAGE; });
  it("defaults to shadow — a gate that can refuse a person is watched before it acts", () => {
    expect(triageMode()).toBe("shadow");
  });
  it("accepts enforce and off, and treats anything else as shadow", () => {
    process.env.ONBOARD_TRIAGE = "enforce"; expect(triageMode()).toBe("enforce");
    process.env.ONBOARD_TRIAGE = "off"; expect(triageMode()).toBe("off");
    process.env.ONBOARD_TRIAGE = "banana"; expect(triageMode()).toBe("shadow");
  });
});

describe("triageInbound — reads the verdict when the model behaves", () => {
  afterEach(() => { delete process.env.ONBOARD_TRIAGE; });
  it("passes a seeker through", async () => {
    const r = await triageInbound("I am a designer looking for work", { client: stub(async () => reply({ verdict: "seeker", why: "ok" })) });
    expect(r.verdict).toBe("seeker");
  });
  it("reports not_seeking for a sales pitch", async () => {
    const r = await triageInbound("buy my SEO service", { client: stub(async () => reply({ verdict: "not_seeking", why: "sales" })) });
    expect(r.verdict).toBe("not_seeking");
  });
  it("reads a fenced JSON reply", async () => {
    const c = stub(async () => ({ content: [{ type: "text", text: '```json\n{"verdict":"not_seeking","why":"sales"}\n```' }] }));
    expect((await triageInbound("x", { client: c })).verdict).toBe("not_seeking");
  });
});

describe("triageInbound — FAILS OPEN, every way it can break", () => {
  afterEach(() => { delete process.env.ONBOARD_TRIAGE; });
  const openCases = {
    "the API throws": stub(async () => { throw new Error("503 overloaded"); }),
    "the reply is not JSON": stub(async () => ({ content: [{ type: "text", text: "I think this is spam" }] })),
    "the verdict is unknown": stub(async () => reply({ verdict: "definitely_spam", why: "?" })),
    "the verdict is missing": stub(async () => reply({ why: "no verdict" })),
    "the response is empty": stub(async () => ({ content: [] })),
  };
  for (const [label, client] of Object.entries(openCases)) {
    it(`returns seeker when ${label}`, async () => {
      const r = await triageInbound("some text", { client, log: () => {} });
      expect(r.verdict).toBe("seeker");
      expect(r.skipped).toBe(true); // marked, so a silent failure is still visible in the shape
    });
  }
  it("returns seeker on empty input without calling the model at all", async () => {
    let called = false;
    const r = await triageInbound("   ", { client: stub(async () => { called = true; return reply({ verdict: "not_seeking", why: "x" }); }) });
    expect(r.verdict).toBe("seeker");
    expect(called).toBe(false);
  });
  it("OFF spends nothing and refuses nobody", async () => {
    process.env.ONBOARD_TRIAGE = "off";
    let called = false;
    const r = await triageInbound("buy my SEO service", { client: stub(async () => { called = true; return reply({ verdict: "not_seeking", why: "x" }); }) });
    expect(r.verdict).toBe("seeker");
    expect(called).toBe(false); // no call = no cost
  });
});
