/**
 * Bounded static discovery of Playwright tests (plan 2026-09-13 phase 2
 * item 3): a TypeScript-compiler-API scan of the configured test-file
 * globs — the same AST-only pattern as `@gateforge/pack-http`'s
 * client-call scanner (pure analysis, no evaluation).
 *
 * The model is deliberately bounded and fail-closed:
 *
 * - **Test calls**: `test('title', fn)`, `test.skip/.only/.fixme(...)`,
 *   `test.each([...])(...)` — resolved through local aliases and the
 *   relative-import graph (`const t = test.extend({...})`,
 *   `t('title', ...)` in another file), plus this pack's own runner
 *   specifier `@gateforge/pack-playwright` (its exported `test` is a
 *   playwright test function — the documented consumer import). Every
 *   other module-external binding stays unproven.
 * - **Describes**: nested `test.describe('X', () => {...})` stacks build
 *   each case's full titlePath.
 * - **Parameterization**: `test.each` and template-literal titles are
 *   recorded via `parameterIdentity` (with `${}` slots); a computed
 *   title that cannot be resolved statically becomes an UNRESOLVED row,
 *   never an omission.
 * - **Budgets**: import traversal has a file-count budget and a depth
 *   bound; exceeding either records `traversal-budget-exceeded`
 *   unresolved rows instead of looping.
 * - **Unresolvable wrappers**: a call through a name that cannot be
 *   proven to be a test function becomes an unresolved row with its
 *   call location — never "no tests".
 * - **Parse errors**: every parser diagnostic is recorded with its
 *   location; a file that half-parses contributes both its rows and a
 *   parse error.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { pathInScope } from '@gateforge/core';
/** Default cap on files pulled in through import traversal. */
export const DEFAULT_MAX_TRAVERSED_FILES = 200;
/** Default bound on import-traversal depth (chain length). */
export const DEFAULT_MAX_IMPORT_DEPTH = 16;
/** Placeholder titlePath for unresolved calls with no readable title. */
export const UNRESOLVED_TITLE_PLACEHOLDER = '<unresolved-title>';
/** Directories never descended into (build output, deps, VCS state). */
const PRUNED_DIRS = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report']);
/** File extensions the scanner parses (everything else is skipped). */
const PARSEABLE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** Playwright's exported test-function binding names. */
const TEST_BINDING_NAMES = new Set(['test', 'it']);
/**
 * The gateforge pack's own module specifier (`packages/pack-playwright`):
 * its exported `test` IS a playwright test function (`base.extend` over
 * `playwright/test` — see `fixture/fixture.ts`, which documents this
 * import as the only sanctioned runner). Binding it lets the static scan
 * follow the documented consumer shape
 * (`import { test as gateforgeTest } from '@gateforge/pack-playwright'`)
 * instead of emitting unresolvable rows for it. Every OTHER
 * module-external import stays unresolved — fail-closed is unchanged.
 */
export const GATEFORGE_PACK_SPECIFIER = '@gateforge/pack-playwright';
/** Whether the specifier is the gateforge pack's runner module. */
function isPackSpecifier(specifier) {
    return specifier === GATEFORGE_PACK_SPECIFIER;
}
/** Chain segments that modify a test/describe call without changing identity. */
const SUPPRESSION_SEGMENTS = new Set(['skip', 'only', 'fixme']);
/** Chain segments never part of a test call (hooks, fixtures, config). */
const NON_TEST_SEGMENTS = new Set([
    'beforeEach',
    'afterEach',
    'beforeAll',
    'afterAll',
    'use',
    'extend',
    'setTimeout',
    'expect',
    'annotate',
    'tag',
    // Event-listener / interception shapes (`cy.on('tap', fn)`,
    // `page.route('**/x', fn)`, `el.addEventListener('click', fn)`): a
    // string first argument + callback is their ordinary shape, not a test
    // declaration — no runner registers tests through these. Treating them
    // as unprovable wrappers flooded the catalog with phantom unresolved
    // rows when product code was scanned (consumer migration, E22).
    'on',
    'once',
    'addEventListener',
    'route',
]);
function languageKindFor(file) {
    if (file.endsWith('.tsx'))
        return ts.ScriptKind.TSX;
    if (file.endsWith('.jsx'))
        return ts.ScriptKind.JSX;
    if (file.endsWith('.mjs') || file.endsWith('.cjs'))
        return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}
function locationOf(file, source, node) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return { file, line: line + 1, col: character };
}
/**
 * Walks the repo (pruning VCS/deps/build dirs) and returns the sorted
 * repo-relative posix files matching the include globs and no exclude
 * glob. Pure filesystem listing — no content is read here.
 */
function collectCandidateFiles(cwd, include, exclude) {
    const found = [];
    const walk = (dir, rel) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return; // unreadable dir: invisible, never a scan failure of other files
        }
        for (const name of names.sort()) {
            if (PRUNED_DIRS.has(name))
                continue;
            const abs = join(dir, name);
            const relPath = rel === '' ? name : `${rel}/${name}`;
            let stats;
            try {
                stats = statSync(abs);
            }
            catch {
                continue;
            }
            if (stats.isDirectory()) {
                walk(abs, relPath);
            }
            else if (PARSEABLE_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
                pathInScope(relPath, include) &&
                !pathInScope(relPath, exclude)) {
                found.push(relPath);
            }
        }
    };
    walk(cwd, '');
    return found.sort();
}
/** The callee shape `{base, names}` of `a.b.c(...)`, else null. */
function calleeChain(expression) {
    if (ts.isIdentifier(expression))
        return { base: expression.text, names: [] };
    if (ts.isPropertyAccessExpression(expression)) {
        const inner = calleeChain(expression.expression);
        if (inner === null)
            return null;
        return { base: inner.base, names: [...inner.names, expression.name.text] };
    }
    return null;
}
/** Reads a file's text; unreadable content is a parse error row. */
function readText(state, file) {
    try {
        return readFileSync(join(state.cwd, file), 'utf8');
    }
    catch (error) {
        state.result.parseErrors.push({
            file,
            message: `cannot read file: ${error.message.split('\n')[0] ?? 'read error'}`,
            location: { file, line: 1, col: 0 },
        });
        return null;
    }
}
/**
 * Models one file's module-scope bindings. Files are modeled on demand:
 * seeded candidates first, import targets pulled from disk under the
 * traversal budget.
 */
function modelOf(state, cwd, file, pulled) {
    const cached = state.models.get(file);
    if (cached !== undefined)
        return cached;
    if (pulled) {
        if (state.traversed.has(file))
            return null;
        if (state.traversed.size >= state.maxTraversedFiles) {
            state.result.budgetExceeded = true;
            return null;
        }
        state.traversed.add(file);
        if (!existsSync(join(cwd, file)))
            return null;
    }
    const text = readText(state, file);
    if (text === null)
        return null;
    if (!state.result.scannedFiles.includes(file))
        state.result.scannedFiles.push(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, languageKindFor(file));
    const parseDiagnostics = source
        .parseDiagnostics;
    for (const diagnostic of parseDiagnostics ?? []) {
        const { line, character } = source.getLineAndCharacterOfPosition(diagnostic.start);
        state.result.parseErrors.push({
            file,
            message: String(diagnostic.messageText).split('\n')[0] ?? 'parse error',
            location: { file, line: line + 1, col: character },
        });
    }
    const model = { file, source, bindings: new Map(), exports: new Map() };
    state.models.set(file, model);
    modelModuleScope(state, cwd, model, source);
    return model;
}
/** Collects module-scope imports, `test.extend` aliases, and exports. */
function modelModuleScope(state, cwd, model, source) {
    const isModuleScope = (node) => {
        let current = node.parent;
        while (current !== undefined) {
            if (ts.isFunctionDeclaration(current) ||
                ts.isFunctionExpression(current) ||
                ts.isArrowFunction(current) ||
                ts.isMethodDeclaration(current) ||
                ts.isBlock(current)) {
                return false;
            }
            current = current.parent;
        }
        return true;
    };
    const visit = (node) => {
        // import { test [as t] } from '@playwright/test' | './helpers'
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isModuleScope(node)) {
            const clause = node.importClause;
            if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
                for (const element of clause.namedBindings.elements) {
                    const imported = element.propertyName?.text ?? element.name.text;
                    const local = element.name.text;
                    if (TEST_BINDING_NAMES.has(imported) && isTestModuleSpecifier(node.moduleSpecifier.text)) {
                        model.bindings.set(local, { kind: 'test' });
                    }
                    else if (node.moduleSpecifier.text.startsWith('./') || node.moduleSpecifier.text.startsWith('../')) {
                        const target = resolveSpecifier(state, cwd, model.file, node.moduleSpecifier.text);
                        if (target !== null) {
                            model.bindings.set(local, { kind: 'import', target, importedName: imported });
                        }
                        else {
                            state.result.unresolved.push({
                                code: 'unresolved-import',
                                detail: `import '${imported}' from '${node.moduleSpecifier.text}' does not resolve inside the scanned set`,
                                file: model.file,
                                titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
                                location: locationOf(model.file, source, node),
                            });
                        }
                    }
                }
            }
        }
        // export { x [as y] } / export { x } from './m'
        if (ts.isExportDeclaration(node) && isModuleScope(node)) {
            const specifier = node.moduleSpecifier;
            if (specifier !== undefined && ts.isStringLiteral(specifier)) {
                if (node.exportClause !== undefined &&
                    ts.isNamedExports(node.exportClause) &&
                    isPackSpecifier(specifier.text)) {
                    // Bare re-export of the pack's own surface (the sanctioned
                    // local runner-module pattern, e.g. the consumer's
                    // `helpers.js`: `export { test } from '@gateforge/pack-playwright'`).
                    for (const element of node.exportClause.elements) {
                        const imported = element.propertyName?.text ?? element.name.text;
                        if (TEST_BINDING_NAMES.has(imported)) {
                            model.exports.set(element.name.text, { packTest: true });
                        }
                    }
                }
                else {
                    const target = specifier.text.startsWith('./') || specifier.text.startsWith('../')
                        ? resolveSpecifier(state, cwd, model.file, specifier.text)
                        : null;
                    if (target !== null && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
                        for (const element of node.exportClause.elements) {
                            model.exports.set(element.name.text, {
                                targetFile: target,
                                importedName: element.propertyName?.text ?? element.name.text,
                            });
                        }
                    }
                }
            }
            else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
                for (const element of node.exportClause.elements) {
                    model.exports.set(element.name.text, { local: element.propertyName?.text ?? element.name.text });
                }
            }
        }
        // module-scope const aliases: `const t = test.extend({...})`, `const t = base`, wrappers
        if (ts.isVariableStatement(node) && isModuleScope(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
                    continue;
                const name = declaration.name.text;
                const initializer = declaration.initializer;
                if (ts.isIdentifier(initializer)) {
                    model.bindings.set(name, { kind: 'alias', target: initializer.text });
                }
                else if (ts.isCallExpression(initializer) &&
                    ts.isPropertyAccessExpression(initializer.expression) &&
                    initializer.expression.name.text === 'extend' &&
                    ts.isIdentifier(initializer.expression.expression)) {
                    model.bindings.set(name, { kind: 'alias', target: initializer.expression.expression.text });
                }
                else {
                    // `const t = makeTest()` and friends: a wrapper the scanner
                    // cannot prove — calls through it stay visible as unresolved.
                    model.bindings.set(name, { kind: 'unresolvable' });
                }
                if ((node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
                    model.exports.set(name, { local: name });
                }
            }
        }
        // CJS destructure: `const { test } = require('@playwright/test')` or
        // `const { test } = require('./helpers')` — same bindings as ESM.
        if (ts.isVariableStatement(node) &&
            isModuleScope(node) &&
            !ts.isImportDeclaration(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isObjectBindingPattern(declaration.name))
                    continue;
                const initializer = declaration.initializer;
                if (initializer === undefined || !ts.isCallExpression(initializer))
                    continue;
                if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'require')
                    continue;
                const requireArgument = initializer.arguments[0];
                if (requireArgument === undefined || !ts.isStringLiteral(requireArgument))
                    continue;
                const specifier = requireArgument.text;
                for (const element of declaration.name.elements) {
                    if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name))
                        continue;
                    const imported = (element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
                        ? element.propertyName.text
                        : element.name.text);
                    const local = element.name.text;
                    if (TEST_BINDING_NAMES.has(imported) && isTestModuleSpecifier(specifier)) {
                        model.bindings.set(local, { kind: 'test' });
                    }
                    else if (specifier.startsWith('./') || specifier.startsWith('../')) {
                        const target = resolveSpecifier(state, cwd, model.file, specifier);
                        if (target !== null) {
                            model.bindings.set(local, { kind: 'import', target, importedName: imported });
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}
/** Whether the specifier is playwright's own test module. */
function isPlaywrightSpecifier(specifier) {
    return specifier === '@playwright/test' || specifier === 'playwright/test' || specifier === 'playwright';
}
/**
 * Whether a named import from this specifier can bind a playwright test
 * function: playwright's own test module, or the gateforge pack (whose
 * exported `test` is a `base.extend` over playwright's — see
 * {@link GATEFORGE_PACK_SPECIFIER}).
 */
function isTestModuleSpecifier(specifier) {
    return isPlaywrightSpecifier(specifier) || isPackSpecifier(specifier);
}
/** Resolves a relative specifier against the repo (candidate extensions). */
function resolveSpecifier(state, cwd, fromFile, specifier) {
    const base = posix.dirname(fromFile);
    const joined = posix.normalize(posix.join(base, specifier));
    const candidates = [
        joined,
        ...PARSEABLE_EXTENSIONS.map((ext) => `${joined}${ext}`),
        ...PARSEABLE_EXTENSIONS.map((ext) => `${joined}/index${ext}`),
    ];
    for (const candidate of candidates) {
        if (state.seeded.has(candidate) || state.traversed.has(candidate) || existsSync(join(cwd, candidate))) {
            return candidate;
        }
    }
    return null;
}
/**
 * Resolves whether `name` in `file` binds to a playwright test function,
 * through aliases and relative imports, bounded by depth + file budget.
 * Cycle-guarded via `state.resolving`.
 */
function resolveTestAlias(state, cwd, file, name, depth) {
    if (depth > state.maxImportDepth) {
        state.result.budgetExceeded = true;
        return 'budget';
    }
    const key = `${file}::${name}`;
    if (state.resolving.has(key))
        return 'unknown'; // alias cycle: not provable
    const model = modelOf(state, cwd, file, !state.seeded.has(file));
    if (model === null) {
        if (state.result.budgetExceeded && !state.seeded.has(file) && !state.traversed.has(file)) {
            return 'budget';
        }
        return 'unknown';
    }
    const binding = model.bindings.get(name);
    if (binding !== undefined) {
        if (binding.kind === 'test')
            return 'test';
        if (binding.kind === 'unresolvable')
            return 'wrapper-unresolvable';
        if (binding.kind === 'alias' && binding.target !== undefined) {
            state.resolving.add(key);
            const resolved = resolveTestAlias(state, cwd, file, binding.target, depth + 1);
            state.resolving.delete(key);
            return resolved;
        }
        if (binding.kind === 'import' && binding.target !== undefined && binding.importedName !== undefined) {
            state.resolving.add(key);
            const resolved = resolveExportedName(state, cwd, binding.target, binding.importedName, depth + 1);
            state.resolving.delete(key);
            return resolved;
        }
    }
    return 'unknown';
}
/** Resolves a name through the target file's exports, then its bindings. */
function resolveExportedName(state, cwd, file, name, depth) {
    if (depth > state.maxImportDepth) {
        state.result.budgetExceeded = true;
        return 'budget';
    }
    const model = modelOf(state, cwd, file, !state.seeded.has(file));
    if (model === null) {
        return state.result.budgetExceeded && !state.seeded.has(file) && !state.traversed.has(file)
            ? 'budget'
            : 'unknown';
    }
    const exported = model.exports.get(name);
    if (exported !== undefined) {
        if ('local' in exported)
            return resolveTestAlias(state, cwd, file, exported.local, depth + 1);
        if ('packTest' in exported)
            return 'test';
        state.resolving.add(`${file}::${name}`);
        const resolved = resolveExportedName(state, cwd, exported.targetFile, exported.importedName, depth + 1);
        state.resolving.delete(`${file}::${name}`);
        return resolved;
    }
    return resolveTestAlias(state, cwd, file, name, depth + 1);
}
/** Extracts the title text (with `${}` slots) or null when computed. */
function titleOf(argument) {
    if (argument === undefined)
        return null;
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        return { title: argument.text, parameterized: false };
    }
    if (ts.isTemplateExpression(argument)) {
        let text = argument.head.text;
        for (const span of argument.templateSpans) {
            text += '${}';
            text += span.literal.text;
        }
        return { title: text, parameterized: true };
    }
    return null;
}
/** Fixture names in the callback's first parameter (destructured or bare). */
function signatureParamsOf(callback) {
    if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
        return [];
    const first = callback.parameters[0];
    if (first === undefined)
        return [];
    if (ts.isObjectBindingPattern(first.name)) {
        const names = [];
        for (const element of first.name.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name))
                names.push(element.name.text);
        }
        return names;
    }
    if (ts.isIdentifier(first.name))
        return [first.name.text];
    return [];
}
/**
 * Signature parameter names that prove a real browser is in play.
 * `evidence` is this pack's trusted-evidence fixture — it is built on a
 * live `page` (see `fixture/fixture.ts`), so a test declaring it runs a
 * real browser journey.
 */
export const BROWSER_FIXTURE_PARAMS = new Set(['page', 'browser', 'context', 'browserName', 'evidence']);
const HTTP_CLIENT_CALLEES = new Set(['fetch', 'axios']);
/** Whether the subtree contains `<x>.route(` — playwright interception. */
function findPageRoute(node, source, file) {
    let found = null;
    const visit = (current) => {
        if (found !== null)
            return;
        if (ts.isCallExpression(current) &&
            ts.isPropertyAccessExpression(current.expression) &&
            current.expression.name.text === 'route' &&
            ts.isIdentifier(current.expression.expression)) {
            found = locationOf(file, source, current);
            return;
        }
        ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
}
/** Whether the subtree calls fetch/axios (the app's HTTP boundary). */
function findHttpClientCall(node, source, file) {
    let found = null;
    const visit = (current) => {
        if (found !== null)
            return;
        if (ts.isCallExpression(current)) {
            const chain = calleeChain(current.expression);
            if (chain !== null && HTTP_CLIENT_CALLEES.has(chain.base)) {
                found = locationOf(file, source, current);
                return;
            }
        }
        ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
}
/** Whether the file contains a `vi.mock(...)` / `jest.mock(...)` call. */
function findModuleMock(source, file) {
    let found = null;
    const visit = (node) => {
        if (found !== null)
            return;
        if (ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            (node.expression.name.text === 'mock') &&
            ts.isIdentifier(node.expression.expression) &&
            (node.expression.expression.text === 'vi' || node.expression.expression.text === 'jest')) {
            found = locationOf(file, source, node);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}
/**
 * Runs the bounded static scan over the configured globs. Every value is
 * derived from ASTs; the only I/O is reading candidate + import-target
 * files under {@link ScanBudget}.
 *
 * Args:
 *   options: cwd, include/exclude globs, and optional budgets.
 *
 * Returns:
 *   StaticScanResult: entries, unresolved rows, parse errors, scanned
 *   files, and the budget flag. Never throws for scanner-detectable
 *   problems — those are rows (fail closed as data, not silence).
 */
export function scanTestFiles(options) {
    const state = {
        cwd: options.cwd,
        result: { entries: [], unresolved: [], parseErrors: [], scannedFiles: [], budgetExceeded: false },
        models: new Map(),
        seeded: new Set(),
        traversed: new Set(),
        resolving: new Set(),
        maxTraversedFiles: options.budget?.maxTraversedFiles ?? DEFAULT_MAX_TRAVERSED_FILES,
        maxImportDepth: options.budget?.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    };
    const seededFiles = collectCandidateFiles(options.cwd, options.include, options.exclude);
    for (const file of seededFiles)
        state.seeded.add(file);
    for (const file of seededFiles) {
        const model = modelOf(state, options.cwd, file, false);
        if (model === null)
            continue;
        const fileHttpClient = findHttpClientCall(model.source, model.source, file);
        const fileMock = findModuleMock(model.source, file);
        scanFileForTests(state, options.cwd, model, fileHttpClient, fileMock);
    }
    state.result.entries.sort((a, b) => compareEntry(a, b));
    state.result.unresolved.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        a.location.line - b.location.line ||
        a.location.col - b.location.col);
    state.result.parseErrors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.location.line - b.location.line);
    state.result.scannedFiles.sort();
    return state.result;
}
/** Deterministic entry order: file, then titlePath, then line. */
function compareEntry(a, b) {
    return ((a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
        (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : a.titlePath.join('>') > b.titlePath.join('>') ? 1 : 0) ||
        a.location.line - b.location.line);
}
/** Visits one modeled file, harvesting describe stacks and test calls. */
function scanFileForTests(state, cwd, model, fileHttpClient, fileMock) {
    const { file, source } = model;
    const visit = (node, describeStack, enclosing) => {
        if (!ts.isCallExpression(node)) {
            ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
            return;
        }
        const chain = calleeChain(node.expression);
        if (chain === null) {
            ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
            return;
        }
        const location = locationOf(file, source, node);
        const resolution = resolveTestAlias(state, cwd, file, chain.base, 0);
        const names = chain.names;
        const isDescribe = names.includes('describe');
        const isExtend = names.includes('extend');
        const lifecycle = names.some((name) => NON_TEST_SEGMENTS.has(name));
        const suppression = names.filter((name) => SUPPRESSION_SEGMENTS.has(name));
        const eachCall = names.includes('each');
        const titleArgument = node.arguments[0];
        const callback = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        // Zero-arg conditional suppression INSIDE a test body: test.skip() / test.fixme()
        if (resolution === 'test' &&
            suppression.length > 0 &&
            node.arguments.length === 0 &&
            enclosing !== null) {
            enclosing.signals.push({ kind: suppression[0], detail: `${chain.base}.${suppression[0]}() call`, location });
            return;
        }
        // Conditional-skip form test.skip(condition, 'reason') inside a body.
        if (resolution === 'test' &&
            suppression.length > 0 &&
            node.arguments.length === 2 &&
            callback === undefined &&
            enclosing !== null) {
            enclosing.signals.push({ kind: suppression[0], detail: `${chain.base}.${suppression[0]}(condition) call`, location });
            return;
        }
        if (isDescribe || (eachCall && names.includes('describe'))) {
            // describe(...) — push its title/signal scope over the callback body.
            const title = titleOf(titleArgument);
            const childStack = [...describeStack];
            if (title !== null) {
                childStack.push({
                    titles: [title.title],
                    signals: suppression.map((kind) => ({
                        kind: kind,
                        detail: `test.describe.${kind} modifier`,
                        location,
                    })),
                });
            }
            if (callback !== undefined) {
                ts.forEachChild(callback, (child) => visit(child, childStack, enclosing));
            }
            return;
        }
        if (resolution === 'test' && !isExtend && !lifecycle && !isDescribe && titleArgument !== undefined && !eachCall) {
            const title = titleOf(titleArgument);
            if (title === null) {
                state.result.unresolved.push({
                    code: 'dynamic-title',
                    detail: 'test title is computed and cannot be resolved statically',
                    file,
                    titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
                    location,
                });
                return;
            }
            const entry = buildEntry({
                file,
                source,
                node,
                callback,
                titlePath: [...describeStack.flatMap((scope) => scope.titles), title.title],
                parameterized: title.parameterized,
                inheritedSignals: describeStack.flatMap((scope) => scope.signals),
                suppression,
                location,
                fileHttpClient,
                fileMock,
            });
            state.result.entries.push(entry);
            // Walk the body so inner zero-arg `test.skip()` / `test.fixme()`
            // calls attach to THIS entry's signals.
            if (callback !== undefined) {
                const enclosing = { facts: entry.facts, signals: entry.signals };
                ts.forEachChild(callback, (child) => visit(child, describeStack, enclosing));
            }
            return;
        }
        if (resolution === 'test' && eachCall && !isExtend && !lifecycle) {
            // test.each([...])(title, fn): the OUTER call carries the title.
            const outer = node.parent;
            if (ts.isCallExpression(outer) && outer.expression === node) {
                const title = titleOf(outer.arguments[0]);
                const outerCallback = outer.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
                const outerLocation = locationOf(file, source, outer);
                if (title === null) {
                    state.result.unresolved.push({
                        code: 'dynamic-title',
                        detail: 'parameterized test title is computed and cannot be resolved statically',
                        file,
                        titlePath: [UNRESOLVED_TITLE_PLACEHOLDER],
                        location: outerLocation,
                    });
                    return;
                }
                const entry = buildEntry({
                    file,
                    source,
                    node: outer,
                    callback: outerCallback,
                    titlePath: [...describeStack.flatMap((scope) => scope.titles), title.title],
                    parameterized: 'each',
                    inheritedSignals: describeStack.flatMap((scope) => scope.signals),
                    suppression,
                    location: outerLocation,
                    fileHttpClient,
                    fileMock,
                });
                state.result.entries.push(entry);
                if (outerCallback !== undefined) {
                    const enclosing = { facts: entry.facts, signals: entry.signals };
                    ts.forEachChild(outerCallback, (child) => visit(child, describeStack, enclosing));
                }
                return;
            }
            return; // the inner test.each(data) call itself: handled via the outer
        }
        if ((resolution === 'wrapper-unresolvable' || resolution === 'unknown' || resolution === 'budget') &&
            !isExtend &&
            !lifecycle &&
            !isDescribe &&
            titleArgument !== undefined &&
            typeof titleOf(titleArgument)?.title === 'string' &&
            node.arguments.some((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) {
            // A call that LOOKS like a test (literal title + callback) through
            // a name we cannot prove: recorded, never omitted, with its call
            // location. Single-argument calls (`page.goto('/x')`) are NOT
            // test-shaped and stay unclassified.
            const code = resolution === 'wrapper-unresolvable'
                ? 'unresolved-wrapper'
                : resolution === 'budget'
                    ? 'traversal-budget-exceeded'
                    : 'unresolved-test-alias';
            const detail = resolution === 'wrapper-unresolvable'
                ? `call target '${chain.base}' is a declared wrapper whose test binding cannot be proven statically`
                : resolution === 'budget'
                    ? `import/alias traversal budget exceeded before '${chain.base}' could be resolved`
                    : `call target '${chain.base}' is not a known test binding (outside the scanned set or not statically provable)`;
            state.result.unresolved.push({
                code,
                detail,
                file,
                titlePath: [...describeStack.flatMap((scope) => scope.titles), titleOf(titleArgument)?.title ?? UNRESOLVED_TITLE_PLACEHOLDER],
                location,
            });
            return;
        }
        // Everything else: keep walking (non-test calls, bare identifiers).
        ts.forEachChild(node, (child) => visit(child, describeStack, enclosing));
    };
    visit(source, [], null);
}
/** Builds one static entry: facts from the callback body + signals. */
function buildEntry(input) {
    const { file, source, node, callback, titlePath, location } = input;
    const params = callback === undefined ? [] : signatureParamsOf(callback);
    const signals = [...input.inheritedSignals];
    for (const kind of input.suppression) {
        signals.push({ kind: kind, detail: `test.${kind} modifier`, location });
    }
    let pageRoute = null;
    let httpClientCall = null;
    if (callback !== undefined) {
        pageRoute = findPageRoute(callback, source, file);
        httpClientCall = findHttpClientCall(callback, source, file);
    }
    return {
        file,
        titlePath,
        title: titlePath[titlePath.length - 1] ?? UNRESOLVED_TITLE_PLACEHOLDER,
        location,
        parameterIdentity: input.parameterized === false ? null : input.parameterized === 'each' ? 'each' : 'template',
        signals,
        facts: {
            signatureParams: params,
            pageRoute,
            httpClientCall,
            fileHttpClientCall: input.fileHttpClient,
            fileMockImport: input.fileMock,
        },
    };
}
//# sourceMappingURL=static-discovery.js.map