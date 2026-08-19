/**
 * js/app.js — bootstrap only.
 *
 * Wires modules together and starts the shell. No feature logic lives here:
 * panels register themselves on import, so adding a panel means adding a file
 * and one import line.
 */

import { bus } from './core/bus.js';
import { store } from './core/store.js';
import { PDFJS_WORKER_SRC } from './core/config.js';
import { startShell, notify, setTabCount, activate } from './ui/shell.js';
import { primeNumbers } from './ui/deps.js';

/* Panels — importing them is what registers them. */
import './ui/panel-extract.js';
import './ui/panel-scrape.js';
import './ui/panel-tools.js';

/* pdf.js needs its worker URL set once, from the same pin as index.html. */
if (typeof window.pdfjsLib !== 'undefined') {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
}

/* Adopt core/numbers.js for cell formatting and foot-checks as soon as it exists. */
primeNumbers().catch(() => {});

startShell({
  tablist: document.getElementById('tablist'),
  main: document.getElementById('main'),
  fallback: 'extract',
  ctx: { store, bus, notify, setTabCount, activate }
});

/* Anything that escapes a panel should still reach the analyst. */
window.addEventListener('error', (event) => {
  console.error('[app] uncaught', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] unhandled rejection', event.reason);
});
