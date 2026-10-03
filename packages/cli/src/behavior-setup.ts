/**
 * Behavior-case setup (plan 2026-09-30 Phase 4): the setup UX that makes
 * behavior cases usable by someone who does not know Gateforge.
 *
 * Two surfaces share this module, and nothing else may re-implement it:
 *
 *   1. `gateforge init` asks (TTY) — or is told by a flag (agent/CI) —
 *      which of the behavior packs the repository actually shows should
 *      have their cases enabled, and writes a commented skeleton with one
 *      example case per ENABLED namespace. Nothing is ever enabled
 *      silently: a non-interactive run prints the exact flag that enables
 *      the pack it found, and enables nothing.
 *   2. `gateforge next` prints the same vocabulary instantiated for the
 *      concrete route the owner is looking at: which file, which case id,
 *      and which test-map entry — every line copy-pasteable as printed.
 *
 * Detection is a bounded content scan of the repository's own source
 * files, mirroring `repo-scan.ts` (same ignore list, same size guard). It
 * is deliberately conservative: a namespace is reported only when the
 * repository contains the machinery that namespace's cases are ABOUT
 * (HMAC signature verification, an authorization decision, a state
 * transition, a request schema). A repository that shows none of them
 * gets no behavior output at all, which keeps `init` byte-identical.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The namespaces the engine drives through an HTTP request: a case in
 * one of them is a claim about what a route answered and what changed.
 */
const HTTP_BEHAVIOR_NAMESPACES = ['webhook', 'workflow', 'auth', 'validation'] as const;

/**
 * The one namespace whose cases are graded from the delivery queue
 * itself rather than from an HTTP attempt. The engine's own
 * `queueObserver` is what makes them gradable: absent that block every
 * `task:*` case fails closed as `missing`, so the pack is only ever
 * OFFERED when the repository declares one. It is last in print order
 * for that reason — a repository without an observer never reaches it.
 */
export const TASK_BEHAVIOR_NAMESPACE = 'task' as const;

/** The behavior packs a repository can be asked to enable cases for. */
export const BEHAVIOR_NAMESPACES = [...HTTP_BEHAVIOR_NAMESPACES, TASK_BEHAVIOR_NAMESPACE] as const;

/** One behavior pack namespace. */
export type BehaviorNamespace = (typeof BEHAVIOR_NAMESPACES)[number];

/**
 * The behavior document list each namespace's cases are declared under:
 * a task case is a claim about a task resource, never about a route.
 */
const NAMESPACE_LIST_KEY: Readonly<Record<BehaviorNamespace, 'endpoints' | 'resources'>> =
  Object.freeze({
    webhook: 'endpoints',
    workflow: 'endpoints',
    auth: 'endpoints',
    validation: 'endpoints',
    task: 'resources',
  });

/** The bundled plugin each namespace's cases are graded through. */
export const BEHAVIOR_NAMESPACE_PLUGIN: Readonly<Record<BehaviorNamespace, string>> = Object.freeze({
  webhook: 'gateforge.pack-webhook',
  workflow: 'gateforge.pack-workflow',
  auth: 'gateforge.pack-auth',
  validation: 'gateforge.pack-validation',
  task: 'gateforge.pack-task',
});

/** Directories never descended into (mirrors `repo-scan.ts`). */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

/** Files larger than this are never content-scanned (binary guard). */
const MAX_SCAN_BYTES = 1_048_576;

/** How many files one namespace may be proven from (bounded evidence). */
const MAX_EVIDENCE_FILES = 5;

/**
 * The machinery a namespace's cases are about. A namespace is detected
 * only when one of these appears in the repository's own source text: the
 * code that decides a signature, an authorization outcome, a state
 * transition, a request schema, or a background delivery.
 */
const NAMESPACE_NEEDLES: Readonly<Record<BehaviorNamespace, readonly RegExp[]>> = Object.freeze({
  webhook: [
    /createHmac\s*\(/,
    /timingSafeEqual\s*\(/,
    /['"`]x-(?:hub-)?signature['"`]/i,
    /\b(?:verify|compute|check)Signature\s*\(/,
    /signatureProfile/,
  ],
  workflow: [
    /\bstateMachine\b/,
    /\ballowedTransitions\b/,
    /\bvalidTransitions\b/,
    /\btransitionTo\s*\(/,
    /\bworkflowState\b/,
  ],
  auth: [
    /\brequireAuth(?:entication|orized)?\b/,
    /\bisAuthenticated\b/,
    /\bcurrentUser\b/,
    /\bjsonwebtoken\b|\bjwt\s*\.\s*verify\b/,
    /\bpassport\s*\.\s*(?:authenticate|use)\b/,
    /\bget_current_user\b/,
    /\bverifyToken\s*\(/,
  ],
  validation: [
    /\bz\s*\.\s*object\s*\(/,
    /\bjoi\s*\.\s*object\s*\(/,
    /\bpydantic\b/,
    /\bclass-validator\b/,
    /\bfield_validator\b/,
    /\bvalidateSchema\s*\(/,
  ],
  task: [
    /\bnew\s+Queue\s*\(/,
    /\bnew\s+Worker\s*\(/,
    /\bqueue\.add\s*\(/,
    /\bnew\s+QueueEvents\s*\(/,
    /\battempts\s*:\s*\d/,
    /\bbackoff\s*:/,
    /\bmaxAttempts\b/,
    /\bidempotencyKey\b/,
    /\bBullMQ\b/,
    /\bCelery\b/,
  ],
});

/** One detected behavior pack, with the file that proves it. */
export interface DetectedBehaviorPack {
  /** The namespace whose cases the pack covers. */
  namespace: BehaviorNamespace;
  /** The repo-relative file the needle was read from. */
  evidenceFile: string;
  /** The needle text that matched, quoted for the printed offer. */
  evidenceNeedle: string;
}

/**
 * Parses the value of `--behavior-packs`.
 *
 * Args:
 *   value: the raw flag value (comma-separated namespaces).
 *
 * Returns:
 *   BehaviorNamespace[]: the requested namespaces, deduplicated in the
 *   canonical print order.
 *
 * Throws:
 *   Error: an unknown namespace name — the caller turns it into a usage
 *   error naming the known set, so an agent can never silently enable the
 *   wrong pack.
 */
export function parseBehaviorPacks(value: string): BehaviorNamespace[] {
  const requested: BehaviorNamespace[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (name.length === 0) continue;
    if (!(BEHAVIOR_NAMESPACES as readonly string[]).includes(name)) {
      throw new Error(
        `unknown behavior pack '${name}' (known packs: ${BEHAVIOR_NAMESPACES.join(', ')})`,
      );
    }
    if (!requested.includes(name as BehaviorNamespace)) requested.push(name as BehaviorNamespace);
  }
  return BEHAVIOR_NAMESPACES.filter((namespace) => requested.includes(namespace));
}

/**
 * Detects which behavior packs the repository shows, in print order.
 *
 * The `task` namespace is scanned ONLY when the repository's config
 * declares a `queueObserver`: the engine can only grade a delivery case
 * from a queue it reads itself, so offering the pack without one would
 * print a flag whose cases can never be satisfied. Absent the block the
 * scan never looks for those needles, which is what keeps a repository
 * without an observer byte-identical.
 *
 * Args:
 *   cwd: absolute repository root.
 *   queueObserverConfigured: whether `.gateforge.yml` declares a
 *     `queueObserver` block.
 *
 * Returns:
 *   DetectedBehaviorPack[]: one entry per detected namespace, each with
 *   the first file that proved it. Empty for a repository that shows none
 *   — the byte-identical `init` case.
 */
export function detectBehaviorPacks(
  cwd: string,
  queueObserverConfigured: boolean,
): DetectedBehaviorPack[] {
  const offered = queueObserverConfigured
    ? BEHAVIOR_NAMESPACES
    : HTTP_BEHAVIOR_NAMESPACES;
  const files: string[] = [];
  collectFiles(cwd, cwd, files);
  const found = new Map<BehaviorNamespace, DetectedBehaviorPack>();
  for (const file of files) {
    const text = readSmallText(join(cwd, file));
    if (text === null) continue;
    for (const namespace of offered) {
      if (found.has(namespace)) continue;
      for (const needle of NAMESPACE_NEEDLES[namespace]) {
        const match = needle.exec(text);
        if (match === null) continue;
        found.set(namespace, {
          namespace,
          evidenceFile: file,
          evidenceNeedle: match[0].length > 60 ? `${match[0].slice(0, 60)}…` : match[0],
        });
        break;
      }
    }
    if (found.size === offered.length) break;
  }
  return BEHAVIOR_NAMESPACES.filter((namespace) => found.has(namespace)).map(
    (namespace) => found.get(namespace) as DetectedBehaviorPack,
  );
}

/** Human sentence naming why a namespace was detected. */
export function behaviorPackEvidence(pack: DetectedBehaviorPack): string {
  return `\`${pack.evidenceNeedle}\` in ${pack.evidenceFile}`;
}

/**
 * The commented example cases init writes for the ENABLED namespaces.
 *
 * Every example is commented: the document itself must still parse as a
 * complete-behavior document with no declarations (a scaffold is never
 * approval), and an example cannot be pasted blind — its resource id is
 * the id `gateforge next` prints for the real route.
 *
 * Args:
 *   packs: the detected packs, already filtered to the enabled ones.
 *
 * Returns:
 *   string: the YAML text to append to the behavior document (may be
 *   empty when no namespace is enabled).
 */
export function behaviorSkeletonExamples(packs: readonly DetectedBehaviorPack[]): string {
  if (packs.length === 0) return '';
  return [
    '',
    ...packs.map((pack) => {
      const isTask = pack.namespace === TASK_BEHAVIOR_NAMESPACE;
      // The header names what THIS pack's example actually contains: a
      // delivery case is declared from the task resource, never from a
      // route, so the placeholders and the list key both differ.
      const header = isTask
        ? [
            "# Replace <resource-id>, <recipe-id> and <actor-id> with this repository's own",
            "# values, then uncomment the block below. The engine produces the delivery and",
            '# reads the queue itself, so these cases are graded on job attempts, never on',
            '# an HTTP attempt.',
          ]
        : [
            "# Replace <resource-id>, <METHOD>, <path>, <recipe-id> and <actor-id> with this",
            "# repository's own values, then uncomment the block below. `gateforge next`",
            '# prints the complete declaration for each discovered route, the matching',
            '# test-map entries, and the command that runs the gate.',
          ];
      return [
        `# --- ${pack.namespace}: ${behaviorPackEvidence(pack)} ---`,
        ...header,
        `# ${NAMESPACE_LIST_KEY[pack.namespace]}:`,
        ...behaviorExampleCase(pack.namespace)
          .split('\n')
          .map((line) => `#   ${line}`),
      ].join('\n');
    }),
  ].join('\n');
}

/**
 * The example case for one namespace, as the owner would write it: the
 * entry contract plus its required negative control. Values the engine
 * reads are real (`channel`, `credentialVariant`, `signatureProfile`);
 * values only the owner knows stay visibly placeheld rather than guessed.
 *
 * The `task` namespace is the exception that proves the rule: its case
 * is graded from the queue the ENGINE produced, so it declares a
 * `deliver` action on the `engine-task` channel and an `attempts` state
 * rule — never an HTTP request, which could never settle a delivery.
 *
 * Args:
 *   namespace: the behavior namespace.
 *
 * Returns:
 *   string: the YAML case list for one endpoint or task resource.
 */
export function behaviorExampleCase(namespace: BehaviorNamespace): string {
  if (namespace === TASK_BEHAVIOR_NAMESPACE) {
    return [
      '- resourceId: <resource-id>         # the task resource id the queueObserver binds',
      '  effects: []',
      '  cases:',
      `    - id: ${slugOf(TASK_EXAMPLE_CONTRACT)}`,
      `      contract: ${TASK_EXAMPLE_CONTRACT}`,
      '      channel: engine-task         # only the engine\'s own queue read can settle this',
      '      fixture: <recipe-id>          # the recipe id in fixtures/behavior-fixtures.yml',
      '      actor: <actor-id>            # an actor of that recipe',
      '      action:',
      '        kind: deliver',
      '        resourceId: <resource-id>',
      '        payload: {from: fixture, key: <payload-key>}',
      '        idempotencyKey: {from: literal, value: <idempotency-key>}',
      '        deliveryId: {from: literal, value: <delivery-id>}',
      '        count: 1',
      '        schedule: serial',
      '      expect:',
      '        statuses: []               # a delivery answers no HTTP status',
      '        response: []',
      '        state:',
      '          - kind: attempts',
      '            resourceId: <resource-id>',
      '            count: <max-attempts>   # the retry bound the queue declares',
      '            terminal: succeeded     # succeeded | failed | rejected',
    ].join('\n');
  }
  const contract = BEHAVIOR_NAMESPACE_CONTRACTS[namespace];
  return [
    '- resourceId: <resource-id>',
    '  effects: []',
    '  cases:',
    `    - id: ${slugOf(contract.accepted)}`,
    `      contract: ${contract.accepted}`,
    `      channel: ${contract.channel}`,
    `      fixture: <recipe-id>          # the recipe id in fixtures/behavior-fixtures.yml`,
    '      actor: <actor-id>            # an actor of that recipe',
    '      action:',
    '        kind: request',
    '        method: <METHOD>',
    '        pathTemplate: <path>       # what `gateforge next` prints for this route',
    '        path: {}',
    '        query: {},',
    '        body: {encoding: json, fields: {}}',
    `        credentialVariant: ${contract.credential}`,
    '      expect:',
    `        statuses: [${contract.acceptedStatus}]`,
    '        response: []',
    `    - id: ${slugOf(contract.rejected)}`,
    `      contract: ${contract.rejected}`,
    `      controlCase: ${slugOf(contract.accepted)}`,
    `      channel: ${contract.channel}`,
    '      fixture: <recipe-id>',
    '      actor: <actor-id>',
    '      action:',
    '        kind: request',
    '        method: <METHOD>',
    '        pathTemplate: <path>',
    '        path: {}',
    '        query: {}',
    '        body: {encoding: json, fields: {}}',
    `        credentialVariant: ${contract.rejectedCredential}`,
    '      expect:',
    `        statuses: [${contract.rejectedStatus}]`,
    '        response: []',
  ].join('\n');
}

/**
 * The contract the task example proves: the queue's own retry bound, the
 * claim the engine's queue read is the only thing that can settle.
 */
const TASK_EXAMPLE_CONTRACT = 'task:retry-policy-enforced';

/** Per-namespace declaration defaults, in the engine's own vocabulary. */
interface NamespaceContracts {
  /** The contract the positive case proves. */
  accepted: string;
  /** Its required negative control (fail-closed, never optional). */
  rejected: string;
  /** The channel the engine drives this namespace through. */
  channel: string;
  /** The credential the positive case presents. */
  credential: string;
  /** The credential the negative control forges or withholds. */
  rejectedCredential: string;
  /** The status the positive case expects. */
  acceptedStatus: number;
  /** The status the negative control expects. */
  rejectedStatus: number;
}

/** The engine's per-namespace declaration vocabulary. */
const BEHAVIOR_NAMESPACE_CONTRACTS: Readonly<
  Record<(typeof HTTP_BEHAVIOR_NAMESPACES)[number], NamespaceContracts>
> = Object.freeze({
    webhook: {
      accepted: 'webhook:signature-accepted',
      rejected: 'webhook:signature-rejected',
      channel: 'engine-http',
      credential: 'valid',
      rejectedCredential: 'valid',
      acceptedStatus: 200,
      rejectedStatus: 401,
    },
    workflow: {
      accepted: 'workflow:transition-allowed',
      rejected: 'workflow:transition-rejected',
      channel: 'engine-http',
      credential: 'valid',
      rejectedCredential: 'valid',
      acceptedStatus: 200,
      rejectedStatus: 409,
    },
    auth: {
      accepted: 'auth:role-allowed',
      rejected: 'auth:role-denied',
      channel: 'engine-http',
      credential: 'valid',
      rejectedCredential: 'invalid',
      acceptedStatus: 200,
      rejectedStatus: 403,
    },
    validation: {
      accepted: 'validation:boundary-accepted',
      rejected: 'validation:boundary-rejected',
      channel: 'engine-http',
      credential: 'valid',
      rejectedCredential: 'valid',
      acceptedStatus: 200,
      rejectedStatus: 422,
    },
  });

/** The case id slug of a contract name (`webhook:signature-accepted` → `signature-accepted`). */
function slugOf(contract: string): string {
  return contract.slice(contract.indexOf(':') + 1);
}

/** Recursively collects repo-relative file paths, skipping ignored directories. */
function collectFiles(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectFiles(root, absolute, out);
    } else if (stat.isFile() && /\.(js|jsx|mjs|cjs|ts|tsx|py)$/.test(entry)) {
      out.push(relative(root, absolute).split('\\').join('/'));
      if (out.length >= 4_000) return;
    }
  }
}

/** Reads a small text file; returns null when unreadable or too large. */
function readSmallText(absolute: string): string | null {
  try {
    if (!existsSync(absolute)) return null;
    const stat = statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// The per-endpoint declaration `gateforge next` prints (Phase 4, item 2).
// ---------------------------------------------------------------------------

/** One adapter-backed entity a case's expectation is graded against. */
export interface BehaviorEffectFacts {
  /** The effect id, which is also the scope name the observer returns. */
  id: string;
  /** The classified resource id of the entity. */
  resourceId: string;
  /** The reviewed adapter bound to the entity. */
  adapter: string;
  /** The entity's ordered identity columns. */
  identityFields: readonly string[];
  /** The entity's writable columns. */
  fields: readonly string[];
}

/** The facts about one discovered endpoint a declaration needs. */
export interface BehaviorEndpointFacts {
  /** The classified resource id of the endpoint. */
  resourceId: string;
  /** `METHOD /path`, as discovery reports it. */
  routeName: string;
  /** The HTTP method the detector reported. */
  method: string;
  /** The canonical path the detector reported. */
  path: string;
  /** The adapter-backed entities the case may be graded against. */
  effects: readonly BehaviorEffectFacts[];
}

/** One declared fixture recipe, as the repository declares it. */
export interface BehaviorRecipeFacts {
  /** The recipe id a case names in its `fixture:` key. */
  id: string;
  /** The actor the case acts as. */
  actor: string;
  /** The subject key the case's request body is built from. */
  subject: string;
  /**
   * The row a successful delivery is expected to create, as the owner
   * declared it next to the recipe. A mutation contract cannot be proven
   * without it, so its absence is reported, never guessed.
   */
  creates: Readonly<Record<string, string | number | boolean>> | null;
}

/** One printed case: the declaration plus everything keyed by its id. */
export interface BehaviorCasePrint {
  /** The case id slug inside the endpoint's `cases:` list. */
  id: string;
  /** The contract the case proves. */
  contract: string;
  /** The canonical case id the compiler hashes for this slug. */
  caseId: string;
  /** The obligation id the case compiles into. */
  obligationId: string;
  /** The proof test's title. */
  title: string;
  /** The test-map key for that test. */
  testKey: string;
}

/** The complete printed declaration for one endpoint. */
export interface BehaviorDeclarationPrint {
  /** The `endpoints:` entry, or null when it cannot be completed here. */
  entry: string | null;
  /** One plain line naming why no complete entry could be printed. */
  incompleteReason: string | null;
  /** Every case the entry declares, in declaration order. */
  cases: readonly BehaviorCasePrint[];
}

/** What one contract's case must look like, in the engine's vocabulary. */
interface ContractShape {
  /** The status a successful execution answers with. */
  status: number;
  /** The state rule the case is graded on. */
  state: 'created' | 'unchanged';
  /** The signature profile the engine signs with, when the namespace has one. */
  signatureProfile?: string;
  /** The credential variant the case presents. */
  credential: string;
  /** The positive counterpart whose acceptance this case needs as a control. */
  control?: string;
}

/**
 * The per-contract shapes the engine's own webhook driver expects. They
 * are the engine's semantics, not a guess: a positive signature is 200
 * and records a row, a forged one is 401 and records nothing, a replay
 * leaves the single row alone.
 */
const CONTRACT_SHAPES: Readonly<Record<string, ContractShape>> = Object.freeze({
  'webhook:signature-accepted': { status: 200, state: 'created', signatureProfile: 'hmac-sha256', credential: 'valid' },
  'webhook:signature-rejected': {
    status: 401,
    state: 'unchanged',
    signatureProfile: 'hmac-sha256;forgery=signature',
    credential: 'valid',
    control: 'webhook:signature-accepted',
  },
  'webhook:malformed-rejected': {
    status: 400,
    state: 'unchanged',
    signatureProfile: 'hmac-sha256;malformed=body',
    credential: 'valid',
    control: 'webhook:signature-accepted',
  },
  'webhook:replay-idempotent': { status: 200, state: 'unchanged', signatureProfile: 'hmac-sha256', credential: 'valid' },
  'webhook:retry-bounded': { status: 429, state: 'unchanged', signatureProfile: 'hmac-sha256', credential: 'valid' },
});

/**
 * The case shape a contract falls back to when it has no engine-proven
 * one. A namespace with no per-namespace table (the `task` one, whose
 * cases are graded from the queue rather than from a response) takes the
 * neutral transport shape; the caller refuses to print a delivery case
 * here at all.
 */
function defaultShape(contract: string): ContractShape {
  const namespace = contract.slice(0, contract.indexOf(':'));
  const contracts = (BEHAVIOR_NAMESPACE_CONTRACTS as Readonly<Record<string, NamespaceContracts>>)[
    namespace
  ];
  if (contracts === undefined) return { status: 200, state: 'unchanged', credential: 'valid' };
  if (contract === contracts.rejected) {
    return {
      status: contracts.rejectedStatus,
      state: 'unchanged',
      credential: contracts.rejectedCredential,
      control: contracts.accepted,
    };
  }
  return { status: contracts.acceptedStatus, state: 'unchanged', credential: contracts.credential };
}

/** The engine-proven shape of a contract, or its namespace default. */
function shapeOf(contract: string): ContractShape {
  return CONTRACT_SHAPES[contract] ?? defaultShape(contract);
}

/**
 * Builds the complete `endpoints:` entry `gateforge next` prints for one
 * discovered route.
 *
 * Everything in the printed text is real: the resource id, the method and
 * path discovery reported, the adapter-backed entity the case is graded
 * against, the recipe the owner declared next to the app, and the case
 * ids the compiler will hash. When a fact is missing the entry is
 * `null` and the reason is printed instead — a declaration that cannot
 * be completed here is never printed as if it could.
 *
 * Args:
 *   input: the endpoint's facts, the contracts the policy requires of
 *   it, and the fixture recipe the repository declares.
 *   caseIdFor: the canonical case-id recipe (`sha256` over domain,
 *   resource id and slug), injected so this module stays free of the
 *   engine's hashing import.
 *
 * Returns:
 *   BehaviorDeclarationPrint: the printable entry and its cases.
 */
export function buildEndpointDeclaration(input: {
  endpoint: BehaviorEndpointFacts;
  requiredContracts: readonly string[];
  recipe: BehaviorRecipeFacts | null;
  caseIdFor: (resourceId: string, slug: string) => string;
  specFile: string;
  project: string;
  runner: string;
}): BehaviorDeclarationPrint {
  const contracts = input.requiredContracts.filter((contract) => contract.includes(':'));
  if (contracts.length === 0) {
    return {
      entry: null,
      incompleteReason:
        'no behavior policy requires a contract for this route, so there is no case to declare — ' +
        'name the contract this route must satisfy in the policy document first',
      cases: [],
    };
  }
  const effect = input.endpoint.effects[0];
  if (effect === undefined) {
    return {
      entry: null,
      incompleteReason:
        'no adapter-backed entity is declared for this repository, so a case has no real state to be ' +
        'graded against — add the entity and its reviewed adapter under .gateforge/adapters first',
      cases: [],
    };
  }
  if (input.recipe === null) {
    return {
      entry: null,
      incompleteReason:
        'no fixture recipe is declared, so the engine has no provider-supplied request to drive — ' +
        'declare one under fixtures/ with its actor, its subject and the row a delivery creates',
      cases: [],
    };
  }
  const recipe = input.recipe;
  const cases: BehaviorCasePrint[] = [];
  const lines: string[] = [
    `  - resourceId: ${input.endpoint.resourceId}`,
    '    effects:',
    `      - id: ${effect.id}`,
    `        resourceId: ${effect.resourceId}`,
    `        adapter: ${effect.adapter}`,
    `        scope: ${effect.id}`,
    `        identityFields: [${effect.identityFields.join(', ')}]`,
    `        fields: [${effect.fields.join(', ')}]`,
    '        completion: immediate',
    '    cases:',
  ];
  for (const contract of contracts) {
    const shape = shapeOf(contract);
    const slug = slugOf(contract);
    if (shape.state === 'created' && recipe.creates === null) {
      return {
        entry: null,
        incompleteReason:
          `'${contract}' is proved by what a delivery CREATES, and the recipe '${recipe.id}' does not ` +
          'declare that row — add it under `creates:` in the fixture declaration',
        cases: [],
      };
    }
    const caseId = input.caseIdFor(input.endpoint.resourceId, slug);
    const title = `gateforge proves ${slug}`;
    cases.push({
      id: slug,
      contract,
      caseId,
      obligationId: `${input.endpoint.resourceId}:${contract}`,
      title,
      testKey: `${input.runner}:${input.project}:${input.specFile}:${title}`,
    });
    lines.push(
      `      - id: ${slug}`,
      `        contract: ${contract}`,
      ...(shape.control === undefined
        ? []
        : [`        controlCase: ${slugOf(shape.control)}`]),
      '        channel: engine-http',
      `        fixture: ${recipe.id}`,
      `        actor: ${recipe.actor}`,
      '        action:',
      '          kind: request',
      `          method: ${input.endpoint.method}`,
      `          pathTemplate: ${input.endpoint.path}`,
      '          path: {}',
      '          query: {}',
      '          body:',
      '            encoding: raw',
      `            fixture: ${recipe.subject}`,
      `          credentialVariant: ${shape.credential}`,
      ...(shape.signatureProfile === undefined
        ? []
        : [`          signatureProfile: ${shape.signatureProfile}`]),
      '        expect:',
      `          statuses: [${shape.status}]`,
      '          response: []',
      '          state:',
      ...(shape.state === 'unchanged'
        ? [`            - kind: unchanged`, `              scope: ${effect.id}`]
        : [
            `            - kind: created`,
            `              scope: ${effect.id}`,
            '              rows:',
            '                - fields:',
            ...Object.entries(recipe.creates ?? {}).map(
              ([field, value]) => `                    ${field}: {from: literal, value: ${JSON.stringify(value)}}`,
            ),
          ]),
    );
  }
  return { entry: lines.join('\n'), incompleteReason: null, cases };
}

/**
 * The proof test the printed cases are proven through: one test per case,
 * each naming its canonical case id and asking the ENGINE to drive it.
 * The test body asserts only that the engine sealed a record — clicks and
 * assertions of its own would prove nothing.
 *
 * Args:
 *   input: the endpoint id and the printed cases.
 *
 * Returns:
 *   string: the complete spec file content.
 */
export function renderProofSpec(input: {
  resourceId: string;
  cases: readonly BehaviorCasePrint[];
}): string {
  return [
    `// Generated for ${input.resourceId} by \`gateforge next\`.`,
    '// Each test names ONE canonical case id and asks the engine to drive it:',
    '// the ENGINE executes the case and seals the record. A test body that',
    '// only clicks proves nothing.',
    "import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';",
    "import { sha256Canonical, BEHAVIOR_CASE_DOMAIN } from '@gate-forge/core';",
    '',
    `const RESOURCE_ID = ${JSON.stringify(input.resourceId)};`,
    '',
    'function caseIdOf(slug) {',
    '  return sha256Canonical({ domain: BEHAVIOR_CASE_DOMAIN, resourceId: RESOURCE_ID, id: slug });',
    '}',
    '',
    ...input.cases.flatMap((entry) => [
      `gateforgeTest(${JSON.stringify(entry.title)}, async ({ evidence }) => {`,
      `  const sealed = await evidence.prove(caseIdOf(${JSON.stringify(entry.id)}));`,
      "  expect(sealed.state).toBe('sealed');",
      '  expect(sealed.recordIds.length).toBeGreaterThan(0);',
      '});',
      '',
    ]),
  ].join('\n');
}

/**
 * The `.gateforge/test-map.yml` entries that connect each printed case to
 * its proof test. Mapping is intent — only engine-issued case evidence
 * can satisfy the claim — so the entries carry the real case ids.
 *
 * Args:
 *   input: the printed cases and the runner identity that keys them.
 *
 * Returns:
 *   string: the `tests:` entries, indented for the document.
 */
export function renderTestMapEntries(input: {
  cases: readonly BehaviorCasePrint[];
  specFile: string;
  project: string;
  runner: string;
}): string {
  return input.cases
    .map((entry) =>
      [
        `  - key: ${JSON.stringify(entry.testKey)}`,
        '    selector:',
        `      runner: ${input.runner}`,
        `      project: ${input.project}`,
        `      file: ${input.specFile}`,
        '      titlePath:',
        `        - ${JSON.stringify(entry.title)}`,
        '    kind: browser-e2e',
        '    claims:',
        `      - ${entry.obligationId}`,
        '    caseIds:',
        `      - ${entry.caseId}`,
        `    reason: the engine drives the ${entry.id} case for this route`,
      ].join('\n'),
    )
    .join('\n');
}

/**
 * Reads the fixture recipes a repository declares. Any YAML document
 * under `fixtures/` that carries a `recipes:` list is read, so an
 * application may keep one shared file or one per namespace.
 *
 * Args:
 *   cwd: absolute repository root.
 *
 * Returns:
 *   BehaviorRecipeFacts[]: the declared recipes in document order; empty
 *   when the repository declares none.
 */
export function loadBehaviorRecipes(cwd: string): BehaviorRecipeFacts[] {
  const fixturesDir = join(cwd, 'fixtures');
  let entries: string[];
  try {
    entries = readdirSync(fixturesDir).filter((name) => /\.ya?ml$/.test(name)).sort();
  } catch {
    return [];
  }
  const recipes: BehaviorRecipeFacts[] = [];
  for (const name of entries) {
    const text = readSmallText(join(fixturesDir, name));
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const declared = (parsed as { recipes?: unknown }).recipes;
    if (!Array.isArray(declared)) continue;
    for (const raw of declared) {
      if (typeof raw !== 'object' || raw === null) continue;
      const recipe = raw as {
        id?: unknown;
        actor?: unknown;
        actors?: unknown;
        subject?: unknown;
        subjects?: unknown;
        creates?: unknown;
      };
      if (typeof recipe.id !== 'string' || recipe.id.length === 0) continue;
      const subjects = Array.isArray(recipe.subjects) ? recipe.subjects : [];
      const actors = Array.isArray(recipe.actors) ? recipe.actors : [];
      const subject =
        typeof recipe.subject === 'string'
          ? recipe.subject
          : typeof subjects[0] === 'string'
            ? subjects[0]
            : `${recipe.id}-input`;
      const actor =
        typeof recipe.actor === 'string'
          ? recipe.actor
          : typeof recipe.actors === 'string'
            ? recipe.actors
            : typeof actors[0] === 'string'
              ? actors[0]
              : 'provider';
      recipes.push({
        id: recipe.id,
        actor,
        subject,
        creates: readCreates(recipe.creates),
      });
    }
  }
  return recipes;
}

/** The scalar row a recipe declares a successful delivery creates. */
function readCreates(value: unknown): Record<string, string | number | boolean> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row: Record<string, string | number | boolean> = {};
  for (const [field, expected] of Object.entries(value as Record<string, unknown>)) {
    if (typeof expected === 'string' || typeof expected === 'number' || typeof expected === 'boolean') {
      row[field] = expected;
    }
  }
  return Object.keys(row).length === 0 ? null : row;
}
