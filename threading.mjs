// threading.mjs — deliberate email threading so RELATED mail shares one conversation and UNRELATED
// mail stays standalone. Without this, Gmail groups purely by subject + participant, which merges
// unrelated role emails/nudges into one messy thread and scatters replies.
//
// Model:
//  - The direct Charlie <-> user CONVERSATION (welcome, gap questions, acks, "reply to change X",
//    check/track acks) threads together: every send carries a Message-ID we control, and follow-ups
//    set In-Reply-To/References to the conversation's stored ROOT Message-ID + keep a steady subject.
//  - PROACTIVE sends (each daily role, the digest, the roundup, announcements) are standalone: a fresh
//    unique Message-ID, a DISTINCT subject, and NO references — so Gmail can't fold them together.
//
// We set our own Message-ID (providers that honor it thread by the header; a steady subject is the
// always-works Gmail backstop when a provider overrides it, so we use both).

import { randomUUID } from "node:crypto";

const DOMAIN = (process.env.CHARLIE_FROM || "charlie@mail.example.com").split("@")[1] || "mail.example.com";

// A fresh RFC-shaped Message-ID we control. `key` just makes it legible in logs.
export function newMessageId(key = "msg") {
  return `<charlie.${String(key).replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}.${randomUUID()}@${DOMAIN}>`;
}

// Headers for one send. root = the conversation's root Message-ID to thread INTO (null = standalone).
// Merges any base headers (e.g. List-Unsubscribe) the caller passes.
export function threadHeaders({ messageId, root = null, base = {} } = {}) {
  const h = { ...base, "Message-ID": messageId };
  if (root) { h["In-Reply-To"] = root; h["References"] = root; }
  return h;
}
