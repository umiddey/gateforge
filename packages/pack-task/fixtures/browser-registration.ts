/**
 * Browser-registration fixture (Phase 3 precision regression): real
 * frontend platform registration shapes that the single-line register
 * heuristic used to misread as custom-queue registrations. The dogfood
 * report flagged the service-worker line below as
 * "AMBIGUOUS_HANDLER: custom-queue registration" — a BROWSER service
 * worker, not a task queue.
 *
 * The pack's detector must emit NOTHING for this file: no resource
 * signal, no finding, no unresolved entry. A receiver rooted at a
 * browser global (navigator/window/document/caches/workbox) — or any
 * chain carrying a `serviceWorker` segment, or the
 * `serviceWorkerRegistration` handle — is never a task queue.
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

// The service-worker handle is usually aliased from
// `navigator.serviceWorker.ready` — still a browser registration.
async function registerBackgroundSync(
  serviceWorkerRegistration: { register: (script: string) => Promise<void> },
): Promise<void> {
  await serviceWorkerRegistration.register('/background-sync.js');
}

// Workbox-style registration: the API surface varies by version, but
// the receiver root (`workbox`) is what marks this as a platform API.
const workbox = { register: (_script: string) => Promise.resolve() };
workbox.register('/precache-manifest.js');
