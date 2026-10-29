// role-match-meta.test.mjs — the meta line under a job title. Ashby returns compensation as an object
// and several boards return remote as a boolean; String() on either produces
// "[object Object] · true · FullTime".
import { describe, it, expect } from "vitest";
import { renderRoleMatch } from "../email-kit.mjs";

const base = {
  email: "a@b.test", name: "Test", quote: "I built the thing", why: "You built the thing. They need it.",
  subject: "A subject", job: { title: "Engineer", company: "Acme", location: "Pune", apply_url: "https://x.test", posted_at: "2026-08-05" },
};
// The meta line is the one directly after the company line. Finding it by looking for a "·" only
// works when two or more fields are present.
const meta = (job) => {
  const lines = renderRoleMatch({ ...base, job: { ...base.job, ...job } }).text.split("\n");
  const i = lines.findIndex((l) => l.startsWith("Acme ·") || l === "Acme");
  return i >= 0 ? (lines[i + 1] || "").trim() : "";
};

describe("the role meta line", () => {
  it("never prints an object or a raw boolean", () => {
    const l = meta({ compensation: { compensationTierSummary: "$120K – $150K • Offers Equity" }, remote: true, employment_type: "FullTime" });
    expect(l).not.toContain("[object Object]");
    expect(l).not.toMatch(/\btrue\b/);
    expect(l).toContain("remote");
  });

  it("reads a salary range as a range, not two numbers", () => {
    // deDash turns the en dash into a comma, and "$120K, $150K" reads as two figures
    expect(meta({ compensation: { compensationTierSummary: "$120K – $150K" } })).toContain("$120K to $150K");
    expect(meta({ compensation: "INR 9,00,000.00 - 12,00,000.00" })).toContain("9,00,000.00 to 12,00,000.00");
  });

  it("drops an empty compensation object rather than printing null", () => {
    const l = meta({ compensation: { compensationTierSummary: null }, remote: null, employment_type: null });
    expect(l).toBe("");
  });

  it("says employment type the way a person would", () => {
    for (const raw of ["FullTime", "full_time", "Full-time Employment", "Full time"]) {
      expect(meta({ employment_type: raw })).toContain("full time");
    }
  });

  it("keeps a string compensation and a string remote as written", () => {
    expect(meta({ compensation: "INR 12 LPA", remote: "hybrid" })).toContain("INR 12 LPA");
    expect(meta({ compensation: "INR 12 LPA", remote: "hybrid" })).toContain("hybrid");
  });

  it("has no double spaces anywhere in it", () => {
    expect(meta({ compensation: "INR 9,00,000.00 - 12,00,000.00", remote: "hybrid" })).not.toMatch(/ {2}/);
  });
});
