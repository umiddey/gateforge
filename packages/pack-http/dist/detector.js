/**
 * Generic HTTP exposure pack detector (plan phase 4, ADR 0003 D1/D2).
 *
 * Discovers externally-reachable HTTP artifacts in TypeScript/JavaScript
 * sources and emits classification signals ONLY — routes are EVIDENCE,
 * never business resources (red-team round 2): a route resource carrying
 * the path-derived bare name would collide with the converged table at
 * the same plane-qualified id (DUPLICATE_BOUND_RESOURCE_ID). The
 * artifact's identity lives in its signals' locations:
 *
 *   - Server routes: Express `app.get('/path', …)` / `router.post(…)`,
 *     Fastify and Hono registrations (import-disambiguated, mirroring
 *     pack-auth's convention), and NestJS `@Controller('prefix')` +
 *     `@Get('suffix')` decorators.
 *   - Frontend API-client calls resolved through the bounded static
 *     dataflow in `client-calls.ts` (plan phase 3): direct literal
 *     `fetch`/Axios, `fetch(url, { method })`, Axios instances and
 *     config objects, configured client symbols, pure URL builders,
 *     module constants (local and imported within the scanned set),
 *     and simple single-return wrapper functions. A modeled
 *     `axios.create` creation with a proven literal `baseURL` joins the
 *     base into the emitted `normalizedPath` (`rawPath` stays as
 *     written); unprovable bases join nothing, byte-identically.
 *     Computed methods, arbitrary concatenation, environment-dependent
 *     hosts, and wrapper flows outside the model emit typed unresolved
 *     entries — they never disappear and never default to GET.
 *
 * Both sides additionally emit `http.contract` evidence facts (ADR 0004
 * D1) — one per server artifact and one per frontend callsite — which the
 * engine's endpoint compiler joins by canonical method + positional path.
 * Facts are engine-owned evidence-only resources: never business
 * resources, never classified directly.
 *
 * Signals (dogfood remediation phase 4): NONE. This pack once minted
 * `exposure`/`lifecycle.<op>` signals targeted at the PATH-DERIVED
 * resource name (last non-parameter path segment); in real repos those
 * names are guesses that mostly match no discovered resource (route
 * `/absences` vs table `employee_absences`), and every minted signal
 * surfaced as a STALE_SIGNAL_TARGET blocker while adding no information:
 * unknown exposure already defaults user-facing and unknown lifecycle
 * operations already default enabled (ADR 0003 D5). Route→resource
 * linkage is the CLI endpoint compiler's exclusive job
 * (`derivePathResourceName` + schema-symbol/handler corroboration, with
 * typed ENDPOINT_RESOURCE_LINK_UNRESOLVED blocks for ambiguity); the
 * schema symbols and handler names this pack discovers travel on the
 * `http.contract` facts the compiler corroborates against. Core's
 * STALE_SIGNAL_TARGET detection remains for genuinely stale authority
 * signals (declaration markers, adapter bindings, read-only
 * declarations) — this pack simply no longer produces false targets.
 *
 * No negative proof exists anywhere in this pack (plan §4.3: no
 * regex-only negative proof, no "not found means internal"); it never
 * writes classifications, only evidence.
 *
 * Determinism: pure over (paths, file bytes); no clock, no network;
 * output sorted by resource id; signals sorted by canonical JSON.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { LocationSchema } from '@gateforge/core';
import { HTTP_CONTRACT_KIND, normalizeHttpMethod, normalizeHttpPath, } from '@gateforge/http-contract';
import { activeClientSymbolNamesIn, fileInServerScanRoots, readClientScanConfigOrNull, scanClientCalls, } from './client-calls.js';
import { PACK_VERSION } from './version.js';
/** Directories the detector never descends into. */
const SKIP_DIR_NAMES = {
    node_modules: true,
    dist: true,
    build: true,
    coverage: true,
    '.git': true,
    '.next': true,
    '.turbo': true,
    '.cache': true,
    out: true,
    __pycache__: true,
};
/** Scanned source extensions. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Recursively resolves repo-relative input paths to source files. */
function resolveInputs(paths, root) {
    const files = [];
    for (const rel of paths) {
        if (rel.includes('..') || resolve(root, rel) === root)
            continue;
        const absolute = resolve(root, rel);
        let stat;
        try {
            // lstat (NOT stat): recognize a final symlink without following it.
            stat = lstatSync(absolute);
        }
        catch {
            continue;
        }
        if (stat.isSymbolicLink()) {
            // SKIP silently — mirrors the CLI walker's symlink rule. A symlink
            // target lies outside the repository's real source tree, so
            // following it would scan content the repo does not own, and a
            // dangling link hides nothing (no target content exists): skipping
            // closes no scan-scope hole.
            continue;
        }
        if (stat.isDirectory()) {
            let entries = [];
            try {
                entries = readdirSync(absolute);
            }
            catch {
                // Silent on purpose: the CLI's expandIncludePaths walk already
                // fail-closes (ExpandError → SCAN_PATH_UNREADABLE) on unreadable
                // directories and stat failures, so this pass can never be the
                // last line of defense — it only narrows an already-proven scope.
                continue;
            }
            const nested = entries
                .filter((entry) => SKIP_DIR_NAMES[entry] !== true)
                .map((entry) => `${rel}/${entry}`);
            files.push(...resolveInputs(nested, root));
            continue;
        }
        if (SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext)))
            files.push(absolute);
    }
    return files.sort();
}
/** Line/column (1-based line, 0-based col) of a text index. */
function lineColumnFor(text, index) {
    const before = text.slice(0, Math.max(index, 0));
    const lines = before.split('\n');
    return { line: lines.length, col: (lines[lines.length - 1] ?? '').length };
}
/**
 * Scans one file's text for server route registrations. Express/Fastify/
 * Hono share the `app|server|router|api.<method>( '<path>' …` shape;
 * framework attribution follows the module the file imports (pack-auth
 * convention — without import disambiguation the first scanner wins and
 * wrong attribution leaks across frameworks).
 */
function scanServerRoutes(text, file, clientSymbols = []) {
    const out = [];
    let origin = 'express';
    if (/\bfrom\s+['"]hono['"]/.test(text) || /\brequire\(\s*['"]hono['"]/.test(text)) {
        origin = 'hono';
    }
    else if (/\bfrom\s+['"]fastify['"]/.test(text) || /\brequire\(\s*['"]fastify['"]/.test(text)) {
        origin = 'fastify';
    }
    const registration = /\b(app|server|router|api)\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\3(?:\s*,\s*([A-Za-z_$][\w$]*)\s*[),])?/g;
    let match;
    while ((match = registration.exec(text)) !== null) {
        const receiver = match[1] ?? '';
        if (clientSymbols.includes(receiver))
            continue;
        const method = (match[2] ?? '').toUpperCase();
        const path = match[4] ?? '';
        if (path.length === 0)
            continue;
        const handler = match[5];
        const { line, col } = lineColumnFor(text, match.index);
        out.push({ method, path, origin, file, line, col, ...(handler !== undefined ? { handler } : {}) });
    }
    return out;
}
/** Scans one file's text for NestJS `@Controller` + `@Get`/`@Post` pairs. */
function scanNestControllers(text, file) {
    const out = [];
    const controller = /@Controller\(\s*(['"`])([^'"`]*)\1\s*\)/g;
    let match;
    while ((match = controller.exec(text)) !== null) {
        const prefix = match[2] ?? '';
        // The controller body spans until the next @Controller or EOF.
        const bodyStart = match.index + (match[0]?.length ?? 0);
        const nextController = text.slice(bodyStart).search(/@Controller\(/);
        const body = text.slice(bodyStart, nextController === -1 ? undefined : bodyStart + nextController);
        const methodDecorator = /@(Get|Post|Put|Patch|Delete|All)\(\s*(['"`])?([^'"`)]*)\2?\s*\)/g;
        let methodMatch;
        while ((methodMatch = methodDecorator.exec(body)) !== null) {
            const method = (methodMatch[1] ?? '').toUpperCase();
            const suffix = methodMatch[3] ?? '';
            const path = `/${prefix}/${suffix}`.replace(/\/+$/, '');
            if (path === '/')
                continue;
            const absoluteIndex = bodyStart + (methodMatch.index ?? 0);
            const { line, col } = lineColumnFor(text, absoluteIndex);
            out.push({ method, path, origin: 'nestjs', file, line, col });
        }
    }
    return out;
}
/**
 * Creates the discover-capable detector module. The default export of
 * the pack is `createHttpDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Optional root override for repo-relative `source` paths.
 *
 * Returns:
 *   HttpDetector: the pinned `{ discover(paths) }` module.
 */
export function createHttpDetector(options = {}) {
    const root = options.root ?? process.cwd();
    const clientScan = options.clientScan ??
        readClientScanConfigOrNull(resolve(root, options.clientScanConfigPath ?? '.gateforge/http-clients.json'));
    return {
        discover(paths) {
            if (paths.length === 0) {
                return { resources: [], unresolved: [], findings: [], classificationSignals: [], scannedPaths: [] };
            }
            const files = resolveInputs(paths, root);
            const artifacts = [];
            const findings = [];
            const scanned = [];
            const texts = new Map();
            for (const file of files) {
                let text;
                try {
                    text = readFileSync(file, 'utf8');
                }
                catch (error) {
                    const source = relative(root, file).split(sep).join('/');
                    findings.push({
                        code: 'SOURCE_READ_ERROR',
                        detail: `failed to read '${source}': ${error instanceof Error ? error.message : String(error)}`,
                        locations: [{ file: source, line: 1, col: 0 }],
                    });
                    continue;
                }
                const sourceRel = relative(root, file).split(sep).join('/');
                scanned.push(sourceRel);
                texts.set(sourceRel, text);
                // Server-route scan scoping (phase 3): generic route regexes and
                // NestJS decorators apply ONLY inside serverScanRoots — another
                // repo discovered false http.endpoint resources inside tests/e2e
                // because test-harness mock servers matched the generic shape,
                // and test servers are not product routes. Files outside the
                // roots yield no server artifacts at all (they still count as
                // scanned: the walk read them; scoping narrows facts, not
                // coverage reporting).
                if (fileInServerScanRoots(clientScan, sourceRel)) {
                    // Client-symbol disambiguation stays scope-aware: a symbol
                    // admits this file only where its scoping does (see
                    // activeClientSymbolNamesIn) — out of client scope,
                    // `api.get('/x', handler)` can only be a router registration.
                    for (const artifact of scanServerRoutes(text, file, activeClientSymbolNamesIn(clientScan, sourceRel))) {
                        artifacts.push(artifact);
                    }
                    for (const artifact of scanNestControllers(text, file))
                        artifacts.push(artifact);
                }
            }
            artifacts.sort((a, b) => {
                const keyA = `${a.file}:${a.line}:${a.col}:${a.method}:${a.path}:${a.origin}`;
                const keyB = `${b.file}:${b.line}:${b.col}:${b.method}:${b.path}:${b.origin}`;
                return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
            });
            // Routes are EVIDENCE, not business resources (red-team round 2):
            // emitting a classifiable resource with the path-derived bare name
            // would collide with the converged table at the same plane-
            // qualified id, and (phase 4) no classification signals are minted:
            // a path-derived target is a guess that mostly names no discovered
            // resource (STALE_SIGNAL_TARGET noise). The contract facts below
            // carry raw/canonical paths, schema symbols, and handler names to
            // the endpoint compiler — the sole sanctioned linkage mechanism.
            const resources = [];
            const unresolved = [];
            for (const artifact of artifacts) {
                const sourceRel = relative(root, artifact.file).split(sep).join('/');
                const location = { file: sourceRel, line: artifact.line, col: artifact.col };
                // Catch-all registrations (app.all/*) are exposure-only evidence:
                // they prove reachability but no concrete method, so they emit no
                // contract fact and no block.
                if (!['all', 'any', '*'].includes(artifact.method.toLowerCase())) {
                    const fact = contractFactFromArtifact(artifact, sourceRel, location, artifact.handler);
                    if (fact.ok)
                        resources.push(fact.resource);
                    else
                        unresolved.push(fact.unresolved);
                }
            }
            // Frontend calls: bounded static dataflow (client-calls.ts) — one
            // fact per source callsite. Every scanned file is offered as an
            // import-resolution target, but clientScanRoots fact emission is
            // enforced inside scanClientCalls: files outside the roots return
            // empty there (no facts, no unresolved entries) while still
            // resolving product imports.
            for (const sourceRel of [...texts.keys()].sort(compareStringsHttp)) {
                const text = texts.get(sourceRel);
                if (text === undefined)
                    continue;
                const result = scanClientCalls(sourceRel, text, clientScan, texts);
                for (const clientCall of result.calls) {
                    const fact = contractFactFromClientCall(clientCall, sourceRel);
                    if (fact.ok)
                        resources.push(fact.resource);
                    else
                        unresolved.push(fact.unresolved);
                }
                unresolved.push(...result.unresolved);
            }
            resources.sort((a, b) => compareStringsHttp(String(a['id']), String(b['id'])));
            unresolved.sort((a, b) => compareStringsHttp(a.location.file, b.location.file) ||
                a.location.line - b.location.line ||
                a.location.col - b.location.col ||
                compareStringsHttp(a.code, b.code) ||
                compareStringsHttp(a.detail, b.detail));
            findings.sort((a, b) => a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0);
            // classificationSignals stays in the wire shape (protocol contract)
            // and is always empty: this pack mints NO classification signals.
            return { resources, unresolved, findings, classificationSignals: [], scannedPaths: scanned.sort(compareStringsHttp) };
        },
    };
}
function contractFactFromArtifact(artifact, sourceRel, location, handler) {
    return buildFact({
        role: 'server-route',
        method: artifact.method,
        rawPath: artifact.path,
        framework: artifact.origin,
        handler,
        file: sourceRel,
        location,
        idSuffix: `${sourceRel}:${artifact.line}:${artifact.col}:${artifact.method}`,
    });
}
function contractFactFromClientCall(clientCall, sourceRel) {
    const location = {
        file: clientCall.location.file,
        line: clientCall.location.line,
        col: clientCall.location.col,
    };
    return buildFact({
        role: 'frontend-call',
        method: clientCall.method,
        rawPath: clientCall.rawPath,
        // baseURL-joined calls (phase 3) canonicalize the JOINED path — the
        // instance prefix is real at runtime. rawPath stays exactly as
        // written for provenance. Without a joined base this is undefined
        // and buildFact normalizes rawPath exactly as before (byte-identical).
        canonicalPath: clientCall.joinedBaseURL === undefined ? undefined : clientCall.canonicalPath,
        framework: clientCall.framework,
        file: sourceRel,
        location,
        idSuffix: `${sourceRel}:${clientCall.location.line}:${clientCall.location.col}`,
        callsites: [`${clientCall.location.file}:${clientCall.location.line}:${clientCall.location.col}`],
    });
}
function buildFact(input) {
    const method = normalizeHttpMethod(input.method);
    if (method === null) {
        return {
            ok: false,
            unresolved: {
                code: 'HTTP_METHOD_DYNAMIC',
                detail: `artifact in ${input.file} carries method '${input.method}' that cannot be proven`,
                location: input.location,
            },
        };
    }
    const canonical = input.canonicalPath !== undefined
        ? { ok: true, canonical: input.canonicalPath }
        : normalizeHttpPath(input.rawPath);
    if (!canonical.ok) {
        return {
            ok: false,
            unresolved: {
                code: 'HTTP_PATH_DYNAMIC',
                detail: `path '${input.rawPath}' in ${input.file}: ${canonical.detail}`,
                location: input.location,
            },
        };
    }
    const attributes = {
        role: input.role,
        method,
        normalizedPath: canonical.canonical,
        rawPath: input.rawPath,
        framework: input.framework,
    };
    if (input.callsites !== undefined)
        attributes['callsites'] = input.callsites;
    if (input.handler !== undefined && input.handler.length > 0)
        attributes['handlerSymbol'] = input.handler;
    return {
        ok: true,
        resource: {
            schemaVersion: 1,
            kind: HTTP_CONTRACT_KIND,
            source: input.file,
            location: input.location,
            detectorVersion: PACK_VERSION,
            attributes,
            id: `http.contract:${input.idSuffix}`,
        },
    };
}
/** Codepoint sort for reported coverage paths. */
function compareStringsHttp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
//# sourceMappingURL=detector.js.map