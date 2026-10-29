// eligibility.test.mjs — the must-have gate (lib/eligibility.mjs) on a synthetic applicant pool. The
// gate has to agree with the client's written must-haves, not with our own ranking: the top three on
// the additive score each fail a must-have, and the one who clears them all ranks fourth.
import { describe, it, expect } from "vitest";
import { MANDATES } from "./mandates.mjs";
import { evaluateEligibility, eligibilitySummary, oneOf, atLeast, namesAnyOf, cannotAnswer } from "./eligibility.mjs";

const northwind = MANDATES.northwind;

// name, additive score, and the four answers the board holds
const APPLICANTS = [
  { name: "Nisha Kulkarni",    score: 81, renewal_owner: "I own all of them",          degree: "Diploma in hotel management", cs_tools: "Gainsight, Zendesk",  accounts_managed: "35" },
  { name: "Tarun Bose",        score: 72, renewal_owner: "shared with the sales team", degree: "B.Com (dropped out)",         cs_tools: "Freshdesk",           accounts_managed: "20" },
  { name: "Leela Fernandes",   score: 66, renewal_owner: "shared with an AE",          degree: "BBA",                         cs_tools: "HubSpot",             accounts_managed: "28" },
  { name: "Omar Siddiqui",     score: 59, renewal_owner: "I do, end to end",           degree: "Commerce",                    cs_tools: "Vitally, Intercom",   accounts_managed: "42" },
  { name: "Gita",              score: 45, renewal_owner: "I handle most of them",      degree: "MBA",                         cs_tools: "spreadsheets",        accounts_managed: "15" },
  { name: "Dev Malhotra",      score: 33, renewal_owner: "someone else in sales",      degree: "Finance",                     cs_tools: "email only",          accounts_managed: "8" },
];

const verdictFor = (a) => evaluateEligibility(northwind, a).verdict;

describe("the gate reproduces the client's own rejection", () => {
  it("fails our top three, each on a different written must-have", () => {
    expect(verdictFor(APPLICANTS[0])).toBe("fails"); // a diploma, not a commerce or business degree
    expect(verdictFor(APPLICANTS[1])).toBe("fails"); // renewals shared with sales, and no completed degree
    expect(verdictFor(APPLICANTS[2])).toBe("fails"); // renewals shared with sales
  });

  it("passes the candidate the additive score ranked fourth", () => {
    expect(verdictFor(APPLICANTS[3])).toBe("meets");
  });

  it("names which must-have each person failed, so the board can say why", () => {
    expect(evaluateEligibility(northwind, APPLICANTS[0]).failed).toEqual(["degree_completed"]);
    expect(evaluateEligibility(northwind, APPLICANTS[1]).failed).toEqual(["owns_renewals", "degree_completed"]);
    // a finance degree clears the degree rule; this one fails on renewals and on naming no CS platform
    expect(evaluateEligibility(northwind, APPLICANTS[5]).failed).toEqual(["owns_renewals", "uses_cs_platform"]);
  });

  it("the score does not predict the gate, which is the whole finding", () => {
    const meets = APPLICANTS.filter((a) => verdictFor(a) === "meets");
    expect(meets).toHaveLength(1);
    // the one who passes is NOT the highest scorer
    expect(Math.max(...APPLICANTS.map((a) => a.score))).toBeGreaterThan(meets[0].score);
  });

  it("summarises for the top of the board without hiding the unknowns", () => {
    const s = eligibilitySummary(APPLICANTS.map((a) => evaluateEligibility(northwind, a)));
    expect(s.total).toBe(6);
    expect(s.meets).toBe(1);
    expect(s.line).toContain("6 applied · 1 meet the stated must-haves");
  });
});

describe("rules refuse to guess", () => {
  it("an unrecognised answer is unknown, never a pass or a fail", () => {
    const r = oneOf({ passes: ["yes"], fails: ["no"] })("it depends on the quarter");
    expect(r.state).toBe("unknown");
    expect(r.why).toContain("unrecognised");
  });

  it("an unanswered question is unknown, and unknown is not fail", () => {
    expect(atLeast(1)("").state).toBe("unknown");
    expect(namesAnyOf(["gainsight"])(null).state).toBe("unknown");
    const v = evaluateEligibility(northwind, { renewal_owner: "I own them", degree: "B.Com", cs_tools: "Zendesk" });
    expect(v.verdict).toBe("unknown");       // accounts_managed missing
    expect(v.failed).toEqual([]);            // and nobody is failed for it
  });

  it("a blocked answer beats a matching pass token", () => {
    // "B.Com (dropped out)" contains "b.com"; blocks are checked first
    expect(evaluateEligibility(northwind, { ...APPLICANTS[3], degree: "B.Com (dropped out)" }).failed).toContain("degree_completed");
  });

  it("a rule that throws reads as unknown, never as a pass", () => {
    const broken = { eligibility: [{ key: "x", criterion: "c", fact: "f", test: () => { throw new Error("boom"); } }] };
    const r = evaluateEligibility(broken, { f: "anything" });
    expect(r.rows[0].state).toBe("unknown");
    expect(r.verdict).toBe("unknown");
  });
});

describe("a criterion we cannot answer can never read as met", () => {
  it("years-building-frontends is declared, not approximated", () => {
    const r = evaluateEligibility(MANDATES.initech, { years_total: "7", frameworks: "React", work_link: "https://github.com/example", studied: "Anna University" });
    // every fact answered, and it still cannot say "meets"
    expect(r.verdict).toBe("unknown");
    const row = r.rows.find((x) => x.key === "years_frontend");
    expect(row.state).toBe("uncollectable");
    expect(row.why).toContain("different denominator");
  });

  it("the client's take-home stays uncollectable until the client shares its rubric", () => {
    const row = evaluateEligibility(MANDATES.initech, { work_link: "https://github.com/example" }).rows.find((x) => x.key === "take_home");
    expect(row.state).toBe("uncollectable");
    expect(row.why).toContain("rubric was not shared");
  });

  it("cannotAnswer ignores whatever it is handed", () => {
    expect(cannotAnswer("because")("Anna University").state).toBe("uncollectable");
  });
});
