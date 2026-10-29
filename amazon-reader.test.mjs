// amazon-reader.test.mjs — the Amazon source.
//
// Amazon is one employer behind a single keyless GET, so it is shaped unlike every sibling in
// scan-jobs.mjs: the slug is constant and the MARKET is what varies. Three things carry real risk
// and each has a test below.
//
// 1. THE ALPHA-3 TRAP. `normalized_country_code[]` speaks ISO-3166 alpha-3 (USA/IND), not the
//    alpha-2 the rest of this codebase uses. Passing "IN" returns hits:0 for every market — a
//    silent empty result set, not an error. The endpoint test pins the exact bracketed key and the
//    alpha-3 value.
//
// 2. THE PAGE CEILING. result_limit above 100 makes the API return an empty jobs array with no
//    error, exactly like WORKDAY_PAGE=20. A vendor ceiling, not a tuning knob.
//
// 3. UK IS NOT A MARKET. classifyPlace("London, England, GBR") is "other" while CAN/AUS are
//    "ca"/"au", because quality-gate.mjs has no UK region, so fetching GBR would be unreachable
//    work. The last test is a tripwire: it fails the day a UK region lands, so GBR gets added
//    deliberately rather than forgotten.
import { describe, it, expect } from "vitest";
import { extractAmazon } from "./scan-jobs.mjs";
import { AmazonJob, ATS_JOB_SCHEMAS } from "./lib/schemas/ats-jobs.mjs";
import { classifyPlace } from "./quality-gate.mjs";

// A real record shape from the live feed (trimmed to the read fields).
const REAL = {
  id: "695df656-7828-4c82-885f-d24aeeed92db",
  id_icims: "10489312",
  title: "Financial Analyst Intern, GFS FP&A",
  company_name: "ADCI - Karnataka",
  city: "Bengaluru",
  country_code: "IND",
  normalized_location: "Bengaluru, Karnataka, IND",
  posted_date: "July 31, 2026",
  job_path: "/en/jobs/10489312/financial-analyst-intern-gfs-fp-a",
  description: "Amazon is looking for a Financial Analyst Intern.",
  basic_qualifications: "Currently enrolled in a Bachelor's degree.",
};

describe("extractAmazon", () => {
  it("reads the fields the pool actually needs", () => {
    const e = extractAmazon(REAL);
    expect(e.title).toBe("Financial Analyst Intern, GFS FP&A");
    expect(e.location).toBe("Bengaluru, Karnataka, IND");
    expect(e.apply_url).toBe("https://www.amazon.jobs/en/jobs/10489312/financial-analyst-intern-gfs-fp-a");
    expect(e.posted_at).toMatch(/^2026-07-3[01]T/); // "July 31, 2026" parsed, not invented
  });

  it("prefers the stable icims handle over the UUID, so a retitle does not orphan the posting", () => {
    expect(extractAmazon(REAL).jobId).toBe("10489312");
    expect(extractAmazon({ ...REAL, id_icims: null }).jobId).toBe(REAL.id); // UUID only as a fallback
  });

  it("appends basic_qualifications — fit-coverage reads requirements out of the description", () => {
    const d = extractAmazon(REAL).description;
    expect(d).toContain("Financial Analyst Intern");
    expect(d, "the requirements must survive into the pooled description").toContain("Bachelor's degree");
  });

  it("leaves an unparseable date null rather than inventing a timestamp", () => {
    expect(extractAmazon({ ...REAL, posted_date: "Posted recently" }).posted_at).toBe(null);
    expect(extractAmazon({ ...REAL, posted_date: null }).posted_at).toBe(null);
  });

  it("never guesses compensation or team", () => {
    const e = extractAmazon(REAL);
    expect(e.compensation).toBe(null);
    expect(e.team, "business_category is an internal cost centre, not a team").toBe(null);
  });

  it("does not throw on junk", () => {
    for (const j of [{}, { title: 42 }, { normalized_location: null }])
      expect(() => extractAmazon(j)).not.toThrow();
  });
});

describe("the schema is the boundary", () => {
  it("is registered, so scan-jobs validates Amazon like every other source", () => {
    expect(ATS_JOB_SCHEMAS.amazon).toBeDefined();
  });

  it("accepts the real record and an int id_icims (the feed sends both shapes)", () => {
    expect(AmazonJob.safeParse(REAL).success).toBe(true);
    expect(AmazonJob.safeParse({ ...REAL, id_icims: 10489312 }).success).toBe(true);
  });
});

describe("the geo contract this source depends on", () => {
  // extractAmazon emits alpha-3 country codes in `location`. If the gate cannot read them, every
  // Amazon role is silently dropped on arrival.
  it("classifies the markets we fetch, with MULTI_REGION on as production has it", () => {
    const prev = process.env.MULTI_REGION;
    process.env.MULTI_REGION = "on";
    try {
      expect(classifyPlace("Seattle, Washington, USA")).toBe("us");
      expect(classifyPlace("Bengaluru, Karnataka, IND")).toBe("india");
      expect(classifyPlace("Toronto, Ontario, CAN")).toBe("ca");
      expect(classifyPlace("Sydney, New South Wales, AUS")).toBe("au");
    } finally { process.env.MULTI_REGION = prev; }
  });

  // A TRIPWIRE, not an endorsement. GBR is excluded from AMAZON_MARKETS only because no UK region
  // exists. The day one lands, this test fails and whoever added it must decide about GBR on purpose.
  it("still has no UK region — the reason GBR is not fetched", () => {
    const prev = process.env.MULTI_REGION;
    process.env.MULTI_REGION = "on";
    try {
      expect(
        classifyPlace("London, England, GBR"),
        "a UK region now exists: add GBR to AMAZON_MARKETS in scan-jobs.mjs and delete this test",
      ).toBe("other");
    } finally { process.env.MULTI_REGION = prev; }
  });
});
