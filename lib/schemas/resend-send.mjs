// lib/schemas/resend-send.mjs — Zod schema for the Resend send payload.
// External boundary: the object passed to `resend.emails.send(...)` on the DIRECT send paths
// (scheduler.mjs, first-role.mjs). There is no send queue, so these direct calls are
// the choke point. safeParse here means a structurally broken send (empty/missing from, to,
// subject, or html) is refused BEFORE it hits Resend — fail-closed, consistent with the send
// discipline (rather send nothing than something malformed). Mirrors the fields those call sites
// actually pass; extra Resend fields are tolerated.
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const recipient = z.union([nonEmpty, z.array(nonEmpty).min(1)]); // Resend accepts a string or string[]

// One attachment as Resend expects it (filename + content); we only ever attach generated docs.
const Attachment = z
  .object({
    filename: z.string().min(1),
    content: z.union([z.string(), z.instanceof(Uint8Array), z.any()]), // Buffer/base64/Uint8Array
  })
  .passthrough();

export const ResendSendPayload = z
  .object({
    from: nonEmpty, // the verified sender (CHARLIE_FROM)
    to: recipient, // the recipient (never empty)
    subject: nonEmpty, // never send a blank subject
    html: nonEmpty, // the rendered email; the direct role-send paths always set html
    text: z.string().optional(), // plaintext alternative (optional)
    headers: z.record(z.string(), z.string()).optional(), // Message-ID / List-Unsubscribe etc.
    attachments: z.array(Attachment).optional(),
    replyTo: z.union([z.string(), z.array(z.string())]).optional(),
    cc: recipient.optional(),
    bcc: recipient.optional(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof ResendSendPayload>} ResendSendPayloadType */
