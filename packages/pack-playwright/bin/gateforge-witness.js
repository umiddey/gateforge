#!/usr/bin/env node
/**
 * `gateforge-witness`: engine-side loopback witness service entry point.
 *
 * Thin ESM wrapper over the compiled `dist/witness/bin.js`. Reads its
 * configuration from CLI flags and the environment (see
 * `gateforge-witness --help` or `dist/witness/bin.js`; env surface
 * GATEFORGE_RUN_ID, GATEFORGE_RUN_TOKEN, GATEFORGE_PROXY_TARGET,
 * GATEFORGE_MOUNT_PATH, GATEFORGE_STATE_DIR, GATEFORGE_ADAPTERS_DIR,
 * GATEFORGE_CLASSIFICATIONS, GATEFORGE_TARGET_BASE_URL,
 * GATEFORGE_TARGET_FINGERPRINT, GATEFORGE_ADAPTER_BASE_URL,
 * GATEFORGE_WITNESS_VERIFIER_KEY), prints the OS-assigned URL to stdout
 * (`GATEFORGE_WITNESS_URL=http://…`, plus
 * `GATEFORGE_WITNESS_PROXY_URL=http://…` when an observation proxy is
 * active), and serves until SIGTERM/SIGINT.
 */
import { main as startWitness } from '../dist/witness/bin.js';

const handle = await startWitness(process.argv.slice(2), process.env);
if (handle.url !== '') {
  process.stdout.write(`GATEFORGE_WITNESS_URL=${handle.url}\n`);
  if (handle.proxyUrl !== null) {
    process.stdout.write(`GATEFORGE_WITNESS_PROXY_URL=${handle.proxyUrl}\n`);
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
  void signal;
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => void shutdown(signal));
}
