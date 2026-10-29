// lib/qualify/reply-key.mjs — the reply address of a Qualify & Submit thread: apply+<key>@<the sending domain>.
// A reply to a verify or confirm email comes back to that address; /inbound (server/charlie-remote.ts) reads the key
// with replyKeyFrom and hands the mail to server/agents.ts qualifyInboundReply. Pure apart from randomBytes.
import { randomBytes } from "node:crypto";

/** 16 characters of [a-z0-9]: the opaque part of apply+<key>@. */
export function newReplyKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(16)].map((b) => alphabet[b % alphabet.length]).join("");
}

/** apply+<key>@<the sending domain>, or null when there is no sending domain or it would not fit RFC 5321. */
export function replyAddress(key, from = process.env.CHARLIE_FROM || "") {
  const domain = String(from).replace(/^.*</, "").replace(/>.*$/, "").split("@")[1] || "";
  if (!key || !domain) return null;
  const local = `apply+${key}`;
  return local.length > 64 || local.length + 1 + domain.length > 254 ? null : `${local}@${domain}`;
}

/** The reply key from the local parts an inbound email was addressed to, or null. */
export function replyKeyFrom(localParts = []) {
  for (const lp of localParts) {
    const m = /^apply\+([a-z0-9]{10,24})$/i.exec(String(lp || "").trim());
    if (m) return m[1].toLowerCase();
  }
  return null;
}
