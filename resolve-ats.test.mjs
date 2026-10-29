// resolve-ats.test.mjs — Vitest fixtures for the verified slug-probe resolver.
// candidateSlugs is pure (no network); resolveAts is exercised with a stubbed global fetch that
// returns a job array only for the "correct" endpoint, so tests stay offline and deterministic.
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveAts, candidateSlugs, extractHostSlugs } from "./resolve-ats.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("candidateSlugs — derive from a company's own facts", () => {
  it("uses YC slug, domain label, and name (deduped, capped)", () => {
    expect(candidateSlugs({ slug: "acme", website: "https://www.acme.com", name: "Acme Inc" })).toEqual(["acme", "acmeinc"]);
  });
  it("strips get/join/try prefixes from the domain label", () => {
    expect(candidateSlugs({ website: "https://getlago.com", name: "Lago" })).toEqual(["getlago", "lago"]);
  });
  it("drops generic stopwords and too-short tokens", () => {
    expect(candidateSlugs({ slug: "app", website: "https://jobs.io", name: "Go" })).toEqual([]);
  });
});

// Build a fetch stub that returns a valid jobs payload ONLY for `source`+`slug`; everything else 404s.
function stubBoard(source, slug, jobCount = 3) {
  const jobs = Array.from({ length: jobCount }, (_, i) => ({ id: i }));
  const payloadFor = {
    ashby: { jobs },
    greenhouse: { jobs },
    lever: jobs, // lever is a bare array
    smartrecruiters: { content: jobs },
    recruitee: { offers: jobs },
    workable: { jobs },
    kula: { data: jobs }, // kula's feed is under `data`, filtered by JOBS_KEY.kula
  };
  return vi.fn(async (url) => {
    const u = String(url);
    const hostMatch =
      (source === "ashby" && u.includes(`/job-board/${slug}?`)) ||
      (source === "greenhouse" && u.includes(`/boards/${slug}/jobs`)) ||
      (source === "lever" && u.includes(`/postings/${slug}?`)) ||
      (source === "smartrecruiters" && u.includes(`/companies/${slug}/postings`)) ||
      (source === "recruitee" && u.includes(`//${slug}.recruitee.com`)) ||
      (source === "workable" && u.includes(`/accounts/${slug}?`)) ||
      (source === "kula" && u.includes(`accountName=${slug}`));
    if (hostMatch) return { ok: true, json: async () => payloadFor[source] };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("resolveAts — verified slug-probe", () => {
  it.each(["ashby", "greenhouse", "lever", "smartrecruiters", "recruitee", "workable", "kula"])(
    "resolves a live %s board on the domain-label slug",
    async (source) => {
      vi.stubGlobal("fetch", stubBoard(source, "acme"));
      expect(await resolveAts({ website: "https://acme.com", name: "Acme" })).toEqual({ source, slug: "acme" });
    },
  );

  it("resolves via the YC slug when it differs from the domain", async () => {
    vi.stubGlobal("fetch", stubBoard("greenhouse", "acmehq"));
    expect(await resolveAts({ slug: "acmehq", website: "https://acme.com", name: "Acme" })).toEqual({ source: "greenhouse", slug: "acmehq" });
  });

  it("accepts a bare website string (the resolveAts(websiteUrl) shape)", async () => {
    vi.stubGlobal("fetch", stubBoard("ashby", "acme"));
    expect(await resolveAts("https://acme.com")).toEqual({ source: "ashby", slug: "acme" });
  });

  it("returns null when no candidate slug hosts a live board (unresolvable)", async () => {
    // every endpoint 404s
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await resolveAts({ website: "https://acme.com", name: "Acme" })).toBeNull();
  });

  it("does NOT accept a board that resolves but has zero postings", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) =>
      String(url).includes("greenhouse") ? { ok: true, json: async () => ({ jobs: [] }) } : { ok: false, status: 404, json: async () => ({}) },
    ));
    expect(await resolveAts({ slug: "acme" })).toBeNull();
  });

  it("returns null (never throws) when every fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await resolveAts({ website: "https://acme.com" })).toBeNull();
  });

  it("returns null for an empty/invalid company", async () => {
    expect(await resolveAts("")).toBeNull();
    expect(await resolveAts(null)).toBeNull();
  });
});

describe("extractHostSlugs — mine {source, slug} from careers HTML", () => {
  it("pulls every distinct ATS host, deduped, generic slugs dropped", () => {
    const html = `
      <a href="https://jobs.ashbyhq.com/9-mothers">Jobs</a>
      <a href="https://jobs.ashbyhq.com/9-mothers">dup</a>
      <iframe src="https://boards.greenhouse.io/embed/job_board?for=acmehq"></iframe>
      <a href="https://boards.greenhouse.io/www">generic</a>`;
    expect(extractHostSlugs(html)).toEqual([
      { source: "greenhouse", slug: "acmehq" },
      { source: "ashby", slug: "9-mothers" },
    ]);
  });
  it("returns [] for HTML with no ATS host", () => {
    expect(extractHostSlugs("<a href='/about'>About</a>")).toEqual([]);
  });
});

describe("resolveAts — careers-mine fallback, still verified", () => {
  // facts-probe misses (candidate slugs 404), but the careers page reveals the EXACT slug,
  // which then confirms live. This is the case the combined approach exists for.
  it("recovers an exact slug from careers HTML and confirms it live", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/careers")) {
        return { ok: true, url: u, text: async () => '<a href="https://jobs.ashbyhq.com/9-mothers">Careers</a>' };
      }
      if (u.includes("/job-board/9-mothers?")) {
        return { ok: true, json: async () => ({ jobs: [{ id: 1 }, { id: 2 }] }) }; // exact slug is live
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "<html></html>" };
    });
    vi.stubGlobal("fetch", fetchMock);
    // name "9 Mothers" -> facts candidate "9mothers" (no hyphen) never matches the real "9-mothers"
    expect(await resolveAts({ website: "https://9mothers.com", name: "9 Mothers", slug: "9-mothers-yc" })).toEqual({
      source: "ashby",
      slug: "9-mothers",
    });
  });

  it("does NOT accept a careers-mined slug whose board is dead (false-positive guard)", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/careers")) {
        return { ok: true, url: u, text: async () => '<a href="https://boards.greenhouse.io/ghost">Careers</a>' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "<html></html>" }; // board 404s
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveAts({ website: "https://ghost.com", name: "Ghost" })).toBeNull();
  });
});

// ── Keka: the two-step probe ─────────────────────────────────────────────────
// Keka's feed is addressed by tenant GUID, not slug, so the single-GET probe above structurally
// cannot see it. Without the handshake an Indian company on Keka would be queued as "no live ATS
// board found", indistinguishable from one with no board at all.
describe("resolveAts — keka needs a GUID handshake, not a slug", () => {
  // careers shell embeds the tenant GUID in its own asset paths; the feed is then addressed by it.
  const GUID = "ed2b6b25-1111-4222-8333-444455556666";
  function stubKeka({ jobs = [{ id: 1 }], guidInShell = true } = {}) {
    return vi.fn(async (url) => {
      const u = String(url);
      if (u.includes(".keka.com/careers/api/embedjobs/")) {
        return u.includes(GUID) ? { ok: true, json: async () => jobs } : { ok: false, status: 404, json: async () => ({}) };
      }
      if (u.includes(".keka.com/careers")) {
        const body = guidInShell ? `<img src="/ats/documents/${GUID}/logo.png">` : "<html>no guid here</html>";
        return { ok: true, url: u, text: async () => body };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "<html></html>" };
    });
  }

  it("resolves a live keka board and carries the GUID as `identifier`", async () => {
    vi.stubGlobal("fetch", stubKeka());
    // Without `identifier` on the row, scan-jobs.mjs cannot build the feed URL and the board never
    // scans — a resolved-but-unscannable row is worse than an unresolved one, because it looks done.
    expect(await resolveAts({ slug: "zluri" })).toEqual({ source: "keka", slug: "zluri", identifier: GUID });
  });

  it("stays null when the careers shell exposes no GUID — never an unverified slug", async () => {
    vi.stubGlobal("fetch", stubKeka({ guidInShell: false }));
    expect(await resolveAts({ slug: "zluri" })).toBeNull();
  });

  it("stays null when the GUID resolves but the board has no postings (same bar as every source)", async () => {
    vi.stubGlobal("fetch", stubKeka({ jobs: [] }));
    expect(await resolveAts({ slug: "zluri" })).toBeNull();
  });

  it("does not add `identifier` to a non-keka hit — every other return stays byte-identical", async () => {
    vi.stubGlobal("fetch", stubBoard("greenhouse", "acme"));
    expect(await resolveAts({ slug: "acme" })).toEqual({ source: "greenhouse", slug: "acme" });
  });

  it("only spends the extra round trip when the cheap sources all miss", async () => {
    const fetchMock = stubBoard("lever", "acme");
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveAts({ slug: "acme" })).toEqual({ source: "lever", slug: "acme" });
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("keka.com")),
      "a single-GET winner must not trigger the keka handshake",
    ).toBe(false);
  });
});
