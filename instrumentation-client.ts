// instrumentation-client.ts — Sentry init for the browser. DSN comes from NEXT_PUBLIC_SENTRY_DSN (unset -> Sentry is a no-op).
// Error monitoring only: no Session Replay (records the screen -> PII), no log forwarding (we log
// emails), no perf traces (URLs carry tokens). Emails/tokens are scrubbed in beforeSend regardless.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "./lib/sentry-scrub.mjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  enableLogs: false,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: (b) => scrubEvent(b),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
