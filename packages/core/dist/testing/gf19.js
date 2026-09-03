/**
 * GF-19 harness rule (fixture harness, G7): a malformed source file must
 * surface as a `PARSE_ERROR` finding with a line number, must never crash
 * the run, and must never contribute silent resources.
 *
 * The rule is detector-agnostic: a detector hands the harness its output
 * plus a per-file parse audit ({@link ParseAudit}); the rule guarantees
 * the finding exists (synthesizing it when the detector failed to emit
 * one), strips resources sourced from malformed files, and records every
 * detector misbehavior as an explicit violation. G5's SQLAlchemy detector
 * reuses this rule with its real audit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { compareStrings } from '../graph/index.js';
import { GATEFORGE_SCHEMA_VERSION } from '../schemas/common.js';
/** The canonical finding code for malformed source files. */
export const PARSE_ERROR_FINDING = 'PARSE_ERROR';
/**
 * Normalizes a detector-supplied path for audit comparisons: posix
 * separators, no leading `./`.
 *
 * Args:
 *   raw: detector-supplied path.
 *
 * Returns:
 *   string: canonical comparison key.
 */
function normalizePath(raw) {
    let path = raw.split('\\').join('/');
    while (path.startsWith('./')) {
        path = path.slice(2);
    }
    return path;
}
/**
 * Applies the GF-19 rule to one detector contribution.
 *
 * Args:
 *   input: detector identity, parse audit, and raw output.
 *
 * Returns:
 *   ParseErrorRuleResult: guaranteed findings, vetted resources, and the
 *   detector's violations (empty when the detector behaved).
 */
export function applyParseErrorRule(input) {
    const violations = [];
    const malformed = new Map();
    for (const entry of input.audit) {
        if (entry.ok)
            continue;
        let line = entry.line ?? 0;
        if (!Number.isInteger(line) || line < 1) {
            violations.push(`parse audit for '${entry.file}' lacks a valid 1-based line; failing closed at line 1`);
            line = 1;
        }
        malformed.set(normalizePath(entry.file), {
            line,
            detail: entry.detail ?? `file failed to parse: ${entry.file}`,
        });
    }
    const findings = input.output.findings.map((finding) => ({
        ...finding,
        detectorId: input.detectorId,
    }));
    const parseErrors = [];
    for (const [file, malformedAt] of malformed) {
        const existing = findings.find((finding) => finding.code === PARSE_ERROR_FINDING &&
            finding.locations.some((location) => location.file === file && location.line === malformedAt.line));
        if (existing !== undefined) {
            parseErrors.push(existing);
            continue;
        }
        const synthesized = {
            code: PARSE_ERROR_FINDING,
            detail: malformedAt.detail,
            locations: [{ file, line: malformedAt.line, col: 0 }],
            detectorId: input.detectorId,
        };
        findings.push(synthesized);
        parseErrors.push(synthesized);
        violations.push(`detector emitted no ${PARSE_ERROR_FINDING} finding for '${file}'; the harness rule synthesized it`);
    }
    const resources = [];
    for (const resource of input.output.resources) {
        if (malformed.has(normalizePath(resource.source))) {
            violations.push(`dropped silent resource '${resource.id}' sourced from malformed file '${resource.source}'`);
            continue;
        }
        resources.push(resource);
    }
    findings.sort((a, b) => {
        const byCode = compareStrings(a.code, b.code);
        if (byCode !== 0)
            return byCode;
        const firstA = a.locations[0];
        const firstB = b.locations[0];
        if (firstA === undefined)
            return -1;
        if (firstB === undefined)
            return 1;
        return compareStrings(`${firstA.file}:${firstA.line}`, `${firstB.file}:${firstB.line}`);
    });
    return { findings, parseErrors, resources, violations };
}
/**
 * Whether a finding list contains at least one `PARSE_ERROR` — the
 * fail-closed signal that a source file could not be read.
 *
 * Args:
 *   findings: graph or rule findings.
 *
 * Returns:
 *   boolean: true when malformed source is in play.
 */
export function hasParseErrors(findings) {
    return findings.some((finding) => finding.code === PARSE_ERROR_FINDING);
}
/**
 * The toy declaration grammar the stub detector parses: blank lines,
 * `# comments`, and `name = value` declarations. Anything else is a
 * syntax error at that line.
 */
const STUB_DECLARATION = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S.*$/;
/**
 * Sorted directory entry names of a directory.
 *
 * Args:
 *   absolute: absolute directory path.
 *
 * Returns:
 *   string[]: entry names, codepoint-sorted.
 */
function readdirSorted(absolute) {
    return readdirSync(absolute).sort(compareStrings);
}
/**
 * Directory check that never throws on missing paths.
 *
 * Args:
 *   absolute: candidate path.
 *
 * Returns:
 *   boolean: true when the path is an existing directory.
 */
function isDirectory(absolute) {
    try {
        return statSync(absolute).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * Reads a UTF-8 file, failing loud with path context on error.
 *
 * Args:
 *   absolute: file path.
 *
 * Returns:
 *   string: file content.
 */
function readTextFile(absolute) {
    return readFileSync(absolute, 'utf8');
}
/**
 * Lists candidate source files under a repository root, deterministically
 * sorted, skipping `.git` and `.gateforge` trees.
 *
 * Args:
 *   root: absolute repository root.
 *   suffixes: optional suffix filter.
 *
 * Returns:
 *   string[]: repo-root-relative posix paths.
 */
function listSourceFiles(root, suffixes) {
    const files = [];
    const visit = (absolute, relative) => {
        for (const entry of readdirSorted(absolute)) {
            if (entry === '.git' || entry === '.gateforge')
                continue;
            const childRelative = relative === '' ? entry : `${relative}/${entry}`;
            const childAbsolute = `${absolute}/${entry}`;
            if (isDirectory(childAbsolute)) {
                visit(childAbsolute, childRelative);
                continue;
            }
            if (suffixes !== undefined && !suffixes.some((suffix) => entry.endsWith(suffix))) {
                continue;
            }
            files.push(childRelative);
        }
    };
    visit(root, '');
    files.sort(compareStrings);
    return files;
}
/**
 * Detects resources in a fixture repository with a deliberately trivial
 * in-process parser: every top-level `name = value` line becomes a
 * resource (`kind: 'stub.declaration'`, `resourceName` attribute), any
 * other non-comment/non-blank line is a syntax error, and a file with a
 * syntax error yields a `PARSE_ERROR` finding at that line and no
 * resources. Malformed files never crash the scan.
 *
 * Args:
 *   repo: the fixture repository to scan.
 *   options: detector identity and optional suffix filter.
 *
 * Returns:
 *   StubDetectorResult: discovery output plus the parse audit for the
 *   GF-19 rule.
 */
export function stubDetector(repo, options = {}) {
    const detectorId = options.id ?? 'gateforge.stub-detector';
    const detectorVersion = options.version ?? '0.0.0';
    const resources = [];
    const findings = [];
    const audit = [];
    for (const relative of listSourceFiles(repo.root, options.suffixes)) {
        const text = readTextFile(`${repo.root}/${relative}`);
        const lines = text.split(/\r?\n/);
        // Resources are buffered per file: a file with ANY syntax error
        // contributes zero resources (GF-19 — a partial parse can't be
        // trusted, so nothing from a malformed file may leak through).
        const fileResources = [];
        let errorLine = 0;
        let errorText = '';
        for (let index = 0; index < lines.length; index += 1) {
            const rawLine = lines[index] ?? '';
            const trimmed = rawLine.trim();
            if (trimmed === '' || trimmed.startsWith('#'))
                continue;
            const match = STUB_DECLARATION.exec(trimmed);
            if (match === null) {
                errorLine = index + 1;
                errorText = trimmed;
                break;
            }
            const name = match[1];
            if (name === undefined) {
                errorLine = index + 1;
                errorText = trimmed;
                break;
            }
            fileResources.push({
                schemaVersion: GATEFORGE_SCHEMA_VERSION,
                id: name,
                kind: 'stub.declaration',
                source: relative,
                location: { file: relative, line: index + 1, col: 0 },
                detectorVersion,
                attributes: { resourceName: name },
            });
        }
        if (errorLine === 0) {
            resources.push(...fileResources);
            audit.push({ file: relative, ok: true });
        }
        else {
            const detail = `stub parse error in '${relative}' at line ${errorLine}: ${JSON.stringify(errorText)}`;
            findings.push({
                code: PARSE_ERROR_FINDING,
                detail,
                locations: [{ file: relative, line: errorLine, col: 0 }],
            });
            audit.push({ file: relative, ok: false, line: errorLine, detail });
        }
    }
    return {
        output: {
            detectorId,
            detectorVersion,
            resources,
            unresolved: [],
            findings,
            classificationSignals: [],
        },
        audit,
    };
}
//# sourceMappingURL=gf19.js.map