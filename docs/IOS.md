# Lead Finder on iOS: assessment

## Short answer

The current app cannot be shipped to iPhone or iPad, and no build setting changes that.

- **Electron does not run on iOS.** Apple allows no Chromium/Node runtime there, and electron-builder has no iOS target.
- **The core feature cannot exist on iOS as designed.** Lead Finder drives *the user's own desktop Chrome* through the Chrome DevTools Protocol (playwright-core over `127.0.0.1:9222`). On iOS:
  - Every browser, Chrome included, must use Apple's WebKit, which has no remote-debugging port.
  - Apps cannot launch or control another app's browser.
  - Apps cannot run a background automation process.
- **Automating Google Maps pages in an app is also an App Store problem.** Scraping a Google property breaks Google Maps' terms, and Apple rejects apps that do it (Guideline 5.2, third-party content and intellectual property).
- **WhatsApp linking through Baileys** (an unofficial WhatsApp Web client) would also be rejected (Guidelines 5.2.2 and 2.5.1).

## What an iOS version would minimally require

It would be a separate app, not a port.

1. **A different data source for leads.** Use the official [Google Places API](https://developers.google.com/maps/documentation/places/web-service) ("Text Search" plus "Place Details": name, phone, website, address).
   - This needs a Google Cloud billing account. Calls are paid per request.
   - The API key must sit behind a server (it could extend the licence server), never inside the app.
   - The website rules in `src/browser/website.js` can be reused on the server: the `website` field becomes the qualification input.
2. **A native or cross-platform client.**
   - Options are SwiftUI, React Native or Capacitor. React Native or Capacitor would let some of the React UI be reused.
   - It would cover search, the lead list, categories, Today/Past, CSV export through the iOS share sheet, and the PIN lock (via Face ID / Keychain).
   - Local storage would be SQLite or Core Data.
3. **Subscriptions through Apple In-App Purchase.**
   - Apple requires IAP for digital subscriptions unlocked inside an iOS app (Guideline 3.1.1).
   - The current flow (manual payment by NayaPay, JazzCash or Easypaisa, with email approval) is not allowed for unlocking features on iOS.
   - The licence server would need to verify App Store receipts through App Store Server API notifications.
4. **WhatsApp.** Drop the Baileys integration. Use `https://wa.me/<number>` links, which open WhatsApp for the user to send a message themselves, or the official WhatsApp Business Platform (Cloud API, needs a Meta business account).

## Distribution requirements

- An Apple Developer Program membership ($99/year) and a Mac with Xcode to build and sign.
- An App Store Connect listing, privacy "nutrition label", privacy policy URL, and App Review.
  - Before public release, testers can install through TestFlight.
- IAP products configured in App Store Connect. Apple takes 15–30% of subscription revenue.
- No sideloading for the general public. EU alternative marketplaces still need Apple notarization and a developer account.

## Recommendation

Keep Lead Finder desktop-only (Windows, macOS, Linux), where its "use your own Chrome" design works.

If mobile access matters, the cheapest step is a small companion app. It would view and export leads that the desktop app syncs, and it would still respect the "no lead data on external servers" rule only if sync stays opt-in and end-to-end encrypted. A full iOS lead finder means the Places API rewrite described above.
