// sentry.edge.config.ts — Sentry init for Next.js edge features (middleware, edge routes). DSN from SENTRY_DSN (unset -> no-op).
// Error monitoring only: no log forwarding, no perf traces. PII scrubbed in beforeSend.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "./lib/sentry-scrub.mjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: false,
  enableLogs: false,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: (b) => scrubEvent(b),
});
