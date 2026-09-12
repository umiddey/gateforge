/**
 * `gateforge check`: the full gate — discover → obligations → claims →
 * verdicts → report, with exit codes per architecture contract 4
 * (0 clean/waived, 1 unresolved, 2 config/usage).
 *
 * `--changed` restricts the gate to changed files: the resolved diff
 * provider (pin #5) picks the changed set, and only obligations whose
 * resource source file changed (plus blocking entries pointing at
 * changed files) are evaluated. The provider identity lands in the run
 * manifest, so a run's report states exactly which diff basis it used
 * (GF-09: local-staged, github-pr, and gitlab-mr produce identical
 * resource-change sets for identical repos).
 *
 * Claims and records come from the run-state directory
 * (`.gateforge/test-gates/` by default) — the same surface the
 * `test-gates` suite contract writes.
 */
import { loadAdoptionRecord, loadBaseline, renderRun, runExitCode, ADOPTION_RECORD_FILENAME, } from '@gateforge/core';
import { dirname, join } from 'node:path';
import { parseArgs, stringFlag } from '../args.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import { runPipeline, resolveRepoPath } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { resolveProvider } from '../providers.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';
import { renderEndpointInventory } from '../endpoint-report.js';
/**
 * Resolves the adopted-baseline forgiveness set for this repo (phase 8 C).
 *
 * Fail-closed semantics:
 * - NO adoption record (the normal pre-adoption state) → nothing is
 *   forgiven, even if a baseline file exists: an unrecorded bulk-add is
 *   unsanctioned and forgives nothing.
 * - Record present but baseline missing/corrupt → throws (exit 2): the
 *   receipt without the document it sanctions is a broken adoption.
 * - Record present and baseline valid → the recorded fingerprint set,
 *   plus the classification layer (two-layer adoption) when the receipt
 *   carries it. A pre-layer receipt (no `classificationBlocked` field) is
 *   simply NOT ADOPTED for that layer — nothing classification-shaped is
 *   waived without the recorded set (fail closed, backward compatible).
 */
export function resolveAdoptedBaseline(cwd, baselinesPath) {
    const baselinePath = resolveRepoPath(cwd, baselinesPath);
    const adoption = loadAdoptionRecord(join(dirname(baselinePath), ADOPTION_RECORD_FILENAME));
    if (adoption === null)
        return null;
    return {
        fingerprints: new Set(loadBaseline(baselinePath).fingerprints),
        classificationBlocked: adoption.classificationBlocked !== undefined
            ? new Set(adoption.classificationBlocked)
            : undefined,
    };
}
export const CHECK_USAGE = 'usage: gateforge check [--changed] [--format text|json|sarif]';
/**
 * Runs the check subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean/waived, 1 unresolved, 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function checkCommand(io, argv) {
    const { options } = parseArgs(argv);
    if (options['help'] === true) {
        writeLine(io.stdout, CHECK_USAGE);
        return 0;
    }
    rejectUnknownFlags(options, ['changed', 'format', 'help'], CHECK_USAGE);
    const format = parseRunFormat(stringFlag(options, 'format') ?? 'text');
    const diffScoped = options['changed'] === true;
    // Witness verifier key (GF-23, audit round 3): read from the
    // environment — never argv, whose cmdline is world-readable. With the
    // key, the manifest's `recordIds` + `recordIdsMac` can be
    // authenticated; without it, no suite-writable artifact can prove
    // issuance and the provenance gate fails closed.
    const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];
    const config = loadConfigAt(io.cwd);
    const providerIdentity = diffScoped ? resolveProvider(config.changed.provider, io.cwd, io.env).provider : 'all-files';
    const stateDir = resolveStateDir(io.cwd);
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: providerIdentity,
        stateDir,
    });
    const evaluated = evaluateRun({
        cwd: io.cwd,
        config,
        graph: pipeline.graph,
        obligations: pipeline.policy.obligations,
        blocking: pipeline.policy.blocking,
        stateDir,
        now: pipeline.now,
        changedFiles: diffScoped ? pipeline.changedFiles : null,
        witnessVerifierKey,
        baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
    });
    const report = renderRun(evaluated.verdicts, {
        format,
        blocking: evaluated.blocking,
        waiverCounts: evaluated.waiverCounts,
        baseline: evaluated.baselined ?? undefined,
        run: pipeline.manifest,
        toolVersion: VERSION,
    });
    if (format === 'text') {
        // Plan phase 7: the endpoint inventory rides the text report —
        // totals, unmatched calls, unconsumed routes, and ambiguous joins
        // are visible on every check, never hidden behind a flag.
        writeLine(io.stdout, '');
        writeLine(io.stdout, renderEndpointInventory(pipeline.endpointInventory));
        writeLine(io.stdout, '');
        writeLine(io.stdout, 'remediation: each blocking entry names its code, cause, and source location; ' +
            'for endpoint obligations the accepted evidence is a witnessed proxy observation ' +
            'plus a provenanced claimed ui anchor (see ADR 0004 D7/D8).');
    }
    writeLine(io.stdout, report);
    return runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
}
//# sourceMappingURL=check.js.map