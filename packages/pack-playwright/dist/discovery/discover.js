/**
 * Catalog orchestration (plan 2026-09-13 phase 2 item 1): builds the
 * validated {@link TestCatalog} from the static scan, the native
 * playwright reconciliation, kind/category inference, and the configured
 * pytest diagnostic suites.
 *
 * Invariants enforced here (fail closed as DATA, never silence):
 * - every statically detected call, unresolved gap, and parse error is a
 *   catalog row — a failed scan never reads as "no tests";
 * - reconciliation is STATIC-FIRST with a native fallback: a case the
 *   static scan derived (and the native list confirmed) is `matched`
 *   with origin `'static'`; a case ONLY the native runner enumerated is
 *   still a DISCOVERED row (origin `'native-list'`, reconciliation
 *   `list-only`) — the runner proved it exists and will execute it —
 *   while a case ONLY the static scan found stays `static-only` and
 *   unresolved (the runner cannot execute what it never enumerated);
 * - `inventoryComplete` is true only when every enabled enumeration
 *   step ran clean (parse errors, budget cuts, unresolved static-only
 *   rows, native reporter errors, and failed pytest collection all make
 *   it false);
 * - the final document passes the strict core schema (duplicate logical
 *   keys are typed errors listing both sources).
 *
 * Output ordering is deterministic: entries sort by (file, titlePath,
 * project); unresolved/parse errors sort by location.
 */
import { join } from 'node:path';
import { canonicalJson, deriveLogicalKey, TestCatalogSchema, } from '@gate-forge/core';
import { inferTestKind } from './inference.js';
import { collectPytestSuite, repoRelative, } from './pytest-adapter.js';
import { fileDigest, listNativePlaywrightTests, reconciliationKey, } from './reconcile.js';
import { scanTestFiles, UNRESOLVED_TITLE_PLACEHOLDER, } from './static-discovery.js';
/**
 * Runs discovery + reconciliation and returns the validated catalog.
 *
 * Pytest suites (plan §3.5) are registered-but-diagnostic-only by
 * default: they appear in `runnerSummaries` with status `registered`
 * (their configured identities, no execution, no collection). With
 * `collectPytest: true` (CLI `--pytest`), the adapter runs the
 * configured argv with `--collect-only -q` and adds one entry per
 * collected node id; diagnostic EXECUTION remains Phase 4 work.
 *
 * Args:
 *   options: cwd, config, optional pytest collection + timeouts.
 *
 * Returns:
 *   Promise<DiscoverResult>: validated catalog + canonical JSON.
 *
 * Throws:
 *   TestDiscoveryError: when an enabled native enumeration could not
 *   run at all (spawn failure, timeout, unparseable output) — the CLI
 *   maps this to exit 2. Scanner-detectable problems are rows, not
 *   throws.
 */
export async function discoverTestCatalog(options) {
    const { cwd, config } = options;
    const scan = scanTestFiles({
        cwd,
        include: config.project.paths.include,
        exclude: config.project.paths.exclude,
    });
    const native = await listNativePlaywrightTests({
        cwd,
        timeoutMs: options.playwrightTimeoutMs,
    });
    const builder = new CatalogBuilder(cwd, scan, native);
    const runnerSummaries = [builder.playwrightSummary()];
    const entries = builder.buildEntries();
    // Registered pytest suites: diagnostic-only identities (§3.5).
    const suites = config.diagnostics?.suites ?? [];
    for (const suite of suites) {
        if (options.collectPytest === true) {
            const collection = await collectPytestSuite(suite, join(cwd, suite.cwd));
            runnerSummaries.push({
                runner: 'pytest',
                name: suite.name,
                status: collection.status === 'discovered' ? 'discovered' : 'unavailable',
                detail: collection.detail,
            });
            if (collection.status !== 'discovered')
                continue;
            for (const testCase of collection.cases) {
                // Collected files are suite-cwd-relative; the catalog rows and
                // digests use repo-relative posix paths.
                const repoFile = repoRelative(cwd, join(cwd, suite.cwd, testCase.file));
                const row = builder.pytestEntry(suite.name, testCase.nodeId, repoFile, testCase.titlePath);
                if (row !== null)
                    entries.push(row);
            }
        }
        else {
            runnerSummaries.push({
                runner: 'pytest',
                name: suite.name,
                status: 'registered',
                detail: 'registered for diagnostics; collection not requested (run tests discover --pytest); execution is Phase 4',
            });
        }
    }
    const catalog = builder.finalize(entries, runnerSummaries);
    return { catalog, json: canonicalJson(catalog) };
}
/** Assembles catalog rows from the scan + native enumeration. */
class CatalogBuilder {
    cwd;
    scan;
    native;
    /** Static entries keyed by file#titlePath for matching. */
    staticByKey = new Map();
    constructor(cwd, scan, native) {
        this.cwd = cwd;
        this.scan = scan;
        this.native = native;
        for (const entry of scan.entries) {
            this.staticByKey.set(reconciliationKey(entry.file, entry.titlePath), entry);
        }
    }
    /** The playwright runner summary line for this run. */
    playwrightSummary() {
        if (this.native.status === 'unavailable') {
            return { runner: 'playwright', name: 'playwright', status: 'unavailable', detail: this.native.detail };
        }
        // Native reporter errors (e.g. a spec that fails to load) are DATA:
        // surfaced on the summary and reflected in inventoryComplete.
        const errors = this.native.errors.length > 0 ? `; native errors: ${this.native.errors.join(' | ').slice(0, 500)}` : '';
        return { runner: 'playwright', name: 'playwright', status: 'discovered', detail: `${this.native.detail}${errors}` };
    }
    /** Builds every playwright row: matched, list-only, static-only, gaps. */
    buildEntries() {
        const rows = [];
        const matchedStaticKeys = new Set();
        // Parameterized static templates (`for (const x of ITEMS)
        // test(\`...${x}...\`)`): the template title is not itself runnable —
        // its concrete instances are. A template whose enumerated instances
        // all share its file + describe ancestry merges its static facts
        // into each instance row (origin 'static' + a template-expansion
        // weak signal) instead of leaving a blocking static-only gap beside
        // fact-less list-only rows (consumer migration, E22). Templates with
        // ZERO enumerated instances stay static-only and blocking (a
        // parameterized case no configuration executes — the owner wires it
        // into a project or removes it). An instance matching two templates,
        // or exactly matching a static entry, merges into no template
        // (ambiguity and exact identity win). Only the LAST titlePath segment
        // may carry `${}` slots; a template slot in a describe segment stays
        // static-only (documented limit).
        const templateConsumed = new Set();
        const instanceTemplate = new Map();
        if (this.native.status === 'discovered') {
            const enumeratedKeys = new Set(this.native.instances.map((instance) => reconciliationKey(instance.file, instance.titlePath)));
            const templates = [...this.staticByKey.values()].filter((entry) => !enumeratedKeys.has(reconciliationKey(entry.file, entry.titlePath)) &&
                templateTitlePattern(entry.title) !== null);
            const claimsByInstance = new Map();
            for (const template of templates) {
                const pattern = templateTitlePattern(template.title);
                if (pattern === null)
                    continue;
                const templateKey = reconciliationKey(template.file, template.titlePath);
                const describes = template.titlePath.slice(0, -1);
                for (const instance of this.native.instances) {
                    const instanceKey = reconciliationKey(instance.file, instance.titlePath);
                    // Exact static identity wins over template expansion.
                    if (this.staticByKey.has(instanceKey))
                        continue;
                    if (instance.file !== template.file)
                        continue;
                    if (instance.titlePath.length !== template.titlePath.length)
                        continue;
                    if (!describes.every((segment, index) => segment === instance.titlePath[index]))
                        continue;
                    if (!pattern.test(instance.titlePath[instance.titlePath.length - 1] ?? ''))
                        continue;
                    const claims = claimsByInstance.get(instanceKey) ?? [];
                    claims.push(templateKey);
                    claimsByInstance.set(instanceKey, claims);
                }
            }
            // An instance claimed by two templates merges into neither.
            for (const [instanceKey, templateKeys] of claimsByInstance) {
                if (templateKeys.length !== 1 || templateKeys[0] === undefined)
                    continue;
                const template = this.staticByKey.get(templateKeys[0]);
                if (template === undefined)
                    continue;
                templateConsumed.add(templateKeys[0]);
                instanceTemplate.set(instanceKey, template);
            }
        }
        // Static unresolved gaps, keyed by reconciliation identity, with
        // duplicates merged (§5.2: line numbers are never identity — two
        // unprovable calls sharing a title path collapse into one gap).
        const gapsByKey = new Map();
        const gapExtras = new Map();
        for (const gap of this.scan.unresolved) {
            const key = reconciliationKey(gap.file, gap.titlePath);
            const existing = gapsByKey.get(key);
            if (existing === undefined) {
                gapsByKey.set(key, gap);
                continue;
            }
            const extras = gapExtras.get(key) ?? [];
            extras.push(`${gap.location.file}:${String(gap.location.line)}`);
            gapExtras.set(key, extras);
        }
        // A gap the native runner ALSO enumerated is RESOLVED BY THE RUNNER:
        // the --list run loaded the file and will execute that exact case, so
        // the discovered row stands and the gap merges into it as a weak
        // signal — a second row over the same identity would duplicate the
        // logical key (the strict schema correctly rejects that).
        const enumeratedKeys = new Set();
        if (this.native.status === 'discovered') {
            for (const instance of this.native.instances) {
                const key = reconciliationKey(instance.file, instance.titlePath);
                enumeratedKeys.add(key);
                const template = instanceTemplate.get(key);
                const staticEntry = this.staticByKey.get(key) ?? template;
                if (staticEntry !== undefined)
                    matchedStaticKeys.add(key);
                const gap = gapsByKey.get(key);
                rows.push(this.playwrightRow(instance, staticEntry, gap, template));
            }
        }
        for (const [key, staticEntry] of this.staticByKey) {
            if (matchedStaticKeys.has(key) || templateConsumed.has(key))
                continue;
            rows.push(this.staticOnlyRow(staticEntry));
        }
        // Remaining unresolved static gaps become visible rows (never
        // omitted): unprovable shapes the runner did NOT enumerate (they
        // cannot execute) stay typed unresolved entries and block the
        // inventory honestly.
        for (const [key, gap] of [...gapsByKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
            if (enumeratedKeys.has(key))
                continue;
            const row = this.unresolvedRow(gap);
            const extras = gapExtras.get(key);
            if (extras !== undefined && row.unresolvedReason !== undefined) {
                row.unresolvedReason = {
                    ...row.unresolvedReason,
                    detail: `${row.unresolvedReason.detail} (further call sites: ${extras.join(', ')})`,
                };
            }
            rows.push(row);
        }
        return rows;
    }
    /** One matched/native-list playwright instance row. */
    playwrightRow(instance, staticEntry, staticGap, template) {
        const digest = fileDigest(this.cwd, instance.file);
        // The native list reports '' when the run has no projects; the
        // catalog identity uses null for that (same as static-only rows) —
        // an empty-string project is a schema violation, never an identity.
        const project = instance.project === '' ? null : instance.project;
        const matched = staticEntry !== undefined;
        // Static-first: when the static scan derived the case, its facts feed
        // kind inference. When it could not (or the file is outside the
        // configured globs), the native runner's OWN enumeration is the
        // identity source (resolution origin 'native-list'): the row is
        // DISCOVERED — the runner proved the case exists and will execute it
        // in the supervised run — but honestly weaker-classified: no static
        // call-site facts were read, so no strong kind rule may fire.
        const inference = staticEntry === undefined
            ? nativeOnlyInference(instance)
            : inferTestKind({ file: staticEntry.file, title: staticEntry.title, titlePath: staticEntry.titlePath, facts: staticEntry.facts });
        const suppression = matched
            ? suppressionOf(staticEntry, instance.annotations, instance.location)
            : { mocks: nativeSuppression(instance.annotations, instance.location), flags: [] };
        const weakSignals = [...inference.weakSignals];
        if (template !== undefined) {
            // The identity is a concrete enumerated instance; the static facts
            // came from its parameterized template (same loop body, same
            // fixtures — sound per-instance). Recorded, never silent.
            weakSignals.push({
                ruleId: 'template-expansion',
                evidence: `static parameterized title '${template.title}' expanded over the enumerated instance (same file, same describe ancestry)`,
                location: template.location,
            });
        }
        if (staticGap !== undefined) {
            // The static scan could not PROVE this call a test (wrapper/
            // dynamic title), yet the runner enumerated it: the runner wins
            // for identity, and the unprovability stays visible as a weak
            // signal (never silently dropped, never blocking twice).
            weakSignals.push({
                ruleId: staticGap.code,
                evidence: `${staticGap.detail} (resolved by native enumeration)`,
                location: staticGap.location,
            });
        }
        return {
            logicalKey: deriveLogicalKey({ runner: 'playwright', project, file: instance.file, titlePath: instance.titlePath }),
            runner: 'playwright',
            project,
            file: instance.file,
            titlePath: [...instance.titlePath],
            title: instance.title,
            sourceLocation: instance.location,
            parameterIdentity: instance.frameworkId,
            sourceDigest: digest ?? EMPTY_SHA256,
            discoveryStatus: 'discovered',
            reconciliation: matched ? 'matched' : 'list-only',
            resolutionOrigin: matched ? 'static' : 'native-list',
            inferredKind: inference.inferredKind,
            kindSignals: inference.kindSignals,
            weakSignals,
            rulesFired: inference.rulesFired,
            categorySignals: inference.categorySignals,
            suppressionSignals: suppression.mocks,
        };
    }
    /** One static-only row: static scan found it, native list did not. */
    staticOnlyRow(staticEntry) {
        const inference = inferTestKind({
            file: staticEntry.file,
            title: staticEntry.title,
            titlePath: staticEntry.titlePath,
            facts: staticEntry.facts,
        });
        const digest = fileDigest(this.cwd, staticEntry.file);
        const suppression = suppressionOf(staticEntry, [], staticEntry.location);
        return {
            logicalKey: deriveLogicalKey({ runner: 'playwright', project: null, file: staticEntry.file, titlePath: staticEntry.titlePath }),
            runner: 'playwright',
            project: null,
            file: staticEntry.file,
            titlePath: [...staticEntry.titlePath],
            title: staticEntry.title,
            sourceLocation: staticEntry.location,
            parameterIdentity: staticEntry.parameterIdentity,
            sourceDigest: digest ?? EMPTY_SHA256,
            discoveryStatus: 'unresolved',
            reconciliation: this.native.status === 'unavailable' ? 'unavailable' : 'static-only',
            resolutionOrigin: 'static',
            inferredKind: inference.inferredKind,
            kindSignals: inference.kindSignals,
            weakSignals: inference.weakSignals,
            rulesFired: inference.rulesFired,
            categorySignals: inference.categorySignals,
            suppressionSignals: [...suppression.mocks, ...suppression.flags],
            unresolvedReason: {
                code: this.native.status === 'unavailable'
                    ? 'reconciliation-unavailable'
                    : 'reconciliation-static-only',
                detail: this.native.status === 'unavailable'
                    ? 'no native playwright enumeration ran (no playwright config) — the case is statically visible only'
                    : 'the static scan found this case but the runner did not enumerate it (check configured globs, dynamic titles, or filters)',
            },
        };
    }
    /** One unresolved-gap row (unresolvable wrapper, budget, dynamic title). */
    unresolvedRow(gap) {
        return {
            logicalKey: deriveLogicalKey({
                runner: 'playwright',
                project: null,
                file: gap.file,
                titlePath: gap.titlePath.length > 0 ? gap.titlePath : [UNRESOLVED_TITLE_PLACEHOLDER],
            }),
            runner: 'playwright',
            project: null,
            file: gap.file,
            titlePath: gap.titlePath.length > 0 ? gap.titlePath : [UNRESOLVED_TITLE_PLACEHOLDER],
            title: gap.titlePath[gap.titlePath.length - 1] ?? UNRESOLVED_TITLE_PLACEHOLDER,
            sourceLocation: gap.location,
            parameterIdentity: null,
            sourceDigest: fileDigest(this.cwd, gap.file) ?? EMPTY_SHA256,
            discoveryStatus: 'unresolved',
            reconciliation: this.native.status === 'unavailable' ? 'unavailable' : 'static-only',
            resolutionOrigin: 'static',
            inferredKind: 'unknown',
            kindSignals: [],
            weakSignals: [],
            rulesFired: [],
            categorySignals: [],
            suppressionSignals: [],
            unresolvedReason: { code: gap.code, detail: gap.detail },
        };
    }
    /** One pytest collected-case row (diagnostic identity only, §3.5). */
    pytestEntry(suiteName, nodeId, file, titlePath) {
        // Suite-cwd-relative file → repo-relative for the digest lookup.
        const repoFile = file;
        const digest = fileDigest(this.cwd, repoFile);
        if (digest === null)
            return null; // unreadable file: no fabricated row
        return {
            logicalKey: deriveLogicalKey({ runner: 'pytest', project: suiteName, file: repoFile, titlePath }),
            runner: 'pytest',
            project: suiteName,
            file: repoFile,
            titlePath,
            title: titlePath[titlePath.length - 1] ?? nodeId,
            sourceLocation: { file: repoFile, line: 1, col: 0 },
            parameterIdentity: nodeId,
            sourceDigest: digest,
            discoveryStatus: 'discovered',
            reconciliation: 'unavailable',
            inferredKind: 'unknown',
            kindSignals: [],
            weakSignals: [],
            rulesFired: [],
            categorySignals: [],
            suppressionSignals: nodeId.includes('[xfail]') || nodeId.includes('[xpass]') ? [{ kind: 'fixme', detail: 'pytest xfail/xpass parameter', location: { file: repoFile, line: 1, col: 0 } }] : [],
        };
    }
    /** Validates + orders everything into the final catalog. */
    finalize(entries, runnerSummaries) {
        const sorted = [...entries].sort((a, b) => compareRows(a, b));
        const unresolved = sorted
            .filter((row) => row.discoveryStatus === 'unresolved' && row.unresolvedReason !== undefined)
            .map((row) => ({
            logicalKey: row.logicalKey,
            code: row.unresolvedReason?.code ?? 'unknown',
            detail: row.unresolvedReason?.detail ?? '',
            location: row.sourceLocation,
        }))
            .sort((a, b) => compareLocations(a.location, b.location) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        const parseErrors = this.scan.parseErrors
            .map((error) => ({ file: error.file, message: error.message, location: error.location }))
            .sort((a, b) => compareLocations(a.location, b.location));
        // Completeness is about ENUMERATION, never classification
        // uncertainty (plan phase 2 item 7): unknown KINDS stay complete;
        // failed parses, budget cuts, native reporter errors, unresolved
        // static-only rows (cases the runner never enumerated — they cannot
        // execute), and failed configured diagnostic suites do not. Rows
        // discovered only through the native list (origin 'native-list')
        // ARE complete enumeration: the runner itself proved the case.
        // A repo with no playwright rows at all is vacuously complete even
        // when native reconciliation reported unavailable (non-playwright
        // repos).
        const diagnosticUnavailable = runnerSummaries.some((summary) => summary.runner !== 'playwright' && summary.status === 'unavailable');
        const complete = parseErrors.length === 0 &&
            !this.scan.budgetExceeded &&
            this.native.errors.length === 0 &&
            !sorted.some((row) => row.runner === 'playwright' && row.discoveryStatus === 'unresolved') &&
            !diagnosticUnavailable;
        // Validate through the strict schema: duplicate logical keys and
        // inconsistent roll-ups fail closed here, at construction time.
        return TestCatalogSchema.parse({
            schemaVersion: 1,
            entries: sorted,
            unresolved,
            parseErrors,
            inventoryComplete: complete,
            runnerSummaries: [...runnerSummaries].sort((a, b) => (a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        });
    }
}
/** sha256 of empty bytes — placeholder ONLY when a digest is unreadable. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/**
 * Builds the instance-title matcher for a parameterized static title, or
 * null when the title carries no `${}` template slots. Literal parts
 * match exactly (regex-escaped); each slot matches any (possibly empty)
 * text — the same expansion the runner performs over the loop values.
 *
 * Args:
 *   title: the static title (may contain `${}` slots).
 *
 * Returns:
 *   Anchored RegExp, or null for non-parameterized titles.
 */
export function templateTitlePattern(title) {
    if (!title.includes('${}'))
        return null;
    const escaped = title.split('${}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escaped.join('.*')}$`);
}
/** Stable key for location dedupe. */
function locationKey(location) {
    return `${location.file}:${String(location.line)}:${String(location.col)}`;
}
/** Row order: file, then titlePath, then project (deterministic). */
function compareRows(a, b) {
    const projectA = a.project ?? '';
    const projectB = b.project ?? '';
    return ((a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : a.titlePath.join('>') > b.titlePath.join('>') ? 1 : 0) ||
        (projectA < projectB ? -1 : projectA > projectB ? 1 : 0));
}
/** Location order: file, line, col. */
function compareLocations(a, b) {
    return ((a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        a.line - b.line ||
        a.col - b.col);
}
/**
 * Inference for rows whose ONLY enumeration source is the native runner
 * list (resolution origin `'native-list'`): no static facts were read,
 * so NO strong kind rule may fire (running the rules over empty facts
 * would fabricate a `unit` proposal from absence). The kind stays
 * `unknown` and the native-only identity is recorded as a weak signal.
 */
function nativeOnlyInference(instance) {
    const weak = {
        ruleId: 'native-list-only',
        evidence: 'identity resolved by the native runner enumeration alone; the static scan did not derive this case ' +
            '(outside configured globs or not statically followable) — no call-site facts were read',
        location: instance.location,
    };
    return { inferredKind: 'unknown', kindSignals: [], weakSignals: [weak], rulesFired: [], categorySignals: [], mockSignals: [] };
}
/** Splits static signals into mock vs skip/only/fixme rows. */
function suppressionOf(staticEntry, annotations, annotationLocation) {
    const mocks = mockSignalsOf(staticEntry);
    const flags = staticEntry.signals.map((signal) => ({
        kind: signal.kind,
        detail: signal.detail,
        location: signal.location,
    }));
    for (const annotation of annotations) {
        if (annotation === 'skip' || annotation === 'fixme') {
            flags.push({
                kind: annotation,
                detail: `native ${annotation} annotation`,
                location: annotationLocation,
            });
        }
    }
    return { mocks, flags };
}
/** Suppression rows derived from native annotations alone. */
function nativeSuppression(annotations, location) {
    return annotations
        .filter((annotation) => annotation === 'skip' || annotation === 'fixme')
        .map((annotation) => ({
        kind: annotation,
        detail: `native ${annotation} annotation`,
        location,
    }));
}
/** Mock suppression signals from a static entry's facts. */
function mockSignalsOf(staticEntry) {
    const signals = [];
    if (staticEntry.facts.pageRoute !== null) {
        signals.push({ kind: 'mock', detail: 'page.route interception inside the test body', location: staticEntry.facts.pageRoute });
    }
    if (staticEntry.facts.fileMockImport !== null) {
        signals.push({ kind: 'mock', detail: 'vi.mock/jest.mock module mock in the test file', location: staticEntry.facts.fileMockImport });
    }
    return signals;
}
// Re-exports kept minimal: the CLI needs repoRelative nowhere else today.
export { repoRelative };
//# sourceMappingURL=discover.js.map