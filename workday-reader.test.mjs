// workday-reader.test.mjs — the Workday source.
//
// Workday is the first source in scan-jobs.mjs that is a POST, pages 20 at a time, and carries no
// description on its list item. The tests that matter are not "does it parse JSON" — they are the
// two places this source can put a WRONG role in a real inbox:
//
//   1. LOCATION. The list item's `locationsText` uses bare two-letter prefixes that are ISO COUNTRY
//      codes on most tenants ("IN - Bangalore") and US STATE codes on others ("IN - Crawfordsville").
//      The same string cannot be decoded to a country. So the
//      extractor must prefer the DETAIL document's own `country.descriptor`, which names the country
//      in words, and must never present an undecodable string as though it were a resolved place.
//   2. DESCRIPTION. A role with no JD can still be scored (the matcher reads the title) and sent, but
//      can never carry a fit chart. A posting whose detail
//      fetch failed must therefore come out with description null so the pool guard drops it.
//
// Both are asserted as behaviour, not as "the function ran".
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { extractWorkday, boardKey, serializeJobsFile } from "./scan-jobs.mjs";
import { WorkdayJob, WorkdayPostingDetail, ATS_JOB_SCHEMAS, ATS_DETAIL_SCHEMAS } from "./lib/schemas/ats-jobs.mjs";

const BASE = "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite";
// A real list item shape from the live API.
const listItem = (over = {}) => ({
  title: "Senior Embedded System Software Engineer",
  externalPath: "/job/Taiwan-Taipei/Senior-Embedded-System-Software-Engineer_JR2022308",
  locationsText: "Taiwan, Taipei",
  postedOn: "Posted Today",
  bulletFields: ["JR2022308"],
  __base: BASE,
  ...over,
});
const detail = (over = {}) => ({
  jobDescription: "<p>We are looking for an engineer.</p>",
  startDate: "2026-07-31",
  jobReqId: "JR2022308",
  timeType: "Full time",
  location: "Taiwan, Taipei",
  country: { descriptor: "Taiwan" },
  ...over,
});

describe("extractWorkday — location is resolved from the country the employer states", () => {
  it("joins the detail document's city and country into a decodable string", () => {
    const ex = extractWorkday(listItem({ __detail: detail() }));
    expect(ex.location).toBe("Taiwan, Taipei, Taiwan");
    expect(ex.posted_at).toBe("2026-07-31");
    expect(ex.jobId).toBe("JR2022308");
    expect(ex.employment_type).toBe("Full time");
    expect(ex.description).toContain("looking for an engineer");
  });

  // THE CASE THIS SOURCE EXISTS TO GET RIGHT. "IN - Crawfordsville" is Indiana; "IN - Bangalore" is
  // India. The list text is identical in shape and cannot be decoded. The country descriptor can.
  it("an ambiguous bare-code location is decided by the country, not the code", () => {
    const usa = extractWorkday(
      listItem({
        locationsText: "IN - Crawfordsville",
        __detail: detail({ location: "IN - Crawfordsville", country: { descriptor: "United States of America" } }),
      }),
    );
    expect(usa.location).toBe("IN - Crawfordsville, United States of America");

    const india = extractWorkday(
      listItem({
        locationsText: "IN - Bangalore",
        __detail: detail({ location: "IN - Bangalore", country: { descriptor: "India" } }),
      }),
    );
    expect(india.location).toBe("IN - Bangalore, India");
    // The two must not be confusable — that is the whole point.
    expect(usa.location).not.toBe(india.location);
  });

  it('"5 Locations" is a COUNT, never passed off as a place', () => {
    const ex = extractWorkday(
      listItem({ locationsText: "5 Locations", __detail: detail({ location: "5 Locations", country: { descriptor: "United States of America" } }) }),
    );
    expect(ex.location).toBe("United States of America"); // the count is dropped, the country kept
    expect(ex.location).not.toMatch(/\d+\s+Locations/i);
  });

  it("with no country stated, the raw text is passed through unchanged for the geo gate to judge", () => {
    const ex = extractWorkday(listItem({ __detail: detail({ country: null, location: null }) }));
    expect(ex.location).toBe("Taiwan, Taipei"); // the list text, not an invention
  });

  it("detects remote and hybrid without inventing either", () => {
    expect(extractWorkday(listItem({ locationsText: "US, NC, Remote", __detail: detail({ location: "US, NC, Remote", country: { descriptor: "United States of America" } }) })).remote).toBe(true);
    expect(extractWorkday(listItem({ __detail: detail({ timeType: "Hybrid" }) })).remote).toBe("hybrid");
    expect(extractWorkday(listItem({ __detail: detail() })).remote).toBe(null); // Taipei office role
  });
});

describe("extractWorkday — a posting with no detail degrades honestly", () => {
  // hydrateDescriptions fails open per posting, so __detail can legitimately be absent. The posting
  // must then come out UNSCOREABLE (description null) rather than half-real, so main()'s pool guard
  // drops it — the same outcome it already gives a description-less SmartRecruiters posting.
  it("no detail -> description null and no invented date", () => {
    const ex = extractWorkday(listItem());
    expect(ex.description).toBe(null);
    expect(ex.posted_at).toBe(null); // "Posted Today" is prose and is never parsed into a timestamp
    expect(ex.employment_type).toBe(null);
    expect(ex.location).toBe("Taiwan, Taipei"); // still honest about what the list said
  });

  it("builds the apply url from the board it was fetched from", () => {
    expect(extractWorkday(listItem()).apply_url).toBe(`${BASE}${listItem().externalPath}`);
    expect(extractWorkday(listItem({ __base: undefined })).apply_url).toBe(null);
  });

  it("falls back to externalPath when the employer states no req id", () => {
    expect(extractWorkday(listItem({ bulletFields: [] })).jobId).toBe(listItem().externalPath);
  });
});

describe("Workday schemas — the boundary", () => {
  it("is registered in both schema registries", () => {
    expect(ATS_JOB_SCHEMAS.workday).toBe(WorkdayJob);
    expect(ATS_DETAIL_SCHEMAS.workday).toBe(WorkdayPostingDetail);
    expect(ATS_DETAIL_SCHEMAS.smartrecruiters).toBeDefined(); // the pre-existing one still registered
  });

  it("rejects a list item with no externalPath — it can be neither linked nor hydrated", () => {
    expect(WorkdayJob.safeParse(listItem()).success).toBe(true);
    const { externalPath, ...noPath } = listItem();
    expect(WorkdayJob.safeParse(noPath).success).toBe(false);
  });

  it("rejects a detail document whose jobDescription is not a string", () => {
    expect(WorkdayPostingDetail.safeParse({ jobPostingInfo: detail() }).success).toBe(true);
    // A vendor returning an object here would otherwise reach stripHtml() as "[object Object]" and
    // pool a garbage description — which is WORSE than null, because garbage is scoreable.
    expect(WorkdayPostingDetail.safeParse({ jobPostingInfo: detail({ jobDescription: { text: "x" } }) }).success).toBe(false);
  });

  it("tolerates the fields Workday genuinely omits on some tenants", () => {
    expect(WorkdayJob.safeParse({ externalPath: "/job/x" }).success).toBe(true); // no locationsText
    expect(WorkdayPostingDetail.safeParse({}).success).toBe(true); // no jobPostingInfo at all
  });
});

// ── The country filter ──────────────────────────────────────────────────────────────────────────
// Ask each board only for the countries Charlie serves, so the per-board cap bounds IN-MARKET roles
// instead of global ones.
//
// The failure mode this guards is specific and quiet: the facet PARAMETER name is per-tenant, and
// there are at least seven of them across the live watchlist. Hardcode any one of them and the
// filter silently matches nothing on most boards — every board keeps pulling the world, the logs
// look normal, and the only symptom is a scan that is slower and shallower than it should be. So
// the tests below drive several REAL parameter names seen on live boards.
import { workdayCountryFacets, workdayMarketFilter } from "./scan-jobs.mjs";

// The shape Workday actually returns: a top-level facet carrying `facetParameter`, whose values are
// unnamed GROUPS ("Location Type", "Locations", "Sites"), whose values are the real leaves.
const facetTree = (param, countries) => [
  { facetParameter: "jobFamilyGroup", descriptor: "Job Category", values: [{ descriptor: "Engineering", id: "jf1", count: 10 }] },
  {
    facetParameter: param,
    values: [
      { descriptor: "Location Type", values: [{ descriptor: "Remote", id: "lt1", count: 5 }] },
      { descriptor: "Locations", values: countries.map(([d, id, count]) => ({ descriptor: d, id, count })) },
    ],
  },
];

describe("workdayCountryFacets — reads the per-tenant parameter off the response", () => {
  it("finds country leaves under the parameter that owns them", () => {
    const got = workdayCountryFacets(facetTree("locationHierarchy1", [["India", "i1", 209], ["United States of America", "u1", 1418]]));
    expect(got["India"]).toEqual({ id: "i1", param: "locationHierarchy1", count: 209 });
    expect(got["United States of America"].param).toBe("locationHierarchy1");
    expect(got["Engineering"]).toBeUndefined(); // a non-location facet must never be read as a country
  });

  it("returns nothing for a board with no location facet at all", () => {
    expect(workdayCountryFacets([{ facetParameter: "jobFamilyGroup", descriptor: "Job Category", values: [{ descriptor: "Sales", id: "x", count: 1 }] }])).toEqual({});
    expect(workdayCountryFacets(undefined)).toEqual({});
  });
});

describe("workdayMarketFilter — only the markets a real user can be in", () => {
  // Every one of these is a parameter name seen on a live board. If a future
  // change hardcodes a single name, all but one of these assertions fails.
  it.each(["locationCountry", "locationHierarchy1", "Country", "locations", "Location_Country", "Country___Territory"])(
    "works when the tenant calls the parameter %s",
    (param) => {
      const f = workdayMarketFilter(facetTree(param, [["India", "i1", 209], ["United States of America", "u1", 1418], ["Taiwan", "t1", 126]]));
      expect(f.param).toBe(param);
      expect(f.ids.sort()).toEqual(["i1", "u1"]); // Taiwan excluded
      expect(f.counted).toBe(1627);
    },
  );

  it("picks up all four markets and excludes everything else", () => {
    const f = workdayMarketFilter(
      facetTree("locationCountry", [
        ["India", "i", 10], ["United States", "u", 20], ["Canada", "c", 30], ["Australia", "a", 40],
        ["United Kingdom", "k", 50], ["Israel", "s", 60], ["China", "n", 70],
      ]),
    );
    expect(f.ids.sort()).toEqual(["a", "c", "i", "u"]);
    // The UK is NOT a market — homeRegion() classifies a UK candidate as "other", so a UK role can
    // never be reachable by anyone. Pulling them would be pure waste.
    expect(f.ids).not.toContain("k");
    expect(f.counted).toBe(100);
  });

  // The fallback that keeps boards without a usable facet working. Returning null here means "pull
  // unfiltered", NOT "pull nothing" — a filter that cannot be built must never become a board that
  // contributes zero.
  it("returns null when the board exposes no country facet, so the caller falls back to unfiltered", () => {
    expect(workdayMarketFilter([{ facetParameter: "jobFamilyGroup", descriptor: "Job Category", values: [{ descriptor: "Sales", id: "x", count: 1 }] }])).toBe(null);
    expect(workdayMarketFilter([])).toBe(null);
    expect(workdayMarketFilter(undefined)).toBe(null);
  });

  it("returns null when the board has countries but none of ours", () => {
    expect(workdayMarketFilter(facetTree("locationCountry", [["Taiwan", "t", 1], ["Israel", "s", 2]]))).toBe(null);
  });

  it("keeps every id under ONE parameter — Workday only ORs ids inside a single facet array", () => {
    const mixed = [
      { facetParameter: "locationCountry", values: [{ descriptor: "Locations", values: [{ descriptor: "India", id: "i", count: 5 }] }] },
      { facetParameter: "someOtherParam", values: [{ descriptor: "Locations", values: [{ descriptor: "Canada", id: "c", count: 5 }] }] },
    ];
    const f = workdayMarketFilter(mixed);
    expect(f.ids).toEqual(["i"]); // the second parameter's id is dropped, not merged into the first
    expect(f.param).toBe("locationCountry");
  });
});

// ── the watchlist itself ─────────────────────────────────────────────────────
//
// Many boards come from an automated enumeration of live tenants. These assertions guard the two
// ways such a batch can go wrong quietly.
//
// 1. A MALFORMED ENTRY IS A SILENT ZERO. `dc` and `site` are both interpolated straight into the CXS
//    URL. An entry missing either builds a URL that 404s, fetchBoard records `notfound`, and the
//    board simply never appears — indistinguishable from an employer with no open roles.
// 2. A DUPLICATE FETCHES TWICE. Workday's CXS path is case-insensitive, so the crawl yields
//    `pwc/Global_Experienced_Careers` and `pwc/global_experienced_careers` as separate rows with
//    identical totals. Both in the watchlist means every posting on that board is fetched, hydrated
//    and paid for twice.
describe("watchlist-workday.json", () => {
  const boards = JSON.parse(readFileSync("watchlist-workday.json", "utf8"));

  it("carries every field ENDPOINT.workday interpolates into the URL", () => {
    const broken = boards.filter((b) => !b.slug || !b.dc || !b.site || !b.company);
    expect(broken.map((b) => b.slug ?? "(no slug)")).toEqual([]);
  });

  it("declares the source and segment the scanner dispatches on", () => {
    expect(boards.every((b) => b.source === "workday")).toBe(true);
    expect(boards.every((b) => b.segment === "workday")).toBe(true);
  });

  it("has no duplicate board, case-insensitively — Workday's CXS path ignores case", () => {
    const keys = boards.map((b) => `${b.slug}|${b.dc}|${b.site}`.toLowerCase());
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect([...new Set(dupes)]).toEqual([]);
  });

  it("uses a dc that looks like a Workday datacenter, since it is interpolated into the host", () => {
    // "wd5", "wd103". Anything else means the entry was hand-written wrong and the host will not resolve.
    const bad = boards.filter((b) => !/^wd\d+$/.test(b.dc));
    expect(bad.map((b) => `${b.slug}:${b.dc}`)).toEqual([]);
  });

  it("names a real employer, never a raw slug copied in verbatim", () => {
    // `company` is printed in the role email a person reads, so it must be a name somebody
    // established — not the URL token echoed back.
    //
    // The check is deliberately EXACT-CASE. "Accenture" for slug `accenture` is correct and common:
    // the slug IS the brand, and someone capitalised it. "accenture" verbatim is the tell that
    // nobody looked. A case-insensitive version of this assertion would flag correct entries and
    // enforce nothing.
    const lazy = boards.filter((b) => !b.company.trim() || b.company === b.slug);
    expect(lazy.map((b) => b.slug)).toEqual([]);
  });
});

// ── the watchlist dedupe ─────────────────────────────────────────────────────
//
// WHY THE DEDUPE KEY INCLUDES dc/site. Deduping the watchlist on `source:slug` is correct for every
// source where a slug IS a board — but a Workday TENANT hosts several boards that differ only by
// `dc`/`site`, and they are routinely DIFFERENT EMPLOYERS:
//
//   slihrms/Careers      = AtkinsRealis        slihrms/Linxon  = Linxon
//   harriscomputer/1     = Harris Computer     harriscomputer/Altera = Altera Digital Health
//   relx/relx            = RELX                relx/RiskSolutions    = LexisNexis Risk Solutions
//
// Keying on source:slug alone drops the second of each pair before any fetch, and because the drop
// happens while building the watchlist, `attempted` never counts it: an entry that reads as present
// in the file and is silently never fetched.
describe("boardKey — one board per endpoint, not per slug", () => {
  const mk = (o) => ({ source: "workday", slug: "slihrms", dc: "wd3", ...o });

  it("separates two boards on ONE tenant that differ only by site", () => {
    expect(boardKey(mk({ site: "Careers" }))).not.toBe(boardKey(mk({ site: "Linxon" })));
  });

  it("separates two boards that differ only by datacenter", () => {
    expect(boardKey(mk({ dc: "wd3", site: "X" }))).not.toBe(boardKey(mk({ dc: "wd5", site: "X" })));
  });

  it("still collapses a genuine duplicate — the reason the dedupe exists", () => {
    // A company in both the curated base list and a feed must still be fetched once.
    expect(boardKey(mk({ site: "Careers" }))).toBe(boardKey(mk({ site: "Careers" })));
    expect(boardKey({ source: "greenhouse", slug: "stripe" })).toBe(boardKey({ source: "greenhouse", slug: "stripe" }));
  });

  it("is unchanged for every source whose slug alone is the endpoint", () => {
    // Most watchlist entries have no dc/site/host/domain. Their key must still be source:slug with
    // empty trailers, so this cannot alter their dedupe.
    expect(boardKey({ source: "greenhouse", slug: "stripe" })).toBe("greenhouse:stripe::::");
    expect(boardKey({ source: "GREENHOUSE", slug: "Stripe" })).toBe("greenhouse:stripe::::");
  });

  it("separates two Eightfold tenants that differ only by host", () => {
    expect(boardKey({ source: "eightfold", slug: "x", host: "a.eightfold.ai", domain: "a.com" }))
      .not.toBe(boardKey({ source: "eightfold", slug: "x", host: "b.eightfold.ai", domain: "b.com" }));
  });

  it("fetches every board in the real watchlist — none silently discarded", () => {
    // Every board in the file must survive the dedupe.
    const boards = JSON.parse(readFileSync("watchlist-workday.json", "utf8"));
    const keys = new Set(boards.map(boardKey));
    expect(keys.size).toBe(boards.length);
  });
});

// ── the watchlist as the scanner actually sees it ────────────────────────────
//
// The watchlist files are concatenated before the dedupe (scan-jobs.mjs), so "already in the
// watchlist" is a question about ALL of them, not about the file being edited. A duplicate is not
// fatal (the dedupe drops it) but it is a lie in the file: an entry someone will later count, cost,
// and believe is being fetched.
describe("the merged watchlist", () => {
  // WATCHLIST_SEGMENT_PATHS + the base file. Some segment files (watchlist-yc.json,
  // watchlist-india.json) are generated and gitignored, so they exist on an operator's machine but
  // NOT in CI or a fresh clone. Reading them unconditionally would throw at module scope and take
  // the whole suite with it. Skip what is absent, and assert on what is there — scan-jobs.mjs itself
  // is equally tolerant (it try/catches each path).
  const FILES = ["watchlist.json", "watchlist-yc.json", "watchlist-india.json", "watchlist-workday.json", "watchlist-eightfold.json"]
    .filter((f) => existsSync(f));
  const all = FILES.flatMap((f) => JSON.parse(readFileSync(f, "utf8")).map((e) => ({ ...e, __file: f })));

  it("actually read some watchlists (otherwise every assertion below passes vacuously)", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeGreaterThan(1000);
  });

  it("lists every board exactly once across all five files", () => {
    const byKey = new Map();
    const dupes = [];
    for (const e of all) {
      const k = boardKey(e);
      if (byKey.has(k)) dupes.push(`${k} in ${e.__file} and ${byKey.get(k).__file}`);
      else byKey.set(k, e);
    }
    expect(dupes).toEqual([]);
  });

  it("gives every Keka board its tenant GUID, which is part of its URL", () => {
    // ENDPOINT.keka interpolates entry.identifier. Without it the URL ends in a bare slash, the feed
    // 404s, and the board reads as "not found" rather than "misconfigured".
    const broken = all.filter((e) => e.source === "keka" && !e.identifier);
    expect(broken.map((e) => e.slug)).toEqual([]);
  });

  it("gives every board a slug and a company", () => {
    const broken = all.filter((e) => !e.slug || !e.company);
    expect(broken.map((e) => e.slug ?? "(no slug)")).toEqual([]);
  });
});

// ── jobs.json and the V8 string ceiling ──────────────────────────────────────
//
// THE FAILURE THIS PREVENTS. jobs.json is written as ONE `JSON.stringify` string and read back by
// scheduler.mjs as one `readFileSync` string. V8 caps a string at 536,870,888 characters. That is a
// runtime limit, not a tuning knob.
//
// An uncapped, pretty-printed posting is ~7 KB, so the write throws `RangeError: Invalid string
// length` at roughly 77,000 postings — a pool size the watchlist can reach.
//
// The shape of that failure is the worst one: the write sits OUTSIDE every try/catch, so the
// RangeError reaches main().catch, exits 1, and engine:run's && chain silently drops scheduler,
// digest and newsletter. Nobody gets an email and the container reports a crash.
describe("serializeJobsFile — jobs.json cannot outgrow the V8 string ceiling", () => {
  const MAX = 536_870_888;
  // A realistically sized posting: an ~8,500-char JD with a requirements section at the end, so
  // the cap has to slide rather than head-slice.
  const posting = (i) => ({
    id: `greenhouse:acme:${i}`, source: "greenhouse", company: "Acme", slug: "acme",
    title: "Staff Product Designer", location: "Bengaluru, India", remote: null, team: null,
    employment_type: null, compensation: null, apply_url: `https://acme.com/${i}`,
    posted_at: "2026-07-30T00:00:00.000Z", first_seen: "x", last_seen: "y",
    description: "About the role. ".repeat(500) + " Requirements: 8+ years of product design, a portfolio, and experience with design systems.",
  });

  it("keeps 90,000 postings — the size this watchlist now implies — under the ceiling", () => {
    const out = serializeJobsFile(Array.from({ length: 90_000 }, (_, i) => posting(i)));
    expect(out.length).toBeLessThan(MAX);
  }, 60_000); // builds a ~90,000-posting file: give it room on a slow or busy machine

  it("proves the regression: the SAME pool uncapped throws the exact production error", () => {
    // cap: Infinity is byte-for-byte the uncapped `JSON.stringify(kept, null, 2)`. V8 refuses to
    // build the string at all: RangeError, outside every try/catch, exit 1, no emails.
    // If this ever stops throwing, the test above has gone vacuous and the guard guards nothing.
    const jobs = Array.from({ length: 90_000 }, (_, i) => posting(i));
    expect(() => serializeJobsFile(jobs, { cap: Infinity })).toThrow(/Invalid string length/);
  }, 60_000);

  it("keeps the requirements, which is the whole reason the cap slides", () => {
    // fit-coverage reads the requirements to build the readout. A blind head-slice would drop them
    // and every Readout would mark real requirements "not shown".
    const out = JSON.parse(serializeJobsFile([posting(1)]));
    expect(out[0].description).toMatch(/Requirements/);
    expect(out[0].description.length).toBeLessThanOrEqual(2500);
  });

  it("leaves a short description untouched", () => {
    const short = { ...posting(1), description: "A small job ad." };
    expect(JSON.parse(serializeJobsFile([short]))[0].description).toBe("A small job ad.");
  });

  it("survives postings with no description at all", () => {
    const rows = [{ id: "a" }, { id: "b", description: null }, null];
    expect(() => serializeJobsFile(rows)).not.toThrow();
    expect(JSON.parse(serializeJobsFile(rows))).toHaveLength(3);
  });
});
