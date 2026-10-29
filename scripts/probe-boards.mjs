// scripts/probe-boards.mjs — verify candidate ATS job boards before adding them to watchlist.json.
//
//   node scripts/probe-boards.mjs candidates.json   probe every {company, slug, source?} candidate
//
// For each candidate it hits the live ATS API (same endpoints scan-jobs.mjs uses), counts total
// postings and India-located ones, and prints only the boards that actually resolve. If `source`
// is omitted it tries every provider so a company name alone is enough. Nothing is invented: a
// board is kept ONLY if its API returns real jobs. Writes verified hits to <input>.verified.json.

import { readFileSync, writeFileSync } from "node:fs";

const ENDPOINT = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(s)}/postings?limit=100`,
  recruitee: (s) => `https://${encodeURIComponent(s)}.recruitee.com/api/offers/`,
  kula: (s) => `https://careers.kula.ai/api/internal/ats_job_posts?accountName=${encodeURIComponent(s)}&page=1&items=99&type=ats_job_post.index`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
};
const JOBS_KEY = {
  ashby: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  greenhouse: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
  lever: (d) => (Array.isArray(d) ? d : null),
  smartrecruiters: (d) => (Array.isArray(d?.content) ? d.content : null),
  recruitee: (d) => (Array.isArray(d?.offers) ? d.offers : null),
  kula: (d) => (Array.isArray(d?.data) ? d.data.filter((j) => j && j.listed !== false && j.kind !== "internal") : null),
  workable: (d) => (Array.isArray(d?.jobs) ? d.jobs : null),
};
const ALL = Object.keys(ENDPOINT);
const INDIA = /\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|gurgaon|gurugram|chennai|noida|kolkata|ahmedabad|kochi|trivandrum|thiruvananthapuram|jaipur|indore|coimbatore|remote,? india|\bka\b|\bmh\b|\bts\b)\b/i;

async function fetchJson(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 charlie-probe" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function probe(source, slug) {
  const data = await fetchJson(ENDPOINT[source](slug));
  if (!data) return null;
  const jobs = JOBS_KEY[source](data);
  if (!jobs || jobs.length === 0) return null;
  const india = jobs.filter((j) => INDIA.test(JSON.stringify(j))).length;
  return { total: jobs.length, india };
}

const inFile = process.argv[2];
if (!inFile) { console.error("usage: node scripts/probe-boards.mjs candidates.json"); process.exit(1); }
const candidates = JSON.parse(readFileSync(inFile, "utf8"));

const CONC = 8;
const verified = [];
let done = 0;
async function worker(queue) {
  while (queue.length) {
    const c = queue.shift();
    const sources = c.source ? [c.source] : ALL;
    for (const src of sources) {
      const r = await probe(src, c.slug);
      done++;
      if (r) {
        verified.push({ company: c.company, slug: c.slug, source: src, total: r.total, india: r.india });
        console.log(`  HIT  ${String(c.company).padEnd(24)} ${src.padEnd(15)} ${c.slug.padEnd(22)} jobs:${String(r.total).padEnd(4)} india:${r.india}`);
        break; // first provider that resolves wins
      }
    }
  }
}
console.log(`probing ${candidates.length} candidates across ${ALL.length} providers...\n`);
const queue = [...candidates];
await Promise.all(Array.from({ length: CONC }, () => worker(queue)));

// summary
const withIndia = verified.filter((v) => v.india > 0);
const totalIndiaJobs = verified.reduce((a, v) => a + v.india, 0);
console.log(`\n${verified.length} boards resolved · ${withIndia.length} have India roles · ${totalIndiaJobs} India roles total`);
writeFileSync(inFile.replace(/\.json$/, "") + ".verified.json", JSON.stringify(verified, null, 2));
console.log(`wrote ${inFile.replace(/\.json$/, "")}.verified.json`);
