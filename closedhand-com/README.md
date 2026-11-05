# closedhand.com

The small service behind closedhand.com. It serves the public website and
the three things a copy of Closedhand asks it for:

- **Personal URLs** (`name.closedhand.ai`): a copy asks for a name, its owner
  claims it here by signing in with Google (or Microsoft), the Cloudflare
  Worker in `workers/provisioner` builds the route, and the copy proves it
  answers at the new address before the address is marked ready.
- **Bug reports** that a person chose to send, with a receipt that can check
  only that report's outcome.
- **Assistant email relay**: a copy that turns on its own email address
  (`name-xxxxxxxx@assist.closedhand.ai`) collects its mail here and hands over
  its replies (`lib/assistant-mail-relay.js`). The owner confirms the address
  at `/assistant-email/confirm`, signed in with Google or a personal Microsoft
  account, since replies go to that address. `lib/assistant-mail-worker.js`
  moves mail through Amazon SES: incoming mail arrives on an SQS queue as an
  S3 object and is sealed to the copy's own key; replies are sent one at a
  time and never resent when the outcome is unknown. A new email (not a
  reply) may only go to the owner. Allowances are per owner (migration 008),
  and a spending guard pauses everything at the monthly reserve.

It holds no one's calendar, files or conversations, and mail only on its
way: sealed to a copy's own key, and deleted once collected or after 14 days. Owners are known by
the permanent ID Google or Microsoft gives them, never by email address.

## Running it

```
npm ci
DATABASE_URL=postgres://... SESSION_SECRET=... TOKEN_ENCRYPTION_KEY=... node server.js
```

Migrations in `migrations/` apply on start.

| Setting | What it is |
|---|---|
| `DATABASE_URL` | Postgres for owners, personal URLs and bug reports |
| `SESSION_SECRET` | 32+ random characters; signs sessions and personal URL tickets |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64; encrypts connection credentials at rest |
| `BASE_URL` | `https://closedhand.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in, asking only for the email |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft sign-in, same |
| `MICROSOFT_ASSOCIATED_APP_IDS` | Microsoft app IDs published at `/.well-known/microsoft-identity-association.json`, so their permission screens name closedhand.com (defaults to `MICROSOFT_CLIENT_ID`). Those other than `MICROSOFT_CLIENT_ID` are the apps a computer connects mail through, and their sign-in claims a personal URL in one step |
| `GOOGLE_ASSOCIATED_CLIENT_IDS` | Closedhand's own Google app (the Desktop app client official builds carry), comma separated; its sign-in claims a personal URL in one step |
| `PHONE_ENROLLMENT_ENABLED` | `1` to accept new personal URLs |
| `PHONE_PROVISIONER_SECRET` | Shared with the provisioner Worker |
| `BUG_RECEIPT_SECRET` | Signs bug report receipts (defaults to `SESSION_SECRET`) |
| `ADDRESS_LIMIT` | How many personal URLs may exist (default 100) |
| `NEAR_REFRESH_TOKEN` | A sign-in at NEAR AI (cloud.near.ai), as its refresh token (`rt_...`, copied from cloud.near.ai while signed in); with it, each account that claims a personal URL gets its own NEAR AI key, Closedhand Managed Models (lib/included-ai.js). NEAR replaces the token each time it is used, so closedhand.com keeps the current one sealed in its database (lib/near-session.js) and only starts again from this one when it changes; the maintainer is told when NEAR stops taking it. `TOKEN_ENCRYPTION_KEY` seals it and keys the fingerprints. Without it, no keys are made |
| `NEAR_USER_AGENT` | The user agent of the browser that sign-in was made in, exactly: NEAR renews a sign-in only for the browser it was made in. A sign-in lasts a week from each renewal, and the hourly sweep renews it. Without it, no keys are made |
| `NEAR_ORG_ID` | The NEAR AI organisation whose credit the keys draw on (optional when the sign-in has only one) |
| `NEAR_WORKSPACE_ID` | The workspace in it the keys are made in (optional when it has only one) |
| `NEAR_API_BASE` | NEAR AI's address for signing in and managing keys (default `https://cloud-api.near.ai`; NEAR says it is moving) |
| `INCLUDED_AI_FIRST_MONTH_DAYS` | How long the first month of Closedhand Managed Models lasts (default 30). Given once per sign-in, ever: a one-way fingerprint of it stays after the account is deleted. Its key has the fair-use ceiling, never reset, and is stopped when the month ends unless a subscription takes over |
| `INCLUDED_AI_MONTHLY_PEOPLE` | How many first months you expect to start in a calendar month (default 100). Never a stop: the maintainer is told at 75%, 90% and 100%, then every further 25% (lib/capacity.js) |
| `INCLUDED_AI_DAILY_PEOPLE` | First months in 24 hours worth telling the maintainer about as a burst (default 25). Never a stop |
| `INCLUDED_AI_MONTHLY_BUDGET_USD` | The monthly NEAR AI spend you expect across every Managed Models key; the misuse check weighs this month's pace against it. The organisation's credit at NEAR is the stop, shown on /insights with the days it lasts |
| `OPERATOR_EMAILS` | The maintainers' sign-in emails, comma-separated: they can open /insights, and an account signed in with one of them, its address verified, collects the notices above and Closedhand says them in its chat. A notice not collected within a day is emailed to `ASSISTANT_EMAIL_OPERATOR` through the `MAIL_*` sender |
| `INCLUDED_AI_PER_CONNECTION` | How many people one internet connection can claim it for in 30 days (default 10, so an office sharing one connection fits) |
| `INCLUDED_AI_FAIR_USE_USD` | Fair use: the most LLM use a key allows (default 20), for the whole first month, or in each paid month of a subscription (each one raises the key's spending limit at NEAR by it; carrying on past it doubles it for that month) |
| `POLAR_ACCESS_TOKEN` | A Polar organization access token for the Managed Models subscription (lib/plus.js), with the scopes `checkouts:write`, `customer_sessions:write` and `subscriptions:write`. Without it, and the three below, subscribing is off |
| `POLAR_WEBHOOK_SECRET` | The secret of Polar's webhook to `BASE_URL/api/plus/webhook`, as Polar shows it (`whsec_...`), sending `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.uncanceled`, `subscription.canceled`, `subscription.revoked` and `order.paid` |
| `POLAR_PLUS_PRODUCT_ID` | The Managed Models subscription product: monthly |
| `POLAR_EXTEND_PRODUCT_ID` | The one-time product that carries a subscriber on past fair use to the end of the month (optional) |
| `POLAR_SERVER` | `sandbox` to use Polar's sandbox (sandbox-api.polar.sh) while trying it out; anything else is live |
| `INCLUDED_AI_MODELS` | The NEAR AI models those keys are for, comma-separated: the first for chat, the second for support work (default `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`). Text only: pictures go to the vision language model on the person's computer. Computers pick up a change within the hour |
| `INCLUDED_AI_MODEL_NAME` | The chat model's name as people read it in Settings and setup (default `DeepSeek V4.1 Flash, uncensored`). Change it with `INCLUDED_AI_MODELS` |
| `TRUSTED_PROXY_HOPS` | Proxies in front that add X-Forwarded-For (default 2: Cloudflare, then Railway) |
| `ASSISTANT_EMAIL_ENABLED`, `ASSISTANT_EMAIL_RELEASED`, `ASSISTANT_EMAIL_PRODUCTION` | All `1` to offer assistant email; any other value keeps it off |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The mail transport's AWS user: send through SES, read the mail queues and bucket, invoke the guard |
| `ASSISTANT_EMAIL_INBOUND_QUEUE`, `ASSISTANT_EMAIL_INBOUND_TOPIC` | Where SES announces incoming mail |
| `ASSISTANT_EMAIL_FEEDBACK_QUEUE`, `ASSISTANT_EMAIL_FEEDBACK_TOPIC` | Where bounces and complaints arrive |
| `ASSISTANT_EMAIL_BUCKET` | Where SES stores incoming mail until it is collected |
| `ASSISTANT_EMAIL_GUARD_FUNCTION`, `ASSISTANT_EMAIL_OPERATOR` | The stop-only AWS function the spending guard calls, and who gets its alerts |

Sign-in callbacks are `BASE_URL/auth/google/callback` and
`BASE_URL/auth/microsoft/callback`.

## Workers

`workers/provisioner` builds each personal URL's Cloudflare tunnel and DNS
record; it receives routing jobs only, never owners. `workers/edge` shows a
"Closedhand is offline" page when a personal URL's computer is asleep. Copy
each `wrangler.example.jsonc` to `wrangler.jsonc` (ignored by git), fill in
the IDs, and deploy with Wrangler.

## Tests

`node --test test/e2e.js` with `DATABASE_URL` pointing at an empty Postgres
(it resets the schema). `scripts/test-closedhand-com.js` in the repo root
covers the rules that need no database.
