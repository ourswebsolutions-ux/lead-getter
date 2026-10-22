# Lead Finder licence server

Receives subscription applications from the app (stored locally: a SQLite file and an uploads folder for payment screenshots, both in `DATA_DIR`), emails them to the administrator with **Approve Subscription** and **Cancel Subscription** buttons, and returns each device's subscription status as a token signed with the server's key. Approvals, expiry and access are decided here, with the server's clock. The desktop app holds no secrets.

## Setup

Requires Node.js 22.13 or newer.

```bash
cd server
npm install
npm run setup -- --public-url https://licence.your-domain.com   # creates the signing key, configures the app
# edit .env: SMTP_*, SUBSCRIPTION_ADMIN_EMAIL, PAYMENT_INSTRUCTIONS
npm start
```

`npm run setup` writes `LICENSE_PRIVATE_KEY` into `server/.env` (keep it secret and back it up; losing it means every issued status becomes unverifiable) and writes the matching **public** key and URL into `../src/main/license-config.json`. **Rebuild the desktop app after running setup** (`npm run release` in the project root) so it trusts this server.

## Environment (`server/.env`)

| Variable | Example | Purpose |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Where the server listens (put an HTTPS reverse proxy in front) |
| `PUBLIC_BASE_URL` | `https://licence.your-domain.com` | Public address used in the email buttons |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Gmail + **app password** | Outgoing email |
| `SUBSCRIPTION_ADMIN_EMAIL` | `info.axoraweb@gmail.com` | Receives approval requests |
| `PAYMENT_INSTRUCTIONS` | (optional) | Extra payment text on the plans screen |
| `LICENSE_PRIVATE_KEY` | created by `npm run setup` | Signs subscription status |
| `DATA_DIR` | `./data` | Subscription database (`subscriptions.db`) and payment screenshots (`uploads/`) |
| `SUBSCRIPTION_API_URL` | `https://subscription.axorawebsolutions.com/api/v1` | Axora subscription website API |
| `SUBSCRIPTION_API_TOKEN` | the website's `ADMIN_API_TOKEN` | When set, the website decides paid access (see below). Admin credential: this file only, never the desktop app |

## Axora subscription website

With `SUBSCRIPTION_API_TOKEN` set, the website decides paid access. On each status check (and after each application), this server reads the device by its exact Device ID. If the website doesn't know the device yet, it registers it there as an **inactive** user under the customer's application email. It never changes or deletes an existing account; an email that already belongs to another Device ID (`409 email_exists`) is left as it is and reported to the app. Only `effectiveStatus` `active` grants paid searches. If the website is unreachable or refuses the token, nothing is written and the next check retries. The full flow, status mapping and error handling are in [docs/AXORA-INTEGRATION.md](../docs/AXORA-INTEGRATION.md).

Without the token, this server decides access itself, as before.

## Data

Everything lives in `DATA_DIR` on this machine: `subscriptions.db` (devices, applications, licences, free-trial counts) and `uploads/` (payment screenshots, readable only through a valid Approve/Cancel link). Back up the folder together with `.env`.

An expired Approve/Cancel link of a still-pending application emails you fresh links when opened (at most every 10 minutes), so a pending request never gets stuck.

## Deployment

**Production address:** `https://subscription.axorawebsolutions.com/lead-getter`. That's the `serverUrl` in `src/main/license-config.json`, which every installed app uses.

This server runs on the same machine as the subscription website, as its own PM2 service. nginx sends `/lead-getter/` to it, and everything else stays with the website, whose code doesn't change. Until this is set up, the website answers `/lead-getter/...` itself with its admin login (HTTP 401, `WWW-Authenticate: Basic realm="Axora Subscriptions"`). Installed apps then report that the licence server isn't installed at that address.

`npm run dev` doesn't need any of this: it starts this server on your computer (`http://127.0.0.1:8787`) and points the app at it. To run the dev app against the production address instead, use `npm run dev -- --production-licence`.

### On the website's server (PM2 + nginx)

Requires Node.js **22.13 or newer** (the server uses the built-in `node:sqlite`) and PM2.

1. Install, as the user that runs the website:

   ```bash
   curl -fsSLo install.sh https://raw.githubusercontent.com/ourswebsolutions-ux/lead-getter/main/server/deploy/install.sh
   bash install.sh            # clones to /opt/lead-getter (APP_DIR=... to change)
   ```

   The first run creates `/opt/lead-getter/server/.env` and stops. Fill it in by copying the values from `server/.env` on your computer, keeping the same `LICENSE_PRIVATE_KEY` (installed apps trust its public key). Then set:

   ```
   PUBLIC_BASE_URL=https://subscription.axorawebsolutions.com/lead-getter
   HOST=127.0.0.1
   PORT=8787
   DATA_DIR=/var/lib/lead-getter
   SUBSCRIPTION_API_URL=http://127.0.0.1:3060/api/v1
   ```

   Then run `bash install.sh` again. It starts the `lead-getter-licence` PM2 service and checks `/lead-getter/health`.
2. Add [deploy/nginx-lead-getter.conf](deploy/nginx-lead-getter.conf) inside the website's `server { … }` block, **above** `location / { … }`, then run `sudo nginx -t && sudo systemctl reload nginx`. The snippet raises the request size to 8 MB, because payment screenshots are larger than nginx's 1 MB default.
3. Check from any computer with the repository: `npm run check:licence`. It must show ✔ for health, plans and the signed status. The release workflow runs the same check and won't publish while it fails.

**Updates:** `bash /opt/lead-getter/server/deploy/install.sh`.

**Logs:** `pm2 logs lead-getter-licence`.

**Back up** `server/.env` and `DATA_DIR`.

### Other hosts

Any host works the same way: run `node --env-file=.env src/index.js` (Node 22.13+) and proxy HTTPS requests for `PUBLIC_BASE_URL` to `HOST:PORT`. The server accepts requests with or without the `/lead-getter` prefix. If the address changes, set it with `npm run setup -- --public-url https://…` (or edit `src/main/license-config.json`) and rebuild the installers.

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
