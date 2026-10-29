// referral-inline.mjs — resolve the ONE referral contact to show INLINE in a role email (the
// "One person to ask" box), draft the intro note, and hand back both the render param and the
// intro-message attachment. Region-gated (REFERRAL_REGIONS, checked by the callers), fail-closed at
// the source (findReferralContact only returns a verified, high-confidence, in-region contact with a
// LinkedIn), quota-capped and cached. Returns null when nothing clears the bar, so the box (and the
// intro attachment, and its footnote line) simply hide.

import { findReferralContact } from "./referral-find.mjs";
import { draftIntro } from "./referral-draft.mjs";

export async function resolveInlineReferral({ email, dossier, company, jobUrl, roleTitle, location, region = "us", owner = false } = {}) {
  if (!company) return null;
  const r = await findReferralContact({ email, company, jobUrl, roleTitle, location, region, owner }).catch(() => null);
  if (!r || r.none || !r.contact || !r.contact.name) return null;
  const c = r.contact;
  let draft = null;
  try { draft = await draftIntro({ dossier: dossier || {}, roleTitle, company: r.company || company, contact: c }); } catch { /* no draft → LinkedIn-only reach */ }
  const enc = encodeURIComponent;
  const reach = c.email && draft
    ? `mailto:${c.email}?subject=${enc(draft.subject || `Intro re ${roleTitle || company}`)}&body=${enc(draft.body || "")}`
    : (c.linkedin || "");
  const referral = { name: c.name, position: c.position || "", linkedin: c.linkedin || "", reach };
  const introAttachment = draft
    ? { filename: "intro-message.txt", content: Buffer.from(`To: ${c.name}${c.position ? `, ${c.position}` : ""}\nSubject: ${draft.subject || ""}\n\n${draft.body || ""}`, "utf8").toString("base64") }
    : null;
  return { referral, introAttachment };
}
