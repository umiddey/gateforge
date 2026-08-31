/**
 * `gateforge discover`: run every configured detector over the expanded
 * include paths and dump the built resource graph.
 *
 * `--json` prints the GF-canonical JSON of the graph (deterministic,
 * snapshot-able); the default text form lists resources, unresolved
 * entries, findings, and stale references. The command never gates —
 * it is the introspection half of the pipeline.
 */
import { canonicalJson } from '@gateforge/core';
import { parseArgs } from '../args.js';
import { writeLine } from '../io.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
export const DISCOVER_USAGE = 'usage: gateforge discover [--json]';
/**
 * Runs the discover subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code (0 on success).
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function discoverCommand(io, argv) {
    const { options } = parseArgs(argv);
    if (options['help'] === true) {
        writeLine(io.stdout, DISCOVER_USAGE);
        return 0;
    }
    rejectUnknownFlags(options, ['json', 'help'], DISCOVER_USAGE);
    const asJson = options['json'] === true;
    const config = loadConfigAt(io.cwd);
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir: resolveStateDir(io.cwd),
    });
    if (asJson) {
        writeLine(io.stdout, canonicalJson(pipeline.graph));
        return 0;
    }
    const graph = pipeline.graph;
    writeLine(io.stdout, `resources (${graph.resources.length}):`);
    for (const resource of graph.resources) {
        const id = resource.id ?? `<unclassified:${resource.name}>`;
        writeLine(io.stdout, `  ${id} [${resource.kind}] ${resource.source}:${resource.location.line}` +
            (resource.exposure !== null ? ` (${resource.exposure})` : ''));
    }
    writeLine(io.stdout, `unresolved (${graph.unresolved.length}):`);
    for (const entry of graph.unresolved) {
        const where = `${entry.reason.location.file}:${entry.reason.location.line}`;
        writeLine(io.stdout, `  [${entry.reason.code}] ${where} — ${entry.reason.detail}`);
    }
    writeLine(io.stdout, `findings (${graph.findings.length}):`);
    for (const finding of graph.findings) {
        const where = finding.locations
            .map((location) => `${location.file}:${location.line}`)
            .join(', ');
        writeLine(io.stdout, `  [${finding.code}] ${where} — ${finding.detail}`);
    }
    writeLine(io.stdout, `stale references (${graph.stale.length}):`);
    for (const stale of graph.stale) {
        writeLine(io.stdout, `  <${stale.kind}> ${stale.reference} — ${stale.detail}`);
    }
    return 0;
}
//# sourceMappingURL=discover.js.map