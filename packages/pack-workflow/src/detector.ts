import { isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { GATEFORGE_SCHEMA_VERSION, LocationSchema } from '@gateforge/core';
import type { z } from 'zod';
import type { DiscoveryOutcome, Finding as ProtocolFinding } from '@gateforge/plugin-protocol';
import type { Resource, UnresolvedReason } from '@gateforge/core';
import { PACK_PLUGIN_ID, PACK_VERSION } from './version.js';
type Location = z.infer<typeof LocationSchema>;

/** Stable detector kind for every workflow resource this pack emits. */
export const WORKFLOW_CONTRACT_KIND = 'workflow.contract';
/** FSM style enumeration; one per detected machine. */
export type FsmStyle = 'xstate' | 'fsm' | 'enum-switch' | 'zustand-slice';

/** One transition extracted from an FSM source. */
export interface WorkflowTransition {
  from: string;
  to: string;
  /** Logical event name (XState `on.<event>` / switch `case` key / Zustand action). */
  action: string;
}

/** Attribute payload of a {@link WORKFLOW_CONTRACT_KIND} resource. */
export interface WorkflowContractAttributes {
  resourceName: string;
  states: string[];
  transitions: WorkflowTransition[];
  terminal: string[];
  auditEvent: boolean;
  style: FsmStyle;
  domain: string;
}

/** Options for {@link createWorkflowDetector}. */
export interface WorkflowDetectorOptions {
  /** Repo root used to compute repo-root-relative `source` paths. */
  cwd?: string;
  /** Detector version override; primarily tests. */
  detectorVersion?: string;
  /** Detector id override; primarily tests. */
  detectorId?: string;
}

/** The pinned in-process plugin contract: `{ discover(paths) }`. */
export interface WorkflowDetector {
  discover(paths: readonly string[]): Promise<DiscoveryOutcome>;
}

// ---------------------------------------------------------------------------
// Internal scanning state — one Machine accumulator per detected FSM.
// ---------------------------------------------------------------------------

/** One in-progress machine under construction. */
interface PendingMachine {
  /** Lower-cased resource id fragment (`<domain>.<name>`). */
  idFragment: string;
  /** Lower-cased resource name (machine / class / variable name). */
  name: string;
  /** Domain inferred from the file basename (e.g. `contracts`). */
  domain: string;
  /** Source location of the machine declaration. */
  location: Location;
  /** Set of state names seen so far (kept unsorted during build). */
  states: Set<string>;
  /** Transition list; de-duplicated post-build. */
  transitions: WorkflowTransition[];
  /** Style heuristic — wins once the first detector arm fires. */
  style: FsmStyle;
  /** Whether the source mentions an audit / append / log sink. */
  auditEvent: boolean;
  /** Whether the machine has been "claimed" by a detector arm already. */
  claimed: boolean;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a discover-capable detector module. The default export of the
 * pack is `createWorkflowDetector()` — the CLI in-process contract.
 *
 * Args:
 *   options: Detector configuration (cwd, identity overrides).
 *
 * Returns:
 *   WorkflowDetector: the pinned `{ discover(paths) }` module.
 */
export function createWorkflowDetector(
  options: WorkflowDetectorOptions = {},
): WorkflowDetector {
  const cwd = options.cwd ?? process.cwd();
  const detectorId = options.detectorId ?? PACK_PLUGIN_ID;
  const detectorVersion = options.detectorVersion ?? PACK_VERSION;

  return {
    async discover(paths) {
      const out: DiscoveryOutcome = { resources: [], unresolved: [], findings: [], classificationSignals: [] };
      if (paths.length === 0) return out;
      const machines: PendingMachine[] = [];
      const findings: ProtocolFinding[] = [];
      const scanned: string[] = [];

      for (const rawPath of paths) {
        const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
        let source: string;
        try {
          source = readFileSync(path, 'utf8');
        } catch {
          out.unresolved.push({
            code: 'WORKFLOW_READ_FAILED',
            detail: `could not read source file: ${path}`,
            location: {
              file: path,
              line: 1,
              col: 0,
            },
          });
          continue;
        }
        scanned.push(relPath(cwd, path));
        const sf = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
        const visit = createVisitor({
          file: path,
          sourceFile: sf,
          cwd,
          onMachine: (m) => machines.push(m),
          onFinding: (f) => findings.push(f),
          onUnresolved: (u) => out.unresolved.push(u),
        });
        ts.forEachChild(sf, visit);
      }

      // Deterministic ordering: sort by id (stable, total).
      machines.sort((a, b) => (a.idFragment < b.idFragment ? -1 : a.idFragment > b.idFragment ? 1 : 0));

      for (const machine of machines) {
        const resource = finalizeMachine(machine, detectorId, detectorVersion);
        out.resources.push(resource);
      }

      // Findings are sorted by `code` then by `file` then by `line`.
      findings.sort((a, b) => {
        if (a.code !== b.code) return a.code < b.code ? -1 : 1;
        const aLoc = a.locations[0]!;
        const bLoc = b.locations[0]!;
        if (aLoc.file !== bLoc.file) return aLoc.file < bLoc.file ? -1 : 1;
        return aLoc.line - bLoc.line;
      });
      out.findings.push(...findings);
      return { ...out, scannedPaths: scanned.sort() };
    },
  };
}

// ---------------------------------------------------------------------------
// Visitor factory
// ---------------------------------------------------------------------------

interface VisitorContext {
  file: string;
  sourceFile: ts.SourceFile;
  cwd: string;
  onMachine: (machine: PendingMachine) => void;
  onFinding: (finding: ProtocolFinding) => void;
  onUnresolved: (reason: UnresolvedReason) => void;
}

function createVisitor(ctx: VisitorContext): (node: ts.Node) => void {
  return function visit(node: ts.Node) {
    // XState v5: `createMachine({ ... })` OR `setup({ ... }).createMachine({ ... })`.
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (isCreateMachineCall(expr)) {
        const machine = tryExtractXstateMachine(ctx, node);
        if (machine !== null) {
          ctx.onMachine(machine);
        }
      } else if (ts.isIdentifier(expr) && expr.text === 'create') {
        // Zustand slice: `create((set, get) => ({ status, transition: ... }))`.
        const machine = tryExtractZustandSlice(ctx, node);
        if (machine !== null) {
          ctx.onMachine(machine);
        }
      }
    }

    // Hand-rolled FSM class: a `ClassDeclaration` whose name ends in
    // `Machine` / `FSM` / `State` / `Workflow` and whose body mentions a
    // `transitions` member.
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      const machine = tryExtractFsmClass(ctx, node);
      if (machine !== null) {
        ctx.onMachine(machine);
      }
    }

    // Enum + switch transition guard: an enum + a switch whose discriminant
    // is the enum identifier.
    if (ts.isEnumDeclaration(node) || ts.isVariableStatement(node)) {
      const machine = tryExtractEnumSwitch(ctx, node);
      if (machine !== null) {
        ctx.onMachine(machine);
      }
    }

    ts.forEachChild(node, visit);
  };
}

// ---------------------------------------------------------------------------
// XState v5 detector arm
// ---------------------------------------------------------------------------

function isCreateMachineCall(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr) && expr.text === 'createMachine') return true;
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'createMachine') return true;
  return false;
}

/**
 * Emits the typed finding for a `createMachine` call that cannot be
 * parsed as a known FSM style. Fail-closed: no resource is produced, and
 * the reason surfaces as a gate-visible finding instead of silence.
 */
function unknownFsmStyleFinding(
  ctx: VisitorContext,
  call: ts.CallExpression,
  cause: string,
): ProtocolFinding {
  const { sourceFile } = ctx;
  const lc = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  return {
    code: 'UNKNOWN_FSM_STYLE',
    detail: `createMachine call could not be parsed as a known FSM style: ${cause}; no workflow resource is emitted from this call`,
    locations: [{ file: relPath(ctx.cwd, ctx.file), line: lc.line + 1, col: lc.character }],
  };
}

function tryExtractXstateMachine(
  ctx: VisitorContext,
  call: ts.CallExpression,
): PendingMachine | null {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
    ctx.onFinding(
      unknownFsmStyleFinding(ctx, call, 'the config argument is not an object literal'),
    );
    return null;
  }
  const statesProp = arg.properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'states',
  );
  if (statesProp === undefined) {
    ctx.onFinding(
      unknownFsmStyleFinding(ctx, call, 'the config declares no `states` object'),
    );
    return null;
  }
  if (!ts.isObjectLiteralExpression(statesProp.initializer)) {
    ctx.onFinding(
      unknownFsmStyleFinding(ctx, call, '`states` is not an object literal'),
    );
    return null;
  }

  const machine: PendingMachine = newMachine(ctx, 'xstate');
  const stateNames: string[] = [];
  for (const stateProp of statesProp.initializer.properties) {
    if (!ts.isPropertyAssignment(stateProp) || !ts.isIdentifier(stateProp.name)) continue;
    const stateName = stateProp.name.text;
    if (stateName === undefined) continue;
    stateNames.push(stateName);
    machine.states.add(stateName);
    if (ts.isObjectLiteralExpression(stateProp.initializer)) {
      const onProp = stateProp.initializer.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'on',
      );
      if (onProp !== undefined && ts.isObjectLiteralExpression(onProp.initializer)) {
        for (const eventProp of onProp.initializer.properties) {
          if (!ts.isPropertyAssignment(eventProp)) continue;
          const eventName = propertyName(eventProp);
          if (eventName === null) continue;
          if (!ts.isObjectLiteralExpression(eventProp.initializer)) continue;
          const targetProp = eventProp.initializer.properties.find(
            (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
              (ts.isIdentifier(p.name) ? p.name.text === 'target' : p.name.text === 'target'),
          );
          if (targetProp === undefined) continue;
          const target = stringValue(targetProp.initializer);
          if (target === null) continue;
          // XState supports `target: 'foo' | 'bar' | undefined`. We split on `|`.
          for (const part of target.split('|')) {
            const cleaned = part.trim();
            if (cleaned.length === 0) continue;
            machine.states.add(cleaned);
            machine.transitions.push({ from: stateName, to: cleaned, action: eventName });
          }
        }
      }
    }
  }
  if (machine.states.size === 0) {
    ctx.onFinding(unknownFsmStyleFinding(ctx, call, 'the `states` object declares no states'));
    return null;
  }
  machine.claimed = true;
  machine.auditEvent = ctx.sourceFile.text.includes('audit') || ctx.sourceFile.text.includes('appendFile');
  machine.name = deriveXstateName(ctx, call, stateNames);
  machine.idFragment = `${machine.domain}.${machine.name}`;
  return machine;
}

function deriveXstateName(ctx: VisitorContext, call: ts.CallExpression, stateNames: string[]): string {
  // Prefer the enclosing variable declaration's identifier (typical usage:
  // `export const contractMachine = createMachine({ ... })`).
  const parent = call.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return lower(parent.name.text);
  }
  // Fall back to the first state name (better than nothing).
  const first = stateNames[0];
  return lower(first ?? ctx.file);
}

// ---------------------------------------------------------------------------
// Hand-rolled FSM class detector arm
// ---------------------------------------------------------------------------

function tryExtractFsmClass(ctx: VisitorContext, decl: ts.ClassDeclaration): PendingMachine | null {
  const className = decl.name?.text;
  if (className === undefined) return null;
  if (!/Machine$|FSM$|StateMachine$|Workflow$/.test(className)) return null;

  const machine: PendingMachine = newMachine(ctx, 'fsm');
  const seenTransitions = new Set<string>();

  for (const member of decl.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'transitions' &&
        member.initializer !== undefined && ts.isObjectLiteralExpression(member.initializer)) {
      for (const fromProp of member.initializer.properties) {
        if (!ts.isPropertyAssignment(fromProp)) continue;
        const from = propertyName(fromProp);
        if (from === null) continue;
        machine.states.add(from);
        if (!ts.isObjectLiteralExpression(fromProp.initializer)) continue;
        const onProp = fromProp.initializer.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'on',
        );
        if (onProp === undefined || !ts.isObjectLiteralExpression(onProp.initializer)) continue;
        for (const eventProp of onProp.initializer.properties) {
          if (!ts.isPropertyAssignment(eventProp)) continue;
          const eventName = propertyName(eventProp);
          if (eventName === null) continue;
          const to = stringValue(eventProp.initializer);
          if (to === null) continue;
          machine.states.add(to);
          const key = `${from}::${eventName}::${to}`;
          if (seenTransitions.has(key)) continue;
          seenTransitions.add(key);
          machine.transitions.push({ from, to, action: eventName });
        }
      }
    }
  }

  if (machine.states.size === 0) return null;
  machine.claimed = true;
  machine.name = lower(className);
  machine.idFragment = `${machine.domain}.${machine.name}`;
  machine.auditEvent = ctx.sourceFile.text.includes('audit') || ctx.sourceFile.text.includes('appendFile');
  return machine;
}

// ---------------------------------------------------------------------------
// Enum + switch transition guard detector arm
// ---------------------------------------------------------------------------

function tryExtractEnumSwitch(ctx: VisitorContext, node: ts.Node): PendingMachine | null {
  // Detect enum declarations (TS enums).
  if (ts.isEnumDeclaration(node)) {
    const machine: PendingMachine = newMachine(ctx, 'enum-switch');
    for (const member of node.members) {
      const name = ts.isEnumMember(member) && member.name !== undefined
        ? (ts.isIdentifier(member.name) ? member.name.text : member.name.getText(ctx.sourceFile))
        : null;
      if (name !== null) machine.states.add(name);
    }
    // Look at sibling switch statements in the file.
    collectEnumSwitchCases(ctx, machine);
    if (machine.states.size === 0) return null;
    machine.claimed = true;
    machine.name = lower(node.name.text);
    machine.idFragment = `${machine.domain}.${machine.name}`;
    machine.auditEvent = ctx.sourceFile.text.includes('audit') || ctx.sourceFile.text.includes('appendFile');
    return machine;
  }

  // Detect `const X = { FOO: 'foo', ... } as const` style enums.
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = decl.initializer;
      if (init === undefined || !ts.isObjectLiteralExpression(init)) continue;
      const machine: PendingMachine = newMachine(ctx, 'enum-switch');
      let looksLikeEnum = false;
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propertyName(prop);
        if (name === null) continue;
        const val = stringValue(prop.initializer);
        if (val !== null) {
          machine.states.add(val);
          looksLikeEnum = true;
        } else {
          machine.states.add(name);
        }
      }
      if (!looksLikeEnum) continue;
      collectEnumSwitchCases(ctx, machine);
      if (machine.states.size === 0) continue;
      machine.claimed = true;
      machine.name = lower(decl.name.text);
      machine.idFragment = `${machine.domain}.${machine.name}`;
      machine.auditEvent = ctx.sourceFile.text.includes('audit') || ctx.sourceFile.text.includes('appendFile');
      return machine;
    }
  }
  return null;
}

function collectEnumSwitchCases(ctx: VisitorContext, machine: PendingMachine): void {
  // Walk the entire file looking for switch statements whose cases
  // mention the machine's state identifiers.
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      const discriminant = node.expression.getText(ctx.sourceFile);
      for (const state of machine.states) {
        if (discriminant.toLowerCase().includes(state.toLowerCase())) {
          for (const clause of node.caseBlock.clauses) {
            if (ts.isCaseClause(clause)) {
              const caseText = clause.expression.getText(ctx.sourceFile).replaceAll('"', '').replaceAll("'", '').trim();
              if (caseText.length === 0) continue;
              machine.states.add(caseText);
              machine.transitions.push({ from: state, to: caseText, action: caseText });
            }
          }
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(ctx.sourceFile, visit);
}

// ---------------------------------------------------------------------------
// Zustand state-slice detector arm
// ---------------------------------------------------------------------------

function tryExtractZustandSlice(ctx: VisitorContext, call: ts.CallExpression): PendingMachine | null {
  const arg = call.arguments[0];
  if (arg === undefined || !ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return null;
  if (!ts.isObjectLiteralExpression(arg.body)) return null;

  const machine: PendingMachine = newMachine(ctx, 'zustand-slice');
  for (const prop of arg.body.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = propertyName(prop);
    if (name === null) continue;
    if (name === 'status' || name === 'state') {
      const initial = stringValue(prop.initializer);
      if (initial !== null) machine.states.add(initial);
      continue;
    }
    if (name === 'transition' || name === 'set' || name === 'move') {
      const init = prop.initializer;
      if (init === undefined) continue;
      const text = init.getText(ctx.sourceFile);
      const matches = text.matchAll(/['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g);
      for (const m of matches) {
        const literal = m[1];
        if (literal !== undefined) machine.states.add(literal);
      }
    }
  }
  if (machine.states.size === 0) return null;
  machine.claimed = true;
  // Naming: prefer the variable assignment that wraps the call.
  const parent = call.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    machine.name = lower(machine.states.values().next().value ?? ctx.file);
  }
  machine.idFragment = `${machine.domain}.${machine.name}`;
  machine.auditEvent = ctx.sourceFile.text.includes('audit') || ctx.sourceFile.text.includes('appendFile');
  return machine;
}

// ---------------------------------------------------------------------------
// Resource finalisation
// ---------------------------------------------------------------------------

function finalizeMachine(
  machine: PendingMachine,
  detectorId: string,
  detectorVersion: string,
): Resource {
  const states = [...machine.states].sort();
  const transitions = dedupTransitions(machine.transitions);
  const outgoing = new Set<string>();
  for (const t of transitions) outgoing.add(t.from);
  const terminal = states.filter((s) => !outgoing.has(s));

  // The graph identity must satisfy the bare-name grammar (`^[^.]+$`):
  // the dotted `idFragment` (`domain.name`) stays on the resource id, the
  // dashed bare form is the graph-visible name. A normalized collision
  // with another machine surfaces downstream as a duplicate-id finding —
  // never silently merged.
  const attributes: WorkflowContractAttributes = {
    resourceName: machine.idFragment.replace(/[^A-Za-z0-9_-]/g, '-'),
    states,
    transitions,
    terminal,
    auditEvent: machine.auditEvent,
    style: machine.style,
    domain: machine.domain,
  };

  return {
    schemaVersion: GATEFORGE_SCHEMA_VERSION,
    id: `workflow.contract.${machine.idFragment}`,
    kind: WORKFLOW_CONTRACT_KIND,
    source: machine.location.file,
    location: machine.location,
    detectorVersion,
    attributes: attributes as unknown as Record<string, unknown>,
  };
  // `detectorId` is consumed by the graph stage (handshake-pinned at
  // plugin registration); the in-process detector's resource records
  // use `detectorVersion` only.
  void detectorId;
}

function dedupTransitions(list: readonly WorkflowTransition[]): WorkflowTransition[] {
  const seen = new Set<string>();
  const out: WorkflowTransition[] = [];
  for (const t of list) {
    const key = `${t.from}::${t.action}::${t.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  out.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.action !== b.action) return a.action < b.action ? -1 : 1;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
function newMachine(ctx: VisitorContext, style: FsmStyle): PendingMachine {
  const { file, sourceFile } = ctx;
  const lc = sourceFile.getLineAndCharacterOfPosition(0);
  const domain = inferDomain(file);
  return {
    idFragment: `${domain}.unknown`,
    name: 'unknown',
    domain,
    location: { file: relPath(ctx.cwd, file), line: lc.line + 1, col: lc.character },
    states: new Set<string>(),
    transitions: [],
    style,
    auditEvent: false,
    claimed: false,
  };
}

function inferDomain(file: string): string {
  const base = file.split('/').pop() ?? file;
  const stripped = base.replace(/\.(ts|tsx|js|mjs|cjs)$/i, '');
  return lower(stripped);
}

function relPath(cwd: string, file: string): string {
  if (file.startsWith(cwd + '/')) return file.slice(cwd.length + 1);
  return file;
}

function propertyName(prop: ts.PropertyAssignment): string | null {
  const name = prop.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function stringValue(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function lower(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '') || 'unknown';
}