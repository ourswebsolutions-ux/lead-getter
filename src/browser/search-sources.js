'use strict';

// Runs one search over its lead sources: Google Maps, then, when Facebook
// Lead Search is on, Facebook with the same keyword and category.
//
// With Facebook off this is exactly the Maps search (every event passes
// through unchanged). With it on, the Maps search's final status is held
// back while Facebook runs and then reported together with Facebook's
// outcome; a Facebook problem (login, check, block, error) is described but
// never turns a finished Maps search into a failed one. Stop ends both; a
// lost Chrome connection that could not be restored ends the search as
// before, without Facebook.

// send(event, payload): 'status' | 'lead'. createMaps(emit) and
// createFacebook(emit, stats) build the sessions. Returns the final stats.
async function runSources({ withFacebook, signal, send, createMaps, createFacebook }) {
  let mapsFinal = null;
  const emit = (event, payload) => {
    if (event === 'lead') return send('lead', payload);
    const finished = payload.state === 'done' || (payload.state === 'error' && payload.phase !== 'connection');
    if (withFacebook && payload.source !== 'facebook' && finished) {
      mapsFinal = payload;
      return send('status', { ...payload, state: 'running', source: 'facebook', message: `Google Maps: ${trimDot(payload.message)}. Now searching Facebook` });
    }
    send('status', payload);
  };

  let stats = await createMaps(emit).run();
  if (!mapsFinal || signal.aborted) return stats;

  const fb = createFacebook(emit, stats);
  const outcome = await fb.run();
  stats = fb.stats;
  if (outcome.state === 'stopped') {
    send('status', { ...stats, state: 'stopped', message: 'Search stopped' });
  } else {
    send('status', {
      ...stats,
      state: mapsFinal.state,
      phase: mapsFinal.phase,
      source: null,
      facebook: { ...stats.facebook, state: outcome.state, kind: outcome.kind || null, message: outcome.message },
      message: `Google Maps: ${trimDot(mapsFinal.message)}. Facebook: ${outcome.message}`,
    });
  }
  return stats;
}

function trimDot(s) {
  return String(s || '').replace(/\.$/, '');
}

module.exports = { runSources };
