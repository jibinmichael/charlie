// send-rule.test.mjs — the proportional D1 rule + the level gate. Fixtures are eight representative
// (title, self-described preferences, satisfied/total) cases.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { sendDecision, levelBand, claimedBand, levelContradiction, D1_RATIO } from "./send-rule.mjs";

const sat = (req, s = "direct") => ({ req, gating: true, kind: "capability", status: "met", evidence_strength: s, evidence: `cited at Acme: ${req}` });
const near = (req) => ({ req, gating: true, kind: "capability", status: "partial", evidence_strength: "adjacent", evidence: "something nearby" });
const silent = (req, tool = false) => ({ req, gating: true, kind: "capability", status: "unknown", evidence_strength: null, evidence: null, tool });
const dos = (seniority, role) => ({ preferences: { seniority, role } });
const reqs = (n, k) => [...Array(k).fill(0).map((_, i) => sat(`ok${i}`)), ...Array(n - k).fill(0).map((_, i) => near(`miss${i}`))];

// Eight representative cases; exactly one is a level contradiction.
const EIGHT = [
  { who: "case1", title: "Data Analyst - Reporting", d: dos("trainee", "Power BI Analyst or reporting role"), sat: 5, tot: 7, keep: true },
  { who: "case2", title: "Head of Clinical Operations", d: dos("Executive / head of operations level", "Chief Operating Officer, VP Operations, Head of Clinical Ops"), sat: 4, tot: 5, keep: true },
  { who: "case3", title: "Mechanical Design Engineer", d: dos("senior", "senior mechanical design engineer"), sat: 4, tot: 5, keep: true },
  { who: "case4", title: "Sr. Firmware Engineer - Embedded Linux", d: dos(null, "Embedded Engineer II"), sat: 5, tot: 7, keep: false },
  { who: "case5", title: "Platform Engineer, Data Infrastructure", d: dos(null, "Data Engineer or Analytics Engineer, ELT"), sat: 6, tot: 8, keep: true },
  { who: "case6", title: "Platform Engineer, Data Infrastructure", d: dos("entry-level or graduate", "Data Engineer, Analytics Engineer, BI Developer"), sat: 6, tot: 8, keep: true },
  { who: "case7", title: "Sr Clinical Research Associate", d: dos("senior", "senior clinical research associate or Senior CRA"), sat: 6, tot: 7, keep: true },
  { who: "case8", title: "Senior Industrial Designer", d: dos("senior", "senior or principal or IC and founding roles"), sat: 5, tot: 7, keep: true },
];

describe("eight representative D1 cases", () => {
  for (const c of EIGHT) {
    it(`${c.who} (${c.sat}/${c.tot}, "${c.title}") -> ${c.keep ? "SEND" : "HELD"}`, () => {
      expect(sendDecision(reqs(c.tot, c.sat), { jobTitle: c.title, dossier: c.d }).send).toBe(c.keep);
    });
  }

  it("8 candidates become 7 — and exactly one is removed", () => {
    const out = EIGHT.map((c) => sendDecision(reqs(c.tot, c.sat), { jobTitle: c.title, dossier: c.d }).send);
    expect(out.filter(Boolean).length).toBe(7);
    expect(EIGHT.filter((c, i) => !out[i]).map((c) => c.who)).toEqual(["case4"]);
  });

  it("the over-level role sends WITHOUT the level gate and is held WITH it", () => {
    const c = EIGHT.find((x) => x.who === "case4");
    // identical requirements, identical ratio (5/7 = 0.714 >= 0.70) — only the level input changes
    expect(sendDecision(reqs(c.tot, c.sat), { jobTitle: c.title }).send).toBe(true);          // no dossier: gate cannot fire
    expect(sendDecision(reqs(c.tot, c.sat), { jobTitle: c.title, dossier: c.d }).send).toBe(false);
    expect(sendDecision(reqs(c.tot, c.sat), { jobTitle: c.title, dossier: c.d }).why).toMatch(/level above what their own record claims/);
  });
});

describe("the level gate is a lattice of words, not a score", () => {
  it("orders the bands people and postings actually use", () => {
    expect(levelBand("Graduate Lab Trainee")).toBe(1);
    expect(levelBand("Embedded Engineer II")).toBe(2);
    expect(levelBand("Sr. Firmware Engineer")).toBe(4);
    expect(levelBand("Staff Software Engineer")).toBe(5);
    expect(levelBand("Head of Clinical Operations")).toBe(6);
    expect(levelBand("Data Analyst - Reporting")).toBe(0);
  });

  it("reads the HIGHEST level the person claims across both of their own fields", () => {
    expect(claimedBand(dos(null, "Embedded Engineer II"))).toBe(2);
    // "founding" is a band-6 word, and it is the highest one present. The claim is the ceiling of
    // what they say, not the first hit.
    expect(claimedBand(dos("senior", "senior or principal or IC and founding roles"))).toBe(6);
    expect(claimedBand(dos("senior", "senior or staff engineer"))).toBe(5);
    expect(claimedBand(dos(null, null))).toBe(0);
  });

  it("fires only downward, and only when BOTH sides state a level", () => {
    expect(levelContradiction("Sr. Firmware Engineer", dos(null, "Embedded Engineer II"))).toMatchObject({ role: 4, claim: 2 });
    expect(levelContradiction("Sr. Firmware Engineer", dos("senior", null))).toBe(null);   // equal
    expect(levelContradiction("Sr. Firmware Engineer", dos("staff", null))).toBe(null);    // above
    expect(levelContradiction("Sr. Firmware Engineer", dos(null, null))).toBe(null);       // FAIL-OPEN: no stated level
    expect(levelContradiction("Software Engineer", dos(null, "fresher"))).toBe(null); // title states no level
  });

  it("is SUBTRACTIVE — it can never turn a hold into a send", () => {
    // A candidate that D1 rejects on ratio stays rejected whatever the levels say.
    for (const d of [dos("director", null), dos("staff", null), dos(null, null)])
      expect(sendDecision(reqs(8, 4), { jobTitle: "Senior Engineer", dossier: d }).send).toBe(false);
  });
});

describe("every inherited protection still holds through this module", () => {
  const D = dos("senior", "senior engineer");
  it("a contradiction is never a send, at any ratio", () => {
    const r = [...Array(7).fill(0).map((_, i) => sat(`ok${i}`)), { req: "8+ years", gating: true, kind: "experience-duration", status: "contradicted", evidence_strength: null, evidence: "no professional history" }];
    expect(sendDecision(r, { jobTitle: "Engineer", dossier: D }).send).toBe(false);
  });
  it("self-reported cannot satisfy", () => {
    const r = [sat("a"), sat("b"), sat("c"), { req: "d", gating: true, kind: "capability", status: "met", evidence_strength: "self-reported", evidence: "listed in skills" }];
    expect(sendDecision(r, { jobTitle: "Engineer", dossier: D }).satisfied).toBe(3);
  });
  it("a send needs at least one direct anchor", () => {
    expect(sendDecision([sat("a", "adjacent"), sat("b", "adjacent"), sat("c", "adjacent")], { jobTitle: "Engineer", dossier: D }).send).toBe(false);
  });
  it("tolerated may not exceed satisfied", () => {
    expect(sendDecision([sat("a"), sat("b"), sat("c"), silent("w", true), silent("x", true), silent("y", true), silent("z", true)], { jobTitle: "Engineer", dossier: D }).send).toBe(false);
  });
  it("the decided floor of 3 is unchanged", () => {
    expect(sendDecision([sat("a"), sat("b")], { jobTitle: "Engineer", dossier: D }).send).toBe(false);
  });
  it("no composite, no weights, no scalar anywhere in the module", () => {
    const src = readFileSync(new URL("./send-rule.mjs", import.meta.url), "utf8");
    const body = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(body).not.toMatch(/composite|weight|0\.4|0\.25|score\s*[+*]/i);
    expect(D1_RATIO).toBe(0.70);
  });
});

describe("IT DECIDES NOTHING YET", () => {
  const ROOT = new URL("../", import.meta.url);
  it("no root production module imports the send rule", () => {
    const importers = readdirSync(ROOT)
      .filter((f) => (f.endsWith(".mjs") || f.endsWith(".ts")) && !f.includes(".test."))
      .filter((f) => readFileSync(new URL(f, ROOT), "utf8").includes("send-rule.mjs"));
    expect(importers).toEqual([]);
  });
  it("and it does not reach into the frozen operator's internals", () => {
    const src = readFileSync(new URL("./send-rule.mjs", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ requirementOutcome \} from "\.\/fit-decision\.mjs"/);
    expect(src).not.toMatch(/fitDecision|SATISFYING|ANCHORING|STRONG|POSSIBLE/);
  });
});
