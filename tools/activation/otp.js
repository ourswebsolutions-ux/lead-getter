'use strict';

// Creates a 4-digit activation code and emails it to ADMIN_EMAIL only. The
// code is not printed here; pass it on to the customer by WhatsApp or phone.
//   npm run otp -- LF-XXXX-XXXX-XXXX monthly|six_months|lifetime
//   npm run check-smtp

const fs = require('node:fs');
const path = require('node:path');
const { PLANS, ID_RE, createCode } = require('../../src/main/activation-code');
const { ENV_FILE, loadEnv, secretFrom, createMailer } = require('./lib');

async function main(argv) {
  const env = loadEnv();
  const mailer = createMailer(env);
  if (argv.includes('--check-smtp')) {
    await mailer.verify();
    console.log(`SMTP works. Codes will be sent to ${env.ADMIN_EMAIL}.`);
    return;
  }
  const [rawId, plan] = argv.filter((a) => !a.startsWith('--'));
  const activationId = String(rawId || '').trim().toUpperCase();
  if (!ID_RE.test(activationId)) throw new Error('Usage: npm run otp -- LF-XXXX-XXXX-XXXX monthly|six_months|lifetime');
  const p = PLANS.find((x) => x.id === plan);
  if (!p) throw new Error(`The plan must be one of: ${PLANS.map((x) => x.id).join(', ')}.`);
  const now = new Date();
  const { code, enterBy } = createCode({ activationId, plan, secret: secretFrom(env), now });
  await mailer.send({
    subject: `Lead Finder activation code ${code} (${p.name}, ${activationId})`,
    text: [
      `Activation code: ${code}`,
      '',
      `Activation ID: ${activationId}`,
      `Plan: ${p.name} (${p.priceLabel}), ${p.months ? `${p.months} month${p.months === 1 ? '' : 's'} from activation (added to a plan still running)` : 'never expires'}`,
      `Enter by: ${enterBy.toUTCString()} (one use, only on this Activation ID and plan)`,
      '',
      'Send the 4 digits to the customer by WhatsApp or phone. They choose the same plan in Lead Finder > Activate, enter the code and click Activate.',
    ].join('\n'),
  });
  fs.appendFileSync(path.join(path.dirname(ENV_FILE), 'issued.log'), `${JSON.stringify({ at: now.toISOString(), activationId, plan, enterBy: enterBy.toISOString() })}\n`);
  console.log(`Code for ${activationId} (${p.name}) emailed to ${env.ADMIN_EMAIL}.`);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
