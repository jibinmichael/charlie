// lib/sentry-node.mjs — Sentry error reporting for the workers + Express server (@sentry/node).
//
// initSentry() is idempotent and a NO-OP when SENTRY_DSN is unset, so nothing changes until the DSN is
// set on the service. When enabled it installs global unhandled-error handlers (so every unhandled
// exception reports) and captureError() reports serious caught errors. Error monitoring only: no perf
// traces (our URLs carry tokens), PII scrubbed via lib/sentry-scrub.mjs. Reporting can never throw or
// slow a job (all wrapped + a short flush timeout).
import * as Sentry from "@sentry/node";
import { scrubEvent } from "./sentry-scrub.mjs";

let _inited = false;

/**
 * Initialize Sentry for a worker/service. Idempotent; no-op without SENTRY_DSN.
 * @param {{ name?: string }} [opts] service tag (e.g. "scan-jobs", "scheduler", "charlie-server")
 */
export function initSentry({ name = "worker" } = {}) {
  if (_inited) return;
  _inited = true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // disabled — captureError still console.errors, just doesn't send
  try {
    Sentry.init({
      dsn,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSend: scrubEvent,
      beforeBreadcrumb: (b) => scrubEvent(b),
      initialScope: { tags: { service: name } },
    });
    // "every unhandled exception should report" — for long-lived + one-shot processes alike.
    process.on("unhandledRejection", (e) => captureError(e, { kind: "unhandledRejection", service: name }));
    process.on("uncaughtException", async (e) => {
      // An uncaught exception leaves the process in an undefined state — report, flush, then exit
      // (don't suppress Node's crash-on-uncaught default; the host restarts the long-lived server).
      captureError(e, { kind: "uncaughtException", service: name });
      await flushSentry();
      process.exit(1);
    });
  } catch (e) {
    console.error(`[sentry] init failed (continuing without it): ${e?.message || e}`);
  }
}

/** Report a serious error to Sentry (if enabled) and ALWAYS console.error. Never throws. */
export function captureError(err, context = {}) {
  try {
    const msg = err?.message || String(err);
    console.error(`[error]${context.kind ? ` ${context.kind}` : ""}${context.service ? ` (${context.service})` : ""} ${msg}`);
    if (_inited && process.env.SENTRY_DSN) {
      Sentry.captureException(err instanceof Error ? err : new Error(msg), { extra: context });
    }
  } catch {
    /* error reporting must never throw */
  }
}

/** Flush pending events before a short-lived (cron) process exits. Best-effort, capped. */
export async function flushSentry(ms = 2000) {
  try {
    if (_inited && process.env.SENTRY_DSN) await Sentry.flush(ms);
  } catch {
    /* ignore */
  }
}
