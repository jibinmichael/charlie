// safe-fetch.mjs — SSRF guard for every server-side fetch of a URL that came from user or job data.
//
// The threat: a job's apply_url, a link in an inbound email, or an
// attachment URL is attacker-influenceable. Without a guard, `fetch(that_url)` lets an attacker make
// the server hit internal services or the cloud metadata endpoint (169.254.169.254) and exfiltrate
// credentials. assertPublicUrl() rejects non-http(s) schemes and any host that resolves to a
// private / loopback / link-local / metadata address; safeFetch() also follows redirects manually,
// re-validating every hop (so a public URL can't 302 you into the internal network).
//
// Residual risk (documented): DNS rebinding within a single fetch (host re-resolves to a private IP
// after our check) is not fully closed here — that needs IP-pinned connect. For our use (reading a
// candidate's portfolio/repo link, checking a posting is live) this guard closes the real holes.

import dns from "node:dns/promises";
import net from "node:net";

function v4ToLong(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) { const x = Number(o); if (!Number.isInteger(x) || x < 0 || x > 255) return null; n = (n << 8) + x; }
  return n >>> 0;
}
function inV4(ip, base, bits) {
  const a = v4ToLong(ip), b = v4ToLong(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}
// IPv4 ranges that must never be reachable from a server-side fetch.
function isPrivateV4(ip) {
  return (
    inV4(ip, "0.0.0.0", 8) ||        // "this" network
    inV4(ip, "10.0.0.0", 8) ||       // private
    inV4(ip, "100.64.0.0", 10) ||    // CGNAT
    inV4(ip, "127.0.0.0", 8) ||      // loopback
    inV4(ip, "169.254.0.0", 16) ||   // link-local (incl. 169.254.169.254 cloud metadata)
    inV4(ip, "172.16.0.0", 12) ||    // private
    inV4(ip, "192.0.0.0", 24) ||     // IETF protocol assignments
    inV4(ip, "192.168.0.0", 16) ||   // private
    inV4(ip, "198.18.0.0", 15) ||    // benchmarking
    inV4(ip, "224.0.0.0", 4) ||      // multicast
    inV4(ip, "240.0.0.0", 4)         // reserved
  );
}
function isPrivateIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) {
    const lo = ip.toLowerCase();
    if (lo === "::1" || lo === "::") return true;                 // loopback / unspecified
    // IPv4-mapped/embedded (::ffff:a.b.c.d, ::a.b.c.d) → check the embedded v4
    const m = lo.match(/(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateV4(m[1]);
    if (lo.startsWith("fe80") || lo.startsWith("fc") || lo.startsWith("fd")) return true; // link-local / ULA
    return false;
  }
  return true; // unparseable → treat as unsafe
}

const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal|instance-data.*)$/i;

// Throw if the URL is not a safe, public http(s) target. Returns the parsed URL when safe.
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error("invalid url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip v6 brackets
  if (BLOCKED_HOST.test(host)) throw new Error(`blocked host: ${host}`);
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    const recs = await dns.lookup(host, { all: true }).catch(() => []);
    ips = recs.map((r) => r.address);
    if (!ips.length) throw new Error(`dns resolve failed: ${host}`);
  }
  for (const ip of ips) if (isPrivateIp(ip)) throw new Error(`blocked private address: ${host} -> ${ip}`);
  return u;
}

// SSRF-safe fetch: validates the target, follows redirects manually re-validating each hop, and caps
// redirects + timeout. Pass headers/etc. through opts. Throws on any unsafe URL or hop.
export async function safeFetch(raw, opts = {}) {
  const { maxRedirects = 3, timeoutMs = 10000, ...rest } = opts;
  let url = String(raw);
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try { res = await fetch(url, { ...rest, redirect: "manual", signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).toString(); // resolve + loop → re-validate next hop
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}
