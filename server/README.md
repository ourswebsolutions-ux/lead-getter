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

**Production address:** `https://subscription.axorawebsolutions.com/lead-getter`. That's the `serverUrl` in `src/main/license-config.json`, which the installers use. This server runs on the same subdomain as the subscription website, under the path `/lead-getter`. The website itself has no routes the app could use: all of its routes need its admin credentials.

For development, `npm run dev` runs this server on `127.0.0.1:8787` and points the app at it, whatever `license-config.json` says.

### cPanel ("Setup Node.js App", next to the subscription website)

1. Upload the `server/` folder, for example to `~/lead-getter-licence`, and run `npm install --omit=dev` in it (cPanel's **Run NPM Install** button).
2. **Create Application:**
   - Node.js **22.13 or newer**. The server uses the built-in `node:sqlite`.
   - Application root: the folder from step 1.
   - Application URL: `subscription.axorawebsolutions.com/lead-getter`.
   - Startup file: `src/index.js`.
3. Environment variables: copy them from your local `server/.env`, keeping `LICENSE_PRIVATE_KEY` unchanged, because the app's public key matches it. Then set:
   - `PUBLIC_BASE_URL=https://subscription.axorawebsolutions.com/lead-getter`
   - `HOST=127.0.0.1`
   - `DATA_DIR`: an absolute path outside `public_html`, for example `/home/<user>/lead-getter-data`
   - `SUBSCRIPTION_API_TOKEN`: the website's `ADMIN_API_TOKEN`
4. Start the app and open `https://subscription.axorawebsolutions.com/lead-getter/health`, which should show `{"ok":true}`.

The server works whether or not the host strips the `/lead-getter` prefix before passing requests on.

### VPS (nginx)

Run `node src/index.js` under systemd, with the environment above and `PORT=8787`. Add this to the subscription site's `server` block, before `location /`:

```nginx
location /lead-getter/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

In both cases, back up `DATA_DIR` along with the environment variables. The subscription records themselves live in the website's database.

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
