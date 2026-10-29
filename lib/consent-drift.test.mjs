// consent-drift.test.mjs — the baseline comparison in lib/consent-drift.mjs: a form that used to match
// a consent question and stopped is a regression; every other change is reported, never failed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareToBaseline, detectOn } from "./consent-drift.mjs";
import { POOL_Q, SHARE_Q } from "./consent-questions.mjs";

const q = (...titles) => titles.map((t) => ({ title: t, type: "MULTIPLE_CHOICE" }));
const POOL = "Would you like to join the Charlie talent pool?";
const SHARE = "If shortlisted, may we share your Charlie profile with the employer?";
const EDITED = "Would you like Charlie to consider you for other relevant roles in the future based on your profile and experience?";

describe("compareToBaseline — only one direction is a failure", () => {
  it("a form that matched, then had its title edited away, is a regression", () => {
    const { regressions } = compareToBaseline(
      { FORM05: { pool: POOL, share: SHARE } },
      { FORM05: { pool: null, share: SHARE } },
    );
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatchObject({ form: "FORM05", field: "pool", was: POOL, now: null });
  });

  it("a form that has NEVER asked is not a regression — those people were genuinely never asked", () => {
    // A form with no consent question at all stores people as not-contactable, correctly. Flagging it
    // every run would train somebody to ignore the output.
    const { regressions } = compareToBaseline(
      { FORM10: { pool: null, share: null } },
      { FORM10: { pool: null, share: null } },
    );
    expect(regressions).toEqual([]);
  });

  it("a re-worded question that still matches is reported, not failed", () => {
    const { regressions, recovered } = compareToBaseline(
      { FORM05: { pool: POOL, share: null } },
      { FORM05: { pool: EDITED, share: null } },
    );
    expect(regressions).toEqual([]);
    expect(recovered).toHaveLength(1);
  });

  it("a question that APPEARS is reported, never failed", () => {
    const { regressions, recovered } = compareToBaseline(
      { F: { pool: null, share: null } }, { F: { pool: POOL, share: null } },
    );
    expect(regressions).toEqual([]);
    expect(recovered[0]).toMatchObject({ was: null, now: POOL });
  });

  it("a form nobody has baselined is surfaced for a human, not silently accepted", () => {
    const { unknown, regressions } = compareToBaseline({}, { BrandNew: { pool: null, share: null } });
    expect(unknown).toEqual(["BrandNew"]);
    expect(regressions).toEqual([]);
  });

  it("a form deleted from Tally is reported, not failed", () => {
    const { gone, regressions } = compareToBaseline({ Old: { pool: POOL, share: null } }, {});
    expect(gone).toEqual(["Old"]);
    expect(regressions).toEqual([]);
  });

  it("share regresses independently of pool", () => {
    const { regressions } = compareToBaseline(
      { F: { pool: POOL, share: SHARE } }, { F: { pool: POOL, share: null } },
    );
    expect(regressions).toHaveLength(1);
    expect(regressions[0].field).toBe("share");
  });
});

describe("detectOn — the same detector the ingest uses", () => {
  it("finds both questions", () => {
    expect(detectOn(q("Full name", POOL, SHARE), POOL_Q, SHARE_Q)).toEqual({ pool: POOL, share: SHARE });
  });
  it("reports absence as null rather than throwing", () => {
    expect(detectOn(q("Full name", "Phone number"), POOL_Q, SHARE_Q)).toEqual({ pool: null, share: null });
  });
});

describe("the committed baseline is real, and covers the forms we ingest", () => {
  const baseline = JSON.parse(readFileSync(new URL("./consent-baseline.json", import.meta.url), "utf8"));

  it("is not empty — an empty baseline makes every regression invisible", () => {
    expect(Object.keys(baseline).length).toBeGreaterThan(10);
  });

  it("records FORM05 as asking both questions", () => {
    expect(baseline.FORM05?.pool).toBe(EDITED);
    expect(baseline.FORM05?.share).toMatch(/^I consent to being contacted/);
  });

  it("every recorded title is one the live detector still matches", () => {
    // If this fails, the baseline and the pattern disagree, and the baseline is the one lying.
    for (const [form, v] of Object.entries(baseline)) {
      if (v.pool) expect(POOL_Q.test(v.pool), `${form} pool baseline no longer matches`).toBe(true);
      if (v.share) expect(SHARE_Q.test(v.share), `${form} share baseline no longer matches`).toBe(true);
    }
  });
});
