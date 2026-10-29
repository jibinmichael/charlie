// scan-boards.mjs — supplementary REMOTE job boards, normalized into Charlie's canonical
// job shape and merged into the scan (scan-jobs.mjs) with dedup so a posting Charlie already
// has from the source ATS wins. These aggregate remote-first roles, many from companies not
// on the ATS watchlist, which widens remote/remote-global coverage.
//
// Sources (all free, no auth): RemoteOK, Remotive, Himalayas. Each posting carries its
// attribution (`via` + `via_url`) so we honor each board's terms when we surface it:
// RemoteOK asks for a dofollow backlink, Remotive and Himalayas ask for a name credit.

const UA = { "User-Agent": "CharlieJobAgent/1.0 (+https://example.com)", accept: "application/json" };
const TIMEOUT_MS = 12000;

function stripHtml(html) {
  if (!html || typeof html !== "string") return null;
  const t = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t || null;
}
const decode = (s) =>
  typeof s === "string"
    ? s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim()
    : s;

async function getJSON(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: UA, signal: c.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Like getJSON but returns the raw response body as text (for RSS/XML feeds). Uses an
// rss/xml accept header instead of application/json.
async function getText(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA["User-Agent"], accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: c.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Decode XML entities so an RSS field that carries entity-encoded HTML (e.g. &lt;p&gt;)
// becomes real markup that stripHtml() can clean. &amp; is decoded LAST so a single-encoded
// string is not mangled (mirrors scan-jobs.mjs decodeEntities).
function unescapeXml(s) {
  if (!s || typeof s !== "string") return s ?? null;
  return s
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
}

// Pull the inner text of the first <tag>…</tag> from an RSS <item> block. Returns null if
// absent. Tolerates attributes on the opening tag (e.g. <guid isPermaLink="false">).
function tag(item, name) {
  const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : null;
}

// Canonical shape — must match scan-jobs.mjs normalize() so the rest of the pipeline (freshness,
// dedup, match, compose, email) treats board jobs exactly like ATS jobs. `slug` is the board
// name so the disappearance test groups a board's jobs under one key. `via`/`via_url` = credit.
function canon(o) {
  return {
    id: `${o.source}:${o.slug}:${o.jobId ?? "unknown"}`,
    source: o.source,
    company: o.company ?? null,
    slug: o.slug,
    title: o.title ?? null,
    location: o.location ?? null,
    remote: o.remote ?? true,
    team: o.team ?? null,
    employment_type: o.employment_type ?? null,
    compensation: o.compensation ?? null,
    apply_url: o.apply_url ?? null,
    posted_at: o.posted_at ?? null,
    description: o.description ?? null,
    via: o.via ?? null,
    via_url: o.via_url ?? null,
  };
}

async function remoteok() {
  const d = await getJSON("https://remoteok.com/api");
  if (!Array.isArray(d)) return [];
  return d
    .filter((j) => j && j.id && j.position)
    .map((j) =>
      canon({
        source: "remoteok", slug: "remoteok", jobId: j.id,
        company: decode(j.company), title: decode(j.position),
        location: j.location || "Remote", remote: true,
        team: Array.isArray(j.tags) ? j.tags[0] : null,
        compensation: j.salary_min || j.salary_max ? `${j.salary_min ?? "?"}-${j.salary_max ?? "?"} USD` : null,
        apply_url: j.apply_url || j.url,
        posted_at: j.date || (j.epoch ? new Date(j.epoch * 1000).toISOString() : null),
        description: stripHtml(j.description),
        via: "RemoteOK", via_url: j.url,
      }),
    );
}

async function remotive() {
  const d = await getJSON("https://remotive.com/api/remote-jobs");
  const jobs = d && Array.isArray(d.jobs) ? d.jobs : [];
  return jobs.map((j) =>
    canon({
      source: "remotive", slug: "remotive", jobId: j.id,
      company: j.company_name, title: j.title,
      location: j.candidate_required_location || "Remote", remote: true,
      team: j.category || null, employment_type: j.job_type || null,
      compensation: j.salary && String(j.salary).trim() ? String(j.salary).trim() : null,
      apply_url: j.url, posted_at: j.publication_date || null,
      description: stripHtml(j.description),
      via: "Remotive", via_url: j.url,
    }),
  );
}

async function himalayas() {
  const d = await getJSON("https://himalayas.app/jobs/api?limit=100");
  const jobs = d && Array.isArray(d.jobs) ? d.jobs : [];
  return jobs.map((j) =>
    canon({
      source: "himalayas", slug: "himalayas", jobId: j.guid || j.applicationLink,
      company: j.companyName, title: j.title,
      location: Array.isArray(j.locationRestrictions) && j.locationRestrictions.length ? j.locationRestrictions.join(", ") : "Remote",
      remote: true, team: Array.isArray(j.categories) ? j.categories[0] : null,
      employment_type: j.employmentType || null,
      compensation: j.minSalary || j.maxSalary ? `${j.minSalary ?? "?"}-${j.maxSalary ?? "?"} ${j.currency ?? ""}`.trim() : null,
      apply_url: j.applicationLink,
      posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
      description: stripHtml(j.description),
      via: "Himalayas", via_url: typeof j.guid === "string" && j.guid.startsWith("http") ? j.guid : j.applicationLink,
    }),
  );
}

// We Work Remotely publishes an RSS feed (not JSON), 100 latest roles across all categories.
// Each <item> title is "Company: Job Title" (company before the first colon); region carries
// the location, type the employment type, category the team, and description is entity-encoded
// HTML. All roles are remote. WWR's terms ask for a link back, so via_url points at the posting.
async function weworkremotely() {
  const xml = await getText("https://weworkremotely.com/remote-jobs.rss");
  if (!xml || typeof xml !== "string") return [];
  const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  return items.map((block) => {
    const rawTitle = decode(unescapeXml(tag(block, "title")) || "");
    // company is everything before the first colon; the rest is the role. No colon -> title only.
    const ci = rawTitle.indexOf(":");
    const company = ci > 0 ? rawTitle.slice(0, ci).trim() : null;
    const title = ci > 0 ? rawTitle.slice(ci + 1).trim() : rawTitle.trim() || null;
    const link = tag(block, "link");
    const guid = tag(block, "guid") || link;
    const region = decode(unescapeXml(tag(block, "region")));
    const pub = tag(block, "pubDate");
    let posted_at = null;
    if (pub) { const t = Date.parse(pub); if (!Number.isNaN(t)) posted_at = new Date(t).toISOString(); }
    return canon({
      source: "weworkremotely", slug: "weworkremotely", jobId: guid || link,
      company, title,
      location: region || "Remote", remote: true,
      team: decode(unescapeXml(tag(block, "category"))) || null,
      employment_type: decode(unescapeXml(tag(block, "type"))) || null,
      apply_url: link, posted_at,
      description: stripHtml(unescapeXml(tag(block, "description"))),
      via: "We Work Remotely", via_url: link,
    });
  }).filter((j) => j.title && j.apply_url);
}

// Fetch all boards (independently — one failing never blocks the others). Returns canonical
// jobs plus the set of sources that actually responded (so the caller's disappearance test
// never false-closes a board's jobs on a transient outage).
export async function fetchBoardJobs(log = console.error) {
  // We Work Remotely is NOT wired in. Its feed carries listings that are not on the employer's own
  // careers site, and its region tag can contradict the posting body. A source that cannot be trusted
  // on WHO is hiring and WHERE is worse than no source: it spends a person's one role of the day on
  // something that may not exist. The reader above is kept, unwired, so re-enabling is one line.
  const defs = [["remoteok", remoteok], ["remotive", remotive], ["himalayas", himalayas]];
  const settled = await Promise.allSettled(defs.map(([, fn]) => fn()));
  const jobs = [];
  const okSources = new Set();
  const stat = {};
  settled.forEach((r, i) => {
    const name = defs[i][0];
    const arr = r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [];
    stat[name] = arr.length;
    if (arr.length) okSources.add(name);
    jobs.push(...arr);
  });
  log(`[boards] ${JSON.stringify(stat)} -> ${jobs.length} remote jobs`);
  return { jobs, okSources };
}
