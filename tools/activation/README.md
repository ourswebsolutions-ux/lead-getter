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
- `src/main/activation-config.json`: the WhatsApp/phone contact shown in the app, and the public key of the cancellation list. Committed.

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

## Cancelling a subscription by email

Send an email **from `ADMIN_EMAIL` to the SMTP account (`SMTP_USER`)**, subject exactly `Subscription Cancellation`, with this line in the body:

```
Activation ID: LF-089S-2JVN-5CMD (stop)
```

### How it works

SMTP only sends, so the inbox of `SMTP_USER` is read over IMAP, read-only, by [the cancellations workflow](../../.github/workflows/cancellations.yml), every 10 minutes (GitHub may run it later than scheduled, sometimes by 30 minutes or more). Accepted commands go into a signed list on the `cancellations` branch, and the app reads it at each start and every 10 minutes. The app itself never opens the mailbox, and **the signing key is never built into the app**. Do not put it in `ACTIVATION_CONFIG`.

### Setup

No new password is needed when SMTP is a Gmail account: the job uses the same login, from the `ACTIVATION_CONFIG` secret. `npm run setup` has already created `CANCEL_SIGNING_KEY`, and put its public key in `activation-config.json`.

1. Give the job the key, from this folder:

   ```
   node -e "const {loadEnv:l}=require('./lib');console.log(JSON.stringify({CANCEL_SIGNING_KEY:l().CANCEL_SIGNING_KEY}))" | gh secret set CANCELLATION_CONFIG
   ```

2. Test it: send a command for your own test computer, then run `gh workflow run cancellations.yml`.

If SMTP moves to a send-only key, the job needs its own mailbox login: add `IMAP_USER` and `IMAP_PASS` to that secret (and `IMAP_HOST`, `IMAP_PORT` for another provider). The activation emails then stop landing in that account's Sent mail, so new Activation IDs count as unknown (see below).

### Rules

- **Sender:** the mail must have one From address, `ADMIN_EMAIL`, with a valid DKIM signature from that address's domain over it, checked by the job against the published key. Headers in the mailbox are not trusted: the login is in every installed copy, so a message could be planted there. A forged From is refused and gets no reply.
- **Command:** the exact subject and the exact line in the body. The subject alone does nothing. A reply, a second Activation ID, or any other wording is ignored.
- **Inbox:** only the inbox is read. If Gmail puts the command in Spam, mark it as not spam and send it again.
- **Unknown ID:** the Activation ID must appear in an activation or Free Trial email in the Sent mail of the same account. Otherwise the command is ignored and logged. A customer activated by reference has no such email: first send any email containing their Activation ID from that account, then send the command again.
- **Once only:** each email is handled once. A plan activated after the cancellation is not affected, so a new code reactivates a customer.
- **Your record:** an email for each event, with its time and Activation ID, and another when the customer's computer has applied it. The workflow log holds no Activation IDs, because the repository is public. If a customer's computer sets its clock ahead before activating, the cancellation can miss that plan.

**Keep `.env` secret and backed up.** `npm run setup -- --new-secret` replaces `ACTIVATION_SECRET`, which ends existing activations in builds made afterwards. Never commit `.env` or send it to anyone.

See the main README, "Limitations (no server)", for what this does and doesn't protect against.
