/**
 * Playwright global setup/teardown for gateforge runs (deterministic
 * witness wiring, no races).
 *
 * `globalSetup` runs in the runner's MAIN process and COMPLETES before
 * any worker spawns, so the spawned witness URL is known before the
 * first test can post evidence. Two channels reach the fixtures:
 * `GATEFORGE_WITNESS_URL` in the process env (inherited by workers) and
 * `witness-url.json` in the run-state dir (a file fallback).
 *
 * When `GATEFORGE_WITNESS_URL` is already set (`gateforge test-gates
 * --witness-url <url>`) the setup does nothing — the caller's witness
 * is authoritative. Without a run-state dir + token (a standalone
 * playwright run outside test-gates) the setup logs a warning and skips
 * fail-closed wiring: evidence primitives then fail tests with an
 * actionable error instead of silently degrading.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_RUN_ID, ENV_RUN_TOKEN, ENV_STATE_DIR, ENV_WITNESS_URL, WITNESS_URL_FILE, } from './constants.js';
/** The child witness process started by globalSetup (teardown kills it). */
let spawned = null;
/** In-progress spawn (avoids double-start in watch mode). */
let pending = null;
/**
 * Starts the witness service as a child process and waits for it to
 * answer `/health`.
 *
 * Args:
 *   env: environment for the child (must carry GATEFORGE_RUN_ID /
 *     GATEFORGE_RUN_TOKEN; the witness derivations are documented in the
 *     pack README).
 *   timeoutMs: startup timeout.
 *
 * Returns:
 *   {child, url}: running child + its loopback URL.
 *
 * Throws:
 *   Error: when the child exits early or never becomes ready.
 */
export async function startWitnessProcess(env, timeoutMs = 15000) {
    const bin = fileURLToPath(new URL('../../bin/gateforge-witness.js', import.meta.url));
    const child = spawn(process.execPath, [bin], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const urlPromise = new Promise((resolveUrl, rejectUrl) => {
        let stdout = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectUrl(new Error('witness child did not report its URL in time'));
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            const match = /^GATEFORGE_WITNESS_URL=(.+)$/m.exec(stdout);
            if (match !== null) {
                clearTimeout(timer);
                resolveUrl(match[1]);
            }
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            rejectUrl(new Error(`witness child failed to start: ${error.message}`));
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                rejectUrl(new Error(`witness child exited early (code ${String(code)}): ${stdout.slice(0, 500)}`));
            }
        });
    });
    const url = await urlPromise;
    await waitForHealth(url, env[ENV_RUN_TOKEN] ?? '', timeoutMs);
    return { child, url };
}
/** Polls the witness health endpoint until ready (or timeout). */
async function waitForHealth(url, token, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(`${url}/health`, {
                headers: { 'x-gateforge-run': token },
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok)
                return;
        }
        catch {
            // not ready yet
        }
        if (Date.now() > deadline) {
            throw new Error(`witness at ${url} did not become healthy in time`);
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
}
/**
 * Playwright `globalSetup`: spawn the witness when the run has a state
 * dir + token and no external witness URL is configured.
 */
export async function gateforgeGlobalSetup() {
    const token = process.env[ENV_RUN_TOKEN];
    const stateDir = process.env[ENV_STATE_DIR];
    const runId = process.env[ENV_RUN_ID];
    const existing = process.env[ENV_WITNESS_URL];
    if (existing !== undefined && existing !== '') {
        return; // caller-wired witness (--witness-url) is authoritative
    }
    if (token === undefined || token === '' || stateDir === undefined || stateDir === '') {
        console.warn('[gateforge] no run state wired (GATEFORGE_STATE_DIR/GATEFORGE_RUN_TOKEN): ' +
            'reporter will not write claims/records and evidence primitives will fail closed');
        return;
    }
    pending ??= startWitnessProcess({
        GATEFORGE_RUN_ID: runId ?? '',
        GATEFORGE_RUN_TOKEN: token,
        GATEFORGE_STATE_DIR: stateDir,
    }).then((handle) => {
        spawned = handle;
        return handle;
    });
    const handle = await pending;
    process.env[ENV_WITNESS_URL] = handle.url;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, WITNESS_URL_FILE), `${JSON.stringify({ url: handle.url })}\n`, 'utf8');
}
/** Playwright `globalTeardown`: stop the spawned witness. */
export async function gateforgeGlobalTeardown() {
    const handle = spawned;
    spawned = null;
    pending = null;
    if (handle !== null) {
        handle.child.kill('SIGTERM');
        // A short grace period lets the witness append its recordIds to the
        // run manifest before the runner reports completion.
        await new Promise((resolveWait) => {
            const timer = setTimeout(() => {
                handle.child.kill('SIGKILL');
                resolveWait();
            }, 2000);
            handle.child.once('exit', () => {
                clearTimeout(timer);
                resolveWait();
            });
        });
    }
}
//# sourceMappingURL=setup.js.map