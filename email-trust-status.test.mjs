// email-trust-status.test.mjs — unit tests for the per-section suppression reason helpers.
// These are the single source of truth for whether the fit Readout and the referral render; the
// renderer gates on them and the send paths log them. The email snapshot tests guard the rendered
// output; these guard the reason semantics.

import { describe, it, expect } from "vitest";
import { readoutStatus, referralStatus } from "./render-email.mjs";

describe("readoutStatus", () => {
  const goodCov = { thin: false, coverage: [{ req: "React", status: "met" }], composite: 72 };

  it("shown when cov is scoreable and the JD is not truncated", () => {
    expect(readoutStatus(goodCov, "a normal short jd")).toBe("shown");
  });
  it("shown for a long-but-complete JD (length is NOT truncation)", () => {
    expect(readoutStatus(goodCov, "x".repeat(4320))).toBe("shown");
  });
  it("hidden:jd_truncated when the JD visibly ends mid-text (trailing ellipsis)", () => {
    expect(readoutStatus(goodCov, `${"x".repeat(1200)}…`)).toBe("hidden:jd_truncated");
  });
  it("hidden:jd_truncated when cov carries a truncation flag", () => {
    expect(readoutStatus({ ...goodCov, jdTruncated: true }, "short")).toBe("hidden:jd_truncated");
  });
  it("hidden:cov_thin when cov is thin or null", () => {
    expect(readoutStatus({ thin: true }, "short")).toBe("hidden:cov_thin");
    expect(readoutStatus(null, "short")).toBe("hidden:cov_thin");
  });
  it("hidden:no_coverage when cov is scoreable but the coverage array is empty", () => {
    expect(readoutStatus({ thin: false, coverage: [] }, "short")).toBe("hidden:no_coverage");
  });
});

describe("referralStatus", () => {
  it("shown for a US recipient with a named contact", () => {
    expect(referralStatus("us", { name: "Jane Doe", position: "EM" })).toBe("shown");
  });
  it("hidden:region when the recipient is not US", () => {
    expect(referralStatus("india", { name: "Jane Doe" })).toBe("hidden:region");
  });
  it("hidden:no_contact when US but no resolved contact", () => {
    expect(referralStatus("us", null)).toBe("hidden:no_contact");
    expect(referralStatus("us", { name: "" })).toBe("hidden:no_contact");
  });
});
