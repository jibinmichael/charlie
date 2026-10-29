// lib/schemas/resend-webhook.mjs — Zod schema for the Resend delivery webhook body.
// External boundary: the JSON POSTed to /webhooks/resend (server/charlie-remote.ts), AFTER the Svix
// signature is verified. The handler drives real behavior off this body (suppression on hard
// bounce / complaint), so it is validated before use. Fail-closed: a body that
// doesn't parse is logged + acked (200) WITHOUT acting on it — we never suppress an address or log an
// event off a shape we can't trust, and we don't make Resend retry a body we can't read.
// Lenient by design (Resend sends many event types + fields we ignore) -> .passthrough() throughout.
import { z } from "zod";

const recipient = z.union([z.string(), z.array(z.string())]); // Resend `to` is a string or string[]

export const ResendWebhookEvent = z
  .object({
    type: z.string().min(1), // e.g. email.delivered | email.bounced | email.complained | email.sent
    created_at: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(), // the sent message id
        id: z.string().optional(),
        to: recipient.optional(),
        from: z.string().optional(),
        subject: z.string().optional(),
        created_at: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** @typedef {import("zod").infer<typeof ResendWebhookEvent>} ResendWebhookEventType */
