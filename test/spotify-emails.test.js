'use strict';
// Spotify descriptions to emails: the page metadata has the shape of real
// Spotify pages (saved from public snapshots), and the text is Snook's real
// wording, where the address runs into the next word.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { metadataOf, readSpotifyPage } = require('../src/browser/podcast-read');
const { emailsIn, processPodcast } = require('../src/browser/podcasts');
const { PodcastSearch } = require('../src/browser/podcast-search');
const { LeadStore } = require('../src/database/db');
const { leadsToCsv } = require('../src/export/csv');

const SHOW = '2FH70nnKmpdV5PY0fp4F9Q';
const EPISODE = '6b3sTuuj13wXJRiPpPfEmt';
const OTHER = '0002P7LyrlNRDGZ1rq3HCb';
const site = 'https://open.spotify.com';
const SNOOK_TEXT = 'Scary stories narrated by Snook. If your story or post was included in today\'s video and you wish for it to be taken down, please reach out to this email. Officialsnook23@gmail.comSubscribe and like for more, thank you';

const ld = (type, url, name, description, publisher) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'http://schema.org/', '@type': type, url, name, description, ...(publisher ? { publisher, author: { '@type': 'Person', name: publisher } } : {}) })}</script>`;
const showHead = (description = 'Scary stories, crazy confessions, and unbelievable stories-all narrated by Snook.') =>
  `<head><title>Snook | Podcast on Spotify</title><meta property="og:title" content="Snook"/><meta property="og:description" content="Podcast · Snook · ${description}"/>${ld('PodcastSeries', `${site}/show/${SHOW}`, 'Snook', `Listen to Snook on Spotify. ${description}`, 'Snook')}</head>`;
const episodeHead = (id, title, description) =>
  `<head><title>${title} - Snook | Podcast on Spotify</title><meta name="description" content="Listen to this episode from Snook on Spotify. ${description.replace(/"/g, '&quot;')}"/><meta property="og:title" content="${title}"/><meta property="og:description" content="Snook · Episode"/>${ld('MusicGroup', `${site}/episode/${id}`, title, `Listen to this episode from Snook on Spotify. ${description}`)}</head>`;

test('Every way of writing an address, with what surrounds it removed', () => {
  const email = 'example@gmail.com';
  for (const text of [`Email: ${email}`, `Contact: ${email}`, `Reach me at ${email}`, `Email me at - ${email}`, `Email me at: ${email}`, `Reach out: ${email}`, `Business inquiries: ${email}`, `<a href="mailto:${email}">write to us</a>`, `Email:${email}`, `(${email})`, `<${email}>`, `"${email}",`, `write to ${email}.`, `${email}!`, `${email}; thanks`, `mail ${email}⁠Join the Patreon`]) {
    assert.deepEqual(emailsIn(text), [email], text);
  }
  assert.deepEqual(emailsIn('Example@Gmail.com and EXAMPLE@GMAIL.COM'), [email], 'the same address once');
});

test('An address run into the next word is cut where it ends; real long endings stay', () => {
  const me = 'officialsnook23@gmail.com';
  for (const text of ['Officialsnook23@gmail.comSubscribe and like', 'Officialsnook23@gmail.comYes... my voice', 'Officialsnook23@gmail.comThank you', 'officialsnook23@gmail.comsubscribe', 'Officialsnook23@gmail.com.Thanks']) assert.deepEqual(emailsIn(text), [me], text);
  assert.deepEqual(emailsIn('hello@studio.company'), ['hello@studio.company']);
  assert.deepEqual(emailsIn('hi@show.co.ukThanks'), ['hi@show.co.uk']);
  assert.deepEqual(emailsIn('hi@my-site.netJoin'), ['hi@my-site.net']);
});

test('Metadata: the description without Spotify\'s opening words, the show and escaped characters', () => {
  const ep = metadataOf(episodeHead(EPISODE, 'Dark Threads', 'A story \\u2014 told. Officialsnook23@gmail.comSubscribe'));
  assert.equal(ep.name, 'Dark Threads');
  assert.equal(ep.show, 'Snook');
  assert.equal(ep.description, 'A story — told. Officialsnook23@gmail.comSubscribe');
  const show = metadataOf(showHead());
  assert.deepEqual([show.name, show.publisher], ['Snook', 'Snook']);
  assert.match(show.description, /^Scary stories/);
  assert.equal(metadataOf('<head><meta name="description" content="Listen to this episode from A &amp; B on Spotify. Mail a@b.co"/></head>').description, 'Mail a@b.co');
  assert.equal(metadataOf('<script type="application/ld+json">{broken</script>').description, '');
});

const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));

// A browser in front of pages shaped like Spotify's: what is served, then what
// the page's script renders. head: served metadata; main: rendered page.
async function withPages(pages, run) {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  const opened = [];
  await page.route('**/*', (route) => {
    const url = route.request().url().replace(/[?#].*$/, '');
    if (route.request().resourceType() === 'document') opened.push(url);
    const p = pages[url];
    return p ? route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html>${p.head || '<head><title>Spotify – Web Player</title></head>'}<body><main>${p.main || ''}</main></body></html>` }) : route.abort();
  });
  try {
    return await run(page, opened);
  } finally {
    await browser.close();
  }
}

const row = (id, title, text) => `<div role="listitem"><a href="/episode/${id}"><span>${title}</span></a><p>${text}</p></div>`;
const showMain = `<h1>Snook</h1><section><h2>About</h2><p>Scary stories<button>Show more</button></p></section>${row(EPISODE, 'Dark Threads', 'If your story or post...')}${row(OTHER, 'Shocking Confessions', 'Send confessions')}`;

test('The test episode: the email is read from the page metadata, with its show', { skip: !exe }, async () => {
  await withPages(
    { [`${site}/episode/${EPISODE}`]: { head: episodeHead(EPISODE, 'Dark Threads', SNOOK_TEXT), main: `<h1>Dark Threads</h1><a href="/show/${SHOW}">Snook</a><h2>Episode Description</h2><div>${SNOOK_TEXT}</div>` } },
    async (page) => {
      const d = await readSpotifyPage(page, `${site}/episode/${EPISODE}?si=abc`.replace(/\?.*/, ''), { pause: 1 });
      assert.deepEqual([d.type, d.title, d.show, d.showUrl], ['episode', 'Dark Threads', 'Snook', `${site}/show/${SHOW}`]);
      assert.deepEqual(emailsIn(d.text), ['officialsnook23@gmail.com']);
      assert.equal(d.fromMetadata, true);
    },
  );
});

test('A page without metadata: the visible description, opened behind Show more; nothing else is pressed', { skip: !exe }, async () => {
  const main = `<h1>Quiet Show</h1><section><h2>About</h2><p id="t">A short start</p><button onclick="document.getElementById('t').textContent='Booking: quiet@show.example'">Show more</button></section><button onclick="document.title='played'">Play</button><aside></aside>`;
  await withPages({ [`${site}/show/${SHOW}`]: { main } }, async (page) => {
    const d = await readSpotifyPage(page, `${site}/show/${SHOW}`, { pause: 1 });
    assert.equal(d.fromMetadata, false);
    assert.deepEqual(emailsIn(d.text), ['quiet@show.example']);
    assert.notEqual(await page.title(), 'played');
  });
});

test('A blocked region and a missing page are reasons, never an empty result', { skip: !exe }, async () => {
  await withPages(
    {
      [`${site}/episode/${EPISODE}`]: { head: '<head><title>Sorry, that’s not currently available in your region.</title></head>', main: '<h1>Sorry, that’s not currently available in your region.</h1>' },
      [`${site}/show/${SHOW}`]: { head: '<head><title>Page not available</title></head>', main: '<h1>Page not available</h1>' },
    },
    async (page) => {
      await assert.rejects(readSpotifyPage(page, `${site}/episode/${EPISODE}`, { pause: 1 }), (e) => e.code === 'region' && /VPN/.test(e.message));
      await assert.rejects(readSpotifyPage(page, `${site}/show/${SHOW}`, { pause: 1 }), (e) => e.code === 'missing');
    },
  );
});

// The search around it, against the real lead store and a fake Chrome.
const noFeed = async () => new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } });
const showPage = (over = {}) => ({ type: 'show', id: SHOW, url: `${site}/show/${SHOW}`, title: 'Snook', host: 'Snook', show: '', showUrl: `${site}/show/${SHOW}`, artwork: '', description: 'Scary stories', text: 'Scary stories', fromMetadata: true, episodes: [{ id: EPISODE, title: 'Dark Threads', url: `${site}/episode/${EPISODE}`, text: 'If your story...' }, { id: OTHER, title: 'Shocking Confessions', url: `${site}/episode/${OTHER}`, text: 'Send them' }], ...over });
const episodePage = (id, title, text) => ({ type: 'episode', id, url: `${site}/episode/${id}`, title, host: '', show: 'Snook', showUrl: `${site}/show/${SHOW}`, artwork: '', description: text, text, fromMetadata: true, episodes: [] });
const pages = (over = {}) => async (url) => {
  const key = url.replace(`${site}/`, '');
  if (over[key] instanceof Error) throw over[key];
  if (over[key]) return over[key];
  if (key === `show/${SHOW}`) return showPage();
  if (key === `episode/${EPISODE}`) return episodePage(EPISODE, 'Dark Threads', SNOOK_TEXT);
  return episodePage(OTHER, 'Shocking Confessions', `Send confessions to Snookconfessions@gmail.com!\nAlso ${SNOOK_TEXT}`);
};

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-spot-'));
  const store = new LeadStore(path.join(dir, 'leads.db'));
  return { store, done: () => (store.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}
const run = (store, opts) => new PodcastSearch({ platforms: ['spotify'], store, fetchImpl: noFeed, findContacts: async () => ({ emails: [], pages: [] }), openInBrowser: async () => assert.fail('the page is read, not only opened'), ...opts }).run();
const inStore = (store) => store.podcastLeads({ pageSize: 50 }).rows;

test('No RSS feed: the pasted episode gives the email, saved on its show with its source episode, shown and exported', async () => {
  const { store, done } = tmpStore();
  const log = [];
  try {
    await run(store, { query: `${site}/episode/${EPISODE}?si=abc`, readPage: pages(), log: (l) => log.push(l) });
    const [lead, ...rest] = inStore(store);
    assert.equal(rest.length, 0, 'one show, one lead');
    assert.equal(lead.name, 'Snook');
    assert.equal(lead.podcastLinks.spotify, `${site}/show/${SHOW}`);
    assert.equal(lead.email, 'officialsnook23@gmail.com');
    assert.equal(lead.emailStatus, 'found');
    const hit = lead.emails.find((e) => e.email === 'officialsnook23@gmail.com');
    assert.equal(hit.from, 'Spotify episode “Dark Threads”');
    assert.deepEqual([hit.source, hit.episode], ['Episode Description', 'Dark Threads']);
    assert.equal(hit.url, `${site}/episode/${EPISODE}`);
    assert.deepEqual(lead.emails.map((e) => e.email).sort(), ['officialsnook23@gmail.com', 'snookconfessions@gmail.com'], 'each address once, across show and episodes');
    assert.match(lead.discovery, /spotify: show description read, 2 episode descriptions read, 2 emails found there/);
    assert.match(lead.discovery, /rss: missing/);
    assert.ok(log.some((l) => /show “Snook”: description read/.test(l)) && log.some((l) => /episode “Dark Threads”: description read/.test(l)), 'the log says what was read');
    const csv = leadsToCsv(inStore(store));
    assert.match(csv, /officialsnook23@gmail\.com \[Spotify episode “Dark Threads”\]/);
  } finally {
    done();
  }
});

test('A search: the show and episode pages of each show are read one at a time, and the email is found with no feed', async () => {
  const { store, done } = tmpStore();
  let open = 0;
  let most = 0;
  const read = pages();
  try {
    const res = await run(store, {
      query: 'scary stories',
      readInBrowser: async () => [{ id: SHOW, title: 'Snook', host: 'Snook', url: `${site}/show/${SHOW}` }, { id: 'zzzzzzzzzzzz', title: 'Other Show', host: 'Someone', url: `${site}/show/zzzzzzzzzzzz` }],
      readPage: async (url) => {
        most = Math.max(most, ++open);
        await new Promise((r) => setTimeout(r, 2));
        open--;
        return url.endsWith('zzzzzzzzzzzz') ? showPage({ id: 'zzzzzzzzzzzz', url, title: 'Other Show', host: 'Someone', text: 'Nothing here', episodes: [] }) : read(url);
      },
    });
    assert.equal(most, 1, 'Chrome reads one page at a time');
    assert.equal(res.withEmail, 1);
    const leads = inStore(store);
    assert.equal(leads.find((l) => l.name === 'Snook').email, 'officialsnook23@gmail.com');
    const none = leads.find((l) => l.name === 'Other Show');
    assert.equal(none.emailStatus, 'none', 'every source was read: a real "no email"');
    assert.match(none.discovery, /Spotify show description/);
  } finally {
    done();
  }
});

test('A page that could not be read is never "no email": it says what is left to check', async () => {
  const { store, done } = tmpStore();
  const region = Object.assign(new Error('Spotify does not offer this in your region: turn on your VPN and try again'), { code: 'region' });
  try {
    await run(store, { query: 'scary', readInBrowser: async () => [{ id: SHOW, title: 'Snook', host: 'Snook', url: `${site}/show/${SHOW}` }], readPage: pages({ [`show/${SHOW}`]: region }) });
    let [lead] = inStore(store);
    assert.equal(lead.emailStatus, 'failed');
    assert.match(lead.discovery, /Spotify show page \(.*VPN/);
    await run(store, { query: 'scary 2', readInBrowser: async () => [{ id: SHOW, title: 'Snook', host: 'Snook', url: `${site}/show/${SHOW}` }], readPage: pages({ [`show/${SHOW}`]: showPage({ text: 'x', description: 'x' }), [`episode/${EPISODE}`]: region, [`episode/${OTHER}`]: episodePage(OTHER, 'Quiet', 'no address') }) });
    [lead] = inStore(store);
    assert.equal(lead.emailStatus, 'failed', 'one episode unread: still not "no email"');
    assert.match(lead.discovery, /Spotify episode “Dark Threads” \(/);
  } finally {
    done();
  }
});

test('A pasted link in a blocked region is reported, and nothing is saved', async () => {
  const { store, done } = tmpStore();
  const events = [];
  try {
    await run(store, { query: `${site}/episode/${EPISODE}`, emit: (e, p) => events.push([e, p]), readPage: async () => { throw Object.assign(new Error('Spotify does not offer this in your region: turn on your VPN and try again'), { code: 'region' }); } });
    assert.ok(events.some(([e, p]) => e === 'platform' && p.state === 'failed' && /VPN/.test(p.message)));
    assert.equal(inStore(store).length, 0);
  } finally {
    done();
  }
});

const feedOf = (emailText) => `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Snook</title><description>Scary stories</description><item><title>Dark Threads</title><description><![CDATA[${emailText}]]></description></item></channel></rss>`;
const fetchWith = (results, xml) => async (url) => (String(url).startsWith('https://itunes.apple.com') ? new Response(JSON.stringify({ results }), { headers: { 'content-type': 'application/json' } }) : Object.defineProperty(new Response(xml, { headers: { 'content-type': 'application/rss+xml' } }), 'url', { value: String(url) }));
const apple = (artistName, id = 7) => ({ kind: 'podcast', wrapperType: 'track', collectionId: id, collectionName: 'Snook', artistName, collectionViewUrl: `https://podcasts.apple.com/us/podcast/x/id${id}`, feedUrl: `https://feeds.example/${id}`, trackCount: 3 });

test('Feed by title: Apple\'s "Unknown" publisher, a publisher with the same episodes, and a different podcast of the same name', async () => {
  const check = async (artist, xml, readPage = pages({ [`episode/${EPISODE}`]: episodePage(EPISODE, 'Dark Threads', 'nothing'), [`episode/${OTHER}`]: episodePage(OTHER, 'Quiet', 'nothing') })) => {
    const { store, done } = tmpStore();
    try {
      await run(store, { query: 'scary', fetchImpl: fetchWith([apple(artist)], xml), readInBrowser: async () => [{ id: SHOW, title: 'Snook', host: 'Snook', url: `${site}/show/${SHOW}` }], readPage });
      return inStore(store)[0];
    } finally {
      done();
    }
  };
  const unknown = await check('Unknown', feedOf(SNOOK_TEXT));
  assert.equal(unknown.rssUrl, 'https://feeds.example/7');
  assert.equal(unknown.email, 'officialsnook23@gmail.com');
  assert.match(unknown.emails[0].from, /^RSS feed: episode/);
  const sameEpisodes = await check('Daylight Media', feedOf('hello'));
  assert.equal(sameEpisodes.rssUrl, 'https://feeds.example/7', 'an episode in common proves it');
  const other = await check('Dr Jennifer Hale', feedOf('hello').replace('Dark Threads', 'A Totally Different Episode').replace('Scary stories', 'Gardening tips for every season of the year'));
  assert.ok(!other.rssUrl, 'a same-named podcast is not taken for this one');
});

test('Retry: a saved Spotify lead has its pages read, and glued addresses saved before are replaced', async () => {
  const { store, done } = tmpStore();
  try {
    store.savePodcastLead({ title: 'Snook', host: 'Snook', links: { spotify: `${site}/show/${SHOW}` }, email: 'officialsnook23@gmail.comsubscribe', emails: [{ email: 'officialsnook23@gmail.comsubscribe', kind: 'free', from: 'old', url: '' }], status: 'found', statusText: 'x', platform: 'spotify', sourceUrl: `${site}/show/${SHOW}`, discovery: 'old' });
    const [l] = inStore(store);
    await run(store, { query: 'retry', seed: [{ leadId: l.id, title: l.name, host: l.podcastHost, description: '', links: l.podcastLinks, platforms: ['spotify'], platform: 'spotify', url: l.podcastLinks.spotify }], readPage: pages() });
    const [after] = inStore(store);
    assert.equal(after.email, 'officialsnook23@gmail.com');
    assert.ok(!after.emails.some((e) => /comsubscribe/.test(e.email)));
  } finally {
    done();
  }
});

const feedFetch = (ownerXml = '') => async (u) => Object.defineProperty(new Response(feedOf('x').replace('<item>', `${ownerXml}<item>`), { headers: { 'content-type': 'application/rss+xml' } }), 'url', { value: String(u) });
const spotifyState = (items = []) => ({ items, failed: [], showRead: 1, episodesRead: 0 });
const OWNER = '<itunes:owner><itunes:email>owner@snook.example</itunes:email></itunes:owner>';
const noSite = async () => ({ emails: [], pages: [] });

test('No email in the show description: episodes are still checked, even when the feed gave one', async () => {
  const asked = [];
  const r = await processPodcast({ title: 'Snook', platformLabel: 'Spotify', feedUrl: 'https://feeds.example/1', feedFrom: 'x', spotify: spotifyState([{ show: true, from: 'Spotify show description', url: 'u', text: 'Scary stories' }]), readEpisodes: async (step, o) => asked.push(o.max) }, { fetchImpl: feedFetch(OWNER), findContacts: noSite });
  assert.equal(r.email, 'owner@snook.example', 'the RSS feed is checked too');
  assert.deepEqual(asked, [3], 'the feed gives every description, so fewer pages are opened');
  const none = [];
  await processPodcast({ title: 'Snook', platformLabel: 'Spotify', spotify: spotifyState(), readEpisodes: async (step, o) => none.push(o.max) }, { fetchImpl: feedFetch(), findContacts: noSite });
  assert.deepEqual(none, [10], 'without a feed, more episode pages');
});

test('An email in the show description: its episodes need no page loads', async () => {
  const asked = [];
  const r = await processPodcast({ title: 'Snook', platformLabel: 'Spotify', spotify: spotifyState([{ show: true, from: 'Spotify show description', url: 'https://open.spotify.com/show/x', text: 'Business inquiries: <a href="mailto:Booking@Snook.example?subject=Hi">write</a>' }]), readEpisodes: async () => asked.push(1) }, { fetchImpl: feedFetch(), findContacts: noSite });
  assert.equal(asked.length, 0);
  assert.deepEqual([r.email, r.emails[0].source, r.emails[0].episode], ['booking@snook.example', 'Show Description', '']);
});

test('Each email names its source and episode, and the export carries them', async () => {
  const { store, done } = tmpStore();
  try {
    await run(store, { query: `${site}/show/${SHOW}`, readPage: pages() });
    const [lead] = inStore(store);
    const hit = lead.emails.find((e) => e.email === lead.email);
    assert.deepEqual([hit.source, hit.episode], ['Episode Description', 'Dark Threads']);
    const row = leadsToCsv([lead]).split('\r\n')[1];
    assert.ok(row.endsWith(`Dark Threads,Episode Description,${site}/show/${SHOW}`), row.slice(-90));
  } finally {
    done();
  }
});

test('Episode pages stop once an email proves to be the show\'s own, and the search counts shows, episodes and emails', async () => {
  const { store, done } = tmpStore();
  const messages = [];
  const opened = [];
  const ids = 'abcdefghijkl'.split('').map((c) => c.repeat(12));
  const rows = ids.map((id, i) => ({ id, title: `Episode ${i}`, url: `${site}/episode/${id}`, text: '' }));
  try {
    const res = await run(store, {
      query: 'scary',
      emit: (ev, p) => ev === 'status' && messages.push(p.message),
      readInBrowser: async () => [{ id: SHOW, title: 'Snook', host: 'Snook', url: `${site}/show/${SHOW}` }, { id: 'yyyyyyyyyyyy', title: 'Quiet', host: 'Q', url: `${site}/show/yyyyyyyyyyyy` }],
      readPage: async (url) => {
        opened.push(url);
        if (url.endsWith('yyyyyyyyyyyy')) return showPage({ url, id: 'yyyyyyyyyyyy', title: 'Quiet', host: 'Q', text: 'none', episodes: rows });
        if (url.includes('/show/')) return showPage({ episodes: [] });
        return episodePage(url.split('/').pop(), `Ep ${url.slice(-1)}`, 'Contact: same@quiet.example');
      },
    });
    assert.equal(opened.filter((u) => u.includes('/episode/')).length, 2, 'the second mention proves it');
    assert.deepEqual([res.episodes, res.emails], [2, 1]);
    assert.ok(messages.some((m) => /^Checking show 1 of 2 · 0 episodes checked · 0 emails found$/.test(m)), messages.join(' | '));
    assert.ok(messages.some((m) => /^Checking show \d of 2 · 1 episode checked/.test(m)), messages.join(' | '));
    assert.match(messages.at(-1), /^Done: 2 podcasts found, 1 with an email, 2 episodes checked, 1 email found$/);
  } finally {
    done();
  }
});

test('Every show is checked, and a show with no email has its episodes listed after the pages opened', async () => {
  const { store, done } = tmpStore();
  const ids = Array.from({ length: 30 }, (_, i) => `show${String(i).padStart(8, '0')}`);
  const opened = new Set();
  try {
    const res = await run(store, {
      query: 'scary',
      readInBrowser: async () => ids.map((id, i) => ({ id, title: `Show ${i} Name`, host: `Host ${i}`, url: `${site}/show/${id}` })),
      readPage: async (url) => {
        opened.add(url);
        const id = url.split('/').pop();
        return showPage({ id, url, title: id, host: '', description: 'x', text: 'Reach out: hello@one.example', episodes: [] });
      },
    });
    assert.equal(opened.size, 30);
    assert.equal(res.done, 30);
    assert.equal(res.withEmail, 30);
  } finally {
    done();
  }
});

test('A show page that loads more as it scrolls, by its button, and drops old rows: every episode is listed, mailto links are read', { skip: !exe }, async () => {
  const ep = (n) => `ep${String(n).padStart(10, '0')}`;
  const script = `<script>let n=3;function draw(){const m=document.getElementById('list');m.innerHTML='';for(let i=Math.max(0,n-3);i<n;i++)m.insertAdjacentHTML('beforeend','<div role="listitem"><a href="/episode/ep'+String(i).padStart(10,'0')+'"><span>Episode '+i+'</span></a><p>Text '+i+'</p>'+(i===4?'<a href="mailto:rows@show.example">Email</a>':'')+'</div>');}
    addEventListener('scroll',()=>{if(n<7){n++;draw();}},true);document.getElementById('more').onclick=()=>{if(n<7){n+=1;draw();}};draw();</script>`;
  const main = `<h1>Long Show</h1><section><h2>About</h2><p>About text <a href="mailto:show@show.example">Email us</a> and more text here</p></section><div style="height:3000px"></div><div id="list"></div><button id="more">Load more episodes</button>${script}`;
  await withPages({ [`${site}/show/${SHOW}`]: { main } }, async (page) => {
    const d = await readSpotifyPage(page, `${site}/show/${SHOW}`, { pause: 30 });
    assert.deepEqual(d.episodes.map((e) => e.id).sort(), [0, 1, 2, 3, 4, 5, 6].map(ep));
    assert.deepEqual(emailsIn(d.text), ['show@show.example']);
    assert.deepEqual(emailsIn(d.episodes.find((e) => e.id === ep(4)).text), ['rows@show.example']);
  });
});

test('Spotify asking to slow down: one wait, then the page; twice is a reason, not an empty page', { skip: !exe }, async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage();
  let calls = 0;
  await page.route('**/*', (r) => (++calls === 1 ? r.fulfill({ status: 429, body: 'slow' }) : calls === 2 ? r.fulfill({ status: 200, contentType: 'text/html', body: `<html>${showHead()}<body><main><h1>Snook</h1></main></body></html>` }) : r.fulfill({ status: 429, body: 'slow' })));
  try {
    const told = [];
    const d = await readSpotifyPage(page, `${site}/episode/${EPISODE}`, { pause: 1, busyWait: 5, onWait: (m) => told.push(m) });
    assert.equal(d.title, 'Snook');
    assert.equal(told.length, 1);
    await assert.rejects(readSpotifyPage(page, `${site}/episode/${EPISODE}`, { pause: 1, busyWait: 5 }), (e) => e.code === 'busy');
  } finally {
    await browser.close();
  }
});
