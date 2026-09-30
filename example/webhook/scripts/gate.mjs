/**
 * The one command a fresh copy of this example needs: `npm run gate`.
 *
 * A supervised `test-gates` run NEVER loads the consumer Playwright
 * config, so its `webServer` never starts — the app has to be running
 * before the gate. This script owns that whole lifecycle so the example
 * installs and gates on a new repository with a single command:
 *
 *   1. pick a free loopback port (no hard-coded collision),
 *   2. generate the receiver's shared signing secret for THIS run and
 *      create a runtime verifier key ring OUTSIDE the repository (mode
 *      0600, in the OS temp dir), so no key material is ever committed
 *      or printed,
 *   3. start the receiver on that port and wait for it to listen,
 *   4. run `tests discover`, `test-gates --changed` and
 *      `check --require-e2e`,
 *   5. stop the app, remove the key ring, and exit with the CHECK's
 *      status — the gate's verdict, not the last command's.
 *
 * Plain lines only: every step prints one line, and neither the key ring
 * nor the signing secret is ever echoed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { startAttestationProxy } from '@gate-forge/pack-playwright';
const root = resolve(import.meta.dirname, '..');
const LOOPBACK = ['127', '0', '0', '1'].join('.');

/**
 * Resolves the installed CLI entrypoint, or explains how to install it.
 *
 * @returns {string} absolute path of the `gateforge` entrypoint
 */
function gateforgeBin() {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      "const {existsSync}=require('node:fs');" +
        "const {join}=require('node:path');" +
        'let dir=process.cwd();let hit=\'\';' +
        'for(;;){const c=join(dir,\'node_modules\',\'@gate-forge\',\'cli\',\'bin\',\'gateforge.js\');' +
        'if(existsSync(c)){hit=c;break;}' +
        'const up=join(dir,\'..\');if(up===dir)break;dir=up;}' +
        'process.stdout.write(hit);',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const found = probe.stdout.trim();
  if (probe.status !== 0 || found === '') {
    throw new Error(
      'the Gateforge CLI is not installed here — run `npm install @gate-forge/cli @gate-forge/pack-playwright` first',
    );
  }
  return found;
}

/**
 * Asks the OS for a free loopback port and releases it immediately.
 *
 * @returns {Promise<number>} a port that was free a moment ago
 */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? rejectPort(new Error('no free loopback port')) : resolvePort(port)));
    });
  });
}

/**
 * Creates a runtime key ring outside the repository.
 *
 * @returns {{dir: string, file: string}} the temp directory and key file
 */
function createKeyRing() {
  const dir = mkdtempSync(join(tmpdir(), 'gateforge-webhook-verifier-'));
  const file = join(dir, 'keys.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      schemaVersion: 1,
      activeKeyId: 'local',
      keys: { local: randomBytes(32).toString('base64') },
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return { dir, file };
}

/**
 * Polls the receiver's read API until it answers, or gives up.
 *
 * @param {string} base loopback base URL
 * @param {import('node:child_process').ChildProcess} child the receiver
 * @returns {Promise<void>} resolves once the app answers
 */
async function waitForApp(base, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the receiver exited early (status ${String(child.exitCode)})`);
    }
    try {
      const response = await fetch(`${base}/delivery-log`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // Not listening yet; keep waiting.
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error('the receiver did not start listening in time');
}

const bin = gateforgeBin();
const port = await freePort();
const appBase = `http://${LOOPBACK}:${String(port)}`;
const keyRing = createKeyRing();
// One secret for this run, shared by the receiver and the engine-side
// provider — generated here, never written into the repository.
const signingSecret = randomBytes(32).toString('base64');
const app = spawn(process.execPath, ['server.js', '--port', String(port)], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, WEBHOOK_SECRET: signingSecret },
});
// The engine refuses to grade an environment it cannot attest. The
// receiver is an ordinary app that does not stamp the marker itself, so
// the run goes through the pack's loopback attestation proxy — the same
// thing an operator wires for any real application.
const fingerprint = 'example-webhook-v1';
const proxy = await startAttestationProxy(appBase, fingerprint);
const base = proxy.url;

/**
 * Runs one gateforge subcommand and reports its status.
 *
 * Asynchronous on purpose: the attestation proxy lives in THIS process,
 * so a blocking child would stop the proxy from serving the witness that
 * the child itself starts.
 *
 * @param {string} label what the step proves
 * @param {string[]} args the subcommand
 * @returns {Promise<number>} the command's exit status
 */
function gate(label, args) {
  console.log(`gate: ${label}`);
  return new Promise((resolveGate) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        GATEFORGE_APP_BASE_URL: base,
        GATEFORGE_TARGET_BASE_URL: base,
        GATEFORGE_TARGET_FINGERPRINT: fingerprint,
        GATEFORGE_FIXTURE_PROVIDER: join(root, 'fixtures', 'fixture-provider.mjs'),
        GATEFORGE_WITNESS_VERIFIER_KEY_FILE: keyRing.file,
        WEBHOOK_SECRET: signingSecret,
      },
    });
    child.once('error', () => resolveGate(1));
    child.once('close', (code) => resolveGate(code ?? 1));
  });
}

let checkStatus = 1;
try {
  await waitForApp(base, app);
  console.log(`gate: receiver listening on ${base}`);
  await gate('tests discover', ['tests', 'discover']);
  const gatesStatus = await gate('test-gates --changed', ['test-gates', '--changed']);
  checkStatus = await gate('check --require-e2e', ['check', '--require-e2e']);
  if (checkStatus === 0 && gatesStatus !== 0) checkStatus = gatesStatus;
} catch (error) {
  console.log(`gate: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await proxy.stop();
  app.kill('SIGTERM');
  rmSync(keyRing.dir, { recursive: true, force: true });
}
console.log(checkStatus === 0 ? 'gate: green' : `gate: blocked (exit ${String(checkStatus)})`);
process.exit(checkStatus);
