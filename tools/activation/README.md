# Lead Finder activation setup (administrator)

The app itself creates each 6-digit activation code and emails it **only to you** (`ADMIN_EMAIL`), with the customer's Activation ID, plan and price. This folder holds the settings the app is built with. It is not a server, website or dashboard.

## 1. Email account

The SMTP login is built into every installed copy of the app, where it can be extracted. **Use a send-only SMTP key** from a transactional email service such as Brevo (free tier), Mailgun, SendGrid or Amazon SES. **Never** use your mailbox password or a Gmail App Password: anyone who extracts it could read your mail, including the codes in the Sent folder.

Brevo example: create an account, verify the sender address, and create an SMTP key under *SMTP & API*. Then use `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER` = your Brevo SMTP login, and `SMTP_PASS` = the SMTP key.

## 2. Setup

```
cd tools/activation
npm run setup          # creates .env (first time) with a new ACTIVATION_SECRET
# fill in ADMIN_EMAIL, SMTP_* (and CONTACT_* if different) in .env, then:
npm run setup          # writes the app's settings
npm run check-smtp     # sends a test email to ADMIN_EMAIL
```

`npm run setup` writes:
- `src/main/activation-secret.json`: secret, `ADMIN_EMAIL` and SMTP. Git-ignored; packaged into builds made on this computer.
- `src/main/activation-config.json`: the WhatsApp/phone contact shown in the app. Committed.

## 3. Releases built on GitHub

From the repository folder:

```
gh secret set ACTIVATION_CONFIG < src/main/activation-secret.json
```

A release build stops with an error when this is missing or incomplete. Run the command again after changing the SMTP key or email.

## Daily use

When a customer clicks **Activate**, you receive *"Lead Finder activation 123456: Monthly for LF-XXXX-XXXX-XXXX"*. Check the payment, then send the 6 digits to the customer by WhatsApp or phone **within 10 minutes**. If the code has expired, the customer clicks **Send a new code** and you get a new email; the old code stops working.

### When the activation email cannot be sent

If `FALLBACK_CODE_PATTERN` is set in `.env` (your private code form; see `.env.example`), a request whose email fails is not lost: the customer sees a **reference** (like `7K2F-9QXM`) to send you with their Activation ID and plan, by WhatsApp or phone. After checking the payment, work out that request's code:

```
npm run fallback-code -- LF-XXXX-XXXX-XXXX monthly 7K2F-9QXM
```

and give the customer the 6 digits within **30 minutes**. The code works only for that request (that computer, plan and reference), once, with 3 tries; at most 3 such requests and 6 wrong codes per day. A new request cancels the previous one. The code form is never shown in the app and is not in the repository: it is built into the app from your `.env` (run `npm run setup`, then `gh secret set ACTIVATION_CONFIG < src/main/activation-secret.json` for GitHub builds). Without it, a failed email is reported as before.

**Keep `.env` secret and backed up.** `npm run setup -- --new-secret` replaces `ACTIVATION_SECRET`, which ends existing activations in builds made afterwards. Never commit `.env` or send it to anyone.

See the main README, "Limitations (no server)", for what this does and doesn't protect against.
