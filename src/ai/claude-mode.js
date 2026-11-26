'use strict';

// Claude as Lead Finder's writer and assistant (no extra screens):
// - a campaign whose writer is "Claude" has each email (and follow-up)
//   written by Claude when it is sent: Lead Finder gives Claude the lead's
//   details and the campaign's prompt, Claude returns the email (and a short
//   analysis of the business, kept per lead), Lead Finder sends it;
// - the assistant talks through Claude when a Claude model is chosen in
//   Settings > AI Integrations (or an Anthropic key is saved).
// Claude is reached through the Anthropic API with the user's key when one
// is saved, else through the user's OpenRouter key (the Claude model chosen
// in Settings, Claude Opus 5.5 by default).

const ACTIVITY_KEY = 'ai.activity';
const TEXT = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// "anthropic/claude-opus-5.5" (OpenRouter) -> "claude-opus-5-5" (Anthropic API).
const anthropicId = (id) => String(id).replace(/^anthropic\//, '').replace(/-(\d+)\.(\d+)$/, '-$1-$2');

function createClaudeMode({ store, vault, model, log = () => {}, now = () => Date.now() }) {
  const db = store.db;
  if (db) db.exec('CREATE TABLE IF NOT EXISTS ai_lead_insights (lead_id INTEGER PRIMARY KEY, summary TEXT, needs TEXT, angle TEXT, model TEXT, created_at INTEGER NOT NULL)');

  // Which API answers, and with which model id.
  function route() {
    if (vault.has('anthropic')) return { provider: 'Claude', via: 'Anthropic API', model: anthropicId(model()) };
    if (vault.has('openrouter')) return { provider: 'OpenRouter', via: 'OpenRouter', model: model() };
    return null;
  }

  const ready = () => Boolean(route());

  // Chat options that reach Claude only (no stand-in model).
  function opts(extra = {}) {
    const r = route();
    return r ? { model: r.model, only: true, ...extra } : null;
  }

  let lastError = null;
  function noteCall(ok, err) {
    if (ok) lastError = null;
    else if (err && err.message !== lastError) {
      lastError = err.message;
      log(`claude: ${err.message}`);
    }
  }

  function saveInsight(leadId, a, usedModel) {
    if (!db || !leadId || !a || typeof a !== 'object') return;
    const summary = TEXT(a.summary, 600);
    if (!summary) return;
    const needs = Array.isArray(a.needs) ? a.needs.map((x) => TEXT(String(x), 120)).filter(Boolean).slice(0, 6) : [];
    db.prepare('INSERT INTO ai_lead_insights (lead_id, summary, needs, angle, model, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (lead_id) DO UPDATE SET summary = excluded.summary, needs = excluded.needs, angle = excluded.angle, model = excluded.model, created_at = excluded.created_at').run(Number(leadId), summary, JSON.stringify(needs), TEXT(a.angle, 300), usedModel || null, now());
  }

  function insight(leadId) {
    const r = db?.prepare('SELECT * FROM ai_lead_insights WHERE lead_id = ?').get(Number(leadId));
    return r ? { summary: r.summary, needs: JSON.parse(r.needs || '[]'), angle: r.angle, model: r.model, at: r.created_at } : null;
  }

  // What Claude wrote (kept for the assistant's list_generated).
  function activity(e) {
    const list = store.getState(ACTIVITY_KEY) || [];
    list.unshift({ at: now(), ...e });
    store.setState(ACTIVITY_KEY, list.slice(0, 200));
  }
  const activities = (n = 100) => (store.getState(ACTIVITY_KEY) || []).slice(0, n);

  return { route, ready, opts, noteCall, lastError: () => lastError, saveInsight, insight, activity, activities };
}

module.exports = { createClaudeMode, anthropicId };
