/**
 * `gateforge enforcement doctor` (plan 2026-09-13 Phase 5 item 7): one
 * honest diagnostic surface for the enforcement boundary — hook
 * presence + ACTIVATION, runner readiness, observer capability, trusted
 * binary/policy ownership, snapshot mode, and the standard/managed mode
 * boundary. It is a diagnostic: exit 0 whenever it runs, with per-check
 * statuses (`ok`/`warn`/`fail`) and an overall readiness verdict.
 * Deterministic `--json`.
 *
 * Honesty rules (ADR 0005 D1):
 * - detecting a hook NEVER counts as managed protection. The
 *   `managed-guarantee` check states plainly that standard mode has no
 *   managed commit guarantee;
 * - in managed mode, an agent-writable authoritative `.git` is reported
 *   as `managed guarantees NOT active: authoritative repository is
 *   agent-writable` (a `fail` status);
 * - the broker surface reported here is the MECHANISM (`gateforge
 *   broker commit`), not a deployed service — reachability of an
 *   external broker is reported `warn`/`not configured` unless an
 *   operator-provided probe says otherwise.
 */
import { accessSync, constants as fsConstants, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { allCapabilities, canonicalJson, policyWeakenedCandidate, } from '@gate-forge/core';
import { parseArgs } from '../args.js';
import { trustedPolicyDigestForConfig } from '../execution.js';
import { UsageError } from '../errors.js';
import { writeLine } from '../io.js';
import { TEST_MAP_RELATIVE } from '../mapping.js';
import { inspectCommitHook } from '../git-hooks.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
import { resolveStateDir } from '../state.js';
import { describeApprovedPolicyResolution, resolveApprovedPolicyDigest } from '../trusted-policy.js';
export const ENFORCEMENT_USAGE = 'usage: gateforge enforcement doctor [--json]';
/**
 * Runs `git` with NUL/UTF-8 output; null on any failure (a doctor check
 * reports the failure class, it never throws).
 */
function probe(cwd, env, args) {
    const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
    if (result.error !== undefined || result.status !== 0)
        return null;
    return (result.stdout ?? '').trim();
}
/**
 * Cheap playwright readiness probe: package resolvable in the repo's
 * node_modules and a nonempty browser registry (default cache or
 * PLAYWRIGHT_BROWSERS_PATH). Never launches anything.
 *
 * Args:
 *   cwd: repository root.
 *
 * Returns:
 *   {status, detail}: ok / warn (no browsers) / fail (no package).
 */
function playwrightReadiness(cwd) {
    let packageJson = null;
    let cursor = resolve(cwd);
    // Walk up like Node resolution: the CLI may run from a workspace root.
    for (let depth = 0; depth < 6; depth += 1) {
        const candidate = join(cursor, 'node_modules', 'playwright', 'package.json');
        if (existsSync(candidate)) {
            packageJson = candidate;
            break;
        }
        const parent = resolve(cursor, '..');
        if (parent === cursor)
            break;
        cursor = parent;
    }
    if (packageJson === null) {
        return {
            status: 'fail',
            detail: 'playwright is not installed (no node_modules/playwright found from the repo root); the supervised E2E runner cannot execute',
        };
    }
    const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), '.cache', 'ms-playwright');
    let browsers = 'missing';
    try {
        const entries = readdirSafe(browsersPath);
        browsers = entries.length > 0 ? `installed (${String(entries.length)} entries)` : 'missing';
    }
    catch {
        browsers = 'missing';
    }
    if (browsers === 'missing') {
        return {
            status: 'warn',
            detail: `playwright installed; browsers NOT found under '${browsersPath}' — run \`npx playwright install\` before the supervised run`,
        };
    }
    return { status: 'ok', detail: `playwright installed; browsers ${browsers} under '${browsersPath}'` };
}
/** Safe directory listing (missing dir → empty). */
function readdirSafe(dir) {
    try {
        return readdirSync(dir);
    }
    catch {
        return [];
    }
}
/**
 * Builds the doctor report (all checks, honest statuses).
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   Promise<DoctorReport>: deterministic report.
 */
export async function buildDoctorReport(io) {
    const checks = [];
    // 0. Config (all later checks degrade honestly when it fails).
    let mode = 'standard';
    let strictE2E = false;
    let configOk = true;
    let configDetail = 'no .gateforge.yml — gateforge is not initialized in this repository';
    try {
        const config = loadConfigAt(io.cwd);
        mode = config.enforcement?.mode ?? 'standard';
        strictE2E = config.enforcement?.strictE2E === true;
        configOk = true;
        configDetail = `.gateforge.yml loaded (mode ${mode}, strictE2E ${String(strictE2E)})`;
    }
    catch (error) {
        configOk = false;
        configDetail = `.gateforge.yml could not be loaded: ${error.message.split('\n')[0] ?? 'unknown'}`;
    }
    checks.push({ id: 'config', status: configOk ? 'ok' : 'fail', detail: configDetail });
    // 1. Hook presence + ACTIVATION (never reported as managed protection).
    const hook = inspectCommitHook(io.cwd, io.env);
    checks.push({
        id: 'hook',
        status: hook.verifyOk ? 'ok' : hook.marker ? 'fail' : 'warn',
        detail: hook.detail,
    });
    // 2. Runner readiness (cheap probes only — nothing is launched).
    checks.push({ id: 'runner', ...playwrightReadiness(io.cwd) });
    // 3. Observer capability (Phase 0 capability registry; witness probe
    //    only when the caller wired GATEFORGE_WITNESS_URL).
    const capabilities = allCapabilities();
    const available = capabilities.filter((capability) => capability.availability.status === 'available');
    const unavailable = capabilities.filter((capability) => capability.availability.status !== 'available');
    let observerDetail = capabilities.length === 0
        ? 'no capability records registered (the engine graded no contracts in this process)'
        : `capability registry: ${String(available.length)} available namespace(s) [${available
            .map((capability) => capability.namespace)
            .join(', ')}], ${String(unavailable.length)} fail-closed [${unavailable
            .map((capability) => capability.namespace)
            .join(', ')}]`;
    const witnessUrl = io.env['GATEFORGE_WITNESS_URL'];
    if (witnessUrl !== undefined && witnessUrl.length > 0) {
        observerDetail += `; witness '${witnessUrl}' configured — reachability probed at gate time (not launched by the doctor)`;
    }
    else {
        observerDetail += '; no external witness configured (the supervised run spawns a loopback witness)';
    }
    checks.push({ id: 'observer', status: 'ok', detail: observerDetail });
    // 4. Trusted binary/policy ownership.
    const binaryPath = process.argv[1] ?? '(unknown)';
    const resolvedBinary = resolve(binaryPath);
    const repoRoot = resolve(io.cwd);
    const binaryOrigin = resolvedBinary.startsWith(`${repoRoot}/`) ? 'repo-local' : 'external (PATH/global)';
    let policyDetail;
    let policyStatus;
    if (!configOk) {
        policyDetail = 'trusted policy digest not computed (config failed to load)';
        policyStatus = 'fail';
    }
    else {
        try {
            const config = loadConfigAt(io.cwd);
            const digest = trustedPolicyDigestForConfig(io.cwd, config);
            // Honest approved-policy surface (review 2026-09-13 P1 #5): the
            // candidate digest alone proves which revision ran, never that the
            // owner approved it. Report absence/mismatch plainly.
            const resolution = resolveApprovedPolicyDigest({
                env: io.env,
                candidateCwd: io.cwd,
                candidateConfig: config,
            });
            let matchNote = '';
            if (resolution.status === 'ok' && resolution.digest !== null) {
                matchNote = policyWeakenedCandidate(resolution.digest, digest).weakened
                    ? ' — MISMATCHES the candidate policy revision (strict gates will block)'
                    : ' — matches the candidate policy revision';
            }
            policyDetail =
                `trusted policy digest present (${digest.slice(0, 12)}…); gateforge binary: ${binaryPath} (${binaryOrigin}); ` +
                    `${describeApprovedPolicyResolution(resolution)}${matchNote}`;
            policyStatus = 'ok';
        }
        catch (error) {
            policyDetail = `trusted policy digest computation failed: ${error.message.split('\n')[0] ?? 'unknown'}`;
            policyStatus = 'fail';
        }
    }
    checks.push({ id: 'trusted-binary-policy', status: policyStatus, detail: policyDetail });
    // 5. Snapshot mode (inventory availability decides evidence binding).
    const inventory = probe(io.cwd, io.env, ['ls-files', '--stage', '-z']);
    checks.push({
        id: 'snapshot',
        status: inventory === null ? 'fail' : 'ok',
        detail: inventory === null
            ? 'snapshot mode: unavailable (no usable Git inventory) — evidence authorization fails closed'
            : 'snapshot mode: git-inventory (tracked + nonignored untracked bytes hashed into the input digest)',
    });
    // 6. Enforcement mode + the honest managed boundary.
    checks.push({
        id: 'enforcement-mode',
        status: 'ok',
        detail: mode === 'managed'
            ? 'enforcement mode: managed — commits go through `gateforge broker commit` (CAS ref update against a verified receipt)'
            : 'enforcement mode: standard — active local hook + mandatory trusted server check',
    });
    if (mode === 'managed') {
        const gitDir = probe(io.cwd, io.env, ['rev-parse', '--absolute-git-dir']);
        let agentWritable = true;
        let boundaryDetail = 'the authoritative Git directory could not be resolved';
        if (gitDir !== null && gitDir.length > 0) {
            try {
                accessSync(gitDir, fsConstants.W_OK);
                agentWritable = true;
                boundaryDetail = `authoritative Git directory '${gitDir}' is writable by the current user`;
            }
            catch {
                agentWritable = false;
                boundaryDetail = `authoritative Git directory '${gitDir}' is NOT writable by the current user`;
            }
        }
        checks.push({
            id: 'managed-guarantee',
            status: agentWritable ? 'fail' : 'ok',
            detail: agentWritable
                ? `managed guarantees NOT active: authoritative repository is agent-writable (${boundaryDetail}). ` +
                    'The broker mechanism exists (`gateforge broker commit`) but the deployment boundary does not.'
                : `managed boundary plausible: ${boundaryDetail}; the broker deployment must ALSO keep the engine, policy authority, and verifier key outside the agent's process boundary`,
        });
    }
    else {
        checks.push({
            id: 'managed-guarantee',
            status: 'warn',
            detail: 'managed guarantees NOT active: standard mode detects a local hook at most — ' +
                '`--no-verify`, an alternate core.hooksPath, direct plumbing, or an unrelated clone bypass it (ADR 0005 D1)',
        });
    }
    return {
        mode,
        strictE2E,
        checks: [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        ready: checks.every((check) => check.status !== 'fail'),
    };
}
/**
 * Runs the `enforcement doctor` subcommand (plan Phase 5 item 7).
 *
 * Args:
 *   io: process context.
 *   argv: flags after `enforcement`.
 *
 * Returns:
 *   Promise<number>: always 0 when the doctor runs (diagnostic);
 *   2 for usage errors.
 */
export async function enforcementCommand(io, argv) {
    const { options, positionals } = parseArgs(argv);
    const sub = positionals[0];
    if (sub === undefined || sub !== 'doctor') {
        throw new UsageError(`unknown enforcement subcommand '${sub ?? '(none)'}' (only 'doctor' exists)`);
    }
    if (options['help'] === true) {
        writeLine(io.stdout, ENFORCEMENT_USAGE);
        return 0;
    }
    rejectUnknownFlags(options, ['json', 'help'], ENFORCEMENT_USAGE);
    const report = await buildDoctorReport(io);
    if (options['json'] === true) {
        writeLine(io.stdout, canonicalJson(report));
        return 0;
    }
    writeLine(io.stdout, `gateforge enforcement doctor (mode ${report.mode}, strictE2E ${String(report.strictE2E)})`);
    for (const check of report.checks) {
        writeLine(io.stdout, `  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`);
    }
    writeLine(io.stdout, `overall: ${report.ready ? 'ready (no failing checks)' : 'NOT ready (failing checks above)'} — diagnostic only; exit 0 either way`);
    return 0;
}
//# sourceMappingURL=enforcement.js.map