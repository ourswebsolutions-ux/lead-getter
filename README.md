# Lead Finder

A desktop app that searches Google Maps in **your own, already-open Google Chrome** and lists businesses that have no website of their own. You watch every step in the visible Chrome window; qualified leads appear in the app as they're found and are saved locally in SQLite.

## Download

Installers are attached to each [GitHub Release](https://github.com/ourswebsolutions-ux/lead-getter/releases): Windows `.exe`, Linux `.deb` and `.AppImage`, macOS `.dmg`. The installed app needs no Node.js or dev tools. Subscriptions and free searches are checked with the licence server set in `src/main/license-config.json`: `https://subscription.axorawebsolutions.com/lead-getter` in production. See [server/README.md](server/README.md#deployment).

The installers are not code-signed yet. Windows SmartScreen says "Windows protected your PC": choose **More info → Run anyway**. On macOS, right-click the app and choose **Open** the first time.

## Requirements

- Google Chrome **144 or newer**, installed normally (Linux, Windows, or macOS)
- Node.js 22.13+ and npm (only for building from source)

## Development

```bash
npm install && (cd server && npm install)
npm run dev          # everything: licence server → UI dev server → app
npm start            # same, with the built UI instead of the dev server
npm test             # unit tests (subscription tests use a temporary local licence server)
npm run test:e2e     # drives the real Electron app (temporary data)
```

`npm run dev` starts the licence server from `server/` (it needs `server/.env`, see [server/README.md](server/README.md)), waits until it answers `/health`, then starts the UI and the app pointed at it. It reuses a licence server that is already running, refuses to start twice, says which port is taken if another program holds 8787 or 5199, restarts the server if it crashes, and stops everything on Ctrl+C or when you close the app. Without `server/.env` the app still starts, but subscriptions and free searches are unavailable.

## Building installers

```bash
npm run release      # installers for this OS in release/
```

| Built on | Produces |
|---|---|
| Linux | `lead-finder_<version>_amd64.deb`, `Lead-Finder-<version>-linux-x86_64.AppImage` |
| Windows | `Lead-Finder-Setup-<version>.exe` |
| macOS | `Lead-Finder-<version>-mac-<arch>.dmg` |

The app finds the licence server through `src/main/license-config.json`. The licence server itself is never bundled into the app, because it holds the secrets that approve subscriptions. Start it with `npm run server` (or `npm run dev`).

### Publishing a release

[.github/workflows/release.yml](.github/workflows/release.yml) builds on Linux, Windows and macOS, installs and smoke-tests each build (the installed app must start, show its UI and load its modules), and publishes a GitHub Release with the installers and the update files:

```bash
npm version patch --no-git-tag-version      # or minor / major; sets "version" in package.json
git commit -am "Lead Finder $(node -p "require('./package.json').version")"
git push origin main
git tag "v$(node -p "require('./package.json').version")" && git push origin --tags
```

The tag must match `version`. No credentials are needed in the repository: the workflow publishes with the built-in `GITHUB_TOKEN`.

Optionally, check that installed copies pick up the new release (installs the previous release, waits for it to update itself):

```bash
gh workflow run update-test.yml -f from=<previous version> -f to=<new version>
```

### Automatic updates

Installed copies update themselves from this repository's GitHub Releases (the repository is public, so the app needs no token).

- **When:** the app checks 10 seconds after it starts, then every 4 hours.
- **Windows (.exe) and Linux AppImage:** the update downloads (only the changed parts when possible), installs silently and the app restarts as the new version. No clicks.
- **Linux .deb:** the update downloads by itself, then the system asks for the administrator password to install it, because installing a package needs root.
- **macOS:** the builds aren't signed, and macOS only installs updates into signed apps. The app shows "Lead Finder X is available" with a **Download** button. Signing with an Apple Developer ID would make macOS fully automatic too.
- **Never during a search:** a running search is never interrupted. The update waits and installs as soon as the search finishes.
- **Failures:** offline, a failed download or a failed install leave the current version running, and it tries again later. The app's data folder (leads, settings, PIN, subscription, WhatsApp link) is never touched by an update.
- **Log:** each install keeps `update.log` in its data folder.

iOS: see [docs/IOS.md](docs/IOS.md).

## Connecting to your Chrome

Lead Finder attaches to the Chrome you already use: same profile, same Google login. It doesn't embed a browser, create or copy a profile, or read cookies.

### One-time setup (normal Chrome profile folder)

Chrome 136+ deliberately ignores debugging flags for its normal profile folder, to protect your cookies from malware ([Chrome announcement](https://developer.chrome.com/blog/remote-debugging-port)). The only way Chrome allows another app to use your real profile is a switch that you turn on yourself. Chrome **remembers** it, so you do this once:

1. Click **Start Search**. If the switch is off, Lead Finder puts `chrome://inspect/#remote-debugging` on your clipboard and tells you what to do. (Chrome refuses `chrome://` addresses sent by other programs, so the app can't open the page for you.)
2. In Chrome, paste the address into the address bar and turn on **Allow remote debugging for this browser instance**.
3. Chrome asks whether to allow the connection. Click **Allow**.

Lead Finder waits up to 5 minutes and continues by itself; you don't need to click Start Search again. From then on, Chrome starts its debugging server whenever it starts (it listens on `127.0.0.1:9222` and writes `DevToolsActivePort` in its profile folder), and only the Allow prompt appears, once per Lead Finder session.

### What happens on Start Search

1. **Find Chrome and the profile.** Lead Finder locates the Chrome installation and the running Chrome process, and reads the profile it's using from the process's `--profile-directory`, or else the most recently used open profile in Chrome's `Local State`. You're never asked to pick one. If Chrome isn't running, it's started normally with that profile.
2. **Connect** through Chrome's endpoint, then verify by opening `chrome://version` in a new tab and reading the profile path. The app reports "connected" only after this real connection succeeds.
3. **If there's no endpoint:**
   - **Switch on, but this Chrome was started before it was saved:** Lead Finder offers to **restart Chrome** (you confirm in a dialog). Chrome closes normally, never force-closed, reopens with the same profile, and restores your tabs. Then the app reconnects and starts the search.
   - **Chrome uses a custom profile folder (`--user-data-dir`):** debugging flags work there, so the same confirmed restart relaunches that folder and profile with debugging enabled.
   - **Switch never turned on:** the one-time setup above.
4. **Search:** opens Google Maps, types your keyword exactly as entered, and submits it. If Enter doesn't submit, it presses Maps' Search button. It checks that Maps really searched for *that* keyword; if nothing happened, it retries once through the equivalent search address. A search that never ran is reported as a search error, never as "no results".

If something can't be done, the status shows a **Chrome connection** or **Search** label with the specific reason: Chrome missing or too old, the switch off (with exactly which files and ports were checked), the restart declined, Chrome not closing, Maps not returning results, and so on.

## Website filter

Before starting a search, choose **Website**:

- **Without website** (default): businesses with no website, or with only a social page. This is the original behaviour, including the extra web check.
- **With website:** only businesses whose Google Maps listing links to their own website. The domain is saved and shown. Listings without a website are skipped without any Google web check.
- **All businesses:** both kinds.

A business keeps the leads it has already become. One skipped earlier only because of a different filter is reopened when a later search wants it, so its phone and address get saved too. In the table, **Website** (All / Without / With) filters what's shown, and **WhatsApp only** shows just numbers WhatsApp confirmed. **Export CSV** exports exactly what's shown, so with WhatsApp only ticked, the file contains only those numbers.

## App lock (4-digit PIN)

- On first launch you create a four-digit PIN and confirm it. After that, every launch shows the unlock screen.
- **Storage:** the PIN is stored as a salted scrypt hash, encrypted with the OS keychain when one is available. It's never stored in plain text.
- **Wrong PINs:** after 5 wrong PINs the app pauses before the next try, starting at 30 seconds and growing to 15 minutes. The pause survives restarts.
- **Enforced in the main process:** until the PIN is accepted, the main process refuses every request except the unlock itself. Restarting, reloading or navigating inside the window doesn't reach any lead data.
- **Security menu:** the lock button in the header offers **Change PIN** (needs the current PIN) and **Lock now**.
- **Limits:** the lock protects the app. Someone with access to your computer account could still open `leads.db` directly with other tools.

## Subscriptions

Plans: **Monthly PKR 3,000**, **Six Months PKR 10,000**, **Lifetime PKR 20,000** (one-time).

- **Applying:** the plan button in the header (or a blocked search) opens the plans. Applying asks for the plan, a payment screenshot (chosen through the system file dialog and checked to be a real PNG, JPEG or WebP of at most 5 MB), an optional message and your email (required; it identifies your account on the subscription website). The application goes to the licence server (`server/`), which emails info.axoraweb@gmail.com with Approve and Cancel buttons. The app shows **Pending Approval** with the application ID.
- **Enforcement:** searching, CSV export and the WhatsApp features need an active subscription. Before each of them, and every 30 minutes during a search, the app asks the server for a freshly **signed** status and enforces it in the main process. Missing, pending, cancelled and expired subscriptions each get their own message and a button to the plans. Without a connection to the server, these features stay blocked; Maps needs the internet anyway.
- **Setup:** see [server/README.md](server/README.md). The app trusts only the server whose public key is in `src/main/license-config.json`.

### Axora subscription website

When the licence server has `SUBSCRIPTION_API_TOKEN`, the [Axora subscription website](https://subscription.axorawebsolutions.com) decides who has a paid subscription. Activation and suspension happen on the website.

- **Account:** each installation is a website user whose ID is its **Device ID** (shown in the plans window) and whose email is the one in the customer's application. The email field is now required.
- **Registration:** a new device is registered on the website automatically as **inactive**, and stays that way until the administrator activates it. Existing accounts are never changed. An email already used by another device is reported, not taken over.
- **Access:** paid searches only while the website reports the subscription as `active`. Suspended, expired, not activated, "email in use" and "could not be confirmed" each have their own message. The 3 free searches per computer stay available.
- **Credentials:** the website's admin token stays on the licence server. The desktop app never has it.

Details: [docs/AXORA-INTEGRATION.md](docs/AXORA-INTEGRATION.md).

## How a search works

1. Types your keyword into Google Maps' search box in a new tab and runs the search.
2. Reads the result list, scrolling it step by step (and pressing *See more* / *Load more* when Maps shows them) until Maps reports the end of the list or you press **Stop Search**.
3. Clicks each listing and reads its public name, phone, address, and website link.
4. Applies the website rules below, saves the result, and adds qualified leads to the table right away.

Pacing is deliberately slow: a few seconds between listings and a longer break every 25 listings.

### Website rules (conservative)

| Situation | Result |
|---|---|
| Maps shows a website link to the business's own domain | Excluded |
| Maps shows only a Facebook / Instagram / WhatsApp / Linktree / similar link, and the web check finds no own site | **Lead**: "No website (social page only)" |
| Maps shows no website, and a Google web search for the business finds no matching site | **Lead**: "No website found" |
| The web search shows a knowledge-panel website, or a result domain that matches the business name | Excluded (website or possible website) |
| Details didn't fully load, the web check failed or timed out, or it was blocked | Unverified: kept out of the table and re-checked on a later search |
| Permanently closed | Excluded |

Lead Finder never fetches a business's website itself, so a site that is temporarily down can't make a business look website-less. Directory and listing sites (Zameen, Yelp, OLX, Google listings, and so on) never count as the business's own website. Matching domains to names is a heuristic that errs toward excluding a business.

## Categories, Today and Past leads

- **Category** (next to the keyword): every search is filed under a category, for example keyword `Software House in Lahore`, category `Software House`. Typing shows saved categories as suggestions; click one, or use the arrow keys and Enter, to pick it. New names are saved automatically when the search starts. Capitalisation is normalised (`software house` becomes `Software House`), and names that differ only in case or spacing are treated as the same category. A category is required to start a search.
- **Today / Past leads:** switch between them with the control at the top of the leads panel.
- **Today's leads** is the default view: only leads discovered on the computer's current local date. Older leads are hidden, not deleted, and the view rolls over at midnight.
- **Open Past Leads** shows earlier days: all past dates, one date, or a date range, optionally narrowed to one category. **Back to Today** returns to the default view.
- **Show category** filters either view by category (with lead counts), including *Uncategorized* for leads saved before categories existed.

### Export

- **Export CSV (n)** exports exactly the leads shown: the current category and/or date, or the date range.
- **Export all** exports every saved lead.

Columns: `Business Name, Phone, Phone Status, Address, Google Maps URL, Website Status, WhatsApp, Category, Date Discovered`. Files are UTF-8 with a BOM, saved through a native save dialog.

### Delete

- **Delete** on a row, **Delete selected (n)** for checked rows, or **Delete all shown** for everything matching the current filters. Every delete asks for confirmation first, and bulk deletes run in a single transaction.
- Deleting removes the lead's name and contact details but keeps a minimal marker (the Maps place id), so a later search won't add the same business back. Saved categories and other records aren't affected.

## Phone numbers

Numbers are normalized with [libphonenumber](https://github.com/catamphetamine/libphonenumber-js) using full metadata, so each number is checked against its country's real numbering plan.

- A number written in international form (`+…` or `00…`) keeps its own country code: `+1 212 555 0123` → `+12125550123`.
- A local number is converted only when the listing's address names its country: `03001234567` on a "…, Pakistan" address → `+923001234567`, and the landline `0673361621` → `+92673361621`. Lead Finder never assumes `+92`.
- **Unverified:** the country can't be determined, or the number isn't valid in it. The number is shown exactly as found, with an *Unverified* tag.
- **Invalid:** too short or malformed. Shown struck through and never presented as a phone number.
- The original text is always kept in the database (`phone_raw`). A later search never replaces a validated number with a worse one. The table and CSV show the same format, and the CSV has a *Phone Status* column.

## WhatsApp (linked by QR code)

Lead Finder can link **your own WhatsApp account** to check whether lead numbers use WhatsApp and to send individual messages. It uses [Baileys](https://github.com/WhiskeySockets/Baileys), the open-source WhatsApp Web library, running inside Lead Finder itself, so there's no third-party server, API key or monthly plan.

> **Read this first.** Baileys is **not an official WhatsApp API**; it works the way WhatsApp Web does. WhatsApp's terms don't allow automated or unofficial clients, and WhatsApp may restrict or ban accounts used this way, especially ones that message many people who don't know them. Use a number you can afford to have restricted, keep volumes low, and only message businesses you have a genuine reason to contact.

### Linking

1. Click the **WhatsApp** button in the header, then **Link WhatsApp**.
2. On your phone: WhatsApp → **Settings → Linked devices → Link a device**, then scan the QR code. The code refreshes automatically; if it runs out, click **Show a new QR code**.
3. The header shows **WhatsApp connected**. The link is remembered and reconnects automatically when Lead Finder starts.

- **Disconnect:** closes the connection and keeps the link.
- **Unlink device:** logs this device out of WhatsApp and deletes the session from this computer. Your leads and check results are kept.
- **Connection drops:** Lead Finder retries 5 times, spaced from 2 s to 60 s. If another WhatsApp Web session takes over, or the phone unlinks the device, it stops and says so rather than fighting for the session.

### Automatic checks

While WhatsApp is connected, every saved lead with a **validated international number** is checked in the background, one number every 4 seconds. The checks never slow down a Maps search, and new leads are queued as they're found.

A number WhatsApp **confirmed** is shown in **green**; click it to write a message. Every other number (not on WhatsApp, check failed, not yet checked) looks normal, with no extra icon or label. Failed checks are retried automatically after an hour.

Each number is checked **separately**. Baileys' lookup silently drops numbers that aren't on WhatsApp, so a batched check couldn't tell "not on WhatsApp" from "no answer". A missing answer is only counted as *Unavailable* when the query itself succeeded; anything else is *Check failed*, never green. Results are saved in SQLite (`whatsapp_checks`) and not repeated. Marks made with the earlier manual flow aren't treated as confirmed: they show as *Not checked* and are re-checked automatically. The CSV *WhatsApp* column uses the same four statuses.

### Sending a message

Click a **green** number. The composer shows the lead, the number, and when you last messaged it. Write your message and click **Send**.

- From the lead table, one message goes to one lead per click. The only automatic sending is the opt-in outreach campaign below.
- The main process checks again before sending that the lead exists, the number is confirmed on WhatsApp, WhatsApp is connected, and the text is 1–4000 characters. It also enforces at least 8 seconds between messages.
- "Sent" appears only when WhatsApp returns a message ID; otherwise the composer shows WhatsApp's error and keeps your text. Every attempt is recorded in `whatsapp_messages` (lead, number, text, WhatsApp message ID, result).

### Chats

The **Leads | Chats | Outreach** switch in the header changes the workspace. Each view keeps its place when you switch: filters, the open chat, unsaved templates.

**Chats** is a WhatsApp Web-style view of your linked account.

- **Chat list:** contact name, number, the lead it matches (when the number is a lead), the last message, its time, unread count and profile picture. Avatars appear only when the contact shares one; otherwise initials are shown.
- **Conversation:** messages in order, with day separators and delivery ticks (sending, sent, delivered, read, not sent) as reported by WhatsApp.
- **Sending:** Enter sends and Shift+Enter starts a new line. Opening a chat sends read receipts, as WhatsApp Web does.
- **Search:** by name, number or message text.

What WhatsApp makes available, and what it doesn't:

- **New messages** (incoming, and sent from this app or your phone) arrive live while WhatsApp is connected.
- **History:** WhatsApp sends a device its **recent chats only when it is linked**. A device linked before this version needs to be linked again (WhatsApp menu → Unlink device → Link WhatsApp) to load past chats. **Older messages** of a chat can be requested with *Older messages*; whether and how many arrive is up to WhatsApp and your phone.
- **Groups**, channels and status updates aren't shown. Photos, voice notes and documents show as a label with their caption; media files aren't downloaded.
- **Privacy IDs:** some contacts appear under a WhatsApp privacy ID instead of a number. When WhatsApp shares the number, the chat is filed under it; otherwise the number shows as *not shared*.
- **Storage:** message text is stored **encrypted** with the OS keychain in the lead database (`wa_chats`, `wa_chat_messages`).

### Real-estate outreach

**Outreach** sends a three-message introduction to leads whose numbers the automatic check confirmed on WhatsApp.

> WhatsApp's terms don't allow automated messaging from unofficial apps, and numbers that send unexpected messages are often restricted or banned. Live sending asks you to accept this risk once. A **Test run** goes through the whole schedule without sending anything.

- **Messages:** three editable messages, in Urdu or Roman Urdu. The defaults are a greeting, *Kaise hain aap?* and a question about their business.
  - Placeholders: `{name}` and `{business}`. Each message has a version used when the name isn't known.
  - The name is the contact's own WhatsApp name, or one word from the business name, such as *Zahid Properties* → *Zahid*. It's used only when the word looks like a name (not *Real*, *Estate*, *Properties*, a city or a number). Otherwise the no-name version is used.
  - Names are never invented. You can edit or clear each contact's name before they're messaged. Previews show the exact text per contact.
- **Schedule:** one campaign message per **45–60 minutes** (a random time within your range), and at most **10–15 unique contacts per day** (10 by default; every message to a contact that day counts once).
  - The three messages to a contact are separated by at least the interval, and never sent back to back.
  - The interval, the daily count and the next send time are kept in the database, so they survive restarts.
- **Quiet hours** apply in the recipient's local time (from the country code; for example, Pakistan uses Pakistan time).
- **Replies:** any reply stops the sequence for that contact and hands the conversation to you. Messages such as *stop*, *not interested*, *message na karein* or *میسج نہ کریں* opt the number out for good. You can also exclude or opt out any contact yourself.
- **No duplicates:** each message to each contact is reserved in the database before it is sent, so retries, restarts, a second copy of the app or a reconnect can never send it twice.
  - If the app closes or a send times out mid-send, that contact is marked *Check chat* and never resent automatically.
  - Only one copy of Lead Finder runs at a time.
- **WhatsApp refusals:** rate limits, restrictions or a logged-out session pause the whole campaign (*possible restriction*) until you resume it. Three failures in a row also pause it.
- **Delivery:** sent, delivered and read states come from WhatsApp's receipts.
- **Conditions:** sending needs an active subscription and a connected WhatsApp, and the app has to be unlocked with your PIN. The campaign waits otherwise.
- **Storage:** campaign data is in `outreach_contacts`, `outreach_sends` and `outreach_optouts`.

### Security

- **Session encryption:** the WhatsApp session (keys and credentials) is stored in `whatsapp-session/` inside the app's data folder. Every file is encrypted with the OS keychain (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows, GNOME Keyring or KWallet on Linux), written atomically, and readable only by your user account. Without a real keychain, linking is disabled rather than storing the session weakly.
- **Kept in the main process:** the session never reaches the app's window. The window only receives the connection state, the QR image while linking, and the linked number.
- **No logging:** Baileys runs with a silent logger, so message content and keys aren't written anywhere.

## Chrome closing during a search

If Chrome, or Lead Finder's tab, closes while a search is running, the search pauses and Lead Finder reopens Chrome with the **same profile folder and profile**. It makes up to 3 attempts, after 5 s, 15 s and 30 s, and you can click Stop at any time. Then it reconnects and continues the same keyword and category, skipping every business already processed, so nothing is duplicated.

- With the normal Chrome folder, Chrome may ask you to **Allow** the new connection. Lead Finder says so and continues as soon as you do.
- If Chrome reopens with a **different profile**, Lead Finder stops rather than switch accounts.
- If Lead Finder itself closes mid-search, the next launch offers **Resume search** for that keyword and category.

## Interface

- **Light and dark mode:** use the sun/moon button in the header. Your choice is remembered; until you pick one, Lead Finder follows the system setting. Colours cross-fade when switching, and the WhatsApp green is tuned for each theme (at least 4.5:1 contrast).
- **Agent card:** while a search runs, a small card in the bottom left shows what the agent is doing: *online → Initializing Chrome connection → now working → Searching for potential clients → Analyzing business listings → Finding businesses without websites*. Each line appears only after its real event; "now working" only after Chrome is actually connected.
- **Completion card:** when a search finishes or you stop it, a card shows the real numbers. *New leads* is counted in the database (businesses that first became leads during this search), alongside *Listings processed* and *Already saved*. A short confetti burst plays only when new leads were found. Failed searches show their error instead, never a success card.
- **Background:** a slow ambient glow (GPU-only CSS) and faint connected nodes along the window edges (Canvas 2D). It runs at 24 fps during a search and 12 fps when idle, pauses when the window is hidden or unfocused, never takes mouse input, and is static under reduced motion. Measured renderer CPU: about 1.3% idle and 2% while searching.
- **Manage categories:** the pencil button next to the category filter renames or deletes saved categories. Renaming onto an existing name offers to **merge** the two. Deleting a category keeps its leads as *Uncategorized*. Leads are never deleted by category changes.
- **Reduced motion:** with the system's reduce-motion setting on, animations, confetti and the moving background are switched off.

## CAPTCHAs, limits, and errors

- If Google shows a CAPTCHA, an "unusual traffic" page, or a consent page, the search **pauses** and keeps its place. Lead Finder never solves or gets around it. Each recovery step is used **at most once per search**, so a persistent block never becomes a cycle of new tabs or restarts:
  1. After 45 s, a **fresh tab in the same Chrome session** reloads the exact page that was blocked. If it isn't blocked, the search continues there.
  2. After 2 min, if Chrome can be restarted with your profile, a **confirmed graceful restart**, then reconnect and continue.
  3. Otherwise it waits for **you** to solve it in Chrome, then resumes after a cool-down at half speed. Collected leads are kept and nothing is duplicated.
- Network loss: limited retries (5 s, 15 s, 30 s), then the search stops.
- Chrome closed, or Lead Finder's tab closed: the search stops with a **Chrome connection** message.
- After each listing, Lead Finder goes back to the result list with Maps' own Back button, so scrolling continues through all results until Maps shows "You've reached the end of the list".
- Every lead is saved the moment it's found, so a crash or a stop loses nothing.

## Data

- Database: `leads.db` in the app's standard user-data folder (`~/.config/Lead Finder` on Linux, `%APPDATA%\Lead Finder` on Windows, `~/Library/Application Support/Lead Finder` on macOS).
- Table `businesses` is keyed by the Google Maps place id, so a business is never stored twice. Every checked listing is recorded so it isn't revisited. Phone and address are kept **only for qualified leads**. A later search fills in missing fields but never blanks existing ones, and a failed re-check never demotes a verified lead. Each lead has `category_id` (pointing to `categories`) and `discovered_date`, the local calendar date. A lead keeps the category and date from when it was first found.
- Phone columns: `phone` (E.164 when validated, else as found), `phone_raw` (original), `phone_status` (`valid` / `unverified` / `invalid`), `phone_country`. Table `whatsapp_checks` holds the per-number result you recorded, and `app_state` holds the last search, for resuming after a crash.
- Table `categories` stores each category once, with a normalised key that ignores case and spacing.
- Schema upgrades are versioned (`PRAGMA user_version`, currently 2) and each runs once in a transaction. Version 2 converts stored phone numbers with the address's country and keeps the originals. Upgrading from the first version keeps every existing lead, computes its date from its recorded discovery time, and leaves its category empty (*Uncategorized*), because no category was ever recorded for it.
- Nothing is uploaded anywhere. Lead Finder doesn't read cookies or passwords.

## Google Maps terms: read this

The [Google Maps Terms of Service](https://www.google.com/help/terms_maps/), section 2, say you may not "copy the content" (2.2) or "mass download or create bulk feeds of the content" (2.3) without permission. Automatically collecting listing details into a database conflicts with those terms. Lead Finder is **not** verified as compliant. You use it at your own risk and are responsible for how you use it and the data it collects. It doesn't bypass CAPTCHAs, rate limits, or sign-in, and it keeps a slow, single-user pace. The browser layer (`src/browser/maps.js`) is separate from the UI and storage, so you can replace it with an authorized data source without changing the app.

## Project layout

```
src/main/       Electron main process: window, validated IPC, search lifecycle
src/preload/    Restricted bridge (window.leadFinder)
src/renderer/   React UI (Vite)
src/browser/    chrome.js (discovery + CDP attach), maps.js (Maps page ops),
                website.js (qualification rules), web-check.js, search-session.js
src/database/   SQLite store (node:sqlite, built into Electron)
src/export/     CSV generation
test/           Unit tests, Electron E2E test, real-Chrome integration script
server/         Licence server (subscriptions, approval email, local SQLite)
scripts/        dev.js (npm run dev), release.js (npm run release)
build/          App icon
```

Security: context isolation on, Node integration off, sandboxed renderer, strict CSP in builds, IPC accepted only from the app's own page, navigation and new windows blocked, and only Google Maps URLs can be opened externally.

## Real-Chrome integration tests

Automatic restart path, using its own temporary profile folder. A Chrome window opens; your own Chrome isn't touched. Optionally it also runs a short real Maps search:

```bash
node test/integration/restart-flow.js                       # restart + reconnect + tab restore
node test/integration/restart-flow.js "Real Estate Lahore" 5
```

Your everyday Chrome, with the switch on:

```bash
node test/integration/real-chrome.js "Real Estate Lahore" 6
```

It connects (click Allow in Chrome), prints the detected profile, processes about 6 listings in a visible tab, prints what it found (into a temporary database, not the app's), closes its own tabs, and disconnects, leaving Chrome running.
