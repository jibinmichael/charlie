// own-words.mjs — what a person actually wrote in a reply, with the thread they replied on top of
// removed. Shared by every reader of inbound replies, because all of them must make the same judgement
// about whose words are whose.

import { stripQuotedReply } from "../campaign-gate.mjs";

/** Charlie's own sending domain (from CHARLIE_FROM), so a quote of our own mail can be recognised. */
const OUR_DOMAIN = String(process.env.CHARLIE_FROM || "charlie@mail.example.com").split("@")[1] || "mail.example.com";

/**
 * What THIS PERSON wrote, with the thread they replied on top of removed.
 *
 * NOT just stripQuotedReply. That helper cuts at the first quote marker, which is right when the
 * quoted text is OURS and wrong when somebody replies on top of their OWN earlier email — and people
 * do, constantly, when they are chasing an answer. A reply of "checking if there are any updates?" on
 * top of their own earlier "Link to my work: https://portfolio.example.com" would otherwise lose the
 * link, which is the entire thing we asked for.
 *
 * So the cut happens only at a quote attributed to US. A quote attributed to the person themselves is
 * their own words and is kept. If the attribution cannot be read, nothing is cut: keeping a little of
 * our own copy is recoverable, deleting theirs is not.
 */
export function ownWords(body, senderEmail) {
  const text = String(body || "");
  const lines = text.split("\n");
  const OURS = new RegExp(`(charlie@|${OUR_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i");
  // "On <date> <someone> wrote:" — the standard attribution most clients emit.
  const ATTRIB = /^\s*(On .*wrote:\s*$|-{2,}\s*Original Message|From:\s)/i;
  for (let i = 0; i < lines.length; i++) {
    if (!ATTRIB.test(lines[i])) continue;
    // the attribution can wrap onto the next line; look at both
    const who = `${lines[i]} ${lines[i + 1] || ""}`;
    if (OURS.test(who)) return lines.slice(0, i).join("\n").trim();
    if (senderEmail && who.toLowerCase().includes(senderEmail)) continue; // their own earlier mail: keep going
    continue; // unknown attribution: do not cut
  }
  // No Charlie-attributed quote found. Fall back to the shared helper only if it keeps most of the
  // text; otherwise the body is theirs end to end.
  const stripped = (stripQuotedReply(text) || "").trim();
  return stripped.length >= text.trim().length * 0.5 ? stripped : text.trim();
}
