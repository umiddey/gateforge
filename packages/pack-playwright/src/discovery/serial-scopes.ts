/**
 * Static serial-scope detection in Playwright spec sources (serial-group
 * selection): when a selected test belongs to a describe in serial mode,
 * the supervised run must select every test of that serial group in file
 * order, so the planner needs a spec's serial scopes as data.
 *
 * The detection source is STATIC PARSING, deliberately: Playwright's own
 * enumeration (`--list --reporter=json`, the listing `reconcile.ts`
 * reads) exposes suites as title/file/line only — a suite's declared
 * execution mode is not part of the list surface, so serialness is
 * unreadable from the runner's own catalog. Parsing the spec source
 * reuses the same trust position as the static scan
 * (`static-discovery.ts`): the suite's own source is the declaration.
 *
 * Three declaration forms are detected, exactly Playwright's serial
 * modes:
 *
 * - `test.describe.serial('<title>', fn)` — an explicitly serial
 *   describe;
 * - `test.describe.configure({ mode: 'serial' })` inside a describe
 *   body — that describe is serial, whether the call sits before or
 *   after the tests it governs (Playwright applies the configuration to
 *   the whole scope regardless of position);
 * - `test.describe.configure({ mode: 'serial' })` at the top level of
 *   the file — the whole file is one serial scope.
 *
 * A scope that declares nothing serial is never detected, and a mode
 * that cannot be read statically (a computed `mode`) is never guessed
 * to be serial. Detection is per-file: scopes of one spec never leak
 * into another.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** One serial scope of one spec file, as data. */
export interface SerialScope {
  /** `describe` for a serial describe, `file` for a file-level serial mode. */
  kind: 'describe' | 'file';
  /**
   * The describe titles ABOVE the serial scope, in file order (the
   * prefix of every member's title path). Empty for a top-level group
   * and for the file-level scope.
   */
  parentTitlePath: string[];
  /** The serial describe's own title; null for the file-level scope (and untitled describes). */
  title: string | null;
  /** Inclusive 1-based source-line range of the scope's body. */
  startLine: number;
  endLine: number;
}

/** Fallback display title for a serial describe declared without a title. */
const UNTITLED = '(untitled describe)';

/**
 * Reads the serial scopes of one spec source.
 *
 * Args:
 *   source: the spec file's source text.
 *   fileName: file name for TypeScript's parser (drives JSX/TSX handling).
 *
 * Returns:
 *   SerialScope[]: the serial scopes, in source order (by start line).
 */
export function serialScopesOf(source: string, fileName = 'serial.spec.ts'): SerialScope[] {
  const scriptKind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.ts')
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind);
  interface Frame {
    kind: 'file' | 'describe';
    parentTitlePath: string[];
    title: string | null;
    serial: boolean;
    startLine: number;
    endLine: number;
  }
  const fileFrame: Frame = {
    kind: 'file',
    parentTitlePath: [],
    title: null,
    serial: false,
    startLine: 1,
    endLine: lineOfPosition(sourceFile, sourceFile.getEnd()),
  };
  const scopes: SerialScope[] = [];

  const visit = (node: ts.Node, stack: readonly Frame[]): void => {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, (child) => visit(child, stack));
      return;
    }
    const chain = calleeChainOf(node.expression);
    if (chain === null || !chain.names.includes('describe')) {
      ts.forEachChild(node, (child) => visit(child, stack));
      return;
    }
    if (chain.names.includes('configure')) {
      // `describe.configure({ mode: ... })`: marks the ENCLOSING scope —
      // the file frame at the top level, the enclosing describe inside
      // one — regardless of where in the body the call sits.
      if (configuredModeIsSerial(node)) {
        const frame = stack[stack.length - 1];
        if (frame !== undefined) frame.serial = true;
      }
      return;
    }
    const callback = node.arguments.find(
      (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
    );
    if (callback === undefined) return;
    const parent = stack[stack.length - 1];
    const parentTitlePath = [...(parent?.parentTitlePath ?? [])];
    if (parent?.kind === 'describe' && parent.title !== null) parentTitlePath.push(parent.title);
    const frame: Frame = {
      kind: 'describe',
      parentTitlePath,
      title: titleOfArgument(node.arguments[0]),
      serial: chain.names.includes('serial'),
      startLine: lineOfPosition(sourceFile, node.getStart(sourceFile)),
      endLine: lineOfPosition(sourceFile, callback.getEnd()),
    };
    ts.forEachChild(callback, (child) => visit(child, [...stack, frame]));
    if (frame.serial) {
      scopes.push({
        kind: frame.kind,
        parentTitlePath: [...frame.parentTitlePath],
        title: frame.title,
        startLine: frame.startLine,
        endLine: frame.endLine,
      });
    }
  };

  visit(sourceFile, [fileFrame]);
  if (fileFrame.serial) {
    scopes.push({
      kind: fileFrame.kind,
      parentTitlePath: [...fileFrame.parentTitlePath],
      title: fileFrame.title,
      startLine: fileFrame.startLine,
      endLine: fileFrame.endLine,
    });
  }
  return scopes.sort((left, right) => left.startLine - right.startLine);
}

/**
 * Reads the serial scopes of one spec file from disk.
 *
 * Args:
 *   absolutePath: absolute path of the spec file.
 *
 * Returns:
 *   SerialScope[]: the file's serial scopes; empty when the file cannot
 *   be read — an unreadable spec expands nothing (fail closed towards
 *   today's behavior, never towards a guessed group).
 */
export function readSerialScopes(absolutePath: string): SerialScope[] {
  let source: string;
  try {
    source = readFileSync(absolutePath, 'utf8');
  } catch {
    return [];
  }
  return serialScopesOf(source, absolutePath);
}

/**
 * Resolves the serial scope ONE test belongs to: the DEEPEST serial
 * scope containing it (a nested serial describe outranks an enclosing
 * one), else the file-level scope, else null — a test outside every
 * serial scope expands nothing.
 *
 * Args:
 *   test: the test's title path and source line (undefined when the
 *     catalog never located it — only a file-level scope can still
 *     claim such a row).
 *   scopes: the file's serial scopes.
 *
 * Returns:
 *   SerialScope | null: the governing serial scope, or null.
 */
export function serialScopeOfTest(
  test: { titlePath: readonly string[]; line: number | undefined },
  scopes: readonly SerialScope[],
): SerialScope | null {
  let best: SerialScope | null = null;
  for (const scope of scopes) {
    if (scope.kind !== 'describe') continue;
    if (test.line === undefined || test.line < scope.startLine || test.line > scope.endLine) continue;
    const { titlePath } = test;
    if (titlePath.length <= scope.parentTitlePath.length) continue;
    if (!scope.parentTitlePath.every((title, index) => titlePath[index] === title)) continue;
    if (best === null || scope.startLine > best.startLine) best = scope;
  }
  if (best !== null) return best;
  return scopes.find((scope) => scope.kind === 'file') ?? null;
}

/**
 * Whether one test belongs to a scope as a MEMBER: same title-path
 * ancestry and, for a describe scope, a source line inside the body.
 *
 * Args:
 *   scope: the serial scope.
 *   test: the candidate member's title path and source line.
 *
 * Returns:
 *   boolean: true when the scope's serial chain covers the test.
 */
export function scopeCoversTest(
  scope: SerialScope,
  test: { titlePath: readonly string[]; line: number | undefined },
): boolean {
  const { titlePath } = test;
  if (!scope.parentTitlePath.every((title, index) => titlePath[index] === title)) return false;
  if (scope.kind === 'file') return true;
  if (titlePath.length <= scope.parentTitlePath.length) return false;
  if (test.line === undefined) return false;
  return test.line >= scope.startLine && test.line <= scope.endLine;
}

/** The scope's display title path (' > ' joined), null for the file scope. */
export function serialScopeTitle(scope: SerialScope): string | null {
  if (scope.kind === 'file') return null;
  const path = [...scope.parentTitlePath, scope.title ?? UNTITLED];
  return path.join(' > ');
}

/** The `{ base, names }` of an `a.b.c(...)` callee, null for computed callees. */
function calleeChainOf(expression: ts.Expression): { base: string; names: string[] } | null {
  const names: string[] = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return null;
  return { base: current.text, names };
}

/** Whether the call's first argument reads `mode: 'serial'` (a literal). */
function configuredModeIsSerial(node: ts.CallExpression): boolean {
  const first = node.arguments[0];
  if (first === undefined || !ts.isObjectLiteralExpression(first)) return false;
  const mode = first.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === 'mode') ||
        (ts.isStringLiteral(property.name) && property.name.text === 'mode')),
  );
  if (mode === undefined) return false;
  const value = mode.initializer;
  return ts.isStringLiteral(value) && value.text === 'serial';
}

/** The static string of one call argument, null when computed. */
function titleOfArgument(argument: ts.Expression | undefined): string | null {
  if (argument === undefined) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  return null;
}

function lineOfPosition(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}
