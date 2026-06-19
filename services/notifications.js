/**
 * Central notifications gate — disabled by default to prevent memory loops
 * from native toast processes (snoretoast) on Windows.
 * Set NOTIFICATIONS_ENABLED = true to re-enable.
 */
const NOTIFICATIONS_ENABLED = false;

let notifier = null;

function getNotifier() {
  if (!NOTIFICATIONS_ENABLED) return null;
  if (!notifier) {
    notifier = require('node-notifier');
  }
  return notifier;
}

function isEnabled() {
  return NOTIFICATIONS_ENABLED;
}

function notify(options) {
  if (!NOTIFICATIONS_ENABLED) return;
  const n = getNotifier();
  if (n) n.notify({ wait: false, sound: false, ...options });
}

function onClick(handler) {
  if (!NOTIFICATIONS_ENABLED) return;
  const n = getNotifier();
  if (n) n.on('click', handler);
}

module.exports = { isEnabled, notify, onClick, NOTIFICATIONS_ENABLED };
