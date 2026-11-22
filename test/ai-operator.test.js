'use strict';
// The AI operator with the app's real engines (lead database, email
// campaigns over SMTP, WhatsApp outreach with a scripted transport) and a
// scripted model in place of Groq: step-by-step set-up, memory across
// turns and restarts, and confirmation enforced by the app (a vague answer
// never starts anything; only an explicit yes does).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LeadStore } = require('../src/database/db');
const { OutreachStore } = require('../src/database/wa-store');
const { Outreach } = require('../src/whatsapp/outreach');
const { eligibleContacts } = require('../src/whatsapp/eligibility');
const { pickName } = require('../src/whatsapp/templates');
const { createEmail } = require('../src/email/service');
const { Vault } = require('../src/main/vault');
const { FileLibrary } = require('../src/main/file-library');
const { buildTools } = require('../src/ai/tools');
const { Operator, YES, NO } = require('../src/ai/operator');
const { startSmtp } = require('./fake-smtp');

const cipher = { encrypt: (t) => Buffer.from(String(t), 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') };

// A model that follows a script: each step gets the messages sent to Groq
// and returns the assistant message (content and/or tool calls).
function scriptedGroq(steps) {
  const seen = [];
  let n = 0;
  return {
    seen,
    configured: () => true,
    chat: async (messages) => {
      seen.push(messages);
      const step = steps[n++];
      if (!step) throw new Error(`the script has no step ${n}`);
      return { message: typeof step === 'function' ? step(messages) : step };
    },
    left: () => steps.length - n,
  };
}
let callN = 0;
const call = (name, args) => ({ id: `c${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content) => ({ content });
const tools = (...calls) => ({ content: null, tool_calls: calls });
const lastTool = (messages) => JSON.parse(messages.filter((m) => m.role === 'tool').at(-1).content);

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-ai-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new LeadStore(path.join(dir, 'leads.db'));
  const state = { get: (k) => db.getState(k), set: (k, v) => db.setState(k, v) };
  const vault = new Vault({ store: db, key: 'secrets', cipher });
  const files = new FileLibrary({ dir: path.join(dir, 'files'), state });
  const email = createEmail({ store: db, vault, files, canSend: async () => true, allowInsecure: true });
  t.after(() => {
    email.campaigns.dispose();
    email.accounts.dispose();
  });
  // WhatsApp: the real engine, a scripted transport.
  const clock = { t: Date.parse('2026-10-21T06:00:00Z') }; // 11:00 in Pakistan
  const sent = [];
  const transport = {
    ready: () => true,
    hasAccount: (id) => id === 'primary',
    send: async (phone, text) => (sent.push({ phone, text, at: clock.t }), { id: `W${sent.length}` }),
    sendMedia: async (phone, file) => (sent.push({ phone, file: file.name, at: clock.t }), { id: `M${sent.length}` }),
    sendAudio: async (phone, v) => (sent.push({ phone, audio: v.name }), { id: `A${sent.length}` }),
  };
  const outreach = new Outreach({ store: new OutreachStore(db.db), state, transport, files: { info: (id) => files.info(id) }, details: (c) => ({ business: c.leadId ? db.leadById(c.leadId)?.name : null }), clock: () => clock.t, random: () => 0, tickMs: 1e9, leads: (f) => db.listLeads(f) });
  const cats = { re: db.ensureCategory('Real Estate'), garments: db.ensureCategory('Garments') };
  let n = 0;
  const lead = (name, { cat, phone, email: mail, wa = false }) => {
    n++;
    db.save({ placeKey: `0x${n}:0xa`, mapsUrl: `https://www.google.com/maps/place/A${n}`, name, phoneRaw: phone || null, address: 'Lahore, Pakistan', websiteStatus: 'no_website', categoryId: cat.id });
    const l = db.listLeads({}).find((x) => x.name === name);
    if (mail) db.saveLeadEmails(l.id, { emails: [mail] });
    if (wa) db.setWhatsAppResult(l.phone, 'available', 'baileys');
    return l;
  };
  const searches = [];
  const deps = {
    version: 'test',
    store: db,
    outreach: () => outreach,
    waAccounts: () => [{ id: 'primary', label: 'Ali Business', number: '923000000000', state: 'open' }],
    waStart: async (id, opts) => outreach.start(id, opts),
    waResume: async (id) => outreach.resume(id),
    waEligible: (id, filters) => eligibleContacts({ leads: db.listLeads({}), store: outreach.store, campaign: outreach.load(id), filters }),
    waAddLeads: async (id, ids) => {
      const leads = db.listLeads({ ids });
      return outreach.addLeads(id, leads.map((l) => ({ phone: l.phone, leadId: l.id, name: pickName({ businessName: l.name }).name })));
    },
    audioAdd: () => ({ ok: false, error: 'no audio in this test' }),
    files,
    email,
    requirePlan: () => ({ ok: true }),
    plan: () => ({ state: 'active', plan: 'Pro', days_left: 20 }),
    search: { status: () => ({ running: false }), pool: () => [], stop: () => ({ ok: true }), start: () => ({ ok: true }), run: (a) => (searches.push(a), { ok: true, started: true, linkedin_mode: a.linkedinMode }) },
    settings: { get: () => ({ continuous_search: false }), set: () => ({ ok: true }) },
    showLeads: () => {},
  };
  const make = (groq) => new Operator({ groq, tools: buildTools(deps), state, context: () => 'test', credentials: (text) => email.addFromText(text, { test: false }) });
  t.after(async () => {
    outreach.dispose();
    await new Promise((r) => setTimeout(r, 30)); // a kick still on its way
    db.close();
  });
  return { db, state, email, outreach, transport, sent, clock, cats, lead, deps, make, files, dir, searches };
}

test('Explicit yes only: confirmations in English, Roman Urdu and Urdu; vague answers are not yes', () => {
  for (const y of ['yes', 'Haan', 'han ji', 'theek hai', 'kar do', 'start kar do', 'ok', 'جی ہاں', '👍']) assert.ok(YES.test(y), y);
  for (const v of ['maybe', 'hmm', 'shayad', 'yes but change the subject', 'kal', 'ok wait', 'haan lekin pehle subject badlo']) assert.ok(!YES.test(v), v);
  for (const no of ['no', 'nahi', 'cancel', 'rehne do', 'نہیں']) assert.ok(NO.test(no), no);
});

test('Email campaign by conversation: drafted step by step, remembered, started only after an explicit yes, then really sent', async (t) => {
  const w = world(t);
  const smtp = await startSmtp();
  t.after(() => smtp.close());
  const acc = w.email.accounts.add({ name: 'Company SMTP', senderName: 'Axora', email: 'sender@example.com', host: '127.0.0.1', port: smtp.port, password: 'pw', encryption: 'none' }).account;
  w.lead('Zahid Properties', { cat: w.cats.re, phone: '03001234567', email: 'zahid@realty.pk' });
  w.lead('Noor Estate', { cat: w.cats.re, phone: '03001234568', email: 'info@noor.pk' });
  w.lead('No Mail Realty', { cat: w.cats.re, phone: '03001234569' });
  let cid = null;
  const groq = scriptedGroq([
    // 1: "Email campaign start karo, real estate leads ko"
    tools(call('list_email_accounts', {})),
    (m) => {
      assert.equal(lastTool(m).accounts[0].name, 'Company SMTP');
      assert.ok(!JSON.stringify(m).includes('"pw"'), 'the password never reaches the AI');
      return tools(call('create_email_campaign', { name: 'Real estate websites', account_id: acc.id }));
    },
    (m) => {
      cid = lastTool(m).campaign.id;
      return tools(call('add_email_recipients', { campaign_id: cid, category: 'real estate' }));
    },
    (m) => {
      const r = lastTool(m);
      assert.equal(r.added, 2);
      assert.equal(r.without_email, 1);
      return say('2 real estate leads ke paas valid email hai. Subject kya ho?');
    },
    // 2: the subject — the model remembers the campaign from the history.
    (m) => {
      assert.ok(m.some((x) => x.role === 'system' && /email campaign being worked on: id \d+/.test(x.content)), 'the task context is given back to the AI');
      return tools(call('update_email_campaign', { campaign_id: cid, subject: 'Professional website for {business}' }));
    },
    say('Subject set. Ab email ka body likhein.'),
    // 3: the body, then ready to start.
    () => tools(call('update_email_campaign', { campaign_id: cid, body: 'Hello {name},\n\nWe build websites for real estate businesses.' }), call('start_campaign', { channel: 'email', campaign_id: cid })),
    (m) => {
      const r = lastTool(m);
      assert.equal(r.status, 'awaiting_user_confirmation');
      assert.match(r.will_do, /2 recipients/);
      return say('Campaign ready: 2 recipients. Start karun? (yes / no)');
    },
    // 4: "hmm shayad" — not a confirmation.
    (m) => {
      assert.match(m.at(-1).content, /NOT done/);
      return say('Theek hai, abhi start nahi kiya.');
    },
    // 5: "start kar do" — no pending action: the AI asks again.
    () => tools(call('start_campaign', { channel: 'email', campaign_id: cid })),
    say('2 recipients ko email bhejna shuru karun? Confirm karein.'),
    // 6: "haan" — the app runs it; the AI only reports the result.
    (m) => {
      const r = lastTool(m);
      assert.equal(r.ok, true);
      assert.equal(r.confirmed_by_user, true);
      return say('Email campaign shuru ho gayi.');
    },
  ]);
  const op = w.make(groq);
  let r = await op.handle('app', 'Email campaign start karo, real estate leads ko');
  assert.ok(r.ok, r.error);
  assert.equal(w.email.campaigns.summary(cid).counts.total, 2);
  r = await op.handle('app', 'Professional website for {business}');
  assert.ok(r.ok, r.error);
  r = await op.handle('app', 'Hello {name}, we build websites for real estate businesses.');
  assert.ok(r.pending, 'waiting for confirmation');
  assert.equal(w.email.campaigns.summary(cid).status, 'draft', 'not started on the AI’s word');
  r = await op.handle('app', 'hmm shayad');
  assert.equal(r.pending, null);
  assert.equal(w.email.campaigns.summary(cid).status, 'draft', 'a vague answer starts nothing');
  r = await op.handle('app', 'start kar do');
  assert.ok(r.pending);
  assert.equal(w.email.campaigns.summary(cid).status, 'draft');
  r = await op.handle('app', 'haan');
  assert.ok(r.ok, r.error);
  assert.ok(r.actions.some((a) => a.tool === 'start_campaign' && a.ok && a.confirmed));
  assert.equal(w.email.campaigns.summary(cid).status, 'running');
  await w.email.campaigns.tick();
  assert.equal(smtp.messages.length, 1, 'really sent, over SMTP');
  assert.match(smtp.messages[0].text, /Subject: Professional website for (Zahid Properties|Noor Estate)/);
  assert.equal(groq.left(), 0);
  // A restart: the conversation and its task context are still there.
  const again = w.make(scriptedGroq([]));
  const v = again.view('app');
  assert.ok(v.display.some((d) => d.role === 'assistant' && /shuru ho gayi/.test(d.text)));
  assert.equal(again.conversation('app').focus.email.id, cid);
  // A confirm tool never runs without the user's yes, even if asked directly.
  const direct = await again.exec('stop_campaign', { channel: 'email', campaign_id: cid });
  assert.equal(direct.ok, false);
  assert.equal(w.email.campaigns.summary(cid).status, 'running');
});

test('WhatsApp campaign by conversation: account, category, two messages and an image; started after yes; sent in order', async (t) => {
  const w = world(t);
  const a = w.lead('Ali Garments', { cat: w.cats.garments, phone: '03011111111', wa: true });
  w.lead('Bilal Fabrics', { cat: w.cats.garments, phone: '03022222222' }); // not confirmed on WhatsApp
  const img = path.join(w.dir, 'offer.png');
  fs.writeFileSync(img, Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64)]));
  const file = w.files.add(img).file;
  let cid = null;
  const groq = scriptedGroq([
    tools(call('create_whatsapp_campaign', { name: 'Garments', account_id: 'primary' })),
    (m) => {
      cid = lastTool(m).campaign.id;
      return tools(call('add_whatsapp_recipients', { campaign_id: cid, category: 'Garments' }));
    },
    (m) => {
      const r = lastTool(m);
      assert.equal(r.added, 1, 'only the number confirmed on WhatsApp');
      assert.equal(r.matching_leads, 2);
      return say('1 garments lead WhatsApp par hai. Message kya ho?');
    },
    () => tools(call('add_whatsapp_message', { campaign_id: cid, text: 'Hello {name}, we make websites.' })),
    say('Message 1 ready. Aur message, image ya voice?'),
    () => tools(call('add_whatsapp_message', { campaign_id: cid, text: 'Hum ecommerce bhi banate hain.' })),
    say('Second message added.'),
    () => tools(call('add_whatsapp_attachment', { campaign_id: cid, file_id: file.id })),
    (m) => {
      const r = lastTool(m);
      assert.deepEqual(r.campaign.messages.map((x) => x.text), ['Hello {name}, we make websites.', 'Hum ecommerce bhi banate hain.'], 'the default message was replaced, the order kept');
      assert.equal(r.campaign.files[0].name, 'offer.png');
      return tools(call('start_campaign', { channel: 'whatsapp', campaign_id: cid }));
    },
    (m) => {
      assert.match(lastTool(m).will_do, /1 recipient, 2 messages, 1 file/);
      return say('Ready. Start karun?');
    },
    say('WhatsApp campaign started.'),
  ]);
  const op = w.make(groq);
  await op.handle('app', 'WhatsApp campaign start karo, Ali Business se, garments category');
  await op.handle('app', 'Hello {name}, we make websites.');
  await op.handle('app', 'Dosra message bhi add karna hai: Hum ecommerce bhi banate hain.');
  const r = await op.handle('app', 'Ismein ye image bhi laga do', { files: [file] });
  assert.ok(r.pending);
  assert.notEqual(w.outreach.load(cid).status, 'running', 'not started on the AI’s word');
  await op.handle('app', 'yes');
  const st = w.outreach.load(cid);
  assert.equal(st.status, 'running');
  assert.equal(st.config.test, false, 'live');
  for (let i = 0; i < 6; i++) {
    await w.outreach.tick();
    w.clock.t += 61_000;
  }
  assert.deepEqual(
    w.sent.map((s) => s.text || s.file),
    ['Hello Ali, we make websites.', 'Hum ecommerce bhi banate hain.', 'offer.png'],
  );
  assert.ok(w.sent.every((s) => s.phone === a.phone));
});

test('An email account written in the chat: added by the app, the password never reaches the AI or the history; then used by a campaign', async (t) => {
  const w = world(t);
  let accId = null;
  const groq = scriptedGroq([
    (m) => {
      const all = JSON.stringify(m);
      assert.ok(!/abcd ?efgh|abcdefghijklmnop/.test(all), 'no password in what the AI gets');
      assert.match(m.at(-1).content, /ali@gmail\.com: added, connected \(account id ([a-f0-9]+)\)/);
      accId = /account id ([a-f0-9]+)/.exec(m.at(-1).content)[1];
      return say('Gmail account add ho gaya.');
    },
    () => tools(call('create_email_campaign', { name: 'From chat', account_id: accId })),
    (m) => {
      assert.equal(lastTool(m).campaign.sending_accounts[0].email, 'ali@gmail.com');
      return say('Campaign ban gayi.');
    },
  ]);
  const op = w.make(groq);
  const r = await op.handle('app', 'mera gmail ali@gmail.com hai aur app password abcd efgh ijkl mnop, isko add kar do');
  assert.ok(r.ok, r.error);
  assert.ok(r.actions.some((a) => a.tool === 'email_account' && a.ok));
  assert.equal(w.email.accounts.list()[0].host, 'smtp.gmail.com');
  assert.ok(!JSON.stringify(w.state.get('ai.conversations')).includes('abcd'), 'not in the saved history either');
  assert.match(op.view('app').display[0].text, /\[password saved securely\]/);
  await op.handle('app', 'is account se campaign banao');
});

test('Any lead search by conversation: LinkedIn My connections, a LinkedIn page with its pages, Google Maps; each after yes', async (t) => {
  const w = world(t);
  const groq = scriptedGroq([
    tools(call('start_lead_search', { sources: ['linkedin'], linkedin_mode: 'connections' })),
    (m) => {
      assert.match(lastTool(m).will_do, /LinkedIn: your connections/);
      return say('LinkedIn connections ki search shuru karun? (yes/no)');
    },
    (m) => {
      assert.equal(lastTool(m).started, true);
      return say('LinkedIn connections search shuru ho gayi.');
    },
    tools(call('start_lead_search', { sources: ['linkedin'], linkedin_mode: 'link', link: 'https://www.linkedin.com/search/results/people/?keywords=seo', from_page: 2, to_page: 3 })),
    (m) => {
      assert.match(lastTool(m).will_do, /pages 2-3/);
      return say('Confirm?');
    },
    say('OK, nahi kiya.'),
    tools(call('start_lead_search', { sources: ['maps'], business: 'real estate agency', countries: ['Lahore'] })),
    say('Confirm?'),
    say('Started.'),
  ]);
  const op = w.make(groq);
  await op.handle('app', 'acha ab linkdin search start kro with my connection');
  assert.equal(w.searches.length, 0, 'not before yes');
  await op.handle('app', 'haan');
  assert.deepEqual([w.searches[0].sources, w.searches[0].linkedinMode], [['linkedin'], 'connections']);
  await op.handle('app', 'is link ke page 2 se 3 tak: https://www.linkedin.com/search/results/people/?keywords=seo');
  await op.handle('app', 'nahi');
  assert.equal(w.searches.length, 1, 'declined: not started');
  await op.handle('app', 'Lahore mein real estate agencies Google Maps par dhoondo');
  await op.handle('app', 'yes');
  assert.deepEqual([w.searches[1].sources, w.searches[1].business, w.searches[1].countries], [['maps'], 'real estate agency', ['Lahore']]);
});
