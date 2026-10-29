// lib/outreach-files.mjs — the files behind the outreach inbox: the CV text a person gave us, and the
// attachments on their emails. READ ONLY: nothing here writes a row, uploads a file or sends mail.
//
// THE CV. Only extracted text is kept (Storage bucket `resumes`, `<email>.txt`); the original file
// was never stored. So "Download CV" gives that text, and says so in its name.
//
// ATTACHMENTS. Inbound mail records no attachment rows. Resend keeps the received email for a while,
// and lists its attachments by email_id with a short-lived download URL, so they are read live, on
// request. Once Resend no longer has the email (404), there is nothing to read and the inbox says
// nothing rather than guess.
//
// WHO. Every read is limited to people who were sent an outreach mandate's first email; a key that
// opens the inbox does not open any other inbox or CV in the system.

import { ResendReceivedAttachmentList } from "./schemas/resend-received.mjs";
import { OUTREACH_MANDATES } from "./hire-outreach.mjs";

const RESEND = "https://api.resend.com";

/** Lowercased emails that were sent some outreach mandate's first email. */
export async function outreachRecipients(db) {
  const out = new Set();
  for (const [key, m] of Object.entries(OUTREACH_MANDATES)) {
    const r = await db.from("sent_emails").select("email").eq("template", m.first).eq("dedupe_key", key);
    if (r.error) throw new Error(`sent_emails: ${r.error.message}`);
    for (const row of r.data || []) out.add(String(row.email).toLowerCase());
  }
  return out;
}

/** The inbound row for a Resend email id, if it belongs to an outreach recipient. */
export async function outreachInbound(db, emailId) {
  const r = await db.from("inbound_messages").select("email,email_id").eq("email_id", emailId);
  if (r.error) throw new Error(`inbound_messages: ${r.error.message}`);
  const row = (r.data || [])[0];
  if (!row) return null;
  return (await outreachRecipients(db)).has(String(row.email).toLowerCase()) ? row : null;
}

/**
 * The attachments on one received email: [{ id, filename, contentType, size }], or null when Resend
 * cannot give them (no read key, gone, or a shape that does not parse).
 */
export async function listAttachments(emailId, { key, fetchImpl = fetch, log = console.error } = {}) {
  const raw = await readList(emailId, { key, fetchImpl, log });
  if (!raw) return null;
  return raw.map((a) => ({ id: a.id, filename: a.filename || "attachment", contentType: a.content_type || "application/octet-stream", size: a.size ?? null }));
}

/** One attachment's bytes, by email id and attachment id. Null when it cannot be read. */
export async function fetchAttachment(emailId, attId, { key, fetchImpl = fetch, log = console.error } = {}) {
  const raw = await readList(emailId, { key, fetchImpl, log });
  const a = raw?.find((x) => x.id === attId);
  if (!a?.download_url) return null;
  const r = await fetchImpl(a.download_url);
  if (!r.ok) { log(`[outreach-files] download ${emailId}/${attId}: ${r.status}`); return null; }
  return { bytes: Buffer.from(await r.arrayBuffer()), filename: a.filename || "attachment", contentType: a.content_type || "application/octet-stream" };
}

async function readList(emailId, { key, fetchImpl, log }) {
  if (!key || !emailId) return null;
  const r = await fetchImpl(`${RESEND}/emails/receiving/${encodeURIComponent(emailId)}/attachments`, { headers: { authorization: `Bearer ${key}` } });
  if (r.status === 404) return null; // Resend no longer has this email
  if (!r.ok) { log(`[outreach-files] attachments ${emailId}: ${r.status}`); return null; }
  const ok = ResendReceivedAttachmentList.safeParse(await r.json());
  if (!ok.success) { log(`[outreach-files] attachments ${emailId}: unexpected shape at ${ok.error.issues[0]?.path.join(".")}`); return null; }
  return ok.data.data;
}

/** The CV text a person gave us (Storage `resumes/<email>.txt`), or null when there is none. */
export async function readCv(db, email) {
  const r = await db.storage.from("resumes").download(`${String(email).toLowerCase()}.txt`);
  if (r.error || !r.data) return null;
  return await r.data.text();
}
