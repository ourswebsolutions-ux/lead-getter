# Lead Finder licence server

The Lead Finder subscription API: plans, activation codes, the daily qualified-lead allowance, and each device's status as a token signed with the server's key. Data is a local SQLite file in `DATA_DIR`. Activation, expiry and allowances are decided here, with the server's clock; the desktop app holds no secrets.

**Production runs the same API on the subscription website** (`https://subscription.axorawebsolutions.com/lead-getter`, project `subcription.axorawebsolutions.com`, MySQL). This server is for development (`npm run dev` starts it), tests and CI.

## Setup

Requires Node.js 22.13 or newer.

```bash
cd server
npm install
npm run setup -- --public-url https://licence.your-domain.com   # creates the signing key, configures the app
# edit .env: SMTP_*, SUBSCRIPTION_ADMIN_EMAIL, PAYMENT_INSTRUCTIONS, CREDITS_TIMEZONE
npm start
```

`npm run setup` writes `LICENSE_PRIVATE_KEY` into `server/.env` (keep it secret and back it up; losing it means every issued status becomes unverifiable) and writes the matching **public** key and URL into `../src/main/license-config.json`. **Rebuild the desktop app after running setup** (`npm run release` in the project root) so it trusts this server.

## Environment (`server/.env`)

| Variable | Example | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where the server listens (put an HTTPS reverse proxy in front) |
| `PUBLIC_BASE_URL` | `https://licence.your-domain.com` | Public address of this server |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Gmail + **app password** | Outgoing email |
| `SUBSCRIPTION_ADMIN_EMAIL` | `info.axoraweb@gmail.com` | Receives every Activation ID and code (the only recipient) |
| `PAYMENT_INSTRUCTIONS` | (optional) | Extra payment text on the plans screen |
| `LICENSE_PRIVATE_KEY` | created by `npm run setup` | Signs subscription status |
| `DATA_DIR` | `./data` | Subscription database (`subscriptions.db`) |
| `CREDITS_TIMEZONE` | `Asia/Karachi` (default) | Daily allowances reset at midnight here |
| `PLAN_*` | see `.env.example` | Optional prices, durations and daily allowances |

## Data

Everything lives in `DATA_DIR` on this machine: `subscriptions.db` (devices, subscriptions with their plan, activation requests with hashed codes, the daily allowance counters and charged leads, and an audit log). Back up the folder together with `.env`.

## Deployment

Production doesn't run this server: the subscription website serves the same API at `https://subscription.axorawebsolutions.com/lead-getter` (the `serverUrl` in `src/main/license-config.json`), with the same signing key. Deploy changes there (see that project's README).

`npm run dev` starts this server on your computer (`http://127.0.0.1:8787`) and points the app at it. To run the dev app against production instead, use `npm run dev -- --production-licence`. Any other host works too: run `node --env-file=.env src/index.js` (Node 22.13+) behind HTTPS.

## How activation works

1. The app asks for a plan (`POST /api/activation { plan }`). The server creates an **Activation ID** (`ACT-XXXX-XXXX`) and a random **4-digit code**, and emails both, with the plan and the Device ID, to `SUBSCRIPTION_ADMIN_EMAIL` only. Asking again for the same plan keeps the same request; another plan replaces it.
2. Once paid, the administrator gives the customer the code.
3. The app sends the code (`POST /api/activation/verify`). If it matches, the request's plan is activated at once: Monthly and Six Months run one and six calendar months from activation (renewing the same plan early continues from its end), and One-Time never expires.

**Code rules:**
- A code works once and expires after 24 hours.
- Only an HMAC of it is stored, keyed with a secret derived from the signing key.
- 5 wrong tries lock it. Each try is counted before the comparison, so simultaneous guesses can't get more.
- `POST /api/activation/resend` emails the administrator a new code, once a minute and up to 5 a day.
- At most 5 requests a day per installation.
- If the email can't be sent, the request is closed and nothing else happens.

## Daily allowance

`POST /api/credits/reserve { source, key }` charges one new qualified lead to today's allowance. `key` is a hash the app makes from the phone number, or from the listing when there is no valid number, so the server never sees leads.

- **Each lead is charged once per account,** stored in `credit_leads` with a unique key. Finding it again, a retry, or the other source finding it costs nothing.
- **The day's counter** (`credit_usage`) is raised in the same transaction, only while it is below the limit, so simultaneous requests can't go over.
- **Accounts:** paid plans use the installation's account and share one counter for both sources. Free uses the computer's account (so reinstalling doesn't reset it), with a counter per source.
- **Expired and suspended plans:** expired falls back to Free; suspended saves nothing.

## Security notes

- **Device signatures:** each app installation has its own Ed25519 key, and its device ID is derived from that public key. Every request is signed and timestamped (±5 minutes) and carries a single-use nonce, so requests can't be replayed.
- **Signed status:** every status answer is signed by this server and includes the app's random nonce and the server's time. The app accepts no other source of truth, so editing local files or changing the computer's clock doesn't grant access.
- **Logging:** SMTP credentials are never logged.
