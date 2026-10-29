// lib/schemas/resend-received.mjs — Zod schema for Resend's received-email attachment list.
// External boundary: GET https://api.resend.com/emails/receiving/<email_id>/attachments, read by
// lib/outreach-files.mjs for the outreach inbox. It is validated before use;
// a list that does not parse is treated as "no attachments readable" and logged, never guessed at.
// Lenient on extra fields (.passthrough()); strict on the ones the inbox uses.
import { z } from "zod";

export const ResendReceivedAttachment = z
  .object({
    id: z.string().min(1),
    filename: z.string().nullable().optional(),
    content_type: z.string().nullable().optional(),
    size: z.number().int().nonnegative().nullable().optional(),
    download_url: z.string().url().nullable().optional(),
    expires_at: z.string().nullable().optional(),
  })
  .passthrough();

export const ResendReceivedAttachmentList = z
  .object({
    data: z.array(ResendReceivedAttachment),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof ResendReceivedAttachment>} ResendReceivedAttachmentType */
