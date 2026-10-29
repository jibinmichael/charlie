// sweep-summary.test.mjs — the twice-daily sweep's summary is the only thing standing in for a human
// at the screen, so what it says has to be true.
//
// Unattended, the only reading of a run's output happens in this one email. These tests are about
// that email not lying.

import { describe, it, expect } from "vitest";
import { summarise } from "../sweep.mjs";
import { MANDATES, FORMS_WITHOUT_MANDATE } from "./mandates.mjs";

const board = (over = {}) => ({
  key: "x", board: "A Board", pooled: 0, consented: 0, withheld: 0, scored: 0,
  failedScores: 0, created: 0, repaired: 0, cvNotUsed: [], problems: [], ...over,
});

describe("the subject says the largest true thing", () => {
  it("leads with problems above everything else", () => {
    const s = summarise([board({ created: 9, problems: ["board write failed"] })], []);
    expect(s.subject).toMatch(/1 thing needing a human/);
  });

  it("counts work that happened even when no row was created", () => {
    // A run that only added people to the pool must not read "0 new on boards, 0 scored".
    const s = summarise([board({ pooled: 2 })], []);
    expect(s.subject).toMatch(/2 into the pool/);
    expect(s.subject).not.toMatch(/nothing new/);
  });

  it("says nothing new only when genuinely nothing happened", () => {
    expect(summarise([board()], []).subject).toMatch(/nothing new/);
  });

  it("raises a new form as a decision waiting", () => {
    const s = summarise([board()], ["Example Senior AI Engineer (abc123, 4 applicants)"]);
    expect(s.subject).toMatch(/1 new form\(s\) awaiting a decision/);
    expect(s.html).toContain("Example Senior AI Engineer");
  });
});

describe("the body never turns an absence into a fact", () => {
  it("says withheld applicants are correct, not missing", () => {
    const s = summarise([board({ consented: 27, withheld: 3 })], []);
    expect(s.html).toMatch(/did not agree to be shown to the employer/);
    expect(s.html).toMatch(/correct, not a gap/);
  });

  it("names every unreadable CV and says what the row will wrongly imply", () => {
    const s = summarise([board({ cvNotUsed: ["Maya Rao: unreadable file format (cv.pages)"] })], []);
    expect(s.html).toContain("Maya Rao");
    expect(s.html).toMatch(/Application only/);
    expect(s.html).toMatch(/they sent nothing/);
  });

  it("states plainly when nothing was refused, rather than staying silent", () => {
    // Silence about failures reads identically to having none.
    const s = summarise([board({ created: 3 })], []);
    expect(s.html).toMatch(/No step failed and nothing was refused/);
  });

  it("repeats that criteria are never derived automatically", () => {
    expect(summarise([board()], []).html).toMatch(/Criteria are never derived automatically/);
  });

  it("reports the problem count back to the caller, so the heartbeat can stay silent", () => {
    // The heartbeat is pinged only on a clean pass: a green tick on a run that needs a human would
    // tell the monitor the opposite of the truth.
    expect(summarise([board({ problems: ["a", "b"] })], []).problems).toBe(2);
    expect(summarise([board()], []).problems).toBe(0);
  });
});

describe("form acknowledgement", () => {
  it("never lists a form as both a mandate and deliberately unhandled", () => {
    for (const m of Object.values(MANDATES)) {
      expect(FORMS_WITHOUT_MANDATE, `${m.formId} is both a mandate and acknowledged as not one`)
        .not.toHaveProperty(m.formId);
    }
  });

  it("gives a reason for every acknowledged form", () => {
    // The entry exists to say "seen, not a client mandate". A blank reason acknowledges nothing.
    for (const [id, why] of Object.entries(FORMS_WITHOUT_MANDATE)) {
      expect(String(why).length, `${id} has no reason`).toBeGreaterThan(20);
    }
  });
});
