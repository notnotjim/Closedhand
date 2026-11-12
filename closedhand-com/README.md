# closedhand.com

The small service behind closedhand.com. It serves the public website and
the three things a copy of Closedhand asks it for:

- **Personal URLs** (`name.closedhand.ai`): a copy asks for a name, its owner
  claims it here by signing in with Google (or Microsoft), and the copy takes
  it at the relay (`relay/` in the repo root) with a pass from here, signed for
  its name and the copy's own key and good for a day. The copy proves it
  answers at the new address before the address is marked ready. Nothing is
  built for an address: Cloudflare only answers DNS for `*.closedhand.ai`,
  with one record pointing at the relay.
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
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64; seals what is kept secret at rest (claim codes, an account number until its computer collects it, the NEAR AI sign-in) |
| `BASE_URL` | `https://closedhand.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in, asking only for the email |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft sign-in, same |
| `MICROSOFT_ASSOCIATED_APP_IDS` | Microsoft app IDs published at `/.well-known/microsoft-identity-association.json`, so their permission screens name closedhand.com (defaults to `MICROSOFT_CLIENT_ID`). Those other than `MICROSOFT_CLIENT_ID` are the apps a computer connects mail through, and their sign-in claims a personal URL in one step |
| `GOOGLE_ASSOCIATED_CLIENT_IDS` | Closedhand's own Google app (the Desktop app client official builds carry), comma separated; its sign-in claims a personal URL in one step |
| `PHONE_ENROLLMENT_ENABLED` | `1` to accept new personal URLs. Personal URLs already claimed keep getting their passes either way |
| `RELAY_PASS_PRIVATE_KEY` | closedhand.com's Ed25519 private key (PEM, PKCS8; `\n` for line breaks is fine), which signs the passes computers show the relay. Its public half is the relay's `RELAY_PASS_KEY` |
| `RELAY_ADDRESS` | Where computers reach the relay, as `host:port` (`relay.closedhand.ai:443`) |
| `RELAY_CONTROL_HOST` | The relay's own name, which computers ask for when they connect (`relay.closedhand.ai`; the relay's `RELAY_CONTROL_HOST`) |
| `RELAY_PIN` | The SHA-256 of the relay's certificate (DER), base64url: computers check the relay against it, so no other server can pose as it |
| `RELAY_REPORT_SECRET` | Shared with the relay, whose report each minute of the personal URLs connected to it (`/jobs/relay-seen`) keeps "last online" and lets unused ones go. Without it, no address is ever let go for lack of use |
| `ADDRESS_IDLE_DAYS` | How long a personal URL's computer may stay away before the address is let go, its name held for its owner (default 90) |
| `BUG_RECEIPT_SECRET` | Signs bug report receipts (defaults to `SESSION_SECRET`) |
| `ADDRESS_LIMIT` | How many personal URLs may exist (default 100) |
| `NEAR_REFRESH_TOKEN` | A sign-in at NEAR AI (cloud.near.ai), as its refresh token (`rt_...`, copied from cloud.near.ai while signed in); with it, each account that claims a personal URL gets its own NEAR AI key, Closedhand Managed Models (lib/included-ai.js). NEAR replaces the token each time it is used, so closedhand.com keeps the current one sealed in its database (lib/near-session.js) and only starts again from this one when it changes; the maintainer is told when NEAR stops taking it. `TOKEN_ENCRYPTION_KEY` seals it and keys the fingerprints. Without it, no keys are made |
| `NEAR_USER_AGENT` | The user agent of the browser that sign-in was made in, exactly: NEAR renews a sign-in only for the browser it was made in. A sign-in lasts a week from each renewal, and the hourly sweep renews it. Without it, no keys are made |
| `NEAR_ORG_ID` | The NEAR AI organisation whose credit the keys draw on (optional when the sign-in has only one) |
| `NEAR_WORKSPACE_ID` | The workspace in it the keys are made in (optional when it has only one) |
| `NEAR_API_BASE` | NEAR AI's address for signing in and managing keys (default `https://cloud-api.near.ai`; NEAR says it is moving) |
| `INCLUDED_AI_TRIAL_DAYS` | How long the free days of Closedhand Managed Models last (default 14), and the subscription's own free days for someone who never had them (Polar's trial, set on each checkout). Given once per sign-in, ever: a one-way fingerprint of it stays after the account is deleted |
| `INCLUDED_AI_TRIAL_USD` | The most LLM use the free days allow (default 12). Whatever they leave unused carries into a paid month as it begins, up to one month's fair use |
| `INCLUDED_AI_MONTHLY_PEOPLE` | How many people you expect to start their free days in a calendar month (default 100). Never a stop: the maintainer is told at 75%, 90% and 100%, then every further 25% (lib/capacity.js) |
| `INCLUDED_AI_DAILY_PEOPLE` | Free days started in 24 hours worth telling the maintainer about as a burst (default 25). Never a stop |
| `INCLUDED_AI_MONTHLY_BUDGET_USD` | The monthly NEAR AI spend you expect across every Managed Models key; the misuse check weighs this month's pace against it. The organisation's credit at NEAR is the stop, shown on /insights with the days it lasts |
| `OPERATOR_EMAILS` | The maintainers' sign-in emails, comma-separated: they can open /insights, and an account signed in with one of them, its address verified, collects the notices above and Closedhand says them in its chat. A notice not collected within a day is emailed to `ASSISTANT_EMAIL_OPERATOR` through the `MAIL_*` sender |
| `INCLUDED_AI_PER_CONNECTION` | How many people one internet connection can claim it for in 30 days (default 10, so an office sharing one connection fits) |
| `INCLUDED_AI_FAIR_USE_USD` | Fair use: the most LLM use a month of the subscription (also each month of one renewing every 6 or 12 months), or of a plan paid ahead in crypto, allows (default 20). Each month raises the key's spending limit by it, plus what the month before left unused, up to one month's fair use; carrying on past it adds another month's. People never see an amount |
| `POLAR_ACCESS_TOKEN` | A Polar organization access token for the Managed Models subscription (lib/plus.js), with the scopes `checkouts:write`, `customer_sessions:write` and `subscriptions:write`. Without it, and the three below, subscribing is off |
| `POLAR_WEBHOOK_SECRET` | The secret of Polar's webhook to `BASE_URL/api/plus/webhook`, as Polar shows it (`whsec_...`), sending `subscription.created`, `subscription.updated`, `subscription.active`, `subscription.uncanceled`, `subscription.canceled`, `subscription.revoked` and `order.paid` |
| `POLAR_PLUS_PRODUCT_ID` | The Managed Models subscription product: monthly |
| `POLAR_EXTEND_PRODUCT_ID` | The one-time product that carries a subscriber on past fair use to the end of the month (optional) |
| `POLAR_6_MONTHS_PRODUCT_ID`, `POLAR_12_MONTHS_PRODUCT_ID` | The subscription products renewing every 6 months and every 12 months, priced for less a month than the monthly one. Both set, an account without a subscription can choose them |
| `BTCPAY_URL`, `BTCPAY_STORE_ID`, `BTCPAY_API_KEY`, `BTCPAY_WEBHOOK_SECRET` | closedhand.com's own BTCPay Server, for paying 3, 6 or 9 months ahead in crypto: its address, the Closedhand store's id, a Greenfield API key that can create and view that store's invoices, and the secret its webhook (to `/api/ahead/btcpay`, on InvoiceSettled) is signed with. Crypto is offered with all four set |
| `CRYPTO_3_MONTHS_USD`, `CRYPTO_6_MONTHS_USD`, `CRYPTO_9_MONTHS_USD`, `CRYPTO_EXTEND_USD` | What paying ahead in crypto costs, in US dollars (default 90, 168 and 243), and carrying on past a month's fair use in crypto (default 30) |
| `POLAR_SERVER` | `sandbox` to use Polar's sandbox (sandbox-api.polar.sh) while trying it out; anything else is live |
| `INCLUDED_AI_PROVIDER` | Where Managed Models' keys are made: `near` (default, NEAR AI's private inference, with `NEAR_REFRESH_TOKEN` and `NEAR_USER_AGENT`) or `openrouter` (OpenRouter's per-account keys behind a guardrail of the chosen models on providers that keep nothing, with `OPENROUTER_PROVISIONING_KEY`). Computers follow within the hour. On OpenRouter the Privacy page and every "nobody but you can read it" line must change too |
| `INCLUDED_AI_MODELS` | The models those keys are for, comma-separated: the first for chat, the second for support work (default on NEAR `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`, on OpenRouter `deepseek/deepseek-v4.1-flash`). On NEAR, text only: pictures go to the vision language model on the person's computer. Computers pick up a change within the hour |
| `INCLUDED_AI_MODEL_NAME` | The chat model's name as people read it in Settings and setup (default on NEAR `DeepSeek V4.1 Flash, uncensored`, on OpenRouter `DeepSeek V4.1 Flash`). Change it with `INCLUDED_AI_MODELS` |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter's provisioning key, only with `INCLUDED_AI_PROVIDER=openrouter` |
| `INCLUDED_AI_VISION_MODEL` | On OpenRouter only, the model pictures and videos go to (default `xiaomi/mimo-v2.6-flash`; empty: the chat model reads them). Never on NEAR, whose encryption carries words |
| `INCLUDED_AI_RETIRING_MODELS` | On OpenRouter only, models being switched away from that keys may still use for a while |
| `TRUSTED_PROXY_HOPS` | Proxies in front that add X-Forwarded-For (default 2: Cloudflare, then Railway) |
| `ASSISTANT_EMAIL_ENABLED`, `ASSISTANT_EMAIL_RELEASED`, `ASSISTANT_EMAIL_PRODUCTION` | All `1` to offer assistant email; any other value keeps it off |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The mail transport's AWS user: send through SES, read the mail queues and bucket, invoke the guard |
| `ASSISTANT_EMAIL_INBOUND_QUEUE`, `ASSISTANT_EMAIL_INBOUND_TOPIC` | Where SES announces incoming mail |
| `ASSISTANT_EMAIL_FEEDBACK_QUEUE`, `ASSISTANT_EMAIL_FEEDBACK_TOPIC` | Where bounces and complaints arrive |
| `ASSISTANT_EMAIL_BUCKET` | Where SES stores incoming mail until it is collected |
| `ASSISTANT_EMAIL_GUARD_FUNCTION`, `ASSISTANT_EMAIL_OPERATOR` | The stop-only AWS function the spending guard calls, and who gets its alerts |

Sign-in callbacks are `BASE_URL/auth/google/callback` and
`BASE_URL/auth/microsoft/callback`.

## The relay

`relay/` in the repo root runs on its own (`relay/main.js` lists its
settings). It passes each browser's encrypted connection to the computer it
asked for, and tells closedhand.com which personal URLs are connected. Making
closedhand.com's key for passes, and the relay's pin from its certificate:

```
openssl genpkey -algorithm ed25519 -out pass-key.pem
openssl pkey -in pass-key.pem -pubout -out pass-key.pub.pem
openssl x509 -in relay-cert.pem -outform der | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
```

`pass-key.pem` is `RELAY_PASS_PRIVATE_KEY` here and `pass-key.pub.pem` the
relay's `RELAY_PASS_KEY`; the last line prints `RELAY_PIN`.

## Tests

`node --test test/e2e.js` with `DATABASE_URL` pointing at an empty Postgres
(it resets the schema). `scripts/test-closedhand-com.js` in the repo root
covers the rules that need no database.
