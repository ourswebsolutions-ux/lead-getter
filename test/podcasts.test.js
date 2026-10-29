'use strict';
// Podcast Lead Finder: Apple Podcasts search and lookup, RSS feed discovery
// and validation, public emails in feeds, episode pages, websites and
// link-in-bio pages, honest statuses for failed checks, and saving to the
// leads (one lead per podcast, shown as each is processed). Apple, feeds and
// websites are served by a fake fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const pc = require('../src/browser/podcasts');

// url -> { status, body, type } | 'down' (the request fails)
function fakeFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    const r = routes[url];
    if (r === 'down') throw new TypeError('fetch failed');
    if (!r) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const res = new Response(body, { status: r.status || 200, headers: { 'content-type': r.type || 'text/html' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
}

function rss({ title = 'Show', link = '', description = '', owner = '', items = [], extra = '' }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${title}</title>
    ${link ? `<link>${link}</link>` : ''}
    <itunes:author>Host Name</itunes:author>
    <description><![CDATA[${description}]]></description>
    ${owner ? `<itunes:owner><itunes:name>Owner</itunes:name><itunes:email>${owner}</itunes:email></itunes:owner>` : ''}
    <image><title>Not the channel title</title><url>https://img.example/x.jpg</url></image>
    ${extra}
    ${items
      .map(
        (it) => `<item><title>${it.title}</title>${it.link ? `<link>${it.link}</link>` : ''}<description><![CDATA[${it.description || ''}]]></description>${
          it.content ? `<content:encoded><![CDATA[${it.content}]]></content:encoded>` : ''
        }<enclosure url="https://cdn.example/${encodeURIComponent(it.title)}.mp3" type="audio/mpeg"/></item>`,
      )
      .join('\n')}
  </channel>
</rss>`;
}

const FEED = { type: 'application/rss+xml' };
const apple = (id, feedUrl, extra = {}) => ({
  wrapperType: 'track',
  kind: 'podcast',
  collectionId: Number(id),
  collectionName: extra.title || `Podcast ${id}`,
  artistName: extra.host || 'Host',
  collectionViewUrl: `https://podcasts.apple.com/us/podcast/p/id${id}?uo=4`,
  ...(feedUrl ? { feedUrl } : {}),
  primaryGenreName: 'Business',
  trackCount: 3,
});

test('Apple Podcasts input: a link or id is a lookup, anything else a search', () => {
  assert.deepEqual(pc.parseAppleInput('https://podcasts.apple.com/us/podcast/pretty-scary-with-clair-buckley/id6784270670'), { id: '6784270670', country: 'us' });
  assert.deepEqual(pc.parseAppleInput('https://podcasts.apple.com/gb/podcast/x/id1234567?i=1000'), { id: '1234567', country: 'gb' });
  assert.deepEqual(pc.parseAppleInput('id6784270670'), { id: '6784270670', country: 'us' });
  assert.deepEqual(pc.parseAppleInput('  true   crime '), { term: 'true crime' });
});

test('Apple Podcasts search and lookup: podcasts with host, feed and clean Apple link; duplicates dropped', async () => {
  const fetchImpl = fakeFetch({
    'https://itunes.apple.com/lookup?id=6784270670&entity=podcast&country=us': { body: { resultCount: 1, results: [apple('6784270670', 'https://feeds.example/ps', { title: 'Pretty Scary', host: 'Audio Always' })] }, type: 'application/json' },
    'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=marketing': {
      body: { results: [apple('1', 'https://f.example/1'), apple('2', null), apple('1', 'https://f.example/1')] },
      type: 'application/json',
    },
    'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=200&country=us&term=busy': { status: 429, body: 'slow down' },
  });
  const one = await pc.searchApple('https://podcasts.apple.com/us/podcast/pretty-scary/id6784270670', { fetchImpl });
  assert.equal(one.exact, true);
  assert.deepEqual(
    { title: one.results[0].title, host: one.results[0].host, feed: one.results[0].feedUrl, url: one.results[0].appleUrl },
    { title: 'Pretty Scary', host: 'Audio Always', feed: 'https://feeds.example/ps', url: 'https://podcasts.apple.com/us/podcast/p/id6784270670' },
  );
  const many = await pc.searchApple('marketing', { fetchImpl });
  assert.deepEqual(many.results.map((p) => p.id), ['1', '2']);
  await assert.rejects(pc.searchApple('busy', { fetchImpl }), /too many requests/);
});

test('RSS parsing: channel fields (not the first episode or image), owner email, episodes; invalid feeds refused', () => {
  const f = pc.parseFeed(
    rss({
      title: 'My &amp; Show',
      link: 'https://myshow.example/',
      description: '<p>About</p>',
      owner: 'owner@myshow.example',
      items: [{ title: 'Ep 1', link: 'https://myshow.example/ep1', description: 'one' }, { title: 'Ep 2' }],
      extra: '<itunes:new-feed-url>https://new.example/feed</itunes:new-feed-url>',
    }),
  );
  assert.equal(f.ok, true);
  assert.equal(f.title, 'My & Show');
  assert.equal(f.link, 'https://myshow.example/');
  assert.equal(f.owner.email, 'owner@myshow.example');
  assert.equal(f.newFeedUrl, 'https://new.example/feed');
  assert.deepEqual(f.items.map((i) => i.title), ['Ep 1', 'Ep 2']);
  assert.equal(pc.parseFeed('<!doctype html><html><body>Hi</body></html>').ok, false);
  assert.match(pc.parseFeed('<!doctype html><html><body>Hi</body></html>').error, /web page/);
  assert.match(pc.parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>').error, /Atom/);
  assert.match(pc.parseFeed('<rss><channel><item><title>x</title></item></channel></rss>').error, /no podcast title/);
});

test('Emails in show notes: mailto, plain, entities, written-out, run into the next link; images and no-reply ignored', () => {
  const html = `<p>Write to <a href="mailto:Hello@Show.example?subject=hi">us</a> or booking&#64;show.example.
    Guests: guests [at] show [dot] co [dot] uk. Mail aloha@kuleana.comwww.kuleana.com
    <img src="logo@2x.png"> noreply@show.example</p>`;
  assert.deepEqual(pc.emailsIn(html).sort(), ['aloha@kuleana.com', 'booking@show.example', 'guests@show.co.uk', 'hello@show.example']);
});

test('The example podcast shape: business email in the show description; the hosting platform’s forwarding address kept but marked', async () => {
  const feedUrl = 'https://feeds.acast.example/public/shows/abc';
  const fetchImpl = fakeFetch({
    [feedUrl]: {
      ...FEED,
      body: rss({
        title: 'Pretty Scary with Clair Buckley',
        link: 'https://prettyscarypod.komi.io/',
        owner: 'info+abc@mg-eu.acast.com',
        description: '<p>Subscribe on Youtube - <a href="https://www.youtube.com/@prettyscarypod">www.youtube.com/@prettyscarypod</a></p><p>Email us on - boo@prettyscarypod.com</p><p>Hosted on Acast. See acast.com/privacy. Questions: support@acast.com</p>',
        items: [{ title: 'Man Or Monster', description: 'Email us on - boo@prettyscarypod.com' }],
      }),
    },
  });
  const r = await pc.processPodcast({ id: '6784270670', title: 'Pretty Scary with Clair Buckley', host: 'Audio Always', appleUrl: 'https://podcasts.apple.com/us/podcast/x/id6784270670', feedUrl }, { fetchImpl });
  assert.equal(r.rssStatus, 'valid');
  assert.equal(r.rssUrl, feedUrl);
  assert.equal(r.episodes, 1);
  assert.equal(r.status, 'found');
  assert.equal(r.email, 'boo@prettyscarypod.com');
  assert.deepEqual(
    r.emails.map((e) => [e.email, e.kind]),
    [
      ['boo@prettyscarypod.com', 'other'],
      ['info+abc@mg-eu.acast.com', 'platform'],
    ],
    'the platform’s own support address in its boilerplate is not the podcast’s',
  );
  assert.deepEqual(r.profiles, ['https://prettyscarypod.komi.io/'], 'a link-in-bio page is a profile, not the website');
  assert.ok(r.socials.some((u) => u.includes('youtube.com/@prettyscarypod')));
  assert.match(r.discovery, /rss: valid \(Apple Podcasts lookup\), 1 episode/);
});

test('No email in the feed: the website’s Contact page is checked and the page it was on is kept', async () => {
  const log = [];
  const fetchImpl = fakeFetch(
    {
      'https://f.example/feed': { ...FEED, body: rss({ link: 'https://www.site.example/', description: 'A show', items: [{ title: 'Ep', link: 'https://www.site.example/' }] }) },
      'https://www.site.example/': { body: '<html><body><a href="/contact-us">Contact</a><a href="/be-a-guest">Be a guest</a></body></html>' },
      'https://www.site.example/contact-us': { body: '<html><body>Reach us: team@site.example, call +1 212 555 0100</body></html>' },
      'https://www.site.example/be-a-guest': { body: '<html><body>Pitch: guests@site.example</body></html>' },
    },
    log,
  );
  const r = await pc.processPodcast({ id: '9', title: 'Show', feedUrl: 'https://f.example/feed', appleUrl: 'https://podcasts.apple.com/us/podcast/x/id9' }, { fetchImpl });
  assert.equal(r.status, 'found');
  assert.equal(r.website, 'https://www.site.example/');
  assert.ok(['team@site.example', 'guests@site.example'].includes(r.email));
  const team = r.emails.find((e) => e.email === 'team@site.example');
  assert.equal(team.kind, 'own');
  assert.equal(team.url, 'https://www.site.example/contact-us');
  assert.ok(log.includes('https://www.site.example/be-a-guest'), 'guest booking pages are read');
  assert.ok(r.checked.some((c) => /^website/.test(c)));
});

test('An email mentioned in one episode only (a guest’s) does not end the search; the podcast’s own wins', async () => {
  const fetchImpl = fakeFetch({
    'https://f.example/g': {
      ...FEED,
      body: rss({ link: 'https://pod.example/', owner: 'me@gmail.com', items: [{ title: 'With Jane', description: 'Reach Jane at jane@janeco.example' }, { title: 'Solo', description: '' }] }),
    },
    'https://pod.example/': { body: '<html><body><footer>Contact: hello@pod.example</footer></body></html>' },
  });
  const r = await pc.processPodcast({ id: '10', title: 'G', feedUrl: 'https://f.example/g' }, { fetchImpl });
  // The owner's address (channel level) is confident: the website is not needed.
  assert.equal(r.email, 'me@gmail.com');
  assert.equal(r.emails.at(-1).email, 'jane@janeco.example');

  const fetch2 = fakeFetch({
    'https://f.example/h': { ...FEED, body: rss({ link: 'https://pod.example/', items: [{ title: 'With Jane', description: 'Reach Jane at jane@janeco.example' }] }) },
    'https://pod.example/': { body: '<html><body><footer>Contact: hello@pod.example</footer></body></html>' },
  });
  const r2 = await pc.processPodcast({ id: '11', title: 'H', feedUrl: 'https://f.example/h' }, { fetchImpl: fetch2 });
  assert.equal(r2.email, 'hello@pod.example', 'the website was checked and its email ranks first');
  assert.deepEqual(r2.emails.map((e) => e.email), ['hello@pod.example', 'jane@janeco.example']);
});

test('Failures are never reported as "no email": website down, feed down, feed invalid, no feed', async () => {
  const fetchImpl = fakeFetch({
    'https://f.example/a': { ...FEED, body: rss({ link: 'https://down.example/' }) },
    'https://down.example/': 'down',
    'https://f.example/b': 'down',
    'https://f.example/c': { body: '<!doctype html><html><body>Moved</body></html>' },
    'https://itunes.apple.com/lookup?id=40&entity=podcast': { body: { results: [] }, type: 'application/json' },
    'https://podcasts.apple.com/us/podcast/x/id40': { body: '<html><body>No feed here</body></html>' },
  });
  const a = await pc.processPodcast({ id: '20', title: 'A', feedUrl: 'https://f.example/a' }, { fetchImpl });
  assert.equal(a.status, 'incomplete');
  assert.match(a.statusText, /could not check: website down\.example/);
  const b = await pc.processPodcast({ id: '30', title: 'B', feedUrl: 'https://f.example/b' }, { fetchImpl });
  assert.equal(b.rssStatus, 'failed');
  assert.equal(b.status, 'failed');
  const c = await pc.processPodcast({ id: '31', title: 'C', feedUrl: 'https://f.example/c' }, { fetchImpl });
  assert.equal(c.rssStatus, 'invalid');
  assert.match(c.rssError, /web page/);
  assert.notEqual(c.status, 'not_found');
  const d = await pc.processPodcast({ id: '40', appleId: '40', title: 'D', appleUrl: 'https://podcasts.apple.com/us/podcast/x/id40' }, { fetchImpl });
  assert.equal(d.rssStatus, 'missing');
  assert.equal(d.status, 'failed');
  assert.match(d.statusText, /lists no RSS feed/);
});

test('RSS discovery: the Apple page’s feed when the lookup has none; a moved feed is followed', async () => {
  const fetchImpl = fakeFetch({
    'https://itunes.apple.com/lookup?id=50&entity=podcast': { body: { results: [apple('50', null)] }, type: 'application/json' },
    'https://podcasts.apple.com/us/podcast/x/id50': { body: '<script>{"showOffer":{"adamId":"50","feedUrl":"https:\\/\\/old.example\\/feed"}}</script>' },
    'https://old.example/feed': { ...FEED, body: rss({ title: 'Old', extra: '<itunes:new-feed-url>https://new.example/feed</itunes:new-feed-url>' }) },
    'https://new.example/feed': { ...FEED, body: rss({ title: 'New', owner: 'host@new.example' }) },
  });
  const r = await pc.processPodcast({ id: '50', appleId: '50', title: 'P', appleUrl: 'https://podcasts.apple.com/us/podcast/x/id50' }, { fetchImpl });
  assert.equal(r.rssFrom, 'Apple Podcasts page');
  assert.equal(r.rssUrl, 'https://new.example/feed');
  assert.equal(r.email, 'host@new.example');
});

test('A link-in-bio profile page is checked when the feed and website have no email', async () => {
  const fetchImpl = fakeFetch({
    'https://f.example/p': { ...FEED, body: rss({ link: 'https://show.komi.io/', description: 'No email here' }) },
    'https://show.komi.io/': { body: '<html><body><a href="mailto:bookings@showmail.example">Email</a></body></html>' },
  });
  const r = await pc.processPodcast({ id: '60', title: 'P', feedUrl: 'https://f.example/p' }, { fetchImpl });
  assert.equal(r.email, 'bookings@showmail.example');
  assert.match(r.emails[0].from, /profile page show\.komi\.io/);
});

test('Apple Podcasts: one network failure is retried; a lasting one is reported in plain words', async () => {
  let calls = 0;
  const flaky = async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ results: [apple('7', 'https://f.example/7')] }), { headers: { 'content-type': 'application/json' } });
  };
  assert.equal((await pc.searchApple('id7000000', { fetchImpl: flaky })).results.length, 1);
  assert.equal(calls, 2);
  await assert.rejects(pc.searchApple('anything', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /could not be reached/);
});

test('A local phone number on a podcast’s website is read in the country of its Apple Podcasts store', async () => {
  const fetchImpl = fakeFetch({
    'https://f.example/wv': { ...FEED, body: rss({ link: 'https://wv.example/' }) },
    'https://wv.example/': { body: '<html><body>Call 304-685-4566</body></html>' },
  });
  const p = pc.fromApple(apple('70', 'https://f.example/wv'), 'us');
  const r = await pc.processPodcast(p, { fetchImpl, country: 'PK' });
  assert.equal(r.phone.phone, '+13046854566', 'a US number, not +92 304…');
});

test('A feed that links to a YouTube channel has no website; the channel is listed as a profile', async () => {
  const fetchImpl = fakeFetch({ 'https://f.example/yt': { ...FEED, body: rss({ link: 'https://youtube.com/c/someone', owner: 'me@show.example' }) } });
  const r = await pc.processPodcast(pc.fromApple(apple('80', 'https://f.example/yt')), { fetchImpl });
  assert.equal(r.website, '');
  assert.deepEqual(r.socials, ['https://youtube.com/c/someone']);
});

test('A huge or slow feed is read as far as it arrives in time: its channel and owner email are used', async () => {
  // A feed whose server keeps sending (like rss.amperwave.net or omnycontent.com feeds of years of episodes).
  const head = '<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Endless Show</title><itunes:owner><itunes:email>owner@endless.example</itunes:email></itunes:owner><item><title>Ep 1</title><description>One</description></item>';
  const fetchImpl = async (url, init) =>
    new Response(
      (() => {
        let stopped = false;
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(head));
          },
          pull(c) {
            return new Promise((r) =>
              setTimeout(() => {
                if (!stopped) c.enqueue(new TextEncoder().encode('<item><title>more</title></item>'));
                r();
              }, 50),
            );
          },
          cancel() {
            stopped = true; // the reader stopped: the rest is never sent
          },
        });
      })(),
      { headers: { 'content-type': 'application/rss+xml' } },
    );
  const got = await pc.fetchFeed('https://slow.example/feed', { fetchImpl, readFor: 400 });
  assert.equal(got.ok, true);
  assert.equal(got.truncated, true);
  const r = await pc.processPodcast({ id: '90', title: 'Endless Show', feedUrl: 'https://slow.example/feed' }, { fetchImpl, feedCache: { get: () => got, set() {} } });
  assert.equal(r.rssStatus, 'valid');
  assert.equal(r.email, 'owner@endless.example');
});
