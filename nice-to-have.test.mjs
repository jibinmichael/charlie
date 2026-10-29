// nice-to-have.test.mjs — keep the nice-to-have section of a posting, the one part where a candidate
// can be memorable, through our own description cap.
//
// Most postings are longer than the 2,500-char cap and roughly 40% of full descriptions name a
// nice-to-have section, usually at the end, so naive truncation destroys it. Measuring our own
// truncated copies would wildly under-count it; these tests use the full layout.
import { describe, it, expect } from "vitest";
import { extractNiceToHave, capKeepingRequirements } from "./lib/jd-requirements.mjs";
import { serializeJobsFile } from "./scan-jobs.mjs";

describe("extractNiceToHave", () => {
  it("pulls the bonus section out of a full posting", () => {
    const jd = "About us. Requirements: 5 years React. Nice to have: Kubernetes in production, Terraform. Benefits: lunch.";
    expect(extractNiceToHave(jd)).toBe("Nice to have: Kubernetes in production, Terraform.");
  });

  it("stops before benefits and boilerplate", () => {
    // Free lunch is not something the employer asked for. Including it would put words in their mouth
    // and produce "they listed health cover as a bonus you have", which is nonsense.
    const jd = "Bonus points: Rust. What we offer: health cover, equity, a laptop, unlimited leave.";
    const out = extractNiceToHave(jd);
    expect(out).toContain("Rust");
    expect(out).not.toMatch(/health cover|equity|laptop/);
  });

  it("recognises the phrasings employers actually use", () => {
    for (const head of ["Nice to have:", "Nice-to-haves:", "Bonus points:", "Preferred qualifications:", "Good to have:", "Even better:"]) {
      expect(extractNiceToHave(`Requirements: React. ${head} Kubernetes.`), head).toContain("Kubernetes");
    }
  });

  it("returns EMPTY rather than guessing when the posting names no bonus", () => {
    // Most postings have none. Inventing one would be a claim about what an employer wants, built from
    // our own inference.
    for (const jd of ["Requirements: React. Benefits: lunch.", "", null, undefined, 12345]) {
      expect(extractNiceToHave(jd)).toBe("");
    }
  });

  it("is length-capped, because it rides on every role in the pool", () => {
    const jd = `Nice to have: ${"kubernetes, ".repeat(500)}`;
    expect(extractNiceToHave(jd).length).toBeLessThanOrEqual(400);
  });
});

describe("the scan keeps it before the cap eats it", () => {
  // The typical layout: requirements early, a long body, bonuses at the end. capKeepingRequirements
  // preserves the requirements window and the bonus would fall off the far end — the loss this guards.
  const long = `Requirements: 5 years React, strong CSS. ${"x".repeat(3000)} Nice to have: Kubernetes, Terraform. Benefits: lunch.`;

  it("stores the bonus separately while still capping the description", () => {
    const [job] = JSON.parse(serializeJobsFile([{ id: "a", description: long }]));
    expect(job.description.length).toBe(2500);
    expect(job.nice_to_have).toContain("Kubernetes");
    // The proof the cap WOULD have destroyed it: the stored description does not contain it.
    expect(job.description).not.toContain("Kubernetes");
    // And the requirements the cap exists to protect are still there.
    expect(job.description).toContain("Requirements");
  });

  it("adds NO field to a role that names no bonus", () => {
    // 60% of roles have none. An empty string on every one of them is dead weight in a pool already
    // at ~47% of V8's single-string ceiling.
    const [job] = JSON.parse(serializeJobsFile([{ id: "b", description: "Requirements: React. Benefits: lunch." }]));
    expect("nice_to_have" in job).toBe(false);
  });

  it("does not disturb a role that was never truncated", () => {
    const short = "Requirements: React. Nice to have: Go.";
    const [job] = JSON.parse(serializeJobsFile([{ id: "c", description: short }]));
    expect(job.description).toBe(short);
    expect(job.nice_to_have).toContain("Go");
  });

  it("leaves a malformed row alone rather than throwing into the scan", () => {
    const out = JSON.parse(serializeJobsFile([{ id: "d" }, { id: "e", description: null }]));
    expect(out).toHaveLength(2);
  });
});
