// campaign-closed.test.mjs — the "closing your application" note.
//
// Applicants who never answered the campaign filter are owed an answer rather than silence. This is
// a one-time, hand-run send to a named list, not a drip.
//
// THE RISK THIS FILE GUARDS is not the copy, it is the offer. Most recipients are not `candidates`
// at all. Nothing in this email may put anybody on a send list: onboarding
// starts when THEY write to start@. The button is a prefilled mailto that opens that door. If it
// ever becomes a link that enrols someone, these tests fail.

import { describe, it, expect } from "vitest";
import { renderCampaignClosed } from "./render-campaign.mjs";

const out = renderCampaignClosed({ email: "applicant@example.com" });

describe("renderCampaignClosed — voice + design contract", () => {
  it("renders html and text", () => {
    expect(out.html).toBeTruthy();
    expect(out.text).toBeTruthy();
    expect(out.subject).toBe("Closing your application");
  });

  it("no em dash anywhere", () => {
    expect(out.html).not.toMatch(/—/);
    expect(out.text).not.toMatch(/—/);
    expect(out.subject).not.toMatch(/—/);
  });

  it("sentence case, no shouting", () => {
    expect(out.text.match(/\b[A-Z]{3,}\b/g)).toBeNull();
  });

  it("carries the unsubscribe the shell requires", () => {
    expect(out.html).toMatch(/\/unsubscribe\?/);
  });

  it("exposes no mechanism — no gate, score, dossier or verdict language", () => {
    for (const word of ["dossier", "gate", "score", "verdict", "pipeline", "algorithm", "status"]) {
      expect(out.text.toLowerCase(), `"${word}" leaked into candidate-facing copy`).not.toContain(word);
    }
  });
});

describe("the offer is an invitation, never an enrolment", () => {
  it("the CTA is a mailto to start@, not a subscribe link", () => {
    expect(out.html).toMatch(/mailto:start@mail\.example\.com/);
    // No http link may appear other than the unsubscribe + the shell's own assets. Specifically:
    // nothing that could sign a person up by being clicked.
    const hrefs = [...out.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const actionable = hrefs.filter((h) => /^https?:/.test(h) && !/\/unsubscribe\?/.test(h));
    for (const h of actionable) {
      expect(h, `"${h}" is a clickable non-unsubscribe link in an email to non-users`).not.toMatch(/subscribe|signup|sign-up|enroll|optin|opt-in/i);
    }
  });

  it("the mailto is prefilled so the reply lands as a real onboarding message", () => {
    expect(out.html).toMatch(/mailto:start@[^"]*\?subject=/);
    expect(out.html).toMatch(/body=/);
  });

  it("says the sign-up is writing in, and does not claim we have done anything for them", () => {
    expect(out.text).toMatch(/write to start@mail\.example\.com/i);
    for (const claim of ["we have added you", "you are now", "we signed you up", "your account is"]) {
      expect(out.text.toLowerCase()).not.toContain(claim);
    }
  });
});

describe("it closes the application honestly", () => {
  it("states the close plainly, and it is reversible", () => {
    expect(out.text).toMatch(/closing your application/i);
    expect(out.text).toMatch(/reply to this email and I will reopen it/i);
  });

  it("never implies a machine judged them — the verdict here is human", () => {
    // Same doctrine as every other candidate template in render-campaign.mjs.
    for (const s of ["did not pass", "rejected", "unsuccessful", "did not meet", "scored"]) {
      expect(out.text.toLowerCase(), `"${s}" reads as a machine verdict`).not.toContain(s);
    }
  });

  it("the only claim about the product is one it can keep", () => {
    // "a few thousand company job boards" matches the live pool size (loadJobPoolStats). Not
    // "10,000", not "every job in India".
    expect(out.text).toMatch(/a few thousand company job boards/);
    expect(out.text).not.toMatch(/every (job|role|company)/i);
    expect(out.text).not.toMatch(/guarantee/i);
  });
});
