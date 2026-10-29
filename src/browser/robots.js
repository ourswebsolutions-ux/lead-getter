'use strict';

// Whether a website lets automated readers fetch a page (robots.txt).
// Podcast email discovery reads only pages a site permits: the rules for
// Lead Finder's own name, else for every reader ("*"); the longest matching
// Allow/Disallow wins (RFC 9309). No robots.txt (or one that can't be read)
// means everything is allowed, as RFC 9309 says for missing files.

const AGENT = 'leadfinder';

// robots.txt text -> rules for us: [{ allow, path }] (patterns with * and $).
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const ours = groups.filter((g) => g.agents.some((a) => a !== '*' && AGENT.startsWith(a.replace(/\/.*$/, ''))));
  const chosen = ours.length ? ours : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function matches(pattern, path) {
  if (!pattern) return false;
  const re = new RegExp(`^${pattern.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$')}`);
  return re.test(path);
}

function allowedBy(rules, url) {
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  let best = null;
  for (const r of rules) {
    if (r.path === '') continue; // "Disallow:" (empty) allows everything
    if (!matches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// A checker with a cache per site: allow(url) -> Promise<boolean>.
function robotsChecker({ fetchImpl = globalThis.fetch, signal, timeout = 8000 } = {}) {
  const sites = new Map(); // origin -> Promise<rules>
  const rulesFor = (origin) => {
    if (!sites.has(origin)) {
      sites.set(
        origin,
        (async () => {
          try {
            const limit = AbortSignal.timeout(timeout);
            const res = await fetchImpl(`${origin}/robots.txt`, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (LeadFinder; podcast contact lookup)' }, signal: signal ? AbortSignal.any([signal, limit]) : limit });
            if (!res.ok) return [];
            return parseRobots((await res.text()).slice(0, 500_000));
          } catch {
            return [];
          }
        })(),
      );
    }
    return sites.get(origin);
  };
  return async (url) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(u.protocol)) return false;
    return allowedBy(await rulesFor(u.origin), url);
  };
}

module.exports = { parseRobots, allowedBy, robotsChecker };
