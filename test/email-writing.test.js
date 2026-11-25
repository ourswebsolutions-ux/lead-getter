'use strict';
// AI-written emails follow the sender's prompt: the prompt is the system
// message (first, whole, nothing competing with it), the lead's facts are
// the user message; the rules read from the prompt (sign-off, greeting,
// required line, bullets, one question, length) are checked on every answer;
// the greeting and sign-off are set exactly by the app (an AI that signs as
// the account, "Best regards, Info Axoraweb", is corrected); anything else is
// sent back to the AI at most twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/ai/email-rules');

const PROMPT = fs.readFileSync(path.join(__dirname, 'fixtures', 'mahi-prompt.txt'), 'utf8').replace(/\r\n/g, '\n');
const SIG = 'Best,\nMahi';
// What an AI may answer when asked for the rules: right, plus some it imagined.
const READING = {
  signoff: 'Best,\nMahi',
  greeting_named: 'Hi {first_name},',
  greeting_unnamed: 'Hello there,',
  required_lines: ['At MahiVirtual, we can help your business with:', 'We are the number one agency in the UK.'],
  bullets: { min: 2, max: 4 },
  questions: { min: 1, max: 1 },
  words: { min: 100, max: 140 },
  mention_business: true,
};
const RULES = R.sanitizeRules(READING, PROMPT);
const EVOLVE = { business_name: 'Evolve Commercial Cleaning Preston', category: 'Commercial cleaning service', address: 'Preston, UK' };

function goodBody(greeting = 'Hello there,') {
  return `${greeting}\n\nEvolve Commercial Cleaning Preston keeps offices and workplaces across Preston clean, which means juggling client bookings, staff rotas and a steady stream of enquiries alongside the cleaning itself. That admin can quietly take up hours that would be better spent on your clients and growing the business.\n\nAt MahiVirtual, we can help your business with:\n- Appointment and calendar scheduling for cleaning jobs\n- Email and inbox management, so enquiries get quick replies\n- Customer support for existing clients\n- Bookkeeping support for invoices and payments\n\nOur virtual assistants work as part of your team, so you can stay focused on the work your clients rely on.\n\nWould you be open to a short call next week to see if this could help?\n\n${SIG}`;
}

test('The rules are read from the prompt, and only what the prompt says is kept', () => {
  assert.equal(RULES.signoff, SIG);
  assert.equal(RULES.greeting_named, 'Hi {first_name},');
  assert.equal(RULES.greeting_unnamed, 'Hello there,');
  assert.deepEqual(RULES.required_lines, ['At MahiVirtual, we can help your business with:'], 'a line the prompt does not have is dropped');
  assert.deepEqual(RULES.bullets, { min: 2, max: 4 });
  assert.deepEqual(RULES.questions, { min: 1, max: 1 });
  assert.deepEqual(RULES.words, { min: 100, max: 140 });
  // A sign-off or length the prompt does not have is never enforced.
  assert.deepEqual(R.sanitizeRules({ signoff: 'Best regards,\nInfo Axoraweb', words: { min: 50, max: 90 } }, PROMPT), {});
  // Without the AI: the sign-off and the length are still found.
  assert.deepEqual(R.fallbackRules(PROMPT), { signoff: SIG, words: { min: 100, max: 140 } });
  assert.deepEqual(R.fallbackRules('Write in English.'), {});
});

test('The sign-off is exactly the prompt’s: other closings, names and contact details after it are removed, the content is kept', () => {
  const wrong = [
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nBest regards,\nInfo Axoraweb',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nBest regards, Mahi',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nRegards,\nMahi\nMahiVirtual\nwww.mahivirtual.com | +44 7000 000000',
    'Hi Sarah,\n\nA short note.\n\nWould a call help? Best regards, Info Axoraweb',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nBest, MahiVirtual',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nInfo Axoraweb',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nBest,\nMahi\n\nBest regards,\nInfo Axoraweb',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?\n\nBest,\nSarah',
    'Hi Sarah,\n\nA short note.\n\nWould a call help?',
  ];
  for (const body of wrong) assert.equal(R.setSignoff(body, SIG, ['Info Axoraweb']), `Hi Sarah,\n\nA short note.\n\nWould a call help?\n\n${SIG}`, body);
  // "Thanks" and "Best" inside the email are content, not a closing.
  const kept = 'Hi Sarah,\n\nThanks to your team, offices in Preston stay spotless.\nBest of all, you cover weekends.\n\nWould a call help?';
  assert.equal(R.setSignoff(kept, SIG), `${kept}\n\n${SIG}`);
  // The greeting with the recipient's name is never touched.
  assert.ok(R.setSignoff('Hi Sarah,\n\nBest,\nAli', SIG).startsWith('Hi Sarah,'));
});

test('The greeting: the first name when the lead has a person’s name, “Hello there,” when it has not', () => {
  assert.equal(R.firstName({ contact_name: 'Sarah Jones', business_name: 'Evolve Commercial Cleaning Preston' }), 'Sarah');
  assert.equal(R.firstName({ contact_name: 'Evolve Commercial Cleaning', business_name: 'Evolve Commercial Cleaning Preston' }), null, 'the business’s name is not a person');
  assert.equal(R.firstName(EVOLVE), null);
  assert.equal(R.expectedGreeting(RULES, 'Sarah'), 'Hi Sarah,');
  assert.equal(R.expectedGreeting(RULES, null), 'Hello there,');
  assert.equal(R.setGreeting('Hi Evolve Commercial Cleaning Preston team,\n\nA note.', 'Hello there,'), 'Hello there,\n\nA note.');
  assert.equal(R.setGreeting('Dear Sir/Madam,\n\nA note.', 'Hello there,'), 'Hello there,\n\nA note.');
  assert.equal(R.setGreeting('Hello there, I hope you are well.\n\nA note.', 'Hello there,'), 'Hello there,\n\nI hope you are well.\n\nA note.');
  assert.equal(R.setGreeting('Evolve keeps Preston clean.', 'Hi Sarah,'), 'Hi Sarah,\n\nEvolve keeps Preston clean.', 'no greeting: added');
});

test('The checks: greeting, business name, required line, 2 to 4 bullets, one question, length, sign-off', () => {
  assert.deepEqual(R.problems({ subject: 'Admin help for Evolve Commercial Cleaning', body: goodBody() }, RULES, EVOLVE), []);
  assert.deepEqual(R.problems({ subject: 'x', body: goodBody('Hi Sarah,') }, RULES, { ...EVOLVE, contact_name: 'Sarah Jones' }), []);
  const bad = 'Hi Evolve,\n\nWe help businesses. Do you need help? Are you busy?\n\nWe offer:\n- Admin\n- Email\n- Calls\n- Social media\n- Bookkeeping\n\nBest regards,\nInfo Axoraweb';
  const p = R.problems({ subject: 'Hello', body: bad }, RULES, EVOLVE);
  assert.ok(p.some((x) => /greeting on its own line: Hello there,/.test(x)), 'greeting');
  assert.ok(p.some((x) => /End with exactly these lines[^]*Best,\nMahi/.test(x)), 'sign-off');
  assert.ok(p.some((x) => /word for word: At MahiVirtual, we can help your business with:/.test(x)), 'service line');
  assert.ok(p.some((x) => /2 to 4 bullet points[^]*has 5/.test(x)), 'bullets');
  assert.ok(p.some((x) => /exactly 1 question[^]*has 2/.test(x)), 'one question');
  assert.ok(p.some((x) => /too short: \d+ words[^]*100 to 140[^]*Add about \d+ words/.test(x)), 'length');
  assert.ok(p.some((x) => /business’s name, Evolve Commercial Cleaning Preston/.test(x)), 'business name');
  // A follow-up keeps only the greeting and sign-off rules.
  assert.deepEqual(R.problems({ subject: 'Re: x', body: 'Hello there,\n\nJust a quick follow-up on my last email. Would a short call help?\n\nBest,\nMahi' }, RULES, EVOLVE, { kind: 'followup' }), []);
});

// The writer, against a fake OpenRouter.
function writer(answers) {
  const { createAI } = require('../src/ai/service');
  const { Vault } = require('../src/main/vault');
  const m = new Map();
  const store = { getState: (k) => m.get(k), setState: (k, v) => m.set(k, v) };
  const vault = new Vault({ store, key: 's', cipher: null });
  vault.set('openrouter', 'sk-or-v1-test');
  store.setState('ai.main', 'openrouter');
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const sys = body.messages[0].content;
    const content = sys === R.RULES_SYSTEM ? JSON.stringify(READING) : answers.shift();
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) };
  };
  return { ai: createAI({ store, vault, toolDeps: { email: null, files: null, store: null }, fetchImpl }), calls, store };
}

test('The prompt is the system message, whole and first; the lead is the user message; no sender name competes with the sign-off', async () => {
  const long = `${PROMPT}\n${'Extra guidance. '.repeat(500)}\nLast rule: keep it warm.`;
  assert.ok(long.length > 6000);
  const { ai, calls } = writer([JSON.stringify({ subject: 'Admin help for Evolve Commercial Cleaning', body: goodBody().replace(SIG, 'Best regards,\nInfo Axoraweb') })]);
  const out = await ai.writeEmail({ instructions: long, sender: { name: 'Info Axoraweb', email: 'info.axoraweb@example.com' }, business: { ...EVOLVE, email: 'hello@evolve.test' } });
  const req = calls.find((c) => c.body.messages[0].content !== R.RULES_SYSTEM).body;
  assert.match(calls[0].url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(req.messages[0].role, 'system');
  const sys = req.messages[0].content;
  assert.ok(sys.indexOf(long) > 0 && sys.indexOf(long) < 100, 'the whole prompt, first (nothing cut at 6000 characters)');
  assert.match(sys.slice(sys.indexOf(long) + long.length), /end with exactly these lines[^]*\nBest,\nMahi/);
  assert.doesNotMatch(sys, /Info Axoraweb|sender’s name|80 to 180/, 'nothing competes with the prompt');
  const user = JSON.parse(req.messages[1].content);
  assert.equal(req.messages[1].role, 'user');
  assert.equal(user.business.business_name, 'Evolve Commercial Cleaning Preston');
  assert.equal(user.first_name, null);
  assert.equal(user.greeting, 'Hello there,');
  assert.equal(user.instructions, undefined, 'the prompt is not repeated as lead data');
  assert.equal(user.sender_name, undefined, 'the prompt has a sign-off: no sender name');
  assert.doesNotMatch(req.messages[1].content, /Info Axoraweb|info\.axoraweb|hello@evolve/);
  // The AI signed as the account: corrected, nothing else changed.
  assert.equal(out.body, goodBody());
  assert.ok(out.body.endsWith('\n\nBest,\nMahi'));
  assert.deepEqual(out.problems, []);
});

test('An email that breaks the prompt’s rules is rewritten (at most twice), and the rules are read once per prompt', async () => {
  const bad = { subject: 'Hello', body: 'Hi Evolve Commercial Cleaning Preston,\n\nWe help. Need help? Busy?\n\n- Admin\n- Email\n- Calls\n- Social\n- Books\n\nRegards,\nInfo Axoraweb' };
  const good = { subject: 'Admin help for Evolve Commercial Cleaning', body: goodBody('Hi there!').replace(SIG, 'Kind regards, Mahi') };
  const { ai, calls, store } = writer([JSON.stringify(bad), `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``]);
  const out = await ai.writeEmail({ instructions: PROMPT, sender: { name: 'Info Axoraweb' }, business: EVOLVE });
  const mails = calls.filter((c) => c.body.messages[0].content !== R.RULES_SYSTEM);
  assert.equal(mails.length, 2, 'asked once more');
  const fix = mails[1].body.messages.at(-1).content;
  assert.match(fix, /does not follow the brief/);
  assert.match(fix, /2 to 4 bullet points/);
  assert.match(fix, /exactly 1 question/);
  assert.match(fix, /word for word: At MahiVirtual/);
  assert.equal(out.body, goodBody(), 'greeting and sign-off set by the app');
  assert.deepEqual(out.problems, []);
  assert.ok(store.getState('ai.emailRules'), 'kept');

  // Never right: three answers in all, the best one is used, what it misses is told.
  const again = writer([JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(good)]);
  const worst = await again.ai.writeEmail({ instructions: PROMPT, sender: { name: 'Info Axoraweb' }, business: { ...EVOLVE, contact_name: 'Sarah Jones' } });
  assert.equal(again.calls.filter((c) => c.body.messages[0].content !== R.RULES_SYSTEM).length, 3);
  assert.ok(worst.body.startsWith('Hi Sarah,\n\n'));
  assert.ok(worst.body.endsWith('\n\nBest,\nMahi'));
  assert.ok(worst.problems.length > 0);
  // The same prompt again: its rules are not asked for again.
  const n = again.calls.length;
  again.calls.length = 0;
  await again.ai.writeEmail({ instructions: PROMPT, sender: {}, business: EVOLVE }).catch(() => {});
  assert.equal(again.calls.filter((c) => c.body.messages[0].content === R.RULES_SYSTEM).length, 0);
  assert.ok(n > 0);
});

test('A follow-up: the prompt first, the earlier email in the user message, the prompt’s sign-off', async () => {
  const { ai, calls } = writer([JSON.stringify({ subject: 'Re: x', body: 'Hi there,\n\nJust following up on my note about admin help for Evolve Commercial Cleaning. Would a quick call next week work?\n\nThanks,\nInfo Axoraweb' })]);
  const out = await ai.writeEmail({ instructions: PROMPT, subject: 'Re: Admin help for Evolve', sender: { name: 'Info Axoraweb' }, business: EVOLVE, followup: { step: 1, note: '', earlier: [goodBody()] } });
  const req = calls.find((c) => c.body.messages[0].content !== R.RULES_SYSTEM).body;
  assert.ok(req.messages[0].content.includes(PROMPT));
  assert.match(req.messages[0].content, /follow-up 1/);
  assert.doesNotMatch(req.messages[0].content, /Bullet points:|Length: 100/, 'not the first email’s structure');
  assert.deepEqual(JSON.parse(req.messages[1].content).earlier_emails, [goodBody()]);
  assert.equal(out.subject, 'Re: x');
  assert.equal(out.body, 'Hello there,\n\nJust following up on my note about admin help for Evolve Commercial Cleaning. Would a quick call next week work?\n\nBest,\nMahi');
});
