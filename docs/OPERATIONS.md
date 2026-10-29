# Operations

How to run Charlie day to day, see what it did, stop it, and fix the common failures. Commands assume the repo root and a filled `.env.local` (see [SETUP.md](SETUP.md#the-env-file)).

## Contents

1. [Daily routine](#daily-routine)
2. [Health checks](#health-checks)
3. [Heartbeats](#heartbeats)
4. [Logs and alerts](#logs-and-alerts)
5. [Reading what people wrote](#reading-what-people-wrote)
6. [Pausing sends](#pausing-sends)
7. [Common failures and fixes](#common-failures-and-fixes)

## Daily routine

1. **Start the engine run.** No service starts itself (see [SETUP.md](SETUP.md#no-cron-schedule)). Redeploy or restart the `charlie-engine` service in Railway, or run `npm run engine:run` on a machine with the production environment.
2. **Read the run's output.** The engine log prints `PASS` / `FAIL` per preflight check, the scan totals, one line per person in the scheduler, and the watchdog report. Alert emails go to `WATCHDOG_TO` / `ALERT_EMAIL` when something fails. If an alert email itself cannot be sent (for example a wrong Resend key), the log says `alert email failed: ...` instead of `alert emailed`.

   **Exit status.** `engine:run` keeps running its reporting tail (health check, watchdog, run-eval) whatever happened before it, then exits with the status of the guarded part: non-zero when a guard aborted the run (pre-scan preflight, the `presend-guard.test.mjs` self-test, or pre-send preflight). Railway therefore marks a run that a guard stopped as failed (red). A scan or send failure alone does not turn the run red; those are reported by the health-check and watchdog alerts.

   **Why `node` everywhere.** Both `npm run scheduler` and the `engine:run` chain start `scheduler.mjs` with plain `node`: it imports only `.mjs` modules. `tsx` is needed only by the server (`server/*.ts`) and by scripts that import the react-pdf template ([resume-pdf.tsx](../resume-pdf.tsx)).
3. **Check the inbox.** `node scripts/inbox.mjs --unanswered` lists people who wrote and got no reply.
4. **Start the sweep** (if you use client boards): restart the `charlie-sweep` service. It emails a summary of what it did and what it refused.
5. **Hiring workspace:** open the dashboard's Inbox and approve or pass the people Qualify & Submit has made ready. Nobody is submitted without that approval.

## Health checks

| Check | Command or URL | What it tells you |
|---|---|---|
| Server is up | `GET <PUBLIC_BASE_URL>/healthz` | `ok`, `version`, `build` (content hash of the running code) and `flags` (hash of shared config). `version` is the hard-coded `VERSION` constant in [server/charlie-remote.ts](../server/charlie-remote.ts): bump it by hand on each deploy (`build` changes on its own). Railway uses this path as the service health check. |
| End-to-end view | `node scripts/health.mjs` | MX records for the mail domain, `/healthz`, `/pool-stats`, `/pool-feed`, and whether key addresses are suppressed. Every call times out after 10 seconds. `/pool-stats` and `/pool-feed` answer `null` before the first scan and `503` when the storage read fails. |
| Same code everywhere | `node scripts/build-id.mjs` | Compares this tree's build id with the server's `/healthz` and the engine's last recorded build. |
| Same config on both services | `node scripts/env-parity.mjs` | Variables that `charlie` and `charlie-engine` both read but hold different values for. Never prints secrets. Needs the Railway CLI. |
| Preflight only | `npm run preflight` | All preflight checks: env present, guard logic, Supabase, Anthropic, pool size and age. |
| Canary | `npm run health` | [health-check.mjs](../health-check.mjs): ATS source probes, plus a real profile build once a week (`HEALTH_FORCE_DOSSIER=1` to run it now). `HEALTH_DRY_RUN=1` skips the alert email. |
| Integrity | `node watchdog.mjs` | The honesty and integrity checks without `--cron` (prints, emails only with `--cron`). |
| Scan coverage | `node scripts/check-scan-health.mjs` | Boards that went silent and segments never fetched in the last scan. |
| Who will get mail | `node scripts/suppression-audit.mjs` | One row per person: will they receive anything next run, and if not, why. |
| One person | `node scripts/check-candidate.mjs <email>` | Status, preferences, profile size, resume on file, recent finds. |
| Inbound debug | `GET <PUBLIC_BASE_URL>/inbound-debug?token=<signed token for OWNER_EMAIL>` | The last 25 inbound events held in memory: signature result, attachment fetch, extraction, routing. |
| Agents | `GET /agents/api/agents/outreach/runs` (Bearer) | Every agent run, including skipped runs and the reason. |
| Partner connection | `GET /agents/api/connections/pieworks/check` (Bearer) | A live read of one page of Pieworks roles. Says why it fails (no key, refused, unreachable). |

## Heartbeats

Each job pings its URL on a clean finish and `<url>/fail` on a failure. Configure each in your monitor (for example Healthchecks.io) with a period that matches how often you run the job.

| Variable | Job | When it pings |
|---|---|---|
| `HEARTBEAT_URL_ATS_POLL` | [scan-jobs.mjs](../scan-jobs.mjs) | End of a scan. |
| `HEARTBEAT_URL_YC_INGEST` | [yc-ingest.mjs](../yc-ingest.mjs) | End of YC ingestion. |
| `HEARTBEAT_URL_INDIA_INGEST` | [india-ingest.mjs](../india-ingest.mjs) | End of India ingestion. |
| `HEARTBEAT_URL_MATCH_SEND` | [scheduler.mjs](../scheduler.mjs) | End of the match and send. |
| `HEARTBEAT_URL_COVERAGE` | [scheduler.mjs](../scheduler.mjs) | `/fail` when an active person got neither a role nor a digest entry. |
| `HEARTBEAT_URL_SWEEP` | [sweep.mjs](../sweep.mjs) | A sweep with no problems (silent otherwise). |
| `HEARTBEAT_URL_WORKER` | [worker.mjs](../worker.mjs) | At most once a minute while busy; every idle pass. |
| `HEARTBEAT_URL_PURSUIT_SYNC` | [server/outreach.ts](../server/outreach.ts) | Each 15-minute pursuit sync. |
| `HEARTBEAT_URL_AGENTS` | [server/agents.ts](../server/agents.ts) | Each 15-minute agents sweep. |
| `HEARTBEAT_URL_PIEWORKS` | [server/charlie-remote.ts](../server/charlie-remote.ts) | Each 30-minute Pieworks pass. |
| `HEARTBEAT_URL_VOICE_PIPELINE` | [voice/pipeline.mjs](../voice/pipeline.mjs) | Each voice post-call pipeline sweep (`/fail` when a session failed). |

An unset URL logs `[heartbeat] HEARTBEAT_URL_<JOB> is not set ... running UNMONITORED` once per process. The watchdog warns when any engine heartbeat URL is missing.

## Logs and alerts

- **Where.** All services log to stdout/stderr. On Railway, read each service's deploy logs.
- **Prefixes.** Lines start with the area, so you can filter: `[inbound]`, `[webhook]`, `[send-guard]`, `[scheduler]`, `[preflight]`, `[pieworks]`, `[agents]`, `[agent:outreach]`, `[qualify-inbound]`, `[pursuit-sync]`, `[voice-live]`, `[voice-webhook]`, `[voice-pipeline]`, `[task]`, `[worker]`, `[sweep]`, `[heartbeat]`.
- **Alert email.** Preflight and watchdog email `WATCHDOG_TO` (then `ALERT_EMAIL`, then `OWNER_EMAIL`). Health check, sweep and server alerts go to `ALERT_EMAIL` (then `OWNER_EMAIL`). With none set, no alert email is sent.
- **Sentry.** With `SENTRY_DSN` set, errors from every service reach Sentry with a `kind` tag (for example `pieworks-webhook`, `agents-sweep`, `silent_no_send`).
- **API errors.** The hiring APIs return `{ "error": "Something went wrong", "id": "<8 chars>" }`. Search the server log for that id to find the cause.

## Reading what people wrote

Charlie has no mailbox. Every inbound email is stored in `inbound_messages`.

```sh
node scripts/inbox.mjs                      # the last 30, newest first
node scripts/inbox.mjs --days 2             # everything from the last 2 days
node scripts/inbox.mjs --from a@b.com       # one person's thread
node scripts/inbox.mjs --unanswered         # messages with no reply after them
```

`--unanswered` compares each message with `sent_emails` for the same address.

## Pausing sends

Pick the narrowest lever that does the job.

| To stop | Do this |
|---|---|
| The daily role send | Do not start `charlie-engine`. Nothing starts it automatically. |
| Emails during a run, keeping everything else | Set `EMAIL_DRY_RUN=1` on `charlie-engine`. Role emails and the newsletter are rendered and logged but not sent; finds are written as `dry_run` and no newsletter sent-flag is written. |
| One person | They reply `pause` (and `restart` to resume). Or set their `candidates.status` to `paused`. |
| Many people | `node scripts/pause-cohort.mjs` (dry run) then `--apply`. It pauses every active person outside `ROLE_COHORT` and can `--restore` from a snapshot. Use `node scripts/cohort-snapshot.mjs` first. |
| Test or dead accounts | `node scripts/deactivate-users.mjs <emails> --apply` (reversible with `--reactivate`). |
| A lifecycle email type | Unset its flag (`COMPLETENESS_NUDGE`, `REPRESENT`, `GAME_PLAN`, `WEDGE_DRIP`, `DEPTH_QUESTION`, ...) on the server and redeploy. |
| Qualify & Submit | Set the connection's mode to `off` or `shadow` in the dashboard (Agents), or `PUT /agents/api/connections/pieworks` with `{"mode":"off"}`. Or turn the agent off with `PUT /agents/api/agents/outreach`. |
| The whole hiring workspace | Unset `HIRING_WORKSPACE`. The APIs answer 404 and the 15-minute sweeps do nothing. |
| Pieworks 2call emails | `PIEWORKS_ACTIVATION=off` (or `shadow`). Webhooks are still stored. |
| Voice verification | Unset `VOICE_VERIFICATION`. Every voice route answers 404. |
| Everything outbound, at once | Stop the `charlie` and `charlie-engine` services. Inbound mail is then not received; Resend retries webhooks for a while. |

Never use the suppression list to pause people. Suppression is permanent do-not-send for bounces, complaints and unsubscribes.

## Common failures and fixes

### The server will not start

- **Log:** `[boot] FATAL: no inbound signing secret`. **Fix:** set `INBOUND_WEBHOOK_SECRET` (the `/inbound` webhook's own Resend secret) and redeploy. The server refuses to start rather than accept unsigned mail.
- **Health check fails on Railway.** Check that `PORT` is not set to something Railway does not route, and that `/healthz` answers locally.

### Inbound email

- **`[inbound] signature REJECTED`.** Each Resend webhook has its own secret. Put the `/inbound` webhook's secret in `INBOUND_WEBHOOK_SECRET`, not the delivery webhook's.
- **Empty bodies, or attachment notes like `401 (key lacks read scope)`** in `/inbound-debug`. Set `RESEND_READ_KEY` to a full-access Resend key.
- **`resume upload failed ... (is the private "resumes" bucket created?)`.** The migrations have not all been applied. Run `supabase db push` (migration `20261029120000_storage_resumes_bucket.sql` creates the bucket).
- **A sender gets no reply at all.** Check, in order: `[inbound] RATE LIMITED` (over `INBOUND_MAX_PER_HOUR`), `sender auth FAIL` (DMARC fail), `ignoring self/system sender`, and whether the address is in `suppressions` because of a bounce or complaint.
- **Onboarding failed during a model outage.** An `onboard_retry` task retries every 30 minutes, up to 3 times. Look for `[onboard_retry]` lines.

### The engine run stops early

- **`FAIL required env present`.** One of `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `CHARLIE_FROM` is missing on `charlie-engine`. Run `node scripts/env-parity.mjs`.
- **`FAIL anthropic reachable`.** The key is wrong, the account is out of credit, or the API is down. Nothing is sent until it passes.
- **`FAIL supabase reachable`.** Wrong URL or service-role key, or Supabase is down.
- **`FAIL job pool healthy (> 1000 roles)` or `job pool fresh`.** The scan did not produce a usable pool. Read the scan output and run `node scripts/check-scan-health.mjs`. A health-check source failure usually means a job board changed its API.
- **`FAIL guard logic intact`** or the `presend-guard.test.mjs` step fails. A code change broke the pre-send guard. Do not send until it is fixed.
- **The process runs out of memory.** The scan and scheduler need a 4,096 MB heap. Give the service more memory. Keep `JOBS_DESC_CAP` set: without it a large pool can exceed the V8 string limit when `jobs.json` is written.
- **The run aborts on cost.** `MAX_RUN_COST_USD` was crossed. This stops role emails, digest and newsletter together. Raise it only after you understand why spend went up (often `MAX_JOBS_PER_USER`).
- **`match batch ... deferred`.** The Message Batches API did not finish within `BATCH_TIMEOUT_MS`. The batch is collected on the next run.

### Sends that do not happen

- **`[send-guard] ... suppressed`.** The address bounced, complained or unsubscribed. Expected.
- **`[send-guard] ... already sent (idempotency ...)`.** The same `(email, template, dedupe key)` was sent before. Expected on retries. A deliberate re-send needs `force: true` in the `sendGuarded` call; suppression still applies.
- **`[send-guard] ... BLOCKED, internal identifier in the copy`.** A template printed an internal name. Fix the template; the message was not sent.
- **Grounding holds.** With `VERIFY_MODE` unset (enforce), a role email whose claims fail grounding, or whose verifier errored, is held and the next role is tried.
- **Agent or Qualify & Submit emails refused with `could not reach ... to confirm what the server is running`** or a build mismatch. Set `CHARLIE_HEALTH_URL` to `<PUBLIC_BASE_URL>/healthz` and make sure the server runs the same code.
- **An agent run is `skipped`.** Read the note: `quiet hours`, `today's limit of N is reached`, `this agent is off`, or `the previous run is still going`.

### Watchdog warnings and failures

- **Build or config mismatch between `charlie` and `charlie-engine`.** Deploy both from the same commit. Run `node scripts/build-id.mjs` and `node scripts/env-parity.mjs`.
- **`server /healthz` fails.** Set `HEALTHZ_URL` to `<PUBLIC_BASE_URL>/healthz` on the engine.
- **Heartbeats dark / Sentry unset.** Warnings only. Configure them to get external alerts.
- **A repeat or ineligible role reached a person, or a stage without evidence exists.** These are integrity failures and exit non-zero. Investigate before the next run.

### Dashboard and hiring APIs

| Response | Cause |
|---|---|
| 404 on `/agents/api`, `/outreach/api` | `HIRING_WORKSPACE` is not on. |
| 404 on `/voice/*` | `VOICE_VERIFICATION` is not on. |
| 503 `no dashboard secret configured` | `VOICE_DASHBOARD_SECRET` is empty on the server. |
| 401 `unauthorized` | The secret in the dashboard URL differs from `VOICE_DASHBOARD_SECRET`. |
| Browser CORS error | The dashboard's origin is missing from `HIRE_APP_ORIGINS`. |
| 503 `the voice provider is not configured` | `ELEVENLABS_API_KEY` or `ELEVENLABS_AGENT_ID` is empty. |
| `/voice/llm` 401 or 503 | `VOICE_LLM_BEARER` differs from the one stored in the ElevenLabs agent, or is empty. Rerun `npm run voice:agent -- --apply`. |
| `/webhooks/elevenlabs` 401 | `ELEVENLABS_WEBHOOK_SECRET` does not match the post-call webhook's secret. |

### Pieworks

See [PIEWORKS_2CALL.md](PIEWORKS_2CALL.md#monitoring). The common causes are a webhook 401 (`PIEWORKS_WEBHOOK_SECRET` mismatch or clock skew over 5 minutes), `Pieworks not configured` (an empty `PIEWORKS_API_*` value or referral code), and `active roles could not be read` (nobody is asked until it works).

### Links in emails stop working

`CHARLIE_TOKEN_SECRET` signs every unsubscribe, feedback and apply link. If it changes or is shorter than 16 characters, old links fail. Keep it the same on `charlie` and `charlie-engine`.
