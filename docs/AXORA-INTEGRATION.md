# Lead Getter and the Axora subscription website

This covers how Lead Getter registers customers on the [Axora subscription website](https://subscription.axorawebsolutions.com) and reads their subscriptions from it. The website's API is described in its own `docs/API.md` (base URL `https://subscription.axorawebsolutions.com/api/v1`).

## Who talks to whom

```
desktop app ──device-signed──▶ Lead Getter licence server ──Bearer SUBSCRIPTION_API_TOKEN──▶ subscription website
            ◀──signed status──                            ◀──JSON──
```

- **Admin token:** every website route needs the website's admin credentials. So only the licence server (`server/`) calls the website, using `SUBSCRIPTION_API_TOKEN` from its own environment. The desktop app never holds `ADMIN_API_TOKEN`, `ADMIN_USERNAME` or `ADMIN_PASSWORD`.
- **Signed requests:** the app signs each request with its device key (Ed25519). Only the licence server's signed answers count, and they carry the app's nonce and the server time. Nothing stored on the computer counts as a subscription.
- **Addresses:** in production the licence server runs at `https://subscription.axorawebsolutions.com/lead-getter` (`src/main/license-config.json`). See [server/README.md](../server/README.md#deployment).

## Identity

| Website field | Lead Getter value |
|---|---|
| `id` | The app's **Device ID**, exactly as it is (case-sensitive, 32 characters `A-Z a-z 0-9 - _`), derived from the installation's device key. The app shows it in the plans window. |
| `email` | The customer's email from their subscription application, lower-cased. It is required in the application form. |

## Registration

The licence server checks the website whenever the app connects (each signed status check: at startup, before each search, every 30 minutes during a search) and right after an application is submitted:

1. `GET /users?search=<Device ID>`, then match the **exact** ID, because search also matches ID prefixes and emails.
2. **Device ID found:** its subscription status and expiry are used. Nothing is created or changed, even if its email differs from the one in the application.
3. **Device ID not found, and an email is on file** (from the customer's latest application): `POST /users` with `{ "id": <Device ID>, "email": <email> }`. The website creates the user as **`inactive`**. Lead Getter never activates anyone automatically: only the administrator does, on the website or with the email **Approve** button.
4. **Device ID not found and no email yet** (no application): nothing is sent. The app runs on its free searches.

| `POST /users` answer | What happens |
|---|---|
| `201` | Registered. The status is `inactive`, so no paid access. |
| `409 user_exists` | Registered a moment earlier. The status is read again; nothing is changed. |
| `409 email_exists` | The email belongs to **another** Device ID. That account isn't deleted, overwritten or modified. This device stays unregistered and the app explains why ("already linked to another Lead Getter device"). It's logged once on the server. To resolve it, the administrator moves or removes the other account on the website, or the customer applies again with their own email. |
| `400 validation_failed` | Not registered. This shouldn't happen, because emails are checked against the website's own rule before sending. |
| `401`, `429`, `5xx`, timeout (10 s), unreachable | Nothing is written. The app shows "could not be confirmed" and the next check retries. |

The administrator's email for each application includes a **Subscription website** line. It shows "registered (inactive until you activate it)", "email already belongs to another Device ID", or "not reachable, retried automatically".

### Email validation

The same rule is applied in the app's form, in the app's main process and on the licence server. It's the rule the website uses for `POST /users`: a local part of 1–64 characters, a domain ending in a 2–24 letter top-level domain, no spaces or `@<>()",;:`, and at most 254 characters overall. A missing email gets "Enter your email address." and an invalid one gets "The email address is not valid." In both cases nothing reaches the licence server or the website.

## Subscription status

Only `effectiveStatus === "active"` grants paid searches.

| Website `effectiveStatus` | Licence server `subscription.state` | App message |
|---|---|---|
| `active` | `active`, with `expiresAt` (`null` = lifetime) | Paid searches allowed; days left shown |
| `expired` | `expired` | "Your subscription has expired." |
| `suspended` | `suspended` | "Your subscription has been suspended." |
| `inactive` | `inactive` | "not been activated yet", or "awaiting approval" while an application is pending |
| not registered | `none` | Free searches, then the plans |
| email belongs to another device | `none`, with `registration.state = email_in_use` | "already linked to another Lead Getter device" |
| website unavailable or token refused | `unavailable` | "could not be confirmed"; paid searches pause, and a running search continues |

In every state, the 3 free searches per computer remain available until they're used up.

The signed status also includes `registration.state`, one of `registered`, `not_registered`, `no_email`, `email_in_use`, `invalid` or `unavailable`.

## Email Approve button

The administrator's **Approve** button is a manual activation:

1. It registers the device if needed (as above).
2. It activates it with `PATCH /users/:id/subscription { "status": "active", "expiresAt": … }` for the plan's duration. A renewal starts from the current expiry, and Lifetime sends `null`.

If the website refuses (for example `email_exists`) or can't be reached, nothing changes and the link stays usable. Suspending or changing a subscription on the website always takes precedence at the app's next check.

## Environment (licence server only)

| Variable | Value |
|---|---|
| `SUBSCRIPTION_API_URL` | `https://subscription.axorawebsolutions.com/api/v1` |
| `SUBSCRIPTION_API_TOKEN` | The website's `ADMIN_API_TOKEN`. When it's set, the website decides paid access. |
| `PUBLIC_BASE_URL` | `https://subscription.axorawebsolutions.com/lead-getter` in production |
| `LICENSE_PRIVATE_KEY` | Unchanged; the app's public key in `license-config.json` matches it |

Nothing about the website is configured in the desktop app.

## Tests

`test/axora.test.js` runs the licence server and the desktop client over real HTTP against the website's own Express app and `Users` code, from `../subcription.axorawebsolutions.com` or `AXORA_SITE_DIR`, with Prisma answered from memory. Where that project isn't present, as in CI, it uses a stand-in written from its `docs/API.md`. It covers:

- new registration (inactive, once);
- an existing Device ID and email;
- a duplicate Device ID and a duplicate email;
- missing and invalid emails;
- inactive, active, expired, suspended and lifetime subscriptions;
- website downtime and recovery, an invalid token and timeouts;
- the email Approve button;
- the `/lead-getter` path deployment.
