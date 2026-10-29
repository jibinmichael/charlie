// health.mjs — quick end-to-end health of the live system. Read-only.
//
//   node scripts/health.mjs
//
// Every network call is capped at 10 s (fetch: AbortSignal.timeout, dig: execSync timeout), so it
// cannot hang. Checks: MX records (sending + inbound), the MCP server /healthz version, the public
// /pool-stats and /pool-feed, and whether key addresses are on the suppression list.

import { execSync } from "node:child_process";
import { loadEnv, isSuppressed } from "../charlie-store.mjs";

loadEnv();
const BASE = process.env.PUBLIC_BASE_URL || "https://api.example.com";

function mx(host) {
  try { return execSync(`dig +short MX ${host} @1.1.1.1`, { encoding: "utf8", timeout: 10000 }).trim() || "(none)"; } catch { return "(dig unavailable)"; }
}
async function getJson(path) {
  try { const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10000) }); return { code: r.status, body: await r.json().catch(() => null) }; }
  catch (e) { return { code: 0, err: e.message }; }
}

console.log("\n— DNS / MX —");
// The sending domain comes from CHARLIE_FROM; the apex is that domain minus its first label.
const MAIL_DOMAIN = String(process.env.CHARLIE_FROM || "charlie@mail.example.com").split("@")[1] || "mail.example.com";
const APEX = MAIL_DOMAIN.split(".").slice(1).join(".") || MAIL_DOMAIN;
console.log(`  ${MAIL_DOMAIN} :`, mx(MAIL_DOMAIN), "(inbound + send)");
console.log(`  ${APEX} :`, mx(APEX));

console.log("\n— MCP server —");
const h = await getJson("/healthz");
console.log(`  /healthz: ${h.code} ${h.body ? `v${h.body.version}` : h.err || ""}`);

console.log("\n— live data —");
const stats = await getJson("/pool-stats");
console.log(`  /pool-stats: ${stats.code} ${stats.body ? `${stats.body.roles} roles · ${stats.body.companies} companies · updated ${stats.body.updatedAt}` : "null"}`);
const feed = await getJson("/pool-feed");
console.log(`  /pool-feed:  ${feed.code} ${feed.body ? `${(feed.body.freshest || []).length} fresh roles · ${(feed.body.byFunction || []).length} functions` : "null"}`);

console.log("\n— suppression (do-not-send) —");
const START = process.env.CHARLIE_START_ADDR || `start@${MAIL_DOMAIN}`;
for (const a of [process.env.OWNER_EMAIL, START].filter(Boolean)) {
  const timeout = new Promise((r) => setTimeout(() => r("(timed out after 10s)"), 10000).unref());
  console.log(`  ${a}: ${await Promise.race([isSuppressed(a).catch((e) => `(error: ${e.message})`), timeout])}`);
}
console.log("");
