# Setup

This guide takes you from an empty set of accounts to a running Charlie. Read it top to bottom the first time.

Every variable named here is described in [CONFIGURATION.md](CONFIGURATION.md) and listed in [../.env.example](../.env.example) or [../web/.env.example](../web/.env.example).

## Contents

1. [Prerequisites](#prerequisites)
2. [External accounts](#external-accounts)
3. [The env file](#the-env-file)
4. [Database](#database)
5. [Email domain and DNS](#email-domain-and-dns)
6. [Run locally](#run-locally)
7. [Deploy the server, engine, sweep and worker (Railway)](#deploy-the-server-engine-sweep-and-worker-railway)
8. [Deploy the web apps](#deploy-the-web-apps)
9. [Turn features on](#turn-features-on)

## Prerequisites

- Node.js 22. The root [package.json](../package.json) sets `"engines": { "node": "22.x" }`, and CI uses Node 22.
- npm. Both [package.json](../package.json) and [web/package.json](../web/package.json) have a lockfile, so use `npm ci`.
- The Supabase CLI (`supabase`), for migrations and type generation.
- Optional: the Railway CLI, for [scripts/env-parity.mjs](../scripts/env-parity.mjs).
- `dig`, if you want [scripts/health.mjs](../scripts/health.mjs) to print MX records.

```sh
npm ci
(cd web && npm ci)
```

## External accounts

The table says which accounts you need for which part. "Core" means the job-seeker engine and email onboarding.

| Service | Needed for | Required? |
|---|---|---|
| Supabase | All data and file storage | Yes |
| Anthropic | Every model call | Yes |
| Resend | Every email in and out | Yes |
| A domain you control | Sending and receiving email, the server's public URL | Yes |
| Railway (or any Node host) | The server, the engine run, the sweep, the worker | Yes, for production |
| A Next.js host (Vercel or other) | The root site and the [web/](../web/) dashboard | For the dashboard |
| ElevenLabs | Voice verification | Only for voice |
| Pieworks partner API | Qualify & Submit and the 2call activation | Only for those features |
| Voyage AI | Semantic pre-filter for matching | Optional |
| Sentry | Error reports | Optional |
| A heartbeat monitor (for example Healthchecks.io) | Alerts when a job stops running | Optional |
| Notion and Tally | The client-board sweep ([sweep.mjs](../sweep.mjs)) | Only for the sweep |
| Hunter.io or Huntr | Warm-intro contacts | Optional |
| BLS API | US wage data in some emails | Optional (works keyless) |
| GitHub token | Higher rate limits when reading GitHub links a person sends | Optional (works keyless) |
| Google Analytics | Site analytics | Optional |

### Supabase

1. Create a project at supabase.com.
2. In **Project Settings → API**, copy:
   - the project URL into `NEXT_PUBLIC_SUPABASE_URL` (server scripts also accept `SUPABASE_URL`),
   - the `service_role` key into `SUPABASE_SERVICE_ROLE_KEY` (scripts also accept `SUPABASE_SERVICE_KEY`),
   - the `anon` key into `NEXT_PUBLIC_SUPABASE_ANON_KEY` (used only by the root site's waitlist action, [app/actions.ts](../app/actions.ts)).
3. Note the project ref (the subdomain of the URL). You need it for `supabase link`.

The service-role key bypasses row-level security. Put it only on servers. Never put it in a `NEXT_PUBLIC_*` variable.

### Anthropic

1. Create an API key in the Anthropic console.
2. Put it in `ANTHROPIC_API_KEY`.

The engine uses the Message Batches API ([match-batch.mjs](../match-batch.mjs)) and prompt caching. Model names have in-code defaults; each has an override variable (see the "Model overrides" section of [CONFIGURATION.md](CONFIGURATION.md)). `MAX_RUN_COST_USD` aborts an engine run whose spend passes the limit.

### Resend

Charlie sends and receives all email through Resend.

1. Add your sending domain (for example `mail.example.com`) and add the DNS records Resend shows. See [Email domain and DNS](#email-domain-and-dns).
2. Create two API keys:
   - a **sending** key for `RESEND_API_KEY`. With this empty, every send is skipped.
   - a **full-access** key for `RESEND_READ_KEY`. Resend's inbound webhook carries only metadata, so the server fetches the body and attachments from the Receiving API. A sending-only key gets a 401 there. If `RESEND_READ_KEY` is empty, the server uses `RESEND_API_KEY`.
3. Turn on **receiving** for the same domain (an MX record, see below).
4. Create two webhooks. Each webhook has its own signing secret (`whsec_...`).

   | Webhook URL | Events | Secret goes in |
   |---|---|---|
   | `<PUBLIC_BASE_URL>/inbound` | email received | `INBOUND_WEBHOOK_SECRET` |
   | `<PUBLIC_BASE_URL>/webhooks/resend` | delivery events (sent, delivered, bounced, complained, opened) | `RESEND_WEBHOOK_SECRET` |

   The server verifies both with the Svix scheme and a constant-time compare. `/inbound` tries `INBOUND_WEBHOOK_SECRET` first, then `RESEND_WEBHOOK_SECRET`. **The server will not start if both are empty.** A bounce or a spam complaint on `/webhooks/resend` adds the address to the `suppressions` table.
5. Set the addresses:
   - `CHARLIE_FROM`, for example `charlie@mail.example.com`. Its domain is also how the server recognises its own mail and ignores it.
   - `CHARLIE_START_ADDR`, for example `start@mail.example.com`. This is the onboarding address shown in emails. On the site, `NEXT_PUBLIC_START_ADDR` holds the same value.

### ElevenLabs (voice verification only)

1. Create a Conversational AI agent in ElevenLabs. Put its id in `ELEVENLABS_AGENT_ID` and an API key in `ELEVENLABS_API_KEY`.
2. Make a long random string for `VOICE_LLM_BEARER` (for example `openssl rand -hex 32`). ElevenLabs presents it to `/voice/llm`, the server's custom LLM endpoint.
3. Configure the agent from this repo:

   ```sh
   npm run voice:agent                                          # read the agent and print the checks
   npm run voice:agent -- --apply --base https://api.example.com   # set auth, custom LLM, prompt, max duration
   ```

   `--base` is your `PUBLIC_BASE_URL`. The script sets the agent to private, points its LLM at `<base>/voice/llm` with `VOICE_LLM_BEARER`, and sets the system prompt and first message.
4. The script does not set the post-call webhook. In the ElevenLabs dashboard, add a post-call webhook to `<PUBLIC_BASE_URL>/webhooks/elevenlabs` with transcripts on and audio off. Put the secret it shows in `ELEVENLABS_WEBHOOK_SECRET`.
5. Make a long random string for `VOICE_DASHBOARD_SECRET`. The dashboards send it as a Bearer token.

The `voice:*` npm scripts use `node --env-file=.env.local`, so they need a `.env.local` in the repo root.

### Pieworks (Qualify & Submit and the 2call activation)

Ask Pieworks for:

- the API base URL (`PIEWORKS_API_BASE`),
- an API key (`PIEWORKS_API_KEY`),
- your referral code (`PIEWORKS_REFERRAL_CODE`),
- a webhook signing secret (`PIEWORKS_WEBHOOK_SECRET`), and give them your webhook URL `<PUBLIC_BASE_URL>/webhooks/pieworks`.

If any `PIEWORKS_API_*` value or the referral code is empty, the connection refuses to run. If the webhook secret is empty, every webhook gets a 401. See [PIEWORKS_2CALL.md](PIEWORKS_2CALL.md).

### Voyage AI (optional)

Put a key in `VOYAGE_API_KEY` and set `VOYAGE_SEMANTIC=on` to blend embedding similarity into the pre-filter. Without a key, ranking is lexical only.

### Sentry (optional)

- `SENTRY_DSN`: the server, the engine, the sweep and the worker report here.
- `NEXT_PUBLIC_SENTRY_DSN`: the root site's browser code.
- `SENTRY_ORG` and `SENTRY_PROJECT`: build-time only, your Sentry organisation and project slugs for source-map upload of the root site ([next.config.mjs](../next.config.mjs)). With either unset, the build uploads nothing.
- `SENTRY_AUTH_TOKEN`: build-time only, for source-map upload. Set these three in your web host's build environment, not in `.env.local`.

With no DSN, error reporting is a no-op. Personal data is scrubbed before sending ([lib/sentry-scrub.mjs](../lib/sentry-scrub.mjs)).

### Heartbeats (optional)

[lib/heartbeat.mjs](../lib/heartbeat.mjs) POSTs to `HEARTBEAT_URL_<JOB>` (the job name uppercased, any character outside `A-Z0-9_` turned into `_`) when a job finishes cleanly, and to `<url>/fail` when it fails. This matches Healthchecks.io. Create one check per job and set the URLs listed in [CONFIGURATION.md](CONFIGURATION.md#cron-heartbeats). An unset URL is a no-op with one warning in the log.

### Notion and Tally (client-board sweep only)

[sweep.mjs](../sweep.mjs) reads applicants from Tally forms and writes scored rows to Notion boards. The forms and boards are defined in [lib/mandates.mjs](../lib/mandates.mjs).

- `TALLY_API_KEY`: a Tally API key with read access to submissions.
- `NOTION_TOKEN`: a Notion integration token. Share each board with the integration.

### Other optional keys

- `HUNTR_GTM_API_KEY` or `HUNTER_API_KEY`: warm-intro contact lookup. Huntr is tried first. `HUNTER_MONTHLY_CAP` limits lookups.
- `BLS_API_KEY`: BLS v2 key. Without it the keyless v1 API is used.
- `GITHUB_TOKEN`: raises GitHub API limits when a person sends GitHub links.
- `NEXT_PUBLIC_GA_ID`: Google Analytics on the root site. Inert when unset.

## The env file

Every Node entry point reads `.env.local` (then `.env`) from the repo root itself. Most call `loadEnv()` from [charlie-store.mjs](../charlie-store.mjs); the ones that read variables while their imports load (the ingest steps, the sweep, the worker, [scripts/check-scan-health.mjs](../scripts/check-scan-health.mjs), [scripts/outreach-dev.mjs](../scripts/outreach-dev.mjs)) import [lib/load-env.mjs](../lib/load-env.mjs) first, which applies the same rules. The `npm run voice:*` scripts use `node --env-file=.env.local` and fail if that file is missing. [scripts/env-parity.mjs](../scripts/env-parity.mjs) reads the Railway services, not your local file. Real environment variables always win. On Railway, set variables in the service instead.

**Required keys must look real.** Preflight treats `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` as missing when they are shorter than 12 characters (and `CHARLIE_FROM` when shorter than 5), and stops the engine run. A placeholder such as `x` fails on purpose.

`loadEnv()` follows the usual dotenv rules ([lib/dotenv.mjs](../lib/dotenv.mjs)): an unquoted value loses a trailing comment that starts with a space and `#`, and a quoted value (`"..."` or `'...'`) keeps a `#` inside the quotes. The `node --env-file=.env.local` scripts (`npm run voice:*`) parse the file the same way. So copy [.env.example](../.env.example) as it is:

```sh
cp .env.example .env.local
cp web/.env.example web/.env.local
```

Quote any value that contains ` #`, for example a URL with a fragment.

Then replace every placeholder such as `<your-domain>` and `sk-ant-...`. Generate the HMAC secret with:

```sh
openssl rand -hex 32     # CHARLIE_TOKEN_SECRET (at least 16 characters; the server refuses shorter)
```

Changing `CHARLIE_TOKEN_SECRET` later breaks every unsubscribe, feedback and apply link already sent.

## Database

### Apply the migrations

The schema is in [supabase/migrations/](../supabase/migrations/). The files are applied in filename (timestamp) order. The first file, `20260712173719_remote_schema.sql`, is the baseline schema. Every later file adds tables or columns.

```sh
supabase login
supabase link --project-ref <your-project-ref>
supabase db push            # applies every migration in order
npm run db:types            # regenerates lib/database.types.ts from the linked project
```

If you prefer, you can paste each file into the Supabase SQL editor in filename order instead. Then run `npm run db:types`.

**Table privileges.** Only the baseline migration grants privileges explicitly. Later migrations create tables and rely on the baseline's `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO service_role`. Supabase is removing automatic API exposure of new tables (see the note in [supabase/config.toml](../supabase/config.toml)). If the server or engine gets `permission denied for table ...` on a newer table, run this once in the SQL editor:

```sql
grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;
```

Never edit a migration that is already applied. A schema change is always a new file. CI enforces this with [scripts/check-migrations.sh](../scripts/check-migrations.sh).

### Storage buckets

The code uses four private Storage buckets. `supabase db push` creates two of them; the code creates the other two.

| Bucket | Used by | How it is created |
|---|---|---|
| `resumes` | [charlie-store.mjs](../charlie-store.mjs): each person's resume text, `<email>.txt` | Created by migration `20261029120000_storage_resumes_bucket.sql` |
| `cvs` | Qualify & Submit: the CV PDFs people send | Created by migration `20261005170000_hire_connections.sql` |
| `job-pool` | The engine: the scanned job pool (`latest.json`), feed and stats, the company cache | Created by the code on first write |
| `voice-verification` | Voice verification: CVs, raw webhook payloads | Created by the code on first write ([voice/store.mjs](../voice/store.mjs)) |

Keep all four private.

### Seeded rows

Two migrations insert rows:

- `hire_connections`: one connection with key `pieworks`, mode `off`.
- `hire_orgs`: one org with id `charlie`.

## Email domain and DNS

Use a subdomain for mail (for example `mail.example.com`) and another for the server (for example `api.example.com`).

1. **Sending.** Add the domain in Resend. Add the SPF (TXT) and DKIM (TXT or CNAME) records Resend shows. Wait until Resend says the domain is verified.
2. **Receiving.** Turn on receiving for the same domain in Resend. Add the MX record Resend shows to that subdomain. Charlie routes inbound mail by the part before `@`, so the domain must accept any address:

   | Address | Purpose |
   |---|---|
   | `start@` (`CHARLIE_START_ADDR`) | Onboarding, and the default for any other reply |
   | `check@` | Fit scorecard for a job the person sends |
   | `track@` | Application tracking from forwarded mail |
   | `intro@` | Warm-intro finder |
   | `join@` (`JOIN_INBOUND`) | Hiring-campaign flow (only when `JOIN_CAMPAIGN=on`) |
   | `chase+<token>@` | A reply to a role email, logged as interest in that role |
   | `apply+<key>@` | A reply to a Qualify & Submit email |
   | `pieworks+<key>@` | A reply to a Pieworks 2call email |

3. **DMARC.** Add a DMARC record for your domain. `/inbound` refuses to act on mail whose provider verdict is an explicit DMARC fail, so a forged `From:` cannot write another person's profile.
4. **Server.** Point `api.example.com` at your server host (a Railway custom domain). Set `PUBLIC_BASE_URL=https://api.example.com`. Links in emails use it.
5. **Site.** Point your site domain at the web host. Set `CHARLIE_SITE_URL` and `NEXT_PUBLIC_SITE_URL` to it.

Check the result with:

```sh
node scripts/health.mjs     # MX records, /healthz, /pool-stats, /pool-feed, suppression status
```

## Run locally

### Server

```sh
npm run start:remote        # tsx server/charlie-remote.ts, port PORT (default 8787)
curl localhost:8787/healthz
```

To receive real inbound mail locally, expose the port with a tunnel and point the Resend `/inbound` webhook at it.

To run only the outreach inbox API, use [scripts/outreach-dev.mjs](../scripts/outreach-dev.mjs).

### Engine

```sh
npm run preflight                       # every preflight check
npm run engine:scan                     # preflight + ingest + scan, then health check; emails no person
EMAIL_DRY_RUN=1 npm run engine:run      # the full daily chain; role emails and the newsletter are previews
EMAIL_DRY_RUN=1 ONLY_EMAIL=you@example.com npm run scheduler   # one person only
```

Notes:

- `engine:run` and `engine:scan` start with `preflight.mjs --phase=pre-scan`. It fails (and stops the chain) if Supabase or Anthropic is unreachable or a required variable is missing.
- The pre-send preflight needs a job pool with more than 1,000 roles, scanned within `POOL_MAX_AGE_HOURS` (default 48). A first local scan may give fewer roles than that.
- The scan and scheduler steps run with `--max-old-space-size=4096`. Give the machine at least 4 GB of free memory.
- Neither command emails a person with `EMAIL_DRY_RUN=1` (`engine:scan` never does). They can still email **you**: preflight, the health check and the watchdog send operator alerts to `WATCHDOG_TO` / `ALERT_EMAIL` / `OWNER_EMAIL` when a check fails. Leave those empty locally if you do not want alert mail.
- `EMAIL_DRY_RUN=1` covers every send path in the chain, the newsletter included. Still run against a test database whose only active people are addresses you control. An empty `RESEND_API_KEY` is not a way to test: preflight fails without it and stops the chain.
- `engine:run` exits non-zero when a guard (preflight or the pre-send guard self-test) stops it, after running the health check, watchdog and run-eval.

### Web apps

```sh
npm run dev                 # root site (app/) at http://localhost:3000
(cd web && npm run dev -- -p 3001)   # dashboard (web/) at http://localhost:3001
```

- The root site has the voice dashboard at `/hq/<VOICE_DASHBOARD_SECRET>`.
- The [web/](../web/) dashboard has the workspace at `/hq/<VOICE_DASHBOARD_SECRET>/workspace` (Inbox, Agents) and the voice studio at `/hq/<VOICE_DASHBOARD_SECRET>/studio`.
- Both read the server URL from `NEXT_PUBLIC_CHARLIE_API_BASE`.
- The hiring APIs are off until `HIRING_WORKSPACE=on`, voice until `VOICE_VERIFICATION=on`. Off routes answer 404.
- A browser may call the hiring APIs only from an origin in `HIRE_APP_ORIGINS`. For the local dashboard above, set `HIRE_APP_ORIGINS=http://localhost:3001`.

### Tests

See [../CONTRIBUTING.md](../CONTRIBUTING.md).

## Deploy the server, engine, sweep and worker (Railway)

The repo has four Railway config files. Create one Railway service per file, all from this repo. In each service's settings, set the config-file path to the matching file. Railway builds with Nixpacks, which reads `engines.node` (22.x) from [package.json](../package.json).

| Config | Suggested service name | Start command | Restart | What it does |
|---|---|---|---|---|
| [railway.json](../railway.json) | `charlie` | `npm run start:remote` | on failure; health check `GET /healthz` | The always-on server: inbound mail, webhooks, links, hiring APIs, and the in-process timers (below). |
| [railway.engine.json](../railway.engine.json) | `charlie-engine` | `npm run engine:run` | never; one replica | One run of the daily chain, then exit. |
| [railway.sweep.json](../railway.sweep.json) | `charlie-sweep` | `npm run sweep:run` | never; one replica | One client-board sweep (Tally → score → Notion), then exit. |
| [railway.worker.json](../railway.worker.json) | `charlie-worker` | `npm run worker:run` | on failure; one replica | The work-queue worker. Loops until stopped. |

[scripts/env-parity.mjs](../scripts/env-parity.mjs) reads the services named `charlie` and `charlie-engine`. Use those names if you want to use it.

### No cron schedule

None of the configs has a `cronSchedule`, and [cron-chain.test.mjs](../cron-chain.test.mjs) fails if one is added. The engine and the sweep run when an operator starts them: redeploy or restart the service in Railway (or run `railway up` / the start command by hand). To run them on a timer, you must remove that test assertion on purpose and add a `cronSchedule`.

### In-process timers on the server

The `charlie` service runs these on `setInterval` ([server/charlie-remote.ts](../server/charlie-remote.ts)). Each one is a no-op unless its feature flag is on.

| Every | Job | Flag |
|---|---|---|
| 5 min | Due scheduled tasks (`scheduled_tasks`): auto-unpause, onboarding retry, journey watchdogs | always |
| 10 min | Voice post-call pipeline sweep | `VOICE_VERIFICATION` |
| 15 min | Qualify & Submit agent sweep | `HIRING_WORKSPACE` |
| 15 min | Pursuit sync for the outreach inbox | `HIRING_WORKSPACE` |
| 30 min | Pieworks 2call activation pass | `PIEWORKS_ACTIVATION` |
| 30 min | Completeness nudge | `COMPLETENESS_NUDGE` |
| 30 min | Invite confirmation sweep | always |
| 1 h | Hiring-campaign stall nudge | `JOIN_CAMPAIGN` |
| 6 h | Wedge email, represent offer, game plan | `WEDGE_DRIP`, `REPRESENT`, `GAME_PLAN` |
| 12 h | Depth question | `DEPTH_QUESTION` |
| 24 h | Depth snapshot | `DEPTH_SNAPSHOT` |

Run exactly one replica of the server, because these timers are in process.

### Environment per service

- `charlie` and `charlie-engine` share most variables. The simplest setup is to give both the same set. [scripts/env-parity.mjs](../scripts/env-parity.mjs) reports any shared variable whose value differs.
- `charlie-sweep` needs the core Supabase, Anthropic and Resend variables, plus `TALLY_API_KEY`, `NOTION_TOKEN`, `ALERT_EMAIL` and optionally `SWEEP_WORK_DIR` and `HEARTBEAT_URL_SWEEP`.
- `charlie-worker` needs the Supabase variables, and optionally `SENTRY_DSN` and `HEARTBEAT_URL_WORKER`.
- `RAILWAY_SERVICE_NAME` is set by Railway. Do not set it.

### Memory

The engine runs scan and scheduler steps with a 4,096 MB heap. Choose a Railway plan that gives the engine service more than that.

## Deploy the web apps

Both apps are standard Next.js apps and run on any Next.js host.

### Root site (`app/`)

- Build from the repo root: `npm run build`, start with `npm run start`.
- [vercel.json](../vercel.json) and [.vercelignore](../.vercelignore) are set up for Vercel. `.vercelignore` keeps large local engine files (such as `jobs.json`) out of the upload.
- Environment: `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_START_ADDR`, `NEXT_PUBLIC_CHARLIE_API_BASE`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optionally `NEXT_PUBLIC_GA_ID`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (build only).

### Dashboard (`web/`)

- Create a separate project whose root directory is `web/`.
- Build with `npm run build`, start with `npm run start` (inside `web/`).
- Environment: `NEXT_PUBLIC_CHARLIE_API_BASE` only. The dashboard holds no keys.
- On the server, add the dashboard's origin to `HIRE_APP_ORIGINS`, and set `VOICE_APP_ORIGIN` to it so voice call links (`/v/<token>`) point at the dashboard.

## Turn features on

Everything beyond the core is off until you set its flag. Turn on one feature at a time and watch the logs.

| Feature | Set on the server |
|---|---|
| Hiring workspace (agents API, outreach inbox, agent schedule) | `HIRING_WORKSPACE=on`, `VOICE_DASHBOARD_SECRET`, `HIRE_APP_ORIGINS`, `CHARLIE_HEALTH_URL=<PUBLIC_BASE_URL>/healthz` (agent sends are refused without it) |
| Qualify & Submit live | The above, the `PIEWORKS_*` API values, then set the `pieworks` connection's mode to `shadow`, then `live`, in the dashboard (Agents) or with `PUT /agents/api/connections/pieworks` |
| Pieworks 2call activation | `PIEWORKS_WEBHOOK_SECRET`, `PIEWORKS_API_*`, `PIEWORKS_ACTIVATION=shadow`, then `live`. See [PIEWORKS_2CALL.md](PIEWORKS_2CALL.md) |
| Voice verification | `VOICE_VERIFICATION=on`, the `ELEVENLABS_*` values, `VOICE_LLM_BEARER`, `VOICE_DASHBOARD_SECRET` |
| Client-board sweep | Deploy `charlie-sweep` with `TALLY_API_KEY` and `NOTION_TOKEN` |
