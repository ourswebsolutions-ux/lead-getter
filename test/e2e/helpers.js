'use strict';
// Shared E2E helpers: unlocking through the real lock screen.

// Sets the PIN on first launch (enter + confirm) or unlocks with it.
async function unlock(win, pin = '1357') {
  const dialog = win.getByRole('dialog', { name: /Create your PIN|Enter your PIN/ });
  await dialog.waitFor({ timeout: 20_000 });
  const creating = /Create/.test(await dialog.getAttribute('aria-label'));
  await win.keyboard.type(pin, { delay: 30 });
  if (creating) {
    await win.getByRole('dialog', { name: 'Confirm your PIN' }).waitFor();
    await win.keyboard.type(pin, { delay: 30 });
  }
  await win.getByRole('heading', { name: 'Lead Finder' }).waitFor();
}

module.exports = { unlock };
