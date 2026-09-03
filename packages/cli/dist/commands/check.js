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
import { renderRun, runExitCode } from '@gateforge/core';
import { parseArgs, stringFlag } from '../args.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import { runPipeline } from '../pipeline.js';
import { resolveProvider } from '../providers.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, parseRunFormat, rejectUnknownFlags, VERIFIER_KEY_ENV, VERSION } from './common.js';
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
    });
    const report = renderRun(evaluated.verdicts, {
        format,
        blocking: evaluated.blocking,
        waiverCounts: evaluated.waiverCounts,
        run: pipeline.manifest,
        toolVersion: VERSION,
    });
    writeLine(io.stdout, report);
    return runExitCode({ verdicts: evaluated.verdicts, blocking: evaluated.blocking });
}
//# sourceMappingURL=check.js.map