'use strict';

// Contact details from a Chrome extension the user installed and signed in
// to (ContactOut), read the way a person uses it: on a LinkedIn profile the
// extension shows its panel (an iframe from its own site inside the page);
// Lead Finder opens the panel with the extension's own button when it is
// closed, waits for it to show this person, and reads the emails and phone
// numbers it displays. Nothing else: not the extension's storage, cookies,
// network traffic or account. Masked values ("j***@acme.com"), login
// prompts, credit limits and "nothing found" are reported as such; nothing
// is guessed or completed.
//
// Lead Finder works in the user's own Chrome (DevTools connection), so the
// extensions of that Chrome profile run as usual. The extension must be
// installed and enabled in that profile; installedIn() tells which profiles
// have it.

const fs = require('node:fs');
const path = require('node:path');
const { findPhones, normalizePhone } = require('../database/phone');

const PROVIDERS = {
  contactout: {
    key: 'contactout',
    label: 'ContactOut',
    extensionId: 'jjdemeiffadmmjhkbbpglgnlgeafomjo',
    // Its panel: an iframe from https://contactout.com/extension/app (off
    // the right edge of the window until opened); its button: an iframe
    // from https://contactout.com/extension/action_button/… on the edge
    // (5.18, 2026). Earlier versions: <iframe id="main-iframe"> with a
    // <button> beside it.
    frame: /^https:\/\/contactout\.com\/extension\/app/,
    button: /^https:\/\/contactout\.com\/extension\/action_button/,
    host: 'iframe#main-iframe',
    // Buttons that reveal a contact it already has ("View email", "View
    // phone"; they use the user's ContactOut credits). Not "Find work email",
    // which is a separate search.
    reveal: /^(view|show|reveal|unlock|see)\s+(the\s+)?(email|emails|phone|phones|number|numbers|contact|contacts|contact info|details)$/i,
  },
};

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const MASKED = /[*•…]|x{3,}@|\.{3}/i;
const STATES = [
  ['login', /\b(log ?in|sign ?in|sign ?up|create (a |your )?(free )?account)\b.{0,40}\b(contactout|to (continue|see|view|use))\b|please (log|sign) ?in/i],
  ['limit', /\b(out of|no (more )?|not enough|run out of|used (all|up))\b.{0,20}\bcredits?\b|\b(daily|monthly|search) limit\b|\blimit (reached|exceeded)\b|\bupgrade (your plan|now|to (see|view|unlock))\b/i],
  ['none', /\bno (contact|email|emails|phone|phones|results?|data|information)\b.{0,30}\b(found|available)\b|\bcouldn.?t find\b|\bnot available\b|\bno contact info\b/i],
  ['checkpoint', /\bcaptcha\b|\bverify (you are|you're) (a )?human\b|\bare you a robot\b/i],
];
const LABEL = /\b(work|business|personal|private|professional|mobile|cell|direct|office|home|phone|email)\b/i;

const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Profiles of a Chrome user-data folder that have the extension, with
// whether it is enabled: [{ dir, name, enabled, version }].
function installedIn(userDataDir, provider = PROVIDERS.contactout) {
  let names = {};
  try {
    names = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'))?.profile?.info_cache || {};
  } catch {}
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(userDataDir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
  } catch {}
  for (const dir of dirs) {
    const st = extensionState(path.join(userDataDir, dir), provider);
    if (st.installed) out.push({ dir, name: names[dir]?.name || dir, enabled: st.enabled, version: st.version });
  }
  return out;
}

// { installed, enabled, version } for one profile folder. Reads only this
// extension's entry in the profile's settings (never other data).
function extensionState(profileDir, provider = PROVIDERS.contactout) {
  const id = provider.extensionId;
  let entry = null;
  for (const f of ['Secure Preferences', 'Preferences']) {
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(profileDir, f), 'utf8'));
      entry = prefs?.extensions?.settings?.[id] || entry;
    } catch {}
  }
  let version = '';
  try {
    version = fs.readdirSync(path.join(profileDir, 'Extensions', id)).sort().pop()?.replace(/_\d+$/, '') || '';
  } catch {}
  const installed = Boolean(version || (entry && entry.manifest));
  if (!installed) return { installed: false, enabled: false, version: '' };
  // Disabled extensions have disable_reasons (or the older state: 0).
  const reasons = entry?.disable_reasons;
  const disabled = (Array.isArray(reasons) ? reasons.length > 0 : Number(reasons) > 0) || entry?.state === 0;
  return { installed: true, enabled: entry ? !disabled : true, version: version || entry?.manifest?.version || '' };
}

// --- in the page ------------------------------------------------------------------

// The extension's panel frame in a page, or null (the one showing the most, when several).
function panelFrame(page, provider) {
  return page.frames().find((f) => provider.frame.test(f.url())) || null;
}

// Whether the panel is on screen: its iframe inside the window, of panel size.
async function panelShown(page, provider) {
  const vw = page.viewportSize()?.width || (await page.evaluate(() => window.innerWidth).catch(() => 1280));
  for (const f of page.frames().filter((x) => provider.frame.test(x.url()))) {
    const el = await f.frameElement().catch(() => null);
    const box = el && (await el.boundingBox().catch(() => null));
    const visible = el && (await el.evaluate((e) => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden').catch(() => false));
    if (box && visible && box.width > 150 && box.height > 150 && box.x < vw - 100) return true;
  }
  return false;
}

// Opens the panel the way a person does: a click on the extension's own
// button (its button iframe, or the earlier in-page toggle).
// Returns 'open' | 'opened' | 'no_toggle'.
async function openPanel(page, provider) {
  if (await panelShown(page, provider)) return 'open';
  const btn = provider.button && page.frames().find((f) => provider.button.test(f.url()));
  if (btn) {
    const el = await btn.frameElement().catch(() => null);
    if (el) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const clicked = await el.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) {
        const box = await el.boundingBox().catch(() => null);
        if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      return 'opened';
    }
  }
  const r = await page.evaluate(openPanelInPage, provider.host).catch(() => 'no_panel');
  return r === 'no_panel' ? 'no_toggle' : r;
}

// Whether the panel is shown; when not, clicks the extension's own toggle
// button next to it. Returns 'open' | 'opened' | 'no_panel' | 'no_toggle'.
function openPanelInPage(hostSelector) {
  const host = document.querySelector(hostSelector);
  if (!host) return 'no_panel';
  const shown = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && el.getBoundingClientRect().width > 40;
  };
  if (shown(host)) return 'open';
  // The extension's toolbar: the nearest container of the panel with buttons.
  let box = host.parentElement;
  for (let i = 0; i < 4 && box && !box.querySelector('button'); i++) box = box.parentElement;
  const buttons = box ? [...box.querySelectorAll('button')] : [];
  const toggle = buttons.find((b) => b.querySelector('img') && getComputedStyle(b).cursor !== 'grab') || buttons[0];
  if (!toggle) return 'no_toggle';
  toggle.click();
  return 'opened';
}

// What the panel shows: its visible text, mailto/tel links and button labels.
function readPanelInFrame() {
  const clean = (s) => String(s || '').replace(/[ \t]+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // Only rendered text: a frame that is not displayed has no layout, and its
  // innerText would fall back to the raw document text (scripts included).
  const rendered = Boolean(document.body && document.body.getClientRects().length && window.innerWidth > 0 && window.innerHeight > 0);
  let text = '';
  if (rendered) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const el = n.parentElement;
        if (!el || el.closest('script, style, noscript, template')) return NodeFilter.FILTER_REJECT;
        return el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const parts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.nodeValue.replace(/[ \t]+/g, ' ').trim();
      if (t) parts.push(t);
    }
    // One line per text block, as it is displayed.
    text = parts.join('\n');
  }
  return {
    rendered,
    text: text.slice(0, 20000),
    mailtos: [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0])),
    tels: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href').slice(4)),
    buttons: [...document.querySelectorAll('button, [role="button"], a')].filter(visible).map((b) => clean(b.innerText || b.getAttribute('aria-label') || '')).filter(Boolean).slice(0, 60),
  };
}

// Clicks the panel's buttons whose label matches `pattern` (each once).
function clickInFrame(source) {
  const re = new RegExp(source, 'i');
  let n = 0;
  for (const b of document.querySelectorAll('button, [role="button"]')) {
    const label = (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const r = b.getBoundingClientRect();
    if (re.test(label) && r.width > 0 && r.height > 0 && !b.disabled) {
      b.click();
      n++;
    }
  }
  return n;
}

// --- reading the panel -----------------------------------------------------------------

// The panel's state and contact details for this person:
// { state: 'ok' | 'none' | 'login' | 'limit' | 'checkpoint' | 'loading' | 'other_person',
//   emails: [{ email, label }], phones: [{ phone, raw, status, country, label }],
//   masked, revealable }.
function parsePanel(panel, { name = '', country = null, provider = PROVIDERS.contactout } = {}) {
  const text = String(panel?.text || '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const emails = new Map();
  let masked = 0;
  // "Work email", "Personal", "Mobile"…: written on the value's line or the line above it.
  const labelFor = (value) => {
    const v = String(value).toLowerCase();
    const i = lines.findIndex((l) => l.toLowerCase().includes(v));
    if (i < 0) return '';
    const m = lines[i].toLowerCase().replace(v, '').match(LABEL) || (lines[i - 1] || '').match(LABEL);
    return m ? m[1].toLowerCase() : '';
  };
  const addEmail = (raw) => {
    const e = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e)) return;
    if (MASKED.test(e) || /\*/.test(raw)) return void masked++;
    if (!emails.has(e)) emails.set(e, { email: e, label: labelFor(e) });
  };
  masked += lines.filter((l) => /[*•]{2,}[^\s@]*@/.test(l)).length;
  for (const m of panel?.mailtos || []) addEmail(m);
  for (const m of text.matchAll(EMAIL)) {
    // "j***@acme.com" is cut by the pattern: look at the characters before it.
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    if (!/[*•]/.test(before)) addEmail(m[0]);
  }
  // Numbers: tel: links and numbers written in the panel (masked ones skipped).
  const phones = new Map();
  for (const t of panel?.tels || []) {
    const n = normalizePhone(t, { address: '' });
    if (n.phone && n.status !== 'invalid') phones.set(n.phone, { ...n, label: labelFor(t) });
  }
  const plain = lines.filter((l) => !/[*•]{2,}/.test(l)).join('\n');
  masked += lines.filter((l) => /\+?\d[\d\s().-]*[*•x]{3,}/i.test(l)).length;
  for (const p of findPhones(plain, { country, max: 5 }).phones) {
    if (!phones.has(p.phone)) phones.set(p.phone, { ...p, label: labelFor(p.raw || p.phone) });
  }
  const revealable = (panel?.buttons || []).filter((b) => provider.reveal.test(b));
  // The panel must be about this person (it can still show the previous one).
  const words = fold(name).replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);
  const t = fold(text);
  const aboutThem = !words.length || words.filter((w) => t.includes(w)).length >= Math.min(2, words.length);
  let state = 'ok';
  if (!emails.size && !phones.size) {
    const hit = STATES.find(([, re]) => re.test(text));
    state = hit ? hit[0] : revealable.length || masked ? 'none' : 'loading';
  }
  if (state === 'ok' && !aboutThem) state = 'other_person';
  return { state, emails: [...emails.values()], phones: [...phones.values()], masked, revealable, aboutThem };
}

// Reads one profile's contacts from the extension, on the profile page
// already open: { state, emails, phones, detail }. reveal: also click the
// panel's reveal buttons (uses the user's credits with the provider).
async function readExtensionContacts(page, { provider = PROVIDERS.contactout, name = '', country = null, reveal = false, timeout = 25_000, wait = (ms) => page.waitForTimeout(ms) } = {}) {
  const deadline = Date.now() + timeout;
  // 1. The extension adds its panel to the page.
  let frame = null;
  while (!frame && Date.now() < deadline) {
    frame = panelFrame(page, provider);
    if (!frame) await wait(500);
  }
  if (!frame) return { state: 'not_active', emails: [], phones: [], detail: `${provider.label} did not appear on the profile` };
  // 2. Its panel open (its own button, as a person would click it).
  let opened = await openPanel(page, provider);
  // 3. Wait until it shows this person's details, or says why not.
  let last = null;
  let revealed = false;
  while (Date.now() < deadline) {
    // Every panel frame shown on screen (and frames inside it): the one showing the most.
    const shown = await panelShown(page, provider);
    const frames = shown ? page.frames().filter((f) => provider.frame.test(f.url()) || (f.parentFrame() && provider.frame.test(f.parentFrame().url()))) : [];
    let panel = null;
    for (const f of frames) {
      const got = await f.evaluate(readPanelInFrame).catch(() => null);
      if (got && got.rendered && (!panel || got.text.length > panel.text.length)) {
        panel = got;
        frame = f;
      }
    }
    // Opened but still empty after a while: one more click on its button.
    if (!shown && opened === 'opened' && Date.now() > deadline - (timeout * 2) / 3) opened = (await openPanel(page, provider)) === 'opened' ? 'opened again' : opened;
    if (panel) {
      last = parsePanel(panel, { name, country, provider });
      if (last.state === 'ok' && !(reveal && !revealed && last.revealable.length)) break;
      if (['login', 'limit', 'checkpoint'].includes(last.state)) break;
      if (reveal && !revealed && last.revealable.length && last.state !== 'other_person') {
        await frame.evaluate(clickInFrame, provider.reveal.source).catch(() => 0);
        revealed = true;
        await wait(1500);
        continue;
      }
      if (last.state === 'none' && !(reveal && !revealed && last.revealable.length) && Date.now() > deadline - timeout / 2) break;
    }
    await wait(800);
  }
  if (!last) return { state: 'loading', emails: [], phones: [], detail: `${provider.label}'s panel did not load (${opened})` };
  const state = last.state === 'loading' ? 'none' : last.state;
  return {
    state,
    emails: state === 'ok' ? last.emails : [],
    phones: state === 'ok' ? last.phones : [],
    masked: last.masked,
    revealable: last.revealable.length,
    revealed,
    detail:
      state === 'ok'
        ? `${last.emails.length} email${last.emails.length === 1 ? '' : 's'}, ${last.phones.length} phone${last.phones.length === 1 ? '' : 's'}`
        : state === 'other_person'
          ? `${provider.label} still showed another person`
          : state === 'none'
            ? `${provider.label} showed no contact details${last.revealable.length && !reveal ? ' (it offers to reveal them with your credits; "Reveal with credits" is off)' : last.masked ? ' (only hidden ones)' : ''}`
            : { login: `${provider.label} asks you to log in`, limit: `${provider.label} says your credits or limit are used up`, checkpoint: `${provider.label} shows a security check` }[state],
  };
}

module.exports = { PROVIDERS, installedIn, extensionState, panelFrame, panelShown, openPanel, parsePanel, readExtensionContacts, readPanelInFrame, openPanelInPage, clickInFrame };
