// url-ingest.mjs — work ingestion: "paste a link, Charlie reads it". Turns URLs a person drops into their email into grounded dossier SOURCES, tiered by
// verifiability (the whole grounding contract):
//
//  - GitHub (repo or profile) → read via the GitHub API. The facts it returns (stars, primary
//    language, repo existence, the person's public repo count) are EXTERNALLY CHECKABLE, so this is an
//    ARTIFACT source. README text is included as context but the verifiable signal is the API data.
//  - Any other URL (portfolio, personal site, Notion) → fetched (SSRF-guarded) and stripped to text.
//    The page EXISTS (checkable) but its content is SELF-AUTHORED narrative, so it is a CLAIM source —
//    the dossier's TIER_ADDENDUM keeps its prose out of evidence unless it names something concrete.
//
// Everything is best-effort: a fetch that fails or is blocked just yields no source, never throws.

import { safeFetch } from "./safe-fetch.mjs";

const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const ghHeaders = (accept = "application/vnd.github+json") => ({
  accept,
  "user-agent": "CharlieBot",
  ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}),
});

// A page that is asking us to log in has not been read. Two signals must BOTH appear, because either
// alone is too common to trust: a sign-in prompt AND a gate on the content itself ("join to view",
// "create a free account to continue"). A public blog with a "Sign in" link in its header keeps
// working; a profile behind a wall does not.
//
// Exported for the test, which drives text shaped like a real captured LinkedIn wall.
export function looksGated(text) {
  const t = String(text || "");
  const signIn = /\b(sign in|log ?in|join now|create (a )?(free )?account)\b/i.test(t);
  const gated = /\bjoin to view\b|\bsign ?up to (view|see|continue)\b|\b(view|see) (the )?full profile\b|\bcreate (a|an)? ?(free )?account to (view|see|continue)\b|\bregister to (view|continue)\b|authwall/i.test(t);
  return signIn && gated;
}

// pull up to `max` distinct http(s) URLs out of free text
export function extractUrls(text, max = 6) {
  const found = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const seen = new Set();
  const out = [];
  for (let u of found) {
    u = u.replace(/[.,;:)]+$/, ""); // trailing punctuation
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

const GH_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)(?:\/([^/\s]+))?/i;

async function ingestGitHub(url, ownedLogins = new Set()) {
  const m = url.match(GH_RE);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2] ? m[2].replace(/\.git$/, "") : null;
  const owned = ownedLogins.has(owner.toLowerCase()); // repo sits in a profile the person also linked
  // skip non-user paths github uses for its own features
  if (/^(features|about|pricing|marketplace|topics|explore|sponsors|orgs|settings)$/i.test(owner)) return null;
  try {
    if (repo) {
      const r = await safeFetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: ghHeaders(), timeoutMs: 9000 });
      if (!r.ok) return null;
      const j = await r.json();
      let readme = "";
      try {
        const rr = await safeFetch(`https://api.github.com/repos/${owner}/${repo}/readme`, { headers: ghHeaders("application/vnd.github.raw+json"), timeoutMs: 9000 });
        if (rr.ok) readme = (await rr.text()).replace(/\s+/g, " ").trim().slice(0, 1500);
      } catch { /* readme optional */ }
      const facts = [
        `GitHub repository (verified live via the GitHub API, so these are externally checkable facts):`,
        `- full name: ${j.full_name}`,
        j.description ? `- description: ${j.description}` : "",
        `- primary language: ${j.language || "not stated"}`,
        `- stars: ${j.stargazers_count ?? 0}, forks: ${j.forks_count ?? 0}`,
        j.homepage ? `- linked site: ${j.homepage}` : "",
        `- url: ${j.html_url}`,
        owned
          ? `- ATTRIBUTION: this repo is owned by the GitHub profile the person ALSO linked (@${owner}), so their ownership of the namespace is corroborated. Still confirm their specific contribution (a shared repo has many contributors) before crediting a claim to them.`
          : `- ATTRIBUTION: linking this repo proves it EXISTS with these public stats; it does NOT prove this person authored it. Do NOT credit it as their work; treat it as context and note that authorship must be confirmed.`,
        readme ? `\nREADME (project's own words, context only): ${readme}` : "",
      ].filter(Boolean).join("\n");
      return { label: `github repo ${j.full_name}`, trust: "artifact", text: facts };
    }
    // profile URL
    const r = await safeFetch(`https://api.github.com/users/${owner}`, { headers: ghHeaders(), timeoutMs: 9000 });
    if (!r.ok) return null;
    const u = await r.json();
    let top = [];
    try {
      const rr = await safeFetch(`https://api.github.com/users/${owner}/repos?per_page=100&type=owner`, { headers: ghHeaders(), timeoutMs: 9000 });
      if (rr.ok) {
        const repos = await rr.json();
        top = (Array.isArray(repos) ? repos : [])
          .filter((x) => !x.fork)
          .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
          .slice(0, 5)
          .map((x) => `${x.name} (${x.language || "?"}, ${x.stargazers_count || 0}★)`);
      }
    } catch { /* repos optional */ }
    const facts = [
      `GitHub profile (verified live via the GitHub API, externally checkable facts):`,
      `- login: @${u.login}${u.name ? `, name on profile: ${u.name}` : ""}`,
      u.bio ? `- bio: ${u.bio}` : "",
      `- public repos: ${u.public_repos ?? 0}, followers: ${u.followers ?? 0}`,
      top.length ? `- top public repos by stars: ${top.join("; ")}` : "",
      `- url: ${u.html_url}`,
    ].filter(Boolean).join("\n");
    return { label: `github profile @${u.login}`, trust: "artifact", text: facts };
  } catch {
    return null;
  }
}

async function ingestGeneric(url) {
  try {
    const r = await safeFetch(url, { timeoutMs: 9000, headers: { "user-agent": "Mozilla/5.0 CharlieBot" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return null; // don't ingest binaries/JSON blobs
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 120) return null; // JS-rendered SPA or empty — nothing grounded to read
    // AN AUTH WALL IS NOT A PAGE WE READ, whatever the status code says. This is the dangerous case:
    // a gated profile returns 200 with a body, so every check above passes and the text below gets
    // wrapped in "treat as their own words" and handed to the dossier build.
    //
    // A gated LinkedIn profile returns HTTP 200 with a large body whose text is the person's name and
    // city, one truncated About line, UI chrome, and OTHER PEOPLE'S NAMES AND CITIES from the "similar
    // profiles" sidebar. Ingesting it would put strangers' identities into one person's dossier as
    // their own words: a REAL fact about a DIFFERENT human being, which is as bad as an invented one.
    // Fail closed — no source beats a poisoned one.
    if (looksGated(text)) return null;
    return { label: `linked page ${url}`, trust: "claim", text: `Content the person linked (${url}) — a page they authored/curated, so treat as their own words: ${text.slice(0, 4000)}` };
  } catch {
    return null;
  }
}

// Ingest all URLs found in `text` into dossier sources. Best-effort; failures are skipped.
export async function ingestUrls(text, { max = 4 } = {}) {
  const urls = extractUrls(text, max);
  // Deterministic corroboration: collect the GitHub profile logins the person linked (their own
  // namespace). A repo owned by one of these is theirs to point to; any other repo is just context.
  const ownedLogins = new Set();
  for (const u of urls) { const m = u.match(GH_RE); if (m && !m[2]) ownedLogins.add(m[1].toLowerCase()); }
  const sources = [];
  for (const url of urls) {
    const s = GH_RE.test(url) ? await ingestGitHub(url, ownedLogins) : await ingestGeneric(url);
    if (s && s.text) sources.push(s);
  }
  return sources;
}
