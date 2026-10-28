'use strict';

// Runs one search over its lead sources.
//
// Each source (Google Maps, Facebook, LinkedIn) has its own switch; any one,
// two or all three can run.
//
// Google Maps alone: exactly the Google Maps search (every event passes
// through unchanged).
//
// Otherwise the sources that are on start together and run side by side,
// each in its own Chrome pages (Maps in its tabs, Facebook and LinkedIn in
// windows of their own), saving leads to the same database as they find
// them. Each has its own progress (status.workers.<source>: running, paused,
// completed, failed or stopped); one failing never stops the others. Stop
// ends all. The overall search finishes when all have: completed if any
// completed, failed only if all failed.

const WORKER_STATE = { connecting: 'running', running: 'running', paused: 'paused', stopping: 'running', done: 'completed', error: 'failed', stopped: 'stopped' };
const LABEL = { maps: 'Google Maps', facebook: 'Facebook', linkedin: 'LinkedIn' };

// send(event, payload): 'status' | 'lead'. createMaps(emit),
// createFacebook(emit) and createLinkedIn(emit) build the sessions.
// Returns the combined stats.
async function runSources({ withMaps = true, withFacebook = false, withLinkedIn = false, signal, send, createMaps, createFacebook, createLinkedIn }) {
  if (withMaps && !withFacebook && !withLinkedIn) return createMaps(send).run();

  const extra = [...(withFacebook ? ['facebook'] : []), ...(withLinkedIn ? ['linkedin'] : [])];
  const selected = [...(withMaps ? ['maps'] : []), ...extra];
  const workers = Object.fromEntries(selected.map((k) => [k, { state: 'running', message: 'Starting', processed: 0, leads: 0, newLeads: 0, skipped: 0 }]));
  let finished = false;
  const totals = () => {
    const t = { processed: 0, leads: 0, newLeads: 0, skipped: 0 };
    for (const w of Object.values(workers)) for (const k of Object.keys(t)) t[k] += w[k] || 0;
    return t;
  };
  // While running, the overall state is running (paused only when no
  // worker is making progress); after Stop it stays "stopping".
  const overall = () => {
    if (signal.aborted) return 'stopping';
    const states = Object.values(workers).map((w) => w.state);
    if (states.includes('running')) return 'running';
    return states.includes('paused') ? 'paused' : 'running';
  };
  const publish = (source, payload) => {
    if (finished) return;
    send('status', {
      ...totals(),
      state: overall(),
      phase: payload.phase || 'search',
      step: payload.step,
      source,
      message: `${LABEL[source]}: ${payload.message}`,
      workers: snapshot(workers),
    });
  };
  const update = (source, payload) => {
    const w = workers[source];
    for (const k of ['processed', 'leads', 'newLeads', 'skipped']) if (typeof payload[k] === 'number') w[k] = payload[k];
    if (payload[source]) w[source] = payload[source];
    if (payload.message) w.message = payload.message;
    if (payload.state) w.state = WORKER_STATE[payload.state] || w.state;
    if (payload.phase) w.phase = payload.phase;
  };
  const emitFor = (source) => (event, payload) => {
    if (event === 'lead') return send('lead', payload);
    update(source, payload);
    publish(source, payload);
  };

  const maps = withMaps ? createMaps(emitFor('maps')) : null;
  const sessions = { facebook: withFacebook ? createFacebook(emitFor('facebook')) : null, linkedin: withLinkedIn ? createLinkedIn(emitFor('linkedin')) : null };
  const [mapsStats, ...outcomes] = await Promise.all([maps ? maps.run() : null, ...extra.map((k) => sessions[k].run())]);

  // Facebook and LinkedIn report their end as an outcome rather than a status.
  const ends = {};
  extra.forEach((k, i) => {
    const outcome = outcomes[i];
    update(k, { ...sessions[k].stats, state: { done: 'done', stopped: 'stopped' }[outcome.state] || 'error', message: outcome.message });
    workers[k].kind = outcome.kind || null;
    ends[k] = { ...sessions[k].stats[k], state: outcome.state, kind: outcome.kind || null, message: outcome.message };
  });
  if (withMaps) update('maps', mapsStats || {});
  finished = true;

  const stats = { ...totals(), ...Object.fromEntries(extra.map((k) => [k, sessions[k].stats[k]])) };
  const states = Object.values(workers).map((w) => w.state);
  const state = signal.aborted || states.every((s) => s === 'stopped') ? 'stopped' : states.includes('completed') ? 'done' : 'error';
  const failedMaps = workers.maps?.state === 'failed';
  send('status', {
    ...stats,
    state,
    // A failed Maps search keeps its phase (e.g. the Chrome connection).
    phase: failedMaps && state === 'error' ? workers.maps.phase || 'search' : 'search',
    source: null,
    ...ends,
    workers: snapshot(workers),
    message:
      state === 'stopped'
        ? 'Search stopped'
        : [...(withMaps ? [`Google Maps: ${trimDot(workers.maps.message)}.`] : []), ...extra.map((k) => `${LABEL[k]}: ${ends[k].message}`)].join(' '),
  });
  return stats;
}

function snapshot(workers) {
  return JSON.parse(JSON.stringify(workers));
}

function trimDot(s) {
  return String(s || '').replace(/\.$/, '');
}

module.exports = { runSources };
