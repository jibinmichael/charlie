# Security

## Reporting a problem

Please report security issues privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. The report is visible only to you and the repository maintainers.

Do not open a public issue, pull request or discussion for a security problem. Describe the affected file or route, the impact, and the steps to reproduce. Do not include real secrets or other people's personal data in the report.

## How secrets are handled

- **Environment only.** Every key and secret is read from environment variables. [.env.example](.env.example) holds placeholders only. `.env*` files other than the examples are in [.gitignore](.gitignore).
- **The server holds the keys.** The Supabase service-role key, the Anthropic key, the Resend keys and the partner keys live only on the server and batch services. The two web apps hold no keys. They read only `NEXT_PUBLIC_*` values, which are public by definition. Never put a secret in a `NEXT_PUBLIC_*` variable.
- **Service-role access.** All database access uses the service-role key on the server side. Row-level security is enabled on the tables. The only policy for the `anon` role lets the site insert into `waitlist`.
- **Error reports.** Sentry is optional. Personal data is scrubbed before an event is sent ([lib/sentry-scrub.mjs](lib/sentry-scrub.mjs)). API errors return only a short id to the browser; the detail stays in the server log.

## Authentication model

### Secret-in-URL dashboard

There are no user accounts. The dashboards live at `/hq/<secret>`. The page sends that secret as `Authorization: Bearer <secret>` to the server's `/agents/api/*`, `/outreach/api/*` and `/voice/api/*` routes.

- The server compares the Bearer with `VOICE_DASHBOARD_SECRET` using `crypto.timingSafeEqual` after a length check.
- An empty `VOICE_DASHBOARD_SECRET` refuses every request (503). A wrong one gets 401.
- Anyone with the link sees candidate data, so use a long random value (`openssl rand -hex 32`), share the link only with people who need it, and rotate the secret if a link leaks.
- The hiring routes answer a browser only from origins listed in `HIRE_APP_ORIGINS` (CORS). Unset means no origin.
- Each feature's routes answer 404 until its flag is on (`HIRING_WORKSPACE`, `VOICE_VERIFICATION`).

### Signed links in emails

Unsubscribe, feedback, apply and other email links carry a token signed with HMAC-SHA256 using `CHARLIE_TOKEN_SECRET` ([charlie-store.mjs](charlie-store.mjs)). The token carries the email address and a signature. The server derives identity only from a valid token, never from a request parameter. Signatures are compared in constant time. The server refuses to sign with a secret shorter than 16 characters. Rotating the secret invalidates every link already sent.

### Voice

- `/voice/llm` (the ElevenLabs custom LLM endpoint) requires `Authorization: Bearer <VOICE_LLM_BEARER>`, checked in constant time before the body is read.
- A candidate's call page uses a per-invitation token. The ElevenLabs agent is private: the browser cannot start a call without the conversation token the server mints.

## Webhook signatures

Every webhook is verified before its body is used. A missing secret rejects the webhook; it never accepts it.

| Route | Scheme | Secret |
|---|---|---|
| `POST /inbound` | Svix (`svix-id`, `svix-timestamp`, `svix-signature`), HMAC-SHA256 over `id.timestamp.body` | `INBOUND_WEBHOOK_SECRET`, then `RESEND_WEBHOOK_SECRET`. The server will not start if both are empty. |
| `POST /webhooks/resend` | Svix, as above | `RESEND_WEBHOOK_SECRET` |
| `POST /webhooks/pieworks` | `X-Pieworks-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `t.body`, at most 300 seconds old | `PIEWORKS_WEBHOOK_SECRET` |
| `POST /webhooks/elevenlabs` | `ElevenLabs-Signature: t=<unix>,v0=<hex>`, HMAC-SHA256 over `t.body`, at most 30 minutes old | `ELEVENLABS_WEBHOOK_SECRET` |

All comparisons use `crypto.timingSafeEqual`. The raw request body is kept for verification.

## Other protections in the code

- **Inbound mail.** Mail from Charlie's own domain and from system senders is ignored, each sender is rate limited (`INBOUND_MAX_PER_HOUR`), and mail with an explicit DMARC fail is refused, so a forged `From:` cannot change another person's profile.
- **Attachments.** At most `MAX_ATTACHMENTS` files of at most `MAX_ATTACHMENT_BYTES` each are read. Download URLs in webhook payloads are fetched through [safe-fetch.mjs](safe-fetch.mjs), which blocks internal and metadata addresses.
- **Input validation.** Request bodies, webhook payloads, partner API replies and model outputs are parsed with Zod schemas ([lib/schemas/](lib/schemas/)) before use.
- **Outbound mail.** Every user-facing email goes through [lib/send-guard.mjs](lib/send-guard.mjs) (suppression, a leak check for internal identifiers, idempotency).
- **HTTP headers.** The server sets security headers on every reply ([lib/http-guards.mjs](lib/http-guards.mjs)) and hides the framework banner. The dashboard sets `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS and `Cross-Origin-Opener-Policy: same-origin` ([web/next.config.ts](web/next.config.ts)).
- **Tests never reach partner hosts.** Under Vitest the Pieworks client refuses any host other than `*.test`, `localhost` and `127.0.0.1`.
