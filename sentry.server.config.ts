// sentry.server.config.ts — Sentry init for the Next.js server (Vercel). DSN from SENTRY_DSN (unset -> no-op). Error monitoring
// only: no log forwarding (we log emails), no perf traces (URLs carry tokens). PII scrubbed in beforeSend.
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
