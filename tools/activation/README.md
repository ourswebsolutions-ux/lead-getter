# Lead Finder activation tool (administrator)

Creates 4-digit activation codes for Lead Finder and emails them **only to you** (`ADMIN_EMAIL`). It runs on your computer when you need it. It is not a server, website or dashboard, and it never contacts the customer.

## Setup (once)

```
cd tools/activation
npm install
npm run setup          # creates .env with a new activation secret; writes it into the app build (git-ignored)
```

Then edit `.env`:

| Setting | |
|---|---|
| `ADMIN_EMAIL` | The only address codes are sent to |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Your outgoing mail account. For Gmail: `smtp.gmail.com`, `465`, your address, and an [App Password](https://myaccount.google.com/apppasswords) (not your normal password) |
| `CONTACT_WHATSAPP`, `CONTACT_PHONE` | Shown on the app's WhatsApp and Call buttons. Run `npm run setup` again after changing them, then build a new release |

Check the mail settings with `npm run check-smtp`.

`npm run setup` writes:
- `src/main/activation-secret.json`: the secret, git-ignored, packaged into builds you make here;
- `src/main/activation-config.json`: the contact numbers, committed.

**Releases built on GitHub** need the same secret as a repository secret. Run this from the repository folder and paste the `ACTIVATION_SECRET` value from `.env` when asked:

```
gh secret set ACTIVATION_SECRET
```

A release build stops with an error if the secret is missing.

**Keep `.env` secret and backed up.** Anyone with `ACTIVATION_SECRET` can make working codes. `npm run setup -- --new-secret` replaces it (then update the GitHub secret too). Codes from the old secret stop working, and existing activations end, in builds made afterwards. `.env` is git-ignored; never commit it or send it to anyone.

The secret is also inside every installed app, because the app has to check codes without a server. See the main README, "How codes are checked (and the limits)".

## Issuing a code

1. The customer sends you their **Activation ID** (`LF-XXXX-XXXX-XXXX`) and plan by WhatsApp or phone.
2. Check the payment.
3. Run:

   ```
   npm run otp -- LF-XXXX-XXXX-XXXX monthly       # or six_months, lifetime
   ```

4. The 4-digit code arrives in your inbox (it is not printed in the terminal). Send it to the customer by WhatsApp or phone. They choose the same plan in **Activate** and type the code.

A code works once, only on that Activation ID and plan, on the day it was made and the next two days (UTC). For a renewal, just issue a new code: the app adds the plan's length to a plan that is still running. `issued.log` here records each issue (ID, plan, dates), without the code.
