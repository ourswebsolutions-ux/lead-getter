# Lead Finder licence server

Receives subscription applications from the app (stored in **Supabase**: Postgres for records, private Storage for payment screenshots), emails them to the administrator with **Approve Subscription** and **Cancel Subscription** buttons, and returns each device's subscription status as a token signed with the server's key. Approvals, expiry and access are decided here, with the server's clock. The desktop app holds no secrets.

## Setup

Requires Node.js 22.13 or newer.

```bash
cd server
npm install
npm run setup -- --public-url https://licence.your-domain.com   # creates the signing key, configures the app
# edit .env: SMTP_*, SUBSCRIPTION_ADMIN_EMAIL, PAYMENT_INSTRUCTIONS
npm start
```

`npm run setup` writes `LICENSE_PRIVATE_KEY` into `server/.env` (keep it secret and back it up; losing it means every issued status becomes unverifiable) and writes the matching **public** key and URL into `../src/main/license-config.json`. **Rebuild the desktop app after running setup** (`npm run dist:linux` in the project root) so it trusts this server.

## Environment (`server/.env`)

| Variable | Example | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where the server listens (put an HTTPS reverse proxy in front) |
| `PUBLIC_BASE_URL` | `https://licence.your-domain.com` | Public address used in the email buttons |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Gmail + **app password** | Outgoing email |
| `SUBSCRIPTION_ADMIN_EMAIL` | `info.axoraweb@gmail.com` | Receives approval requests and usage alerts |
| `PAYMENT_INSTRUCTIONS` | (optional) | Extra payment text on the plans screen |
| `LICENSE_PRIVATE_KEY` | created by `npm run setup` | Signs subscription status |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Supabase project |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` | Storage API, **server only** |
| `SUPABASE_DB_URL` | `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` | Session pooler (IPv4). URL-encode the password (`@` becomes `%40`) |
| `SUPABASE_DB_CA` | `certs/supabase-root-2021-ca.crt` | Supabase root CA. TLS is verified against it (same file as Dashboard → Database → SSL) |
| `SUPABASE_SCHEMA` | `leadfinder` | Private schema, not exposed by Supabase's public API |
| `SUPABASE_BUCKET` | `payment-screenshots` | Private bucket (5 MB, PNG/JPEG/WebP only) |
| `SUPABASE_CRON` | `1` | Schedule the hourly pg_cron cleanup |
| `SCREENSHOT_RETENTION_DAYS` | `90` | Days to keep a screenshot after approval or cancellation |
| `USAGE_DB_LIMIT_MB`, `USAGE_STORAGE_LIMIT_MB` | `500`, `1024` | Free Plan limits used for alerts |
| `USAGE_ALERT_PERCENTS` | `80,90,95` | Email thresholds |
| `MAINTENANCE_INTERVAL_HOURS` | `6` | How often the server runs maintenance |
| `MAINTENANCE_MAX_DELETES` | `200` | Cap on deletions per step per run |
| `MAINTENANCE_DRY_RUN` | `0` | `1` = report only, delete nothing, send no alerts |

The publishable key isn't needed: the desktop app never talks to Supabase directly. `npm run migrate` applies the schema (it also runs automatically on start); `npm run maintenance` runs one cleanup pass by hand.

## Storage management

| What | When | How |
|---|---|---|
| Replay-protection records | expired | pg_cron, hourly at :17 (`leadfinder.cleanup_db`) and in each server run |
| Email links | used (after 1 day); expired links of **decided** applications; expired email-verification links | same |
| Maintenance log | after 90 days | same |
| Payment screenshots | `SCREENSHOT_RETENTION_DAYS` after approval or cancellation | server job via the Storage API, every `MAINTENANCE_INTERVAL_HOURS` |
| Orphaned uploads (no application refers to them) | older than 1 day | server job |
| Usage check (database + storage vs Free Plan) | every run | email at 80/90/95%, repeated weekly while above |

**Never deleted automatically:** pending applications or their screenshots, applications themselves (when a screenshot is removed, its size and SHA-256 stay as the payment reference), licences and expiry dates, devices, and free-trial counts. Every delete has explicit conditions and a per-run cap; storage deletes only exact `applications/…` object names, never a prefix or a bucket. Every step is written to `leadfinder.maintenance_log`.

An expired Approve/Cancel link of a still-pending application emails you fresh links when opened (at most every 10 minutes), so a pending request never gets stuck.

## Deployment

Render: use the Blueprint in [render.yaml](../render.yaml) (steps in the main README). Render's free tier blocks outgoing SMTP, so set `BREVO_API_KEY` there; mail then goes through Brevo's HTTPS API, from the `SMTP_FROM` address verified in Brevo.

Any other small Linux host works as well (a VPS, Railway, Fly.io). Requirements:

1. HTTPS on `PUBLIC_BASE_URL` (for example Caddy or nginx with Let's Encrypt) proxying to `HOST:PORT`.
2. Keep `.env` backed up (the data itself lives in Supabase).
3. `chmod 600 .env` on the host. On the current NTFS drive, Linux can't enforce file permissions.

## How approval works

- **Opening a button** shows a confirmation page with the plan, the message and the screenshot. Nothing changes until **Approve Subscription** or **Cancel Subscription** is pressed on that page, so email link scanners can't trigger it.
- **Each link** is random, stored only as a hash, valid for 7 days and usable once. Approving or cancelling spends both links, and a second attempt shows "already processed".
- **On approval**, the plan is activated for that device: Monthly is 1 month and Six Months is 6 months, both counted from activation (a renewal before expiry continues from the current end date); Lifetime never expires.
- **Notifications** go to the applicant only if they gave an email and confirmed it through the link sent to them.

## Security notes

- **Device signatures:** each app installation has its own Ed25519 key, and its device ID is derived from that public key. Every request is signed and timestamped (±5 minutes) and carries a single-use nonce, so requests can't be replayed.
- **Signed status:** every status answer is signed by this server and includes the app's random nonce and the server's time. The app accepts no other source of truth, so editing local files or changing the computer's clock doesn't grant access.
- **Uploads:** screenshots are checked by their file signature (PNG, JPEG or WebP, up to 5 MB), stored with random names, and only viewable through a valid action link.
- **Logging:** SMTP credentials are never logged.
