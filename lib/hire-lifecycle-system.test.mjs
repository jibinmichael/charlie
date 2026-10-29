// lib/hire-lifecycle-system.test.mjs — the candidacy lifecycle's fixed system stages for a pursuit: every
// state lands on one of the nine words, a closed one says which group ended it, and only facts close anyone.
import { describe, it, expect } from "vitest";
import { createPursuit, systemStageOf, SYSTEM_STAGES, CLOSE_GROUPS } from "./hire-lifecycle.mjs";

const job = { id: "j1", employer_id: "Acme", company: "Acme", lifecycle: "active" };
const base = createPursuit({ id: "p1", job, person: { id: "a@x.com" }, source: "pool", open_gaps: ["c1"], at: 1 });
const ctx = (over = {}) => ({ job, person: {}, assessment: null, ...over });
const at = (over, c = ctx()) => systemStageOf({ ...base, ...over }, c);

describe("the system stage of a pursuit", () => {
  it("moves through the stages on facts", () => {
    expect(at({})).toEqual({ stage: "Found", group: null });
    expect(at({ engagement: "AWAITING_REPLY" })).toEqual({ stage: "Contacted", group: null });
    expect(at({ engagement: "INTERESTED" })).toEqual({ stage: "Interested", group: null });
    expect(at({ engagement: "INTERESTED", screening_consent: { state: "REQUESTED" } })).toEqual({ stage: "Qualifying", group: null });
    expect(at({ engagement: "INTERESTED", handoff: "HANDED_OFF" })).toEqual({ stage: "Introduced", group: null });
    expect(at({ engagement: "INTERESTED", handoff: "EMPLOYER_PROGRESSING" })).toEqual({ stage: "With employer", group: null });
  });

  it("a closed candidacy says which group ended it", () => {
    expect(at({ engagement: "NOT_INTERESTED" })).toEqual({ stage: "Closed", group: "They chose" });
    expect(at({ engagement: "OPTED_OUT" })).toEqual({ stage: "Closed", group: "They chose" });
    expect(at({ engagement: "INTERESTED", disclosure: { state: "DENIED" } })).toEqual({ stage: "Closed", group: "They chose" });
    expect(at({ engagement: "NO_RESPONSE" })).toEqual({ stage: "Closed", group: "No answer" });
    expect(at({ engagement: "INTERESTED", handoff: "EMPLOYER_DECLINED" })).toEqual({ stage: "Closed", group: "Employer chose" });
    expect(at({ engagement: "AWAITING_REPLY" }, ctx({ assessment: { eligibility_status: "ELIGIBLE", disposition: "EVIDENCE_SUPPORTED", employer_review: "PASSED" } }))).toEqual({ stage: "Closed", group: "Employer chose" });
  });

  it("an assessment alone never closes anyone: an ineligible gate with no review keeps their stage", () => {
    expect(at({ engagement: "AWAITING_REPLY" }, ctx({ assessment: { eligibility_status: "INELIGIBLE", disposition: "EVIDENCE_SUPPORTED", employer_review: "NONE" } }))).toEqual({ stage: "Contacted", group: null });
  });

  it("the words are the fixed list", () => {
    expect(SYSTEM_STAGES).toEqual(["Found", "Contacted", "Interested", "Qualifying", "Ready to introduce", "Introduced", "With employer", "Hired", "Closed"]);
    expect(CLOSE_GROUPS).toEqual(["They chose", "No answer", "Not a fit", "Employer chose"]);
  });
});
