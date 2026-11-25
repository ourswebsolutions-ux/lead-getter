'use strict';

// The checkable rules of an AI-written email, taken from the sender's own
// prompt (nothing is fixed here for one sender), and the checks and fixes the
// app applies to what the AI wrote:
//   signoff           the exact closing lines every email must end with
//   greeting_named    the greeting when the first name is known ("Hi {first_name},")
//   greeting_unnamed  the greeting when it is not ("Hello there,")
//   required_lines    lines every email must contain word for word
//   bullets           { min, max } bullet lines (e.g. services)
//   questions         { min, max } questions (the call to action)
//   words             { min, max } words in the body
//   mention_business  the business's name must be used
// The AI reads the prompt for them (RULES_SYSTEM); sanitizeRules() keeps only
// what the prompt really says (its text, its numbers), so a rule the AI
// imagined is never enforced. fallbackRules() finds the sign-off and length
// without the AI.

const { extractName } = require('../whatsapp/templates');

const CLOSINGS = 'best regards|best wishes|best|kind regards|warm regards|warmest regards|warm wishes|regards|many thanks|thanks again|thanks|thank you|cheers|yours sincerely|yours truly|yours faithfully|sincerely|respectfully|all the best|take care|talk soon|with thanks|with gratitude|salaam|wassalam';
// A closing line on its own ("Best regards," / "Best, Mahi" / "Thanks!").
const CLOSING_LINE = new RegExp(`^(?:${CLOSINGS})\\s*(?:[,!.—–-]+\\s*(?:\\S.{0,60})?)?$`, 'i');
// A closing at the end of the last sentence ("... a quick chat? Best regards, Info").
const CLOSING_TAIL = new RegExp(`([.?!])\\s+(?:${CLOSINGS})\\s*[,!.]\\s*.{0,60}$`, 'i');
const GREETING = /^(?:hi|hello|hey|hiya|dear|good (?:morning|afternoon|evening)|greetings|assalam\w*|salam\w*|as-?salamu\w*)\b/i;
const BULLET = /^\s*(?:[-•*–·▪●◦➤✓✔]|\d{1,2}[.)])\s+\S/;

const RULES_SYSTEM = [
  'You read an email-writing brief (in the user message) and list the requirements it states that a program can check in each finished email.',
  'Copy text exactly as the brief writes it, character for character (same words, punctuation and line breaks). Use null (or []) for anything the brief does not clearly require. Never add requirements of your own, and never take an example the brief gives as a requirement unless it says to use it.',
  'Answer with JSON only:',
  '{',
  '  "signoff": the exact closing lines every email must end with, lines separated by \\n (for example "Thanks,\\nSam"), or null,',
  '  "greeting_named": the greeting to use when the recipient’s first name is known, with {first_name} where the name goes (for example "Hi {first_name},"), or null,',
  '  "greeting_unnamed": the exact greeting to use when the first name is not known, or null,',
  '  "required_lines": [sentences or lines the brief says every email must contain word for word (not the greeting, not the sign-off)],',
  '  "bullets": {"min": n, "max": n} when the brief asks for a list of bullet points (for example services), else null,',
  '  "questions": {"min": n, "max": n} when the brief says how many questions or call-to-action questions, else null,',
  '  "words": {"min": n, "max": n} when the brief gives the email’s length in words, else null,',
  '  "mention_business": true when the brief says to use the business’s name, else false',
  '}',
].join('\n');

// Quotes and spaces made alike (curly vs straight, runs of spaces / line breaks).
function norm(s) {
  return String(s || '')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
const lower = (s) => norm(s).toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const flexible = (s) => esc(norm(s)).replace(/ /g, '\\s+').replace(/'/g, "['‘’`´]").replace(/"/g, '["“”]');
const inPrompt = (text, prompt) => Boolean(text) && new RegExp(flexible(text), 'i').test(prompt);

function range(v, lo, hi) {
  if (!v || typeof v !== 'object') return null;
  const min = Math.round(Number(v.min));
  const max = Math.round(Number(v.max ?? v.min));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < lo || max > hi || min > max) return null;
  return { min, max };
}

// The sign-off as lines: trimmed, no empty lines, at most 4 short ones.
function cleanSignoff(s) {
  const lines = String(s || '')
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^["“']+|["”']+$/g, '').trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 4 || lines.some((l) => l.split(/\s+/).length > 8)) return null;
  return lines.join('\n');
}

// The AI's reading of the prompt, kept only where the prompt says it.
function sanitizeRules(raw, prompt) {
  const p = String(prompt || '');
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const sig = cleanSignoff(raw.signoff);
  if (sig && inPrompt(sig, p)) out.signoff = sig;
  const named = typeof raw.greeting_named === 'string' ? raw.greeting_named.trim() : '';
  if (named && /\{first_name\}/.test(named) && named.length <= 80) {
    // "Hi {first_name}," is in the prompt as itself, as "Hi [First Name],", or with an example name.
    const pattern = new RegExp(norm(named).split('{first_name}').map(flexible).join(`(?:\\{[^}]{1,30}\\}|\\[[^\\]]{1,30}\\]|<[^>]{1,30}>|[A-Za-z][\\w'-]{1,20})`), 'i');
    if (pattern.test(p)) out.greeting_named = norm(named);
  }
  const unnamed = typeof raw.greeting_unnamed === 'string' ? norm(raw.greeting_unnamed) : '';
  if (unnamed && unnamed.length <= 60 && inPrompt(unnamed, p)) out.greeting_unnamed = unnamed;
  const lines = (Array.isArray(raw.required_lines) ? raw.required_lines : []).map((l) => norm(l)).filter((l) => l.length >= 8 && l.length <= 300 && inPrompt(l, p) && (!out.signoff || lower(l) !== lower(out.signoff)));
  if (lines.length) out.required_lines = [...new Set(lines)].slice(0, 6);
  const bullets = range(raw.bullets, 1, 12);
  if (bullets) out.bullets = bullets;
  const questions = range(raw.questions, 0, 5);
  if (questions) out.questions = questions;
  const words = range(raw.words, 20, 1500);
  // A length only when the prompt has those numbers.
  if (words && new RegExp(`\\b${words.min}\\b`).test(p) && new RegExp(`\\b${words.max}\\b`).test(p)) out.words = words;
  if (raw.mention_business === true) out.mention_business = true;
  return out;
}

// What can be read from the prompt without the AI: the sign-off and the length in words.
function fallbackRules(prompt) {
  const p = String(prompt || '');
  const out = {};
  const sig = new RegExp(`(?:signature|sign[- ]?off|closing|close (?:it |the email |each email )?with|end (?:it |the email |each email |every email )?with)[^\\n]{0,40}?[:\\-–]?\\s*["“']?\\s*((?:${CLOSINGS})[,!.]?[ \\t]*(?:\\n[ \\t]*|[ \\t]+)[A-Za-z][\\w.'’-]*(?:[ \\t]+[A-Za-z][\\w.'’-]*){0,2})`, 'i').exec(p);
  if (sig) {
    const s = cleanSignoff(sig[1]);
    if (s) out.signoff = s;
  }
  const w = /(\d{2,4})\s*(?:-|–|—|to)\s*(\d{2,4})\s*words/i.exec(p);
  if (w && Number(w[1]) <= Number(w[2])) out.words = range({ min: w[1], max: w[2] }, 20, 1500) || undefined;
  if (!out.words) delete out.words;
  return out;
}

// The AI's reading wins where it found something; the fallback fills the rest.
function mergeRules(fallback, read) {
  return { ...fallback, ...read };
}

// The recipient's first name, when the lead has a person's name that is not
// the business's name ("Evolve Commercial Cleaning" for "Evolve Commercial
// Cleaning Preston" is not a person; "Zahid Khan" of "Zahid Properties" is).
function firstName(facts = {}) {
  const raw = facts.first_name || facts.contact_name;
  const name = extractName(raw);
  if (!name) return null;
  const contact = lower(raw).split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  for (const b of [facts.business_name, facts.company].filter(Boolean).map(lower)) {
    const words = new Set(b.split(/[^\p{L}\p{N}'-]+/u).filter(Boolean));
    if (lower(raw) === b || (contact.length > 1 && contact.every((w) => words.has(w)))) return null;
  }
  return name;
}

function expectedGreeting(rules, first) {
  if (first && rules.greeting_named) return rules.greeting_named.replace(/\{first_name\}/g, first);
  if (!first && rules.greeting_unnamed) return rules.greeting_unnamed;
  return null;
}

const lines = (body) => String(body || '').replace(/\r\n/g, '\n').split('\n');
const firstLine = (body) => lines(body).findIndex((l) => l.trim());
const looksGreeting = (l) => GREETING.test(l.trim()) && l.trim().split(/\s+/).length <= 8 && l.trim().length <= 80;

// The body with its greeting line set to `greeting` (the one it has is replaced).
function setGreeting(body, greeting) {
  if (!greeting) return body;
  const ls = lines(body);
  const i = firstLine(body);
  if (i < 0) return greeting;
  if (looksGreeting(ls[i])) {
    // "Hello there, I hope you are well." keeps the rest of the line.
    const rest = ls[i].trim().replace(/^[^,!:\n]*[,!:]\s*/, '');
    ls[i] = rest && rest !== ls[i].trim() ? `${greeting}\n\n${rest}` : greeting;
    return ls.join('\n');
  }
  return `${greeting}\n\n${String(body).trimStart()}`;
}

// The body without its own closing (and anything after it: names, titles,
// company, contact details), and without trailing lines that are only the
// sender's name. The greeting and the content are never touched.
function stripClosing(body, names = []) {
  let ls = lines(body);
  while (ls.length && !ls.at(-1).trim()) ls.pop();
  const start = firstLine(body);
  const filled = ls.map((l, i) => (l.trim() ? i : -1)).filter((i) => i > start);
  const tail = filled.slice(-6);
  let cut = -1;
  for (const i of tail) {
    if (!CLOSING_LINE.test(ls[i].trim())) continue;
    // Only a signature can follow a closing: short lines, no questions.
    const after = ls.slice(i + 1).filter((l) => l.trim());
    if (after.every((l) => l.trim().split(/\s+/).length <= 8 && !l.includes('?'))) {
      cut = i;
      break;
    }
  }
  if (cut > 0) ls = ls.slice(0, cut);
  else if (ls.length > 1) {
    const last = ls.length - 1;
    const m = CLOSING_TAIL.exec(ls[last]);
    if (m && last > start) ls[last] = ls[last].slice(0, m.index + 1);
  }
  const drop = new Set(names.map(lower).filter(Boolean));
  while (ls.length > start + 1 && (!ls.at(-1).trim() || drop.has(lower(ls.at(-1))))) ls.pop();
  return ls.join('\n').trimEnd();
}

// The body ending with exactly the sign-off.
function setSignoff(body, signoff, names = []) {
  if (!signoff) return body;
  return `${stripClosing(body, names)}\n\n${signoff}`;
}

// The body without the sign-off lines (for counting words, questions).
function content(body, signoff) {
  const b = String(body || '').trimEnd();
  return signoff && b.endsWith(signoff) ? b.slice(0, -signoff.length) : b;
}

const wordCount = (t) => (String(t).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []).length;
const questionCount = (t) => (String(t).replace(/https?:\/\/\S+/g, '').match(/\?+/g) || []).length;
const bulletCount = (t) => lines(t).filter((l) => BULLET.test(l)).length;

// The business's name is used: whole, or its first words ("Evolve Commercial"
// for "Evolve Commercial Cleaning Preston").
function namesBusiness(body, name) {
  const b = lower(body);
  const words = norm(name).split(' ').filter(Boolean);
  for (let k = words.length; k >= Math.min(2, words.length); k--) if (b.includes(words.slice(0, k).join(' ').toLowerCase())) return true;
  return false;
}

// What is still wrong with an email (after setGreeting / setSignoff), as
// instructions for the AI: [] when it meets every rule.
// kind 'followup': only the greeting and sign-off rules (its structure and
// length are not the first email's).
function problems({ subject = '', body = '' }, rules, facts = {}, { kind = 'email' } = {}) {
  const out = [];
  const first = firstName(facts);
  const greeting = expectedGreeting(rules, first);
  const top = lines(body)[firstLine(body)] || '';
  if (greeting && norm(top) !== norm(greeting)) out.push(`Start with exactly this greeting on its own line: ${greeting}`);
  else if (!greeting && first && looksGreeting(top) && !lower(top).includes(first.toLowerCase())) out.push(`Greet them by their first name, ${first}.`);
  if (rules.signoff && !String(body).trimEnd().endsWith(`\n${rules.signoff}`)) out.push(`End with exactly these lines and nothing after them:\n${rules.signoff}`);
  if (/\[[A-Z][A-Za-z ]{2,30}\]|\{[a-z_ ]{2,30}\}|<(?:company|name|business)>/i.test(`${subject}\n${body}`)) out.push('Replace every placeholder ([Name], {business}, ...) with the real value from the facts, or rephrase the sentence without it.');
  if (kind === 'followup') return out;
  const text = content(body, rules.signoff);
  for (const l of rules.required_lines || []) if (!lower(text).includes(lower(l))) out.push(`Include this line word for word: ${l}`);
  if (rules.bullets) {
    const n = bulletCount(text);
    if (n < rules.bullets.min || n > rules.bullets.max) out.push(`Give ${rules.bullets.min === rules.bullets.max ? rules.bullets.min : `${rules.bullets.min} to ${rules.bullets.max}`} bullet points, each on its own line starting with "- " (this one has ${n}).`);
  }
  if (rules.questions) {
    const n = questionCount(text);
    if (n < rules.questions.min || n > rules.questions.max) out.push(`Ask ${rules.questions.min === rules.questions.max ? `exactly ${rules.questions.min}` : `${rules.questions.min} to ${rules.questions.max}`} question${rules.questions.max === 1 ? '' : 's'} (the call to action); this one has ${n}.`);
  }
  if (rules.words) {
    // "About 100 to 140 words": a few words either side are still fine.
    const n = wordCount(text);
    const slack = Math.max(3, Math.round(rules.words.max * 0.04));
    const aim = Math.round((rules.words.min + rules.words.max) / 2);
    if (n < rules.words.min - slack) out.push(`It is too short: ${n} words, and the brief asks for ${rules.words.min} to ${rules.words.max}. Add about ${aim - n} words (aim for ${aim}): say a little more about this business’s day-to-day work and how the services help it, without adding questions, bullet points or facts that are not given.`);
    else if (n > rules.words.max + slack) out.push(`It is too long: ${n} words, and the brief asks for ${rules.words.min} to ${rules.words.max}. Cut about ${n - aim} words (aim for ${aim}).`);
  }
  if (rules.mention_business && facts.business_name && !namesBusiness(`${subject}\n${text}`, facts.business_name)) out.push(`Use the business’s name, ${facts.business_name}.`);
  return out;
}

module.exports = { RULES_SYSTEM, sanitizeRules, fallbackRules, mergeRules, firstName, expectedGreeting, setGreeting, setSignoff, stripClosing, problems, wordCount, questionCount, bulletCount, norm };
