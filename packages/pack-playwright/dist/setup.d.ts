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
import { type ChildProcess } from 'node:child_process';
/**
 * Starts the witness service as a child process and waits for it to
 * answer `/health`.
 *
 * Args:
 *   env: environment for the child (must carry GATEFORGE_RUN_ID /
 *     GATEFORGE_RUN_TOKEN; the witness derivations are documented in the
 *     pack README). GATEFORGE_PROXY_TARGET / GATEFORGE_MOUNT_PATH start
 *     the observation proxy (see the `gateforge-witness --help` surface).
 *   timeoutMs: startup timeout.
 *
 * Returns:
 *   {child, url, proxyUrl}: running child, its loopback URL, and the
 *   observation-proxy URL when one is active (null otherwise).
 *
 * Throws:
 *   Error: when the child exits early or never becomes ready.
 */
export declare function startWitnessProcess(env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<{
    child: ChildProcess;
    url: string;
    proxyUrl: string | null;
}>;
/**
 * Playwright `globalSetup`: spawn the witness when the run has a state
 * dir + token and no external witness URL is configured.
 */
export declare function gateforgeGlobalSetup(): Promise<void>;
/** Playwright `globalTeardown`: stop the spawned witness. */
export declare function gateforgeGlobalTeardown(): Promise<void>;
//# sourceMappingURL=setup.d.ts.map