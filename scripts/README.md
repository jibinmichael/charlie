# scripts/ — operator tools

Command-line tools for running and inspecting a Charlie deployment. Run them from the repo root. Every
script here that reads configuration loads the repo's `.env.local` (then `.env`) itself, through
`loadEnv()` or `import "../lib/load-env.mjs"`, so `node scripts/<name>.mjs` is enough;
`node --env-file=.env.local …` (as some file headers show) also works, and real environment variables
always win. Exceptions: `env-parity.mjs` reads the Railway services, not your local file;
`probe-boards.mjs` reads no configuration; and `mandate-run.mjs` / `mandate-board.mjs` do not load the
file themselves, so run them as their headers show, with `node --env-file=.env.local`. They use the Supabase **service-role** key: backend only,
never expose it. [scripts-smoke.test.mjs](../scripts-smoke.test.mjs) checks that every script named
here (and in docs/OPERATIONS.md) parses and imports only names that exist.

Scripts marked **sends** deliver real email to real inboxes and most spend Anthropic tokens. Every
sender is dry by default or takes an explicit recipient; read the header of the file before running it.
Scripts that import the react-pdf template chain need `tsx` (`node_modules/.bin/tsx scripts/<name>.mjs`).

## Inspect (read-only)

| Script | What it does |
|---|---|
| `check-candidate.mjs <email>` | One user's stored state: status, name, preferences, dossier size, resume on file, recent finds. |
| `inbox.mjs [--days N] [--from a@b.com] [--unanswered]` | What people wrote to Charlie (`inbound_messages`), and who is still waiting for a reply. |
| `health.mjs` | MX records for the sending domain, the server's `/healthz`, `/pool-stats`, `/pool-feed`, and suppression status of key addresses. |
| `build-id.mjs [--files]` | Compares this tree's build fingerprint with what the server (`/healthz`) and the engine (last cron stamp) are running. |
| `env-parity.mjs [--contract]` | Checks the Railway services `charlie` and `charlie-engine` agree on every env var both read (contract derived from the import graph). Never prints secrets; exits non-zero on drift. Needs the Railway CLI. |
| `check-scan-health.mjs` | After a scan: boards that went silent and segments that were never fetched. |
| `suppression-audit.mjs [--json] [--silent-only]` | One row per user: will they receive anything next run, and if not, which switch is off. |
| `engagement.mjs [--all]` | Per-user scoreboard: what was sent vs what they did. |
| `features.mjs [--days N] [--all]` | Usage rate of each in-email feature, normalised by role emails sent. |
| `ranker-eval.mjs [--days N]` | Click rate by retrieval rank band, source and feature score. |
| `eval-history.mjs` | The `run_eval` series as a trend. |
| `evidence-reconcile.mjs [--file]` | Checks every evidence reply reached the person's record; `--file` repairs gaps with the live writer. |
| `probe-boards.mjs candidates.json` | Verifies candidate ATS boards resolve to real postings before adding them to `watchlist.json`. |

## Maintain (write to the database, send nothing)

| Script | What it does |
|---|---|
| `cohort-snapshot.mjs [--out path]` | Snapshot of every candidate's status, email_config and dossier (default `snapshots/`, contains personal data). |
| `pause-cohort.mjs [--apply] [--restore snap.json]` | Pauses active candidates outside `ROLE_COHORT` via `status`, never via suppression. Dry by default. |
| `deactivate-users.mjs [emails…] [--apply] [--reactivate]` | Moves test or dead accounts out of the pool (status + suppression), reversibly. Dry by default. |
| `seed-us-testers.mjs [--wipe]` | Seeds two synthetic US test candidates; set their addresses to inboxes you control first. |
| `backfill-positions.mjs [--limit N] [--apply]` | Computes and stores the positioning statement on each active dossier. Spend-capped; dry by default. |
| `talent-enrich.mjs`, `skill-cluster.mjs` | Populate the talent pool table and build the skill alias map. |
| `mandate-parse.mjs`, `mandate-run.mjs`, `mandate-board.mjs`, `pool-applicants.mjs`, `backfill-consent.mjs`, `consent-drift.mjs` | The client-mandate pipeline (Tally forms → consent gate → scoring → Notion board). `sweep.mjs` (`npm run sweep:run`) runs the pool, fetch, score and board steps in one go. |
| `vv-plan.mjs`, `vv-agent.mjs`, `vv-pipeline.mjs` | Voice verification: build and approve a plan, configure the ElevenLabs agent, run the post-call pipeline (`npm run voice:*`). |
| `outreach-dev.mjs` | Local server for the outreach inbox API only. |
| `check-migrations.sh [BASE_REF]` | CI guard: fails if an existing `supabase/migrations/` file was modified, deleted or renamed. |

## Send (real email)

| Script | What it does |
|---|---|
| `send-finding.mjs <email>` (tsx) | One matched-role email to an onboarded user, through the full guarded path. |
| `send-one-role.mjs <email> <jobId> [--send]` (tsx) | One specific role to one person, still through `preSendGuard` and `sendGuarded`. |
| `send-india-first.mjs [--to email] [--send]` | Best above-bar role per candidate, India-located roles first. |
| `send-us-roundup.mjs <email>` (tsx) | A few US roles plus a warm-intro contact, for a US-home candidate. |
| `send-profile-nudge.mjs [--to email] [--send]` | Invites users with incomplete profiles to fill the gaps. |
| `send-market-report.mjs --for email [--to email] [--dry]` | The "State of Your Market" briefing for one person. |
| `send-putforward.mjs --in spec.json [--send]` | Puts one person forward for one role, after readiness and `preSendGuard`. |

All user-facing sends go through `lib/send-guard.mjs` (`sendGuarded`: suppression, `sent_emails`
idempotency, then Resend) except the documented operator tools listed in `lib/send-doors.test.mjs`.
A script that mails someone about a specific role must also clear `preSendGuard` (`sender-gate.test.mjs`).

Useful env vars for these tools: `OWNER_EMAIL` (excluded from cohorts, protected from deactivation),
`CHARLIE_FROM`, `CHARLIE_SITE_URL`, `PUBLIC_BASE_URL`, `HEALTHZ_URL`. See `.env.example`.
