/**
 * Multi-line browser-registration fixture (phase 4 precision
 * regression): the EXACT unified-dogfood shape — the receiver
 * `navigator.serviceWorker` sits on its OWN line below the
 * `window.addEventListener` wrapper, with the service-worker
 * registration call on a continuation line. A line-only receiver
 * extraction saw no receiver, the browser exclusion never fired, and
 * the handler-less registration call degraded to a typed
 * UNPROVEN_QUEUE_REGISTRATION blocking entry.
 *
 * The pack's detector must emit NOTHING for this file: no signal, no
 * finding, no unresolved entry. The receiver chain is rebuilt across
 * the line break (bounded lookback) and hits the browser-root
 * exclusion before any queue-evidence gate.
 */
window.addEventListener('load', () => {
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' });
});

// The same split-chain shape with the receiver over TWO continuation
// lines: `navigator` / `.serviceWorker` / `.register(...)` must still
// rebuild to a browser-rooted chain.
navigator
  .serviceWorker
  .register('/sw-precache.js', { scope: '/precache' });
