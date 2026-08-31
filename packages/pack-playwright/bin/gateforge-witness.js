#!/usr/bin/env node
/**
 * `gateforge-witness`: engine-side loopback witness service entry point.
 *
 * Thin ESM wrapper over the compiled `dist/witness/bin.js`. Reads its
 * configuration from the environment (GATEFORGE_RUN_ID, GATEFORGE_RUN_TOKEN,
 * GATEFORGE_STATE_DIR, GATEFORGE_ADAPTERS_DIR, GATEFORGE_CLASSIFICATIONS,
 * GATEFORGE_TARGET_BASE_URL, GATEFORGE_TARGET_FINGERPRINT,
 * GATEFORGE_ADAPTER_BASE_URL), prints the OS-assigned URL to stdout
 * (`GATEFORGE_WITNESS_URL=http://…`), and serves until SIGTERM/SIGINT.
 */
import { main as startWitness } from '../dist/witness/bin.js';

const handle = await startWitness(process.argv.slice(2), process.env);
process.stdout.write(`GATEFORGE_WITNESS_URL=${handle.url}\n`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await handle.stop();
  } finally {
    process.exit(0);
  }
  void signal;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}