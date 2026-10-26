'use strict';

// Runs one search over its lead sources.
//
// Facebook Lead Search off: exactly the Google Maps search (every event
// passes through unchanged).
//
// On: the Google Maps and Facebook workers start together and run side by
// side, each in its own Chrome pages (Maps in its tabs, Facebook in a window
// of its own), saving leads to the same database as they find them. Each
// has its own progress (status.workers.maps / .facebook: running, paused,
// completed, failed or stopped); one failing never stops the other. Stop
// ends both. The overall search finishes when both have: completed if
// either completed, failed only if both failed.

const WORKER_STATE = { connecting: 'running', running: 'running', paused: 'paused', stopping: 'running', done: 'completed', error: 'failed', stopped: 'stopped' };

// send(event, payload): 'status' | 'lead'. createMaps(emit) and
// createFacebook(emit) build the sessions. Returns the combined stats.
async function runSources({ withFacebook, signal, send, createMaps, createFacebook }) {
  if (!withFacebook) return createMaps(send).run();

  const workers = {
    maps: { state: 'running', message: 'Starting', processed: 0, leads: 0, newLeads: 0, skipped: 0 },
    facebook: { state: 'running', message: 'Starting', processed: 0, leads: 0, newLeads: 0, skipped: 0 },
  };
  let finished = false;
  const totals = () => {
    const t = { processed: 0, leads: 0, newLeads: 0, skipped: 0 };
    for (const w of Object.values(workers)) for (const k of Object.keys(t)) t[k] += w[k] || 0;
    return t;
  };
  // While running, the overall state is running (paused only when neither
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
      message: `${source === 'maps' ? 'Google Maps' : 'Facebook'}: ${payload.message}`,
      workers: snapshot(workers),
    });
  };
  const update = (source, payload) => {
    const w = workers[source];
    for (const k of ['processed', 'leads', 'newLeads', 'skipped']) if (typeof payload[k] === 'number') w[k] = payload[k];
    if (payload.facebook) w.facebook = payload.facebook;
    if (payload.message) w.message = payload.message;
    if (payload.state) w.state = WORKER_STATE[payload.state] || w.state;
    if (payload.phase) w.phase = payload.phase;
  };
  const emitFor = (source) => (event, payload) => {
    if (event === 'lead') return send('lead', payload);
    update(source, payload);
    publish(source, payload);
  };

  const maps = createMaps(emitFor('maps'));
  const fb = createFacebook(emitFor('facebook'));
  const [mapsStats, outcome] = await Promise.all([maps.run(), fb.run()]);

  // Facebook reports its end as an outcome rather than a status.
  update('facebook', { ...fb.stats, state: { done: 'done', stopped: 'stopped' }[outcome.state] || 'error', message: outcome.message });
  workers.facebook.kind = outcome.kind || null;
  update('maps', mapsStats || {});
  finished = true;

  const stats = { ...totals(), facebook: fb.stats.facebook };
  const states = [workers.maps.state, workers.facebook.state];
  const state = signal.aborted || states.every((s) => s === 'stopped') ? 'stopped' : states.includes('completed') ? 'done' : 'error';
  const failedMaps = workers.maps.state === 'failed';
  send('status', {
    ...stats,
    state,
    // A failed Maps search keeps its phase (e.g. the Chrome connection).
    phase: failedMaps && state === 'error' ? workers.maps.phase || 'search' : 'search',
    source: null,
    facebook: { ...fb.stats.facebook, state: outcome.state, kind: outcome.kind || null, message: outcome.message },
    workers: snapshot(workers),
    message: state === 'stopped' ? 'Search stopped' : `Google Maps: ${trimDot(workers.maps.message)}. Facebook: ${outcome.message}`,
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
