# Contributing

## Install

Node.js 22 and npm.

```sh
npm ci
(cd web && npm ci)
```

The tests need no API keys and no database. [vitest.config.mjs](vitest.config.mjs) sets fixed placeholder values for the variables tests read.

## Run the checks

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, the migration guard, and a `web` job (dashboard tests, type check, lint and build).

To run the same checks before every push, enable the repo's pre-push hook once per clone:

```sh
git config core.hooksPath .githooks
```

[.githooks/pre-push](.githooks/pre-push) runs typecheck, lint, `npm test`, build and the migration guard (`origin/main` must be fetched; the guard stops with "base ref not found; fetch it first" otherwise).

| Check | Command |
|---|---|
| Everything below in one go (root) | `npm test` |
| Vitest suite | `npx vitest run` |
| Plain-node guard tests | `npm run test:guard`, `npm run test:drip`, `npm run test:preflight-logic`, `npm run test:knockout`, `npm run test:freshness`, `npm run test:font` |
| Type check | `npm run typecheck` |
| Lint | `npm run lint` |
| Root site build | `npm run build` |
| Migration guard | `bash scripts/check-migrations.sh origin/main` |
| Dashboard tests | `cd web && npm test` |
| Dashboard type check | `cd web && npm run typecheck` |
| Dashboard lint (also runs its tests) | `cd web && npm run lint` |
| Dashboard build | `cd web && npm run build` |

Focused Vitest runs: `npm run test:emails`, `npm run test:prompts`, `npm run test:schemas`, `npm run test:evals`, `npm run test:voice`, or `npx vitest run <file>`.

Vitest runs only the files listed in [vitest.config.mjs](vitest.config.mjs) `include`. A new root-level test file must be added there. Tests under `emails/`, `prompts/`, `lib/`, `evals/` and `voice/` are picked up by folder.

Other hand-run scripts (they need a filled `.env.local` and real services; none runs in CI):

| Script | What it does |
|---|---|
| `npm run scheduler:test` | [scheduler-e2e.mjs](scheduler-e2e.mjs): seeds a throwaway user and job pool, runs `scheduler.mjs` with `EMAIL_DRY_RUN=1` exactly as the engine does, checks a find was written, then cleans up. With `PROOF_INBOX` set it also sends one real proof email there. Needs a database. |
| `npm run voice:text` | [voice/text-mode.mjs](voice/text-mode.mjs): the voice-verification controller in your terminal. You type the candidate's answers; no model and no voice. Options: `--plan plan.json`, `--seconds-per-turn N`. |
| `npm run voice:pipeline -- --session <id>` or `-- --sweep` | [scripts/vv-pipeline.mjs](scripts/vv-pipeline.mjs): runs the post-call pipeline (extract, validate, evaluate, report) for one session or every session that owes a report. Spends model tokens (capped by `VOICE_MAX_PIPELINE_COST_USD`); sends nothing. |

Live evals call the Anthropic API and are opt-in: `node --env-file=.env.local evals/live.mjs`. See [evals/README.md](evals/README.md).

## Conventions

These rules are enforced by tests or CI where noted.

- **Migrations are new files only.** Never edit, rename or delete a file in [supabase/migrations/](supabase/migrations/). A schema change is a new timestamped file. After applying it, run `npm run db:types` and commit [lib/database.types.ts](lib/database.types.ts). CI: [scripts/check-migrations.sh](scripts/check-migrations.sh).
- **Every env var is in `.env.example`.** Any `process.env.NAME` read in a root module, `server/`, `voice/` or `prompts/` must be named in [.env.example](.env.example) with a one-line description. Test: [env-example.test.mjs](env-example.test.mjs). It also sees the heartbeat names built from `pingHeartbeat("<job>")` call sites and `process.env[NAME]` reads where `NAME` is a string constant in the same file; any other name built at run time is not caught, so add it by hand.
- **Prompts live in [prompts/](prompts/).** One file per model task, exporting the system prompt. The exceptions are the three runtime prompt specs at the repo root, [composer.md](composer.md), [dossier.md](dossier.md) and [matcher.md](matcher.md), which the engine reads at run time. The output schema for that task lives in [lib/schemas/](lib/schemas/). Model output is parsed with `safeParse` before use; a parse failure is handled, never guessed at.
- **External data is parsed at the boundary.** Webhooks, partner APIs and job-board feeds get a Zod schema in [lib/schemas/](lib/schemas/).
- **Every user-facing send goes through the send guard.** Call `sendGuarded` from [lib/send-guard.mjs](lib/send-guard.mjs). Never call `resend.emails.send` directly. Test: [lib/send-doors.test.mjs](lib/send-doors.test.mjs). An email about a specific role must also pass `preSendGuard` ([presend-guard.mjs](presend-guard.mjs)). Test: [sender-gate.test.mjs](sender-gate.test.mjs).
- **Nothing about a person is invented.** Copy that describes a person must come from their own material and pass the grounding verifier. The grounding gate is [evals/](evals/).
- **Email templates are locked by snapshots.** A template change shows up as a snapshot diff in [emails/](emails/). Update snapshots (`npx vitest run emails -u`) only after reviewing the rendered change. Colours and fonts come from [emails/tokens.mjs](emails/tokens.mjs).
- **New features are off by default.** Put a new feature behind an env flag, document the flag in `.env.example`, and fail closed when it is unset.
- **No scheduled starts.** The Railway configs must not declare a `cronSchedule`. Test: [cron-chain.test.mjs](cron-chain.test.mjs).
- **Formatting.** There is a Prettier config ([.prettierrc.json](.prettierrc.json)), but most existing root files predate it and are not Prettier-formatted, so `npm run format` / `format:check` are not part of the contributor flow and CI does not run them. Match the style of the file you edit. [web/](web/) has its own Prettier config (`cd web && npm run format`).

## Pull requests

Use the template in [.github/pull_request_template.md](.github/pull_request_template.md). Make sure `npm test`, `npm run typecheck`, `npm run lint` and the dashboard checks pass.
