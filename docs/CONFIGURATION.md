# Configuration

Charlie is configured only through environment variables. This page lists every variable in [../.env.example](../.env.example) and [../web/.env.example](../web/.env.example).

## How to read the tables

- **Required.** `Required` means the core does not work without it. `Recommended` means it works, but you lose alerts, attachments or similar. A feature name (`Pieworks`, `Voice`, `Hiring workspace`, `Sweep`, `join@ campaign`) means that feature needs it. `Optional` means there is a safe in-code default.
- **Read by.** Which part reads the variable, found by following imports from each entry point. A variable read in a shared module shows every part that imports that module, even if that part never reaches the line that reads it:
  - `server`: [server/charlie-remote.ts](../server/charlie-remote.ts) and everything it imports (the `charlie` Railway service),
  - `engine`: the commands in `npm run engine:run` (the `charlie-engine` service),
  - `sweep`: [sweep.mjs](../sweep.mjs) and the scripts it runs,
  - `worker`: [worker.mjs](../worker.mjs),
  - `site`: the root Next.js app in [app/](../app/),
  - `web`: the dashboard in [web/](../web/),
  - `scripts`: the operator tools in [scripts/](../scripts/),
  - `hand-run`: root CLIs that no service runs (for example [digest.mjs](../digest.mjs), [first-role.mjs](../first-role.mjs), [market-gap.mjs](../market-gap.mjs), `announce-*.mjs`) and the live evals.
- **What it does; default.** The description from `.env.example`. "Example value" is the value `.env.example` ships with. An empty value means the in-code default applies.

## General rules

- Every value is read when the code runs. Nothing is read at build time except `NEXT_PUBLIC_*` (inlined into the browser bundle) and `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` (source-map upload).
- `.env.local` follows the usual dotenv rules: an unquoted value loses a trailing ` # comment`; quote a value that must keep ` #`. So `cp .env.example .env.local` works as it is.
- Never put a secret in a `NEXT_PUBLIC_*` variable.
- Feature flags are off until set. Mode parsers read an unknown value as their safe default. For example: `PIEWORKS_ACTIVATION` reads anything but `shadow` or `live` as `off`; `LIFECYCLE_ENGINE` reads anything but `enforce` as `shadow`; `FIT_SEND_MODE` reads unknown values as `off`; `GROUNDING_MODE` reads unknown values as `drop` (enforcing). Cohort lists (`FIT_SEND_COHORT`, `ROLE_ASK_COHORT`) mean nobody when empty, never everybody.
- Secrets that guard a route fail closed. An empty `INBOUND_WEBHOOK_SECRET` and `RESEND_WEBHOOK_SECRET` stop the server from starting. An empty `PIEWORKS_WEBHOOK_SECRET`, `ELEVENLABS_WEBHOOK_SECRET`, `VOICE_DASHBOARD_SECRET` or `VOICE_LLM_BEARER` makes that route refuse every request (401 or 503).
- `charlie` and `charlie-engine` should hold the same value for every variable both read. [scripts/env-parity.mjs](../scripts/env-parity.mjs) checks this.
- `NEXT_PUBLIC_CHARLIE_API_BASE` appears in both example files: the root site and the dashboard each need it.
- The test [env-example.test.mjs](../env-example.test.mjs) fails when a root, `server/`, `voice/` or `prompts/` module reads a `process.env.NAME` that `.env.example` does not mention. It also checks the heartbeat names built from `pingHeartbeat("<job>")` and `process.env[NAME]` reads of a string constant (such as `DRIP_GLOBAL_MIN_GAP_DAYS`).

## Variables

### Core

The minimum to run the core pipeline (model calls, database, email, signed links).

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Required | server, engine, scripts, hand-run | All model calls (dossier, matching, composing, grounding). |
| `VOYAGE_API_KEY` | Optional | server, engine, scripts | Voyage AI embeddings for the semantic pre-filter; unset = lexical ranking only. |
| `NEXT_PUBLIC_SUPABASE_URL` | Required (or `SUPABASE_URL`) | server, engine, sweep, worker, site, scripts, hand-run | Supabase project URL. |
| `SUPABASE_URL` | Optional (alias) | server, engine, sweep, worker, scripts | Fallback name for NEXT_PUBLIC_SUPABASE_URL (server scripts). |
| `SUPABASE_SERVICE_ROLE_KEY` | Required (or `SUPABASE_SERVICE_KEY`) | server, engine, sweep, worker, scripts, hand-run | Backend only; bypasses RLS. |
| `SUPABASE_SERVICE_KEY` | Optional (alias) | server, engine, sweep, worker, scripts | Fallback name for SUPABASE_SERVICE_ROLE_KEY. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Required (root site) | site | Browser-safe, RLS-protected key (site waitlist action). |
| `RESEND_API_KEY` | Required | server, engine, sweep, scripts, hand-run | Resend send key; every send is skipped when unset. |
| `CHARLIE_FROM` | Required | server, engine, sweep, worker, scripts, hand-run | From: address; its domain is also treated as "our own" by the inbound loop guard. |
| `CHARLIE_TOKEN_SECRET` | Required | server, engine, sweep, worker, scripts | HMAC secret for unsubscribe, feedback and apply links. |
| `PUBLIC_BASE_URL` | Required | server, engine, scripts | Public base URL of server/charlie-remote.ts, used in minted links. |
| `CHARLIE_SITE_URL` | Required | server, engine, scripts | Marketing site base used in email links and images. |

### Inbound email

Needed for the server to accept and answer email.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `RESEND_READ_KEY` | Recommended | server, scripts | Full-access key to fetch inbound bodies and attachments; falls back to RESEND_API_KEY. |
| `RESEND_WEBHOOK_SECRET` | Required | server | Svix secret for the delivery/bounce webhook (/webhooks/resend). |
| `INBOUND_WEBHOOK_SECRET` | Required (or `RESEND_WEBHOOK_SECRET`) | server | Svix secret for the /inbound webhook; falls back to RESEND_WEBHOOK_SECRET; unset = inbound rejected. |
| `CHARLIE_START_ADDR` | Required | server, engine, scripts | The onboarding address shown in email copy. |
| `JOIN_INBOUND` | join@ campaign | server | Inbound address of the hiring-campaign flow (JOIN_CAMPAIGN). |
| `JOIN_ADDRESS` | Optional | server | Reply-To for hiring-campaign nudges; defaults to the join@ address. |
| `QUESTION_APPLY_URL` | Optional | server | Optional apply link included when Charlie acknowledges a question it cannot answer. |

### Operator identity, alerts and local tools

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `OWNER_EMAIL` | Recommended | server, engine, sweep, scripts, hand-run | The operator's address: admin scripts' allowlists, owner-only debug routes, default alert recipient; unset = nobody is owner. |
| `ALERT_EMAIL` | Recommended | server, engine, sweep | Where health-check, sweep and server alerts go (falls back to OWNER_EMAIL; no alert when both unset). |
| `WATCHDOG_TO` | Optional | engine | Where watchdog and preflight alerts go (falls back to ALERT_EMAIL, then OWNER_EMAIL). |
| `FOUNDER_NAME` | Optional | server, engine, scripts | Signs the personal founder note (renderFounderNote); unset = "the founder". |
| `CHARLIE_TO` | Optional | server, engine, sweep, worker, scripts, hand-run | Default recipient for local send tests. |
| `CHARLIE_USER_EMAIL` | Optional | server, engine, sweep, worker, scripts | The address local scripts onboard and scan as. |
| `PROOF_INBOX` | Optional | hand-run | Inbox for scheduler-e2e.mjs and scripts' live proof sends; unset = no live send. |
| `PICK_RANK` | Optional | scripts | scripts/send-finding.mjs: 0 = best match, higher = weaker (stress test). |
| `SEED_ONLY` | Optional | hand-run | discover-companies.mjs: probe only the non-YC seed list. |
| `EMAIL_DRY_RUN` | Optional | engine, hand-run | 1 = run every engine send path (scheduler.mjs, first-role.mjs, match-one.mjs, newsletter.mjs) without sending; finds are written as dry_run and the newsletter writes no sent-flag. |
| `ONLY_EMAIL` | Optional | engine | Process just this one address (targeted reruns). |
| `ROLE_COHORT` | Optional | scripts | Read only by hand-run audit scripts; no send path uses it. |
| `ONBOARDING_GRACE_HOURS` | Optional | scripts | Read only by scripts/suppression-audit.mjs (default 30). |
| `HEALTH_DRY_RUN` | Optional | engine | health-check.mjs: 1 = do not send the alert. |
| `HEALTH_FORCE_FAIL` | Optional | engine | health-check.mjs: inject a synthetic failure to test the alert path. |
| `HEALTH_FORCE_DOSSIER` | Optional | engine | health-check.mjs: 1 = run the full dossier-build canary now (otherwise weekly; other days a free reachability probe). |
| `HEALTHZ_URL` | Recommended | engine, scripts | The /healthz URL watchdog and scripts probe. Set it to `<PUBLIC_BASE_URL>/healthz`; the watchdog's server check fails without it. |
| `CHARLIE_HEALTH_URL` | Hiring workspace | server | The /healthz URL lib/ask-preflight.mjs probes. Set it to `<PUBLIC_BASE_URL>/healthz`. Qualify & Submit and agent sends compare their build with the build this URL reports, and refuse to send when the URL cannot be reached or the builds differ. The default points at example.com, so without it every agent send is refused. |
| `ANTHROPIC_PROBE_TIMEOUT_MS` | Optional | engine | Preflight Anthropic /v1/models probe timeout. |
| `GUARD_FIX_SINCE` | Optional | engine | watchdog.mjs: start of the window in which a repeated or ineligible send counts as a new leak. |
| `DEBUG_DOSSIER_RAW` | Optional | server, engine, sweep, scripts | dossier-build.mjs: dump the raw model output. |
| `JOBS_FILE` | Optional | engine | scheduler.mjs: local pool path override (default jobs.json). |
| `SCRATCH` | Optional | hand-run | Scratch directory for temporary outputs (default /tmp). |
| `PORT` | Optional | server | charlie-remote.ts listen port (default 8787). |
| `RAILWAY_SERVICE_NAME` | Never set (platform) | engine | Injected by Railway, never set by hand; recorded in the engine build stamp ("local" when absent). |

### Site API base and analytics

Public values only; they are shipped to the browser.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `NEXT_PUBLIC_CHARLIE_API_BASE` | Required (web apps) | site, web | Base URL of the Charlie server. The root site reads the public /pool-* stats from it; the dashboard sends every API call to it (also in web/.env.example). |
| `NEXT_PUBLIC_GA_ID` | Optional | site | Google Analytics id; GA is inert when unset. |

### Optional integrations

Server side only.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `GITHUB_TOKEN` | Optional | server, scripts | Lifts GitHub API rate limits during URL-ingest grounding (works keyless). |
| `HUNTR_GTM_API_KEY` | Optional | server, engine, scripts, hand-run | Huntr GTM warm-intro finder (preferred provider). |
| `HUNTER_API_KEY` | Optional | server, engine, scripts, hand-run | Hunter.io warm-intro finder (fallback provider); order: huntr > hunter > none. |
| `HUNTER_MONTHLY_CAP` | Optional | server, engine, scripts | Monthly warm-intro lookup cap shared across users and providers. Example value: `45`. |
| `REFERRAL_REGIONS` | Optional | server, engine, scripts | Regions where warm-intro referrals may surface (comma list); every other region stays off. Example value: `us`. |
| `REFERRAL_MIN_CONFIDENCE` | Optional | server, engine, scripts | Hunter confidence bar (0-100); below it no contact is surfaced. Example value: `80`. |
| `REFERRAL_CACHE_DAYS` | Optional | server, engine, scripts | Warm-intro lookup cache TTL in days. |
| `BLS_API_KEY` | Optional | server, engine, scripts | BLS v2 registration key (keyless v1 works without it). |
| `BLS_CACHE_TTL_DAYS` | Optional | server, engine, sweep, worker, scripts | BLS wage cache TTL (wages are annual). Example value: `180`. |
| `NOTION_TOKEN` | Sweep | server, sweep, scripts | Notion integration token for the client-board scripts; each board must be shared with the integration. |
| `TALLY_API_KEY` | Sweep | sweep, scripts | Tally API key; read-only access to applicant submissions (lib/tally.mjs). |
| `SWEEP_WORK_DIR` | Optional (sweep) | sweep | sweep.mjs working directory (default /tmp/charlie-sweep); holds applicant data, never point it inside the repo. |
| `HIRE_YES_LISTS_FILE` | Optional | server, scripts | Path to the operator file holding the human-approved outreach lists (lib/hire-outreach-lifecycle.mjs). |

### Sentry

Unset means error reporting is a no-op everywhere. Personal data is scrubbed in lib/sentry-scrub.mjs.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | site | Browser DSN for the site. |
| `SENTRY_DSN` | Optional | server, engine, sweep, worker, site, scripts | Server DSN for the Next server, charlie-remote and the engine. |
| `SENTRY_ORG` | Optional | site (build time) | Your Sentry org slug for source-map upload; unset (or no `SENTRY_PROJECT`) = no upload. |
| `SENTRY_PROJECT` | Optional | site (build time) | Your Sentry project slug for source-map upload. |

### Cron heartbeats

Each job POSTs to `HEARTBEAT_URL_<JOB>` (the job name uppercased, any character outside `A-Z0-9_` turned into `_`) on a clean finish and to `<url>/fail` on a failed one. Unset is a no-op with one log warning; a failed ping never fails the job.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `HEARTBEAT_URL_ATS_POLL` | Optional | engine | scan-jobs.mjs finished cleanly. |
| `HEARTBEAT_URL_MATCH_SEND` | Optional | engine | scheduler.mjs match/gate/compose/send finished cleanly. |
| `HEARTBEAT_URL_COVERAGE` | Optional | engine | scheduler.mjs coverage sweep: /fail when an active user got nothing. |
| `HEARTBEAT_URL_YC_INGEST` | Optional | engine | yc-ingest.mjs finished cleanly. |
| `HEARTBEAT_URL_INDIA_INGEST` | Optional | engine | india-ingest.mjs finished cleanly. |
| `HEARTBEAT_URL_SWEEP` | Optional | sweep | sweep.mjs finished with no problems (silent on a run that found problems). |
| `HEARTBEAT_URL_WORKER` | Optional | worker | worker.mjs pass finished cleanly. |
| `HEARTBEAT_URL_PURSUIT_SYNC` | Optional | server | server/outreach.ts pursuit sync finished cleanly. |
| `HEARTBEAT_URL_AGENTS` | Optional | server | server/agents.ts 15-minute agents sweep finished cleanly (/fail on any failure). |
| `HEARTBEAT_URL_PIEWORKS` | Optional | server | charlie-remote 30-minute Pieworks activation pass (/fail when any record failed). |
| `HEARTBEAT_URL_VOICE_PIPELINE` | Optional | server, scripts | voice/pipeline.mjs post-call pipeline sweep (/fail when any session failed). |
| `HEARTBEAT_TIMEOUT_MS` | Optional | server, engine, sweep, worker, scripts | Per-ping timeout in ms. Example value: `5000`. |

### Grounding

Nothing about a person is sent unless it is grounded in their own material.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `VERIFY_MODE` | Optional | server, engine, scripts | Grounding verifier: unset = enforce (hold on a high-severity violation or verifier error); log/off downgrade to logging. |
| `VERIFY_CONSTRAINED_DECODE` | Optional | server, engine, scripts | On = schema-constrained verifier output (default off). |
| `GROUNDING_MODE` | Optional | engine | Leave unset (= drop: remove flagged claims, hold on high severity); shadow/hold are debug modes. |

### Matching and batch cost guardrails

Read by match-batch.mjs and the matcher.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `MATCH_BAR` | Optional | server, engine, scripts, hand-run | Score threshold to pass the bar. |
| `MAX_JOBS_PER_USER` | Optional | engine | Pre-filter cap per user. LEAVE BLANK: the default (300) keeps above-bar roles inside the cap; raising it raises per-run spend toward MAX_RUN_COST_USD, which aborts the whole run when crossed. |
| `MAX_USERS_PER_RUN` | Optional | engine | Users processed per run. |
| `MAX_BATCH_REQUESTS` | Optional | engine | Anthropic Batch API request cap. |
| `MAX_RUN_COST_USD` | Optional | engine | Hard abort ceiling per run, a runaway backstop rather than a budget; a breach aborts role emails, digest and newsletter together. Example value: `60`. |
| `MATCH_CACHE` | Optional | engine | On = reuse cached verdicts for unchanged pairs (needs the match_verdicts table). |
| `MATCH_CACHE_TTL_DAYS` | Optional | engine | Re-score a cached verdict after this many days (default 7). |
| `MATCH_CONSTRAINED_DECODE` | Optional | engine, hand-run | On = schema-constrained scoring output (default off). |
| `MATCH_BATCH_CACHE` | Optional | engine | Prompt caching on the batch prefix (default on); off when logs show cache writes with no reads. |
| `MATCH_ONE_TOPN` | Optional | hand-run | match-one.mjs: how many roles to score on demand. |
| `MATCH_ONE_MODEL` | Optional | hand-run | match-one.mjs: model override. |
| `BATCH_POLL_MS` | Optional | engine | Batch poll interval (default 5000). |
| `BATCH_TIMEOUT_MS` | Optional | engine | Wait for the Message Batches API before failing the run (default 4h; keep above 1h). |
| `POOL_TABLE` | Optional | server, engine, sweep, worker, scripts | On = read the job pool from job_pool rows instead of the storage blob; falls back to the blob on any error. |
| `POOL_JSONL` | Optional | server, engine, sweep, worker, scripts | On = write the job pool one posting per line instead of one JSON array. |
| `VOYAGE_MODEL` | Optional | server, engine, scripts | Embedding model (default voyage-3.5-lite). |
| `VOYAGE_DIM` | Optional | server, engine, scripts | Output dimension 256\|512\|1024\|2048 (default 512). |
| `VOYAGE_SEMANTIC` | Optional | engine | On = blend the semantic score into the pre-filter rank. |
| `VOYAGE_SEM_WEIGHT` | Optional | server, engine, scripts | Weight of the semantic score in that blend, 0..1 (default 0.5). |
| `VOYAGE_TIMEOUT_MS` | Optional | server, engine, scripts | Per-request timeout. |
| `VOYAGE_MAX_RETRIES` | Optional | server, engine, scripts | Retries on a transient failure. |
| `VOYAGE_RETRY_BASE_MS` | Optional | server, engine, scripts | Base backoff between retries. |
| `VOYAGE_VEC_TTL_MS` | Optional | engine | In-process vector cache TTL (default 600000). |

### Send gates

Read by quality-gate.mjs, presend-guard.mjs and scheduler.mjs. Gate modes are off, shadow (log only) or enforce.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `FIT_FLOOR` | Optional | server, engine, scripts | Minimum fit composite to send rather than digest. |
| `FIT_FLOOR_MODE` | Optional | server, engine, scripts | Shadow (default) \| v2 \| off. |
| `UNIFIED_SCORE_MODE` | Optional | server, engine, scripts | Unified composite routing: shadow (default) \| enforce \| off. |
| `UNIFIED_SEND_BAR` | Optional | server, engine, scripts | Unified composite at or above this sends (default 58). |
| `UNIFIED_DIGEST_BAR` | Optional | server, engine, scripts | Unified composite in [this, send bar) goes to the digest. Example value: `45`. |
| `FIT_SEND_MODE` | Optional | engine | Fit-engine send authority (lib/fit-authority.mjs). off = never called; shadow = decision recorded only; enforce = may VETO a send the existing gate approved, never create one. Unknown values = off. Example value: `off`. |
| `FIT_SEND_COHORT` | Optional | engine | Addresses the fit engine has authority over (comma list). EMPTY MEANS NOBODY, never everybody. |
| `ROLE_ASK` | Optional | engine | The one grounded question in the role email (lib/role-ask-flag.mjs): off \| shadow (computed, not rendered) \| on. Example value: `off`. |
| `ROLE_ASK_COHORT` | Optional | engine | Addresses that see the question (comma list). EMPTY MEANS NOBODY, never everybody. |
| `GATE_SCAN` | Optional | engine, hand-run | Candidates the gate walks per person per run; each survivor costs one coverage call. Example value: `6`. |
| `GATE_FETCH_MS` | Optional | server, engine, scripts | Liveness re-check fetch timeout. |
| `GATE_LIVE_RETRIES` | Optional | server, engine, scripts | Liveness re-check retries. |
| `GATE_LIVE_BACKOFF_MS` | Optional | server, engine, scripts | Liveness re-check backoff. |
| `KNOCKOUT_MODE` | Optional | server, engine, scripts | Eligibility knockout floor (eligibility-gate.mjs). Example value: `shadow`. |
| `KNOCKOUT_DEALBREAKER_BODY` | Optional | server, engine, scripts | Also knock out on a dealbreaker found in the JD body (over-blocks on mere mentions). Example value: `off`. |
| `PREGATE_MODE` | Optional | engine | Eligibility pre-gate: shadow (default) \| off. |
| `SENIORITY_GATE` | Optional | engine, scripts | Hold a role below the lowest level the person asked for; unknown levels pass. Example value: `shadow`. |
| `SENIORITY_UNDER_FLOOR` | Optional | server, engine, scripts | Drop a solo send when the fit pass rates the person "under" and the seniority subscore is at or below this. |
| `GHOST_SCORE` | Optional | engine, scripts | Hold postings open longer than GHOST_DAYS without closing (evergreen reqs); unknown age passes. Example value: `shadow`. |
| `GHOST_DAYS` | Optional | engine, scripts | Days continuously open before a posting reads as evergreen. Example value: `45`. |
| `FRESHNESS_MODE` | Optional | engine | Freshness in the send order (freshness.mjs). Example value: `shadow`. |
| `FRESHNESS_WEIGHT` | Optional | server, scripts | Blend weight of freshness vs matcher score (0..1). Example value: `0.2`. |
| `FRESH_FULL_DAYS` | Optional | engine | A role this new counts as fully fresh. Example value: `2`. |
| `FRESH_HORIZON_DAYS` | Optional | engine | Freshness decays linearly to 0 at this age. Example value: `45`. |
| `FRESH_UNKNOWN` | Optional | engine | Freshness for a role with no parseable posted date. Example value: `0.2`. |
| `FRESH_PICK_HOURS` | Optional | engine | "Fresh pick" badge window. Example value: `12`. |
| `RETRIEVAL_MODE` | Optional | server, engine, scripts | Role-family regex gate on what a person may be shown. Example value: `off`. |
| `PAY_FLOOR_MODE` | Optional | server, engine, scripts | Drop a solo send whose disclosed pay is below the person's floor (default enforce). |
| `CITY_CORRIDOR` | Optional | server, engine, scripts | Route an onsite/hybrid role outside the person's named cities to the digest (default on). |
| `REMOTE_ACCESS` | Optional | server, engine, scripts | Tier-1 remote-accessibility gate for non-US candidates (default on). |
| `REMOTE_ACCESS_TIER2` | Optional | server, engine, scripts | Tier-2 model verifier for ambiguous remote roles (default on). |
| `REMOTE_ACCESS_JD_CAP` | Optional | server, engine, scripts | Max JD characters sent to the Tier-2 verifier (default 6000). |
| `B7_REMOTE_RECOVERY` | Optional | server, engine, scripts | Recover placeless global-remote roles dropped by the company-location heuristic: off (default) \| shadow \| on. |
| `MULTI_REGION` | Optional | server, engine, scripts | On = treat Canada and Australia as served regions. |
| `MARKET_REACH_FILTER` | Optional | engine | Scan-time market reachability filter: off (default) \| shadow. |
| `CHARLIE_ROLE_FILTER` | Optional | engine | 1 = turn on the design/product title pre-filter in the scanner. |
| `DESIRE_COPY` | Optional | server, engine, scripts | Let the composer lead with the person's stated motivation. Example value: `off`. |
| `PAIRWISE_RANK` | Optional | engine | Order the shortlist by pairwise comparison: off (default) \| shadow \| on. |
| `COMPANY_COOLOFF_DAYS` | Optional | engine, scripts | Per-company send cool-off. |
| `DIGEST_CAP` | Optional | hand-run | Weekly digest role cap. Example value: `5`. |

### Scanner and job pool

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `JOBS_DESC_CAP` | Optional | engine | Per-posting description cap in jobs.json. Not cosmetic: the file is one JSON string, V8 caps a string at 536,870,888 chars, and an uncapped pool overflows it and aborts the run. Example value: `2500`. |
| `WORKDAY_MAX_PER_BOARD` | Optional | engine | Max postings per Workday board per run; truncation is logged. Example value: `400`. |
| `EIGHTFOLD_MAX_PER_BOARD` | Optional | engine | Max postings per Eightfold board per run (10 per request); truncation is logged. Example value: `300`. |
| `AMAZON_MAX_PER_MARKET` | Optional | engine | Max postings per Amazon market per run; this cap bounds India coverage. Example value: `600`. |
| `POOL_MAX_AGE_HOURS` | Optional | engine | Pool freshness window. |
| `COMPANY_CACHE_TTL_DAYS` | Optional | server, engine, sweep, worker, scripts | Company-insight cache TTL. |
| `COMPANY_SEARCH_MAX` | Optional | server, engine, scripts | Max web_search uses per company (composer.mjs). |
| `BORDERLINE_LO` | Optional | engine | Low end of the borderline score band tracked by stats.mjs. Example value: `60`. |
| `BORDERLINE_HI` | Optional | engine | High end of the borderline score band. Example value: `80`. |
| `YC_INGEST` | Optional | engine | 0 = disable YC ingestion (default enabled). |
| `YC_RESOLVE_CONCURRENCY` | Optional | engine | Concurrent resolveAts() probes. Example value: `10`. |
| `YC_FEED_TIMEOUT_MS` | Optional | engine | Feed fetch timeout. Example value: `20000`. |
| `INDIA_INGEST` | Optional | engine | 0 = disable India ingestion (default enabled). |
| `INDIA_RESOLVE_CONCURRENCY` | Optional | engine | Concurrent resolveAts() probes. Example value: `10`. |
| `INDIA_FEED_TIMEOUT_MS` | Optional | engine | Feed fetch timeout. Example value: `20000`. |
| `RESOLVE_ATS_TIMEOUT_MS` | Optional | engine | Per-ATS-endpoint probe timeout (resolve-ats.mjs). Example value: `8000`. |
| `RESOLVE_ATS_HTML_TIMEOUT_MS` | Optional | engine | Careers-page fetch timeout. Example value: `8000`. |
| `RESOLVE_ATS_MAX_CANDIDATES` | Optional | engine | Candidate slugs tried before mining the careers page. Example value: `4`. |

### Onboarding and inbound

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `ONBOARDING_V2` | Optional | server, engine, sweep, worker, scripts | On = new users join the v2 journey (journey.mjs). |
| `ONBOARD_ASK_FIRST` | Optional | server, scripts | On = ask one question and wait instead of building a profile from too little. |
| `ONBOARD_ASK_FIRST_CHARS` | Optional | server, scripts | Ask-first threshold in characters (default 400). |
| `ONBOARD_MIN_BIO_CHARS` | Optional | server, scripts | Minimum characters of a new person's own words to onboard without a resume. |
| `ONBOARD_TRIAGE` | Optional | server, scripts | Cheap triage before the dossier build: shadow (default) \| enforce \| off. |
| `MAX_ATTACHMENT_BYTES` | Optional | server, sweep, scripts | Largest attachment the inbound path reads (default 10 MB). |
| `MAX_ATTACHMENTS` | Optional | server | Attachments read per email (default 5). |
| `INBOUND_MAX_PER_HOUR` | Optional | server | Inbound emails accepted per address per hour (default 12); excess is dropped silently. |
| `REPLY_INTENT` | Optional | server | On = one reply per inbound intent, linted; off = the single acknowledgement template. Example value: `off`. |
| `REPLY_SIGNAL` | Optional | engine, hand-run | On = role emails carry a signed chase+ Reply-To so a reply logs intent against that role. |
| `EDGE_ENGINE` | Optional | server, engine, sweep, scripts | On = build and store the grounded "edge" (rarest true combination) on the dossier. |
| `COMPANY_CONTEXT` | Optional | server, engine, sweep, scripts | On = record each past employer's domain as context on the dossier, never as a skill claim. |
| `COMPANY_CONTEXT_MAX` | Optional | server, scripts | Max distinct past employers researched per dossier. Example value: `6`. |

### Lifecycle emails and drips

Every one is off until set.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `PRO_PITCH` | Optional | server, engine, scripts | On = show the "what else I could do for you" interest probe in role emails. |
| `GIFT_A_ROLE` | Optional | server, engine, scripts | On = show the "send this role to a friend" block in role emails. |
| `POSITION_ASK` | Optional | server, engine, scripts | On = show the "how to position for this role" link in role emails. |
| `COMPLETENESS_NUDGE` | Optional | server | Completeness nudge sweep: off \| dry \| on. Example value: `off`. |
| `REPRESENT` | Optional | server | "can I represent you?" ask: off \| dry \| on. |
| `DEPTH_SNAPSHOT` | Optional | server, engine | Depth-per-user time series: off \| dry \| on. |
| `DEPTH_QUESTION` | Optional | server, engine | Market read plus one question: off \| dry \| on. |
| `GAME_PLAN` | Optional | server | On = send the onboarding "game plan" email after the briefing. |
| `WEDGE_DRIP` | Optional | server | On = send the once-ever "here's your edge" email (needs EDGE_ENGINE). |
| `WEDGE_MIN_AGE_HOURS` | Optional | server | A new profile must be this old before its wedge email fires. Example value: `24`. |
| `MARKETGAP_DROP` | Optional | hand-run | On = weekly market-gap email for people whose profile keeps just missing. |
| `MARKETGAP_STALLED` | Optional | hand-run | On = also reach users who had roles and went quiet. |
| `MARKETGAP_WEB` | Optional | server, engine | On = add attributed web and BLS research to the gap email. |
| `MARKETGAP_SCAN` | Optional | hand-run | Near-miss roles scored per user to find the recurring gap. Example value: `6`. |
| `MARKETGAP_MIN_COUNT` | Optional | hand-run | A gap must recur across this many near-misses. Example value: `2`. |
| `MARKETGAP_STALLED_MIN_COUNT` | Optional | hand-run | Recurrence bar for the stalled cohort. Example value: `3`. |
| `MARKETGAP_STALLED_QUIET_DAYS` | Optional | hand-run | Quiet period before a stalled user is eligible. Example value: `14`. |
| `MARKETGAP_MAX` | Optional | hand-run | Lifetime cap of market-gap emails per person. Example value: `6`. |
| `MARKETGAP_SEARCH_MAX` | Optional | server, engine | Max web_search uses per gap research. Example value: `3`. |
| `MARKETGAP_CACHE_TTL_DAYS` | Optional | server, engine, sweep, worker, scripts | Gap research cache TTL, keyed by gap x role x region. Example value: `14`. |
| `MARKETBRIEF_EXCLUDE` | Optional | server, scripts | Comma-separated addresses that never receive the market briefing. |
| `MARKETBRIEF_MIN_ADDRESSABLE` | Optional | server, scripts | Minimum reachable roles before a briefing is warranted. Example value: `8`. |
| `STANDOUT_FIT` | Optional | server, scripts | Briefing spotlight picked by coverage and freshness (about 5 coverage calls once per person); off = relevance only. Example value: `on`. |
| `STANDOUT_SHORTLIST` | Optional | server, engine, scripts | Top-relevance roles the spotlight ranker chooses between. Example value: `5`. |
| `GAP_CHART` | Optional | server, engine, scripts | Briefing gap chart: keyword \| coverage (reuses the STANDOUT_FIT passes; falls back to keyword). Example value: `keyword`. |
| `DRIP_GLOBAL_MIN_GAP_DAYS` | Optional | server, engine, scripts | Minimum days between any two lifecycle drip emails to one person, of any type (drip-guard.mjs; default 2). |
| `DRIP_COOLDOWN_COMPLETENESS_DAYS` | Optional | server, engine, scripts | Per-type drip cooldowns in days (drip-guard.mjs); each has an in-code default. |
| `DRIP_COOLDOWN_DIGEST_DAYS` | Optional | server, engine, scripts | Minimum days between two digest emails to one person (drip-guard.mjs; default 6). |
| `DRIP_COOLDOWN_CHECKIN_DAYS` | Optional | server, engine, scripts | Minimum days between two checkin emails to one person (drip-guard.mjs; default 10). |
| `DRIP_COOLDOWN_PROFILE_DAYS` | Optional | server, engine, scripts | Minimum days between two profile emails to one person (drip-guard.mjs; default 7). |
| `DRIP_COOLDOWN_MARKETGAP_DAYS` | Optional | server, engine, scripts | Minimum days between two marketgap emails to one person (drip-guard.mjs; default 7). |
| `DRIP_COOLDOWN_MARKETBRIEF_DAYS` | Optional | server, engine, scripts | Minimum days between two marketbrief emails to one person (drip-guard.mjs; default 30). |
| `DRIP_COOLDOWN_PLAN_DAYS` | Optional | server, engine, scripts | Minimum days between two plan emails to one person (drip-guard.mjs; default 30). |
| `DRIP_COOLDOWN_INVITE_DAYS` | Optional | server, engine, scripts | Minimum days between two invite emails to one person (drip-guard.mjs; default 30). |
| `DRIP_COOLDOWN_REFERRAL_DAYS` | Optional | server, engine, scripts | Minimum days between two referral emails to one person (drip-guard.mjs; default 30). |
| `DRIP_COOLDOWN_THESIS_DAYS` | Optional | server, engine, scripts | Minimum days between two thesis emails to one person (drip-guard.mjs; default 30). |
| `DRIP_COOLDOWN_FOLLOWUP_DAYS` | Optional | server, engine, scripts | Minimum days between two followup emails to one person (drip-guard.mjs; default 5). |
| `DRIP_COOLDOWN_WEDGE_DAYS` | Optional | server, engine, scripts | Minimum days between two wedge emails to one person (drip-guard.mjs; default 30). |

### Hiring campaign (join@ address)

Every verdict is made by a human; Charlie only carries it out.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `JOIN_CAMPAIGN` | join@ campaign | server | On = enable the join@ campaign flow. |
| `JOIN_OWNER_EMAIL` | join@ campaign | server | The one human who casts verdicts; unset = verdicts are held. |
| `JOIN_LOOP_MAX_TURNS` | Optional | server | Cap on Charlie messages in the challenge loop. Example value: `6`. |
| `JOIN_STALL_HOURS` | Optional | server | Silence before the single nudge to a stalled applicant (default 36). |
| `JOIN_CALENDLY` | Optional | server | Scheduling link sent only after an applicant replies "I'm in". |

### Hiring workspace, Pieworks and voice verification

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `HIRING_WORKSPACE` | Hiring workspace | server, scripts | On = the agents and outreach APIs and their 15-minute schedule run. |
| `HIRE_APP_ORIGINS` | Hiring workspace | server | Comma-separated browser origins allowed to call the hiring APIs (CORS); unset = none. |
| `CANDIDATE_SCORER` | Optional | server | Which scorer decides who the agent may contact: pieworks \| none (everyone, reviewed by hand). Example value: `pieworks`. |
| `PIEWORKS_SCORE_THRESHOLD` | Optional | server | The pieworks scorer passes a person at or above this score. Example value: `70`. |
| `PIEWORKS_API_BASE` | Pieworks | server | Partner API base URL; any unset PIEWORKS_API_* value = the connection refuses to run. |
| `PIEWORKS_API_KEY` | Pieworks | server | Partner API key. |
| `PIEWORKS_REFERRAL_CODE` | Pieworks | server | Partner referral code sent with submissions. |
| `PIEWORKS_WEBHOOK_SECRET` | Pieworks | server | HMAC secret verifying partner webhooks; unset = webhooks rejected. |
| `PIEWORKS_ACTIVATION` | Optional | server | Partner shortlist activation emails: off (default) \| shadow \| live. |
| `PIEWORKS_STATS_TO` | Optional | server | Recipient of the weekly activation stats email. |
| `LIFECYCLE_ENGINE` | Optional | server | Qualify lifecycle engine: shadow (default) \| enforce. |
| `VOICE_VERIFICATION` | Voice | server | On = voice verification routes are served; off = every route 404s. |
| `VOICE_DASHBOARD_SECRET` | Voice | server, scripts | Bearer secret for the hiring dashboard APIs; unset = refused. |
| `VOICE_APP_ORIGIN` | Optional | server | Origin of the voice call page (defaults to CHARLIE_SITE_URL). |
| `VOICE_LLM_BEARER` | Voice | server, scripts | Bearer the voice provider presents to /voice/llm; unset = refused. |
| `VOICE_MAX_PIPELINE_COST_USD` | Optional | server, scripts | Model spend cap per post-call pipeline run. |
| `ELEVENLABS_API_KEY` | Voice | server, scripts | ElevenLabs API key for voice sessions. |
| `ELEVENLABS_AGENT_ID` | Voice | server, scripts | ElevenLabs conversational agent id. |
| `ELEVENLABS_WEBHOOK_SECRET` | Voice | server | ElevenLabs post-call webhook HMAC secret; unset = webhooks rejected. |

### Model overrides

Each has an in-code default. Set one only to change the model for that task.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `COMPOSE_MODEL` | Optional | server, engine, scripts | Role-email composer. |
| `DOSSIER_THINKING` | Optional | server, engine, sweep, scripts | Off = disable adaptive thinking on the dossier build (default on). |
| `DOSSIER_EFFORT` | Optional | server, engine, sweep, scripts | Dossier reasoning effort: low\|medium\|high\|xhigh\|max (default high). |
| `RESUME_MODEL` | Optional | server | Tailored resume. |
| `CHECK_MODEL` | Optional | server | Check@ fit scorecard. |
| `VERIFY_MODEL` | Optional | server, engine, sweep, scripts | Grounding verifier. |
| `PREF_MODEL` | Optional | server, scripts | Preference write-back. |
| `TRACK_MODEL` | Optional | server | Application-tracking classifier. |
| `REFERRAL_MODEL` | Optional | server, engine, scripts | Warm-intro draft. |
| `FIT_MODEL` | Optional | server, engine, scripts | Fit coverage. |
| `YEARS_MODEL` | Optional | server, scripts | Professional-years reader. |
| `TRIAGE_MODEL` | Optional | server, scripts | Onboarding triage. |
| `ENRICH_MODEL` | Optional | scripts | Applicant enrichment. |
| `EDGE_MATCH_MODEL` | Optional | engine | Edge-to-role matcher. |
| `PAIRWISE_MODEL` | Optional | engine | Pairwise shortlist ranker. |
| `POSITION_MODEL` | Optional | scripts | Positioning build. |
| `STORY_BUILD_MODEL` | Optional | hand-run | Represent story writer. |
| `STORY_VERIFY_MODEL` | Optional | hand-run | Represent story verifier. |
| `INBOUND_INTENT_MODEL` | Optional | server | Inbound intent classifier. Example value: `claude-haiku-4-5-20251001`. |
| `INBOUND_REPLY_MODEL` | Optional | server | Conversational reply composer. |
| `MARKETGAP_MODEL` | Optional | hand-run | Market-gap email composer. |
| `MARKETGAP_RESEARCH_MODEL` | Optional | server, engine | Market-gap web research. |
| `WEDGE_MODEL` | Optional | server | Wedge email composer. |
| `JOIN_MODEL` | Optional | server | Hiring-campaign challenge composer. |
| `MANDATE_PARSE_MODEL` | Optional | server, scripts | Mandate parser. |
| `XYZ_SCREEN_MODEL` | Optional | hand-run | Applicant X-Y-Z screen. |
| `HIRE_WHY_MODEL` | Optional | server | Candidate justification note. |
| `HIRE_MANDATE_ANSWERS_MODEL` | Optional | server | Files replies against mandate questions. |
| `VOICE_PLANNER_MODEL` | Optional | server, scripts | Voice: question planner. |
| `VOICE_ASK_MODEL` | Optional | server | Voice: live question wording. |
| `VOICE_EXTRACTOR_MODEL` | Optional | server, scripts | Voice: evidence extractor. |
| `VOICE_JUDGE_MODEL` | Optional | server, scripts | Voice: judge. |
| `VOICE_WRITER_MODEL` | Optional | server, scripts | Voice: report writer. |

### Marketing site (app/)

Public values only.

| Variable | Required | Read by | What it does; default |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Recommended (root site) | site | Canonical site URL for metadata (default https://example.com). |
| `NEXT_PUBLIC_START_ADDR` | Recommended (root site) | site | The address the landing page's "Reply" button writes to. |

## Not operator settings

Set by the platform or the test runner, never by an operator: `CI`, `NODE_ENV`, `NEXT_RUNTIME`, `VITEST`, `RAILWAY_*`.
