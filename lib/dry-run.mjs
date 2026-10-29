// lib/dry-run.mjs — one definition of "this is a preview", shared by every path that writes a find.
//
// `EMAIL_DRY_RUN=1` must hold on every send path: `scheduler.mjs`, and `first-role.mjs` /
// `match-one.mjs` (the first role every new user gets). A safety flag that covers one of two send
// paths is worse than no flag, because it is trusted.
//
// A preview must also never write a find as 'new' or 'digest': that poisons
// `getEmailedRoleSignatures`, so `repeatDecision` would answer "already sent this posting" for that
// person forever. Previews write 'dry_run' instead.
//
// So the rule lives here, and `findStatus()` makes a find write dry-run-aware BY CONSTRUCTION instead
// of by somebody remembering. Pure, so both halves are testable without a send.

/** Is this process a preview? The one place the flag is interpreted. */
export function isDryRun(env = process.env) {
  return env.EMAIL_DRY_RUN === "1";
}

// Statuses that `getEmailedRoleSignatures` counts as "this person has seen this posting", and which a
// PREVIEW must therefore never write. Kept here beside the helper that avoids them, so the list and the
// avoidance cannot drift apart.
export const BLOCKING_STATUSES = ["emailed", "digest", "new"];

/** The status to persist for an intended one. In a preview, anything blocking becomes 'dry_run'. */
export function findStatus(intended, dry = isDryRun()) {
  return dry && BLOCKING_STATUSES.includes(intended) ? "dry_run" : intended;
}
