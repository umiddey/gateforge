/**
 * `gateforge classify`: run detectors + the deterministic classifier and
 * report every resource's effective classification and typed blocks.
 *
 * `--json` prints the GF-canonical JSON of the classification result
 * (decisions with traces, stale/invalid signals) plus the derived
 * effective-classification view; the default text form renders one
 * decision per resource: exposure/plane/primaryKey/rules/defaults plus
 * every typed block with its locations. `--write-snapshot <path>` writes
 * the derived effective-classification view document for review — the
 * pipeline NEVER reads it back as input (ADR 0003 D5).
 *
 * `classify` and `check` share the identical pipeline, so their
 * effective decisions agree byte-for-byte (phase-5 checklist).
 */
import { writeFileSync } from 'node:fs';
import { canonicalJson } from '@gateforge/core';
import { stringify as stringifyYaml } from 'yaml';
import { parseArgs, stringFlag } from '../args.js';
import { writeLine } from '../io.js';
import { runPipeline } from '../pipeline.js';
import { resolveStateDir } from '../state.js';
import { loadConfigAt, rejectUnknownFlags } from './common.js';
export const CLASSIFY_USAGE = 'usage: gateforge classify [--json] [--write-snapshot <path>]';
/** Renders the text form of one classification pass. */
function describeResult(io, pipeline) {
    const { graph, classification } = pipeline;
    writeLine(io.stdout, `decisions (${String(classification.decisions.length)}):`);
    for (const resource of graph.resources) {
        const id = resource.id ?? `<unresolved:${resource.name}>`;
        const classificationEntry = resource.classification;
        const trace = resource.classificationTrace;
        writeLine(io.stdout, `  ${id} [${resource.kind}] ${resource.source}:${String(resource.location.line)}`);
        if (classificationEntry === null || trace === null) {
            writeLine(io.stdout, '    classification: BLOCKED (see blocks below)');
            continue;
        }
        writeLine(io.stdout, `    exposure: ${String(classificationEntry.exposure)}  plane: ${String(classificationEntry.plane)}  ` +
            `primaryKey: [${classificationEntry.primaryKey.join(', ')}]` +
            (classificationEntry.evidenceAdapter !== undefined
                ? `  adapter: ${classificationEntry.evidenceAdapter}`
                : ''));
        writeLine(io.stdout, `    lifecycle: create=${String(classificationEntry.lifecycle.create)} read=${String(classificationEntry.lifecycle.read)} ` +
            `update=${String(classificationEntry.lifecycle.update)} delete=${String(classificationEntry.lifecycle.delete)}` +
            (classificationEntry.lifecycle.deleteSemantics !== undefined
                ? ` (${classificationEntry.lifecycle.deleteSemantics})`
                : ' (semantics UNRESOLVED)'));
        writeLine(io.stdout, `    rules: ${trace.rules.join(', ')}`);
        if (trace.defaultsApplied.length > 0) {
            writeLine(io.stdout, `    defaults: ${trace.defaultsApplied.join(', ')}`);
        }
        if (trace.contradictions.length > 0) {
            for (const contradiction of trace.contradictions) {
                writeLine(io.stdout, `    contradiction [${contradiction.dimension}]: ${contradiction.detail}`);
            }
        }
        writeLine(io.stdout, `    fingerprint: ${trace.decisionFingerprint}  signals: ${String(trace.contributingSignalIds.length)}`);
    }
    const blockCount = classification.decisions.reduce((sum, decision) => sum + decision.blocks.length, 0) +
        classification.staleTargets.length +
        classification.invalidSignals.length +
        classification.unauthorizedSuppressive.length;
    writeLine(io.stdout, `blocks (${String(blockCount)}):`);
    for (const decision of classification.decisions) {
        for (const block of decision.blocks) {
            const where = block.locations
                .map((location) => `${location.file}:${String(location.line)}`)
                .join(', ');
            writeLine(io.stdout, `  [${block.code}] ${decision.resourceId ?? decision.name} — ${block.detail}` +
                (where.length > 0 ? ` (${where})` : ''));
        }
    }
    for (const stale of classification.staleTargets) {
        writeLine(io.stdout, `  [${stale.code}] ${stale.detail}`);
    }
    for (const invalid of classification.invalidSignals) {
        writeLine(io.stdout, `  [${invalid.code}] ${invalid.detail}`);
    }
    for (const unauthorized of classification.unauthorizedSuppressive) {
        writeLine(io.stdout, `  [${unauthorized.code}] ${unauthorized.detail}`);
    }
}
/**
 * Runs the classify subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 when every decision is block-free, 1 when any
 *   typed classification block exists (fail visible), 2 config/usage.
 * @throws fail-closed errors (exit 2) from config/plugin/pipeline layers.
 */
export async function classifyCommand(io, argv) {
    const { options } = parseArgs(argv);
    if (options['help'] === true) {
        writeLine(io.stdout, CLASSIFY_USAGE);
        return 0;
    }
    rejectUnknownFlags(options, ['json', 'write-snapshot', 'help'], CLASSIFY_USAGE);
    const asJson = options['json'] === true;
    const snapshot = stringFlag(options, 'write-snapshot');
    const config = loadConfigAt(io.cwd);
    const pipeline = await runPipeline({
        cwd: io.cwd,
        env: io.env,
        config,
        provider: 'all-files',
        stateDir: resolveStateDir(io.cwd),
    });
    if (asJson) {
        writeLine(io.stdout, canonicalJson({
            schemaVersion: 1,
            classification: pipeline.classification,
            classifications: pipeline.classificationsView,
        }));
    }
    else {
        describeResult(io, pipeline);
    }
    if (snapshot !== undefined) {
        writeFileSync(snapshot, stringifyYaml(pipeline.classificationsView), 'utf8');
        writeLine(io.stdout, `snapshot written (derived artifact, never authoritative input): ${snapshot}`);
    }
    const blocked = pipeline.policy.blocking.filter((entry) => entry.kind === 'classification' || entry.kind === 'unclassified');
    return blocked.length > 0 ? 1 : 0;
}
//# sourceMappingURL=classify.js.map