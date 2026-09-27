/** Static, non-executing inventory for UI tests that need a surface descriptor. */
import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';
import { compareStrings } from '@gate-forge/core';

const PACK_IMPORT = '@gate-forge/pack-playwright';
const TEST_FILE_PATTERN = /(?:\.spec|\.test)\.[cm]?[jt]sx?$/i;
const SKIP_DIRECTORIES = new Set(['.git', '.gateforge', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2_000_000;

/** One UI test that uses the fixture but has no statically declared surface. */
export interface MissingSurfaceTest {
  file: string;
  title: string;
}

/** Stable result for `gateforge tests surface-doctor`. */
export interface SurfaceDoctorReport {
  schemaVersion: 1;
  scannedFiles: number;
  complete: boolean;
  warnings: string[];
  missingSurface: MissingSurfaceTest[];
  action: string;
}

/** Scans test source without importing, evaluating, or running consumer code.
 *
 * Args:
 *   cwd: absolute or relative repository root to scan.
 *
 * Returns:
 *   SurfaceDoctorReport: deterministic list of UI tests without a surface.
 */
export function diagnoseMissingUiSurfaces(cwd: string): SurfaceDoctorReport {
  const root = resolve(cwd);
  const files: string[] = [];
  const warnings: string[] = [];
  let complete = true;
  let limitReported = false;
  const walk = (directory: string): void => {
    if (files.length >= MAX_FILES) {
      complete = false;
      if (!limitReported) warnings.push(`scan limit reached (${String(MAX_FILES)} test files)`);
      limitReported = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      complete = false;
      warnings.push(`${relative(root, directory) || '.'}: cannot read directory (${(error as Error).message})`);
      return;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name));
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        if (files.length >= MAX_FILES) {
          complete = false;
          if (!limitReported) warnings.push(`scan limit reached (${String(MAX_FILES)} test files)`);
          limitReported = true;
          return;
        }
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(root);

  const missingSurface: MissingSurfaceTest[] = [];
  for (const absolutePath of files) {
    let sourceText: string;
    try {
      sourceText = readFileSync(absolutePath, 'utf8');
    } catch (error) {
      complete = false;
      warnings.push(`${relative(root, absolutePath).split(sep).join('/')}: cannot read source (${(error as Error).message})`);
      continue;
    }
    if (Buffer.byteLength(sourceText, 'utf8') > MAX_FILE_BYTES) {
      complete = false;
      warnings.push(`${relative(root, absolutePath).split(sep).join('/')}: source exceeds ${String(MAX_FILE_BYTES)} bytes`);
      continue;
    }
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(absolutePath),
    );
    const testObjects = new Set<string>();
    const surfaceObjects = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== PACK_IMPORT) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'test') testObjects.add(element.name.text);
      }
    }
    const declarations: ts.VariableDeclaration[] = [];
    const collectDeclarations = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) declarations.push(node);
      node.forEachChild(collectDeclarations);
    };
    collectDeclarations(sourceFile);
    for (let pass = 0; pass <= declarations.length; pass += 1) {
      let changed = false;
      for (const declaration of declarations) {
        if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
        if (!ts.isCallExpression(declaration.initializer)) continue;
        const call = declaration.initializer;
        if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'extend') continue;
        const base = call.expression.expression;
        if (!ts.isIdentifier(base) || !testObjects.has(base.text)) continue;
        if (!testObjects.has(declaration.name.text)) {
          testObjects.add(declaration.name.text);
          changed = true;
        }
        if (objectHasProperty(call.arguments[0], 'surface')) surfaceObjects.add(declaration.name.text);
      }
      if (!changed) break;
    }
    const surfaceUsePositions: number[] = [];
    const inspectSurfaceUse = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'use' &&
        ts.isIdentifier(node.expression.expression) &&
        testObjects.has(node.expression.expression.text) &&
        objectHasProperty(node.arguments[0], 'surface')
      ) {
        surfaceUsePositions.push(node.getStart(sourceFile));
      }
      node.forEachChild(inspectSurfaceUse);
    };
    inspectSurfaceUse(sourceFile);
    const inspectTestCases = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTestCaseCall(node, testObjects)) {
        const title = node.arguments[0];
        const body = node.arguments[node.arguments.length - 1];
        const surfaceUseApplies = surfaceUsePositions.some((position) => position < node.getStart(sourceFile));
        if (body !== undefined && containsEvidenceUi(body) && !surfaceUseApplies && !surfaceObjects.has(testObjectName(node))) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          missingSurface.push({
            file: relative(root, absolutePath).split(sep).join('/'),
            title: title !== undefined && ts.isStringLiteralLike(title) ? title.text : `<computed title at line ${String(position.line + 1)}>` ,
          });
        }
      }
      node.forEachChild(inspectTestCases);
    };
    inspectTestCases(sourceFile);
  }

  const unique = new Map<string, MissingSurfaceTest>();
  for (const entry of missingSurface) unique.set(`${entry.file}\0${entry.title}`, entry);
  const rows = [...unique.values()].sort((left, right) =>
    left.file === right.file ? compareStrings(left.title, right.title) : compareStrings(left.file, right.file),
  );
  return {
    schemaVersion: 1,
    scannedFiles: files.length,
    complete,
    warnings: [...new Set(warnings)].sort(compareStrings),
    missingSurface: rows,
    action:
      'Add a surface descriptor with test.extend({ surface: ... }) for each UI test. Keep the existing v1/v2 table or v3 card shape; do not copy selectors from another page.',
  };
}

/** Selects the TypeScript parser mode from a file extension.
 *
 * Args:
 *   path: source file path.
 *
 * Returns:
 *   ts.ScriptKind: parser mode for the source file.
 */
function scriptKindFor(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Returns true when an object literal declares a named property.
 *
 * Args:
 *   node: candidate expression.
 *   name: property name to find.
 *
 * Returns:
 *   boolean: true when a static object literal contains the property.
 */
function objectHasProperty(node: ts.Expression | undefined, name: string): boolean {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return false;
  return node.properties.some((property) => {
    const propertyName = ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
      ? property.name
      : ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
    if (propertyName === undefined || (!ts.isIdentifier(propertyName) && !ts.isStringLiteralLike(propertyName))) return false;
    if (propertyName.text !== name) return false;
    if (ts.isPropertyAssignment(property) && (property.initializer.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(property.initializer) && property.initializer.text === 'undefined'))) return false;
    return true;
  });
}

/** Tests whether a call is a Playwright test case for a known fixture object.
 *
 * Args:
 *   node: candidate call expression.
 *   testObjects: known fixture identifiers.
 *
 * Returns:
 *   boolean: true when the call begins from a fixture test identifier.
 */
function isTestCaseCall(node: ts.CallExpression, testObjects: ReadonlySet<string>): boolean {
  if (node.arguments.length < 2) return false;
  const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
  if (method !== null && !['only', 'skip', 'fixme', 'fail', 'slow'].includes(method)) return false;
  let expression: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) && testObjects.has(expression.text);
}

/** Returns the root fixture identifier used by a test case call.
 *
 * Args:
 *   node: test call expression.
 *
 * Returns:
 *   string: root identifier name.
 */
function testObjectName(node: ts.CallExpression): string {
  let expression: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(expression)) expression = expression.expression;
  return ts.isIdentifier(expression) ? expression.text : '';
}

/** Finds direct evidence.ui access in a test callback without evaluation.
 *
 * Args:
 *   node: callback syntax tree.
 *
 * Returns:
 *   boolean: true when the callback reads evidence.ui.
 */
function containsEvidenceUi(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'ui' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'evidence'
  ) {
    return true;
  }
  return node.getChildren().some(containsEvidenceUi);
}
