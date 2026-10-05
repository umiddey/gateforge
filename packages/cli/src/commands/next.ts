/**
 * `gateforge next`: the only agent-facing navigation command — exactly
 * ONE blocking next action, never a dump.
 *
 * Runs the same discover → classify → obligations → evaluate path as
 * `check` (without `--require-e2e`: next is navigation, not the gate),
 * collects blocking entries plus verdicts whose status is blocking, and
 * prints the single highest-ranked item. Exit 0 when clean, 1 when a
 * next action exists, 2 on config/usage errors.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join } from 'node:path';
import {
  BLOCKING_VERDICTS,
  CAUSE_NEXT_ACTIONS,
  BEHAVIOR_CASE_DOMAIN,
  HTTP_ENDPOINT_RESOURCE_KIND,
  OWNER_ANSWERS_PATH,
  PolicyFileSchema,
  sha256Canonical,
  type BlockingEntry,
  type CauseCode,
  type ClassificationDecision,
  type ChangedProvider,
  type Claim,
  type ObligationVerdict,
  type ResourceGraph,
} from '@gate-forge/core';
import {
  ENDPOINT_SEMANTICS_UNRESOLVED,
  FASTAPI_PREFIX_UNRESOLVED,
} from '@gate-forge/http-contract';
import { FASTAPI_SCAN_CONFIG_SECTION } from '@gate-forge/pack-fastapi';
import {
  discoverTestCatalog,
  TestDiscoveryError,
  type DiscoverResult,
} from '@gate-forge/pack-playwright';
import { parseArgs } from '../args.js';
import { resolveAdoptedBaseline } from '../adopted-baseline.js';
import { UsageError } from '../errors.js';
import type { Io } from '../io.js';
import { declaresSection } from '../yaml-section.js';
import { writeLine } from '../io.js';
import { evaluateRun } from '../evaluate.js';
import {
  findRunnerConfigPath,
  loadOptionalTestMap,
  mappedCoverageFrom,
  mappingBlocking,
  nativeInventoryBlocking,
  resolveRepositoryMappings,
} from '../mapping.js';
import type { MappedCoverage } from '@gate-forge/core';
import {
  collectInputFiles,
  computeInputSnapshot,
  diffInputFiles,
  symlinkNotices,
  SnapshotUnavailableError,
  UnsupportedSnapshotError,
  type SnapshotFileEntry,
} from '../input-snapshot.js';
import { runPipeline, sourcesByResourceId } from '../pipeline.js';
import { changeBaseTextReader, resolveProvider } from '../providers.js';
import { computeEvaluationScope, detectStagedWorkingTreeMismatches } from '../scope.js';
import { httpRoutesView, resolveStateDir } from '../state.js';
import { gateforgeOwnedInputs } from '../gateforge-owned.js';
import { engineGeneratedStateFileFilter } from '../state-artifacts.js';
import { loadConfigAt, rejectUnknownFlags, VERIFIER_KEY_ENV } from './common.js';
import { loadCacheExclusions } from '../cache-exclusions.js';
import { singletonPerTenantGuidanceLines } from '../singleton-guidance.js';
import { unmatchedRouteBannerLines } from '../unmatched-routes.js';
import {
  buildEndpointDeclaration,
  loadBehaviorRecipes,
  renderProofSpec,
  renderTestMapEntries,
  type BehaviorDeclarationPrint,
  type BehaviorEffectFacts,
  type BehaviorEndpointFacts,
} from '../behavior-setup.js';
import { ENDPOINT_CAPABILITIES } from '../endpoint-config.js';

export const NEXT_USAGE = 'usage: gateforge next [--changed] [--json]';

/**
 * The causes that mean "this repository has no proof yet" rather than
 * "this proof failed". A fresh repository owes all three at once, so the
 * behavior setup is printed for any of them.
 */
const SETUP_CAUSES: readonly CauseCode[] = [
  'ENDPOINT_BEHAVIOR_MISSING',
  'TEST_INVENTORY_INCOMPLETE',
  'TEST_MAPPING_MISSING',
];

const ENVIRONMENT_GUIDES: Partial<Record<CauseCode, string>> = {
  EVIDENCE_STALE: 'packages/cli/guides/TEST-ENVIRONMENT.md#keep-the-repository-unchanged-during-a-run',
  ENFORCEMENT_UNTRUSTED: 'packages/cli/guides/TEST-ENVIRONMENT.md#run-containers-as-your-user',
  RUN_INCOMPLETE: 'packages/cli/guides/TEST-ENVIRONMENT.md#register-the-same-tests-in-every-mode',
};

/**
 * One ranked navigation candidate: a blocking entry or a blocking
 * verdict, normalized to the `next/cause/why/do` surface.
 */
interface NextCandidate {
  /** Obligation id or resource id (human identity of the item). */
  id: string;
  /** Stable cause code (never null — unmapped causes get a fallback). */
  cause: string;
  /** Single-cause human explanation. */
  why: string;
  /** The single imperative action. */
  do: string;
  /** The blocking entry's kind, or `'verdict'` for an obligation. */
  kind: string;
  /** Rank per the plan §2 table (lower wins). */
  rank: number;
  /**
   * Tie-break inside one rank: 0 when the item is a real business route
   * (linked to a model, or consumed by the frontend), 1 otherwise.
   */
  focus: number;
}

/**
 * Endpoint identities that carry real application weight.
 *
 * A route the engine LINKED to a business model, or that the frontend
 * statically CONSUMES, is business surface: answering it moves the
 * product forward. A route with neither (a demo endpoint, an internal
 * probe, a leftover script) is still reported — it is never hidden —
 * but it must not be the FIRST thing an agent or an owner is told to
 * do, which is where alphabetical id order used to put it: the top item
 * of a thousand was a fifteen-line demo app's `/api/test`.
 *
 * Both the plane-qualified resource id and the bare resource name are
 * registered, because a plane-unresolved endpoint has no id at all and
 * is reported under its name.
 *
 * Args:
 *   graph: the built resource graph.
 *
 * Returns:
 *   ReadonlySet<string>: the focused route identities.
 */
function focusedRouteKeys(graph: ResourceGraph): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const resource of graph.resources) {
    if (resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND) continue;
    const linked = resource.attributes['linkedResourceName'];
    const isLinked = typeof linked === 'string' && linked.length > 0;
    if (!isLinked && resource.attributes['frontendConsumed'] !== true) continue;
    if (resource.id !== null) keys.add(resource.id);
    keys.add(resource.name);
  }
  return keys;
}

/**
 * Whether one ranked item belongs to a focused route — either the route
 * itself or an obligation carried by it (`<resourceId>:<contract>`).
 *
 * Args:
 *   focused: the focused route identities.
 *   id: the candidate id (resource name/id, or an obligation id).
 *
 * Returns:
 *   number: 0 when focused, 1 otherwise.
 */
function routeFocus(focused: ReadonlySet<string>, id: string): number {
  if (focused.has(id)) return 0;
  for (const key of focused) {
    if (id.startsWith(`${key}:`)) return 0;
  }
  return 1;
}

/**
 * Ranks a cause per the plan §2 table: capability gaps first, mapping
 * intent last, everything else blocking after that.
 */
function rankCause(cause: CauseCode | null | undefined, kind: string): number {
  switch (cause) {
    case 'VERIFIER_UNSUPPORTED':
      return 1;
    // Complete-behavior setup/declaration problems block before any
    // test-generation advice: an owner document gap is not something a
    // test can fix.
    case 'ENDPOINT_BEHAVIOR_MISSING':
    case 'BEHAVIOR_REFERENCE_STALE':
    case 'BEHAVIOR_CASE_UNMAPPED':
    case 'BEHAVIOR_CASE_MISSING':
    case 'BEHAVIOR_BINDING_MISMATCH':
    case 'BEHAVIOR_EFFECT_MISMATCH':
    case 'OBSERVATION_SCOPE_INCOMPLETE':
    case 'BEHAVIOR_UNEXPECTED_EFFECT':
    case 'ENFORCEMENT_BOUNDARY_UNVERIFIED':
      return 2;
    case 'MIGRATION_MISSING':
    case 'MIGRATION_LINEAGE_BROKEN':
    case 'MIGRATION_DOWNGRADE_NOOP':
    case 'MIGRATION_DRIFT':
    case 'MIGRATION_ROUNDTRIP_FAILED':
    case 'MIGRATION_DATA_LOST':
    case 'MIGRATION_CONFLICT':
    case 'MIGRATION_SCRATCH_UNSAFE':
      return 2;
    case 'CRUD_COVERAGE_MISSING':
      return 3;
    case 'CHANGE_UNMAPPED':
      return 4;
    case 'ENFORCEMENT_UNTRUSTED':
      return 5;
    case 'EVIDENCE_NOT_COLLECTED':
      return 6;
    case 'EVIDENCE_STALE':
    case 'RUN_INCOMPLETE':
    case 'TEST_NOT_EXECUTED':
    case 'TEST_FAILED':
      return 7;
    case 'TEST_INVENTORY_INCOMPLETE':
      return 0;
    case 'TEST_MAPPING_MISSING':
    case 'TEST_MAPPING_AMBIGUOUS':
    case 'TEST_MAPPING_STALE':
    case 'TEST_KIND_UNKNOWN':
      return 8;
    default:
      break;
  }
  if (cause === null || cause === undefined) {
    // Unclassified / unresolved / parse findings sort right after
    // capability gaps; a blocking verdict without a cause is still an
    // unsatisfied obligation (missing-evidence rank).
    if (kind === 'unclassified' || kind === 'unresolved' || kind === 'finding') return 2;
    if (kind === 'verdict') return 6;
    return 9;
  }
  return 9;
}

/**
 * Normalizes blocking entries + blocking verdicts into ranked
 * candidates.
 *
 * Order: cause rank first (unchanged — a capability gap still outranks
 * everything), then business weight, then id. The focus tie-break only
 * ever reorders items of the SAME rank, so it cannot demote anything
 * the plan says must come first; it only stops alphabetical id order
 * from putting an unlinked demo route at the top of a thousand-item
 * list.
 *
 * Args:
 *   blocking: the run's blocking entries.
 *   verdicts: the run's obligation verdicts.
 *   focused: endpoint identities with real business weight.
 *
 * Returns:
 *   NextCandidate[]: ranked candidates.
 */
function rankBlockers(
  blocking: readonly BlockingEntry[],
  verdicts: readonly ObligationVerdict[],
  focused: ReadonlySet<string>,
): NextCandidate[] {
  const candidates: NextCandidate[] = [];
  for (const entry of blocking) {
    const cause = entry.cause ?? null;
    candidates.push({
      id: entry.resourceId ?? entry.name ?? 'repo',
      cause: cause ?? 'BLOCKING_FINDING',
      why: entry.detail,
      do:
        entry.nextAction ??
        (cause !== null
          ? CAUSE_NEXT_ACTIONS[cause]
          : entry.resourceId !== null && entry.resourceId !== undefined
            ? `gateforge explain ${entry.resourceId}`
            : 'gateforge discover --json'),
      kind: entry.kind,
      rank: rankCause(cause, entry.kind),
      focus: routeFocus(focused, entry.resourceId ?? entry.name ?? 'repo'),
    });
  }
  for (const verdict of verdicts) {
    if (!BLOCKING_VERDICTS.includes(verdict.verdict)) continue;
    const cause = verdict.cause ?? null;
    candidates.push({
      id: verdict.obligation.id,
      cause: cause ?? 'EVIDENCE_NOT_COLLECTED',
      why: verdict.reason ?? `obligation '${verdict.obligation.id}' is ${verdict.verdict}`,
      do:
        verdict.nextAction ??
        (cause !== null ? CAUSE_NEXT_ACTIONS[cause] : CAUSE_NEXT_ACTIONS['EVIDENCE_NOT_COLLECTED']),
      kind: 'verdict',
      rank: rankCause(cause, 'verdict'),
      focus: routeFocus(focused, verdict.obligation.id),
    });
  }
  candidates.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.focus !== b.focus
        ? a.focus - b.focus
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  return candidates;
}

/**
 * The state-changing command that clears ONE classifier block. A code
 * with no entry here is never given an invented command.
 */
const CLASSIFIER_BLOCK_ANSWERS: Readonly<Record<string, string>> = {
  ADAPTER_MISSING:
    '`gateforge adapters scaffold` — run it, then review the adapter it writes for this resource',
  DELETE_SEMANTICS_UNRESOLVED:
    "declare what the endpoint does — a 'crud-archive' or 'crud-delete' rule in the endpoints: section of '.gateforge/classification-policy.yml' (works with no linked model), or `gateforge classify delete <file|folder|glob> <hard|archive> --reason '<why>' --confirm` to write the owner's deleteRules entry",
  PLANE_UNRESOLVED:
    "gateforge classify plane <file|folder|glob> <tenant|master|global> --reason '<why>' --confirm — or change the existing rule for that source in the planes: section of '.gateforge/classification-policy.yml'",
};

/**
 * The answer for a resource the classifier blocked DEFINITIONALLY: it
 * has no effective classification, so nothing on it can be graded.
 *
 * The block used to be exactly three lines ending in `do: gateforge
 * classify --json` — a read-only dump that writes nothing, so the
 * documented loop (run the printed command, run `next` again) printed
 * the identical block forever, and nothing named the blocks that
 * actually hold the resource. `gateforge explain <id>` shows them, so
 * the id this block prints is the one that resolves.
 *
 * Args:
 *   candidate: the ranked next item.
 *   decisions: the run's classifier decisions.
 *
 * Returns:
 *   { do: string; lines: string[] }: the imperative action and the
 *     explanation, or `null` when this candidate is not such a block.
 */
function classifierBlockGuidance(
  candidate: NextCandidate,
  decisions: readonly ClassificationDecision[],
): { do: string; lines: string[] } | null {
  if (candidate.kind !== 'unclassified') return null;
  const decision = decisions.find((row) => row.name === candidate.id || row.resourceId === candidate.id);
  const blocks = decision?.blocks ?? [];
  if (blocks.length === 0) return null;
  const first = blocks[0] as { code: string };
  const answer = CLASSIFIER_BLOCK_ANSWERS[first.code];
  return {
    do: answer ?? `read every block on this resource with \`gateforge explain ${shellQuote(candidate.id)}\``,
    lines: [
      'about this block: the classifier refused this resource definitionally, so it carries no effective',
      'classification and nothing on it can be graded. `gateforge classify --json` only LISTS these blocks — it',
      'writes nothing, so running it and running `gateforge next` again prints this identical block. What closes',
      'each one:',
      ...blocks.map(
        (block) =>
          `  [${block.code}] — ${CLASSIFIER_BLOCK_ANSWERS[block.code] ?? 'nothing in Gateforge closes this on your behalf; its evidence is below'}`,
      ),
      `Read every block and the evidence behind it: gateforge explain ${shellQuote(candidate.id)}`,
    ],
  };
}

/**
 * Quotes one shell argument so generated commands can be copied safely.
 *
 * Args:
 *   value: the argument text.
 *
 * Returns:
 *   string: a POSIX single-quoted argument.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds owner-directed advice for an endpoint with no resolved plane.
 *
 * Every printed command runs exactly as printed, and no line printed
 * with it is something a user could paste into a shell by mistake: the
 * prerequisite that creates the owner-reviewed planes file is printed
 * FIRST (the plane command below it exits 2 without that file) and ONLY
 * while that file is absent — repeating "run this once" on every route
 * makes the sentence false for everyone but the first.
 *
 * Args:
 *   routeName: canonical method and path shown to the user.
 *   resourceName: detector identity used by the owner-only policy edit.
 *   source: router source file used by the plane writer.
 *   cwd: absolute repository root (the planes file is repo-relative).
 *
 * Returns:
 *   string[]: ordered question, runnable commands, and exact policy edit.
 */
function unresolvedRouteGuidance(
  routeName: string,
  resourceName: string,
  source: string,
  cwd: string,
): string[] {
  const choices = ['tenant', 'master', 'global'] as const;
  const commands = choices.map((plane) => {
    const reason = `Owner review confirms the ${plane} plane for ${routeName}.`;
    return `gateforge classify plane ${shellQuote(source)} ${plane} --reason ${shellQuote(reason)} --confirm`;
  });
  const answersPath = join(cwd, OWNER_ANSWERS_PATH);
  const planesMissing =
    !existsSync(answersPath) ||
    !declaresSection(readFileSync(answersPath, 'utf8'), ['planes'], OWNER_ANSWERS_PATH);
  return [
    // One plain line BEFORE the question: a new repo meets this
    // question first, and no shipped document prepares anyone for it.
    // It says what is being asked, why only the owner can answer it,
    // and what each answer does next — so the question is answerable
    // from the output alone.
    'about this question: this route has no data plane, so Gateforge cannot tell whether its records are ' +
      'per-tenant, shared master data, or global — that is an owner decision no detector can read from the ' +
      'code. Answer once, then run only the `classify plane` command for that answer (tenant / master / ' +
      'global), or, if the route is not used by real users, the internal rule printed at the end.',
    `question: ${routeName} — is this route used by real users, and which data plane owns its records?`,
    'This edits a classification input; re-approve any approved policy pin before strict gates run.',
    ...(planesMissing
      ? [
          `The plane command below needs the owner-reviewed \`planes:\` section of '${OWNER_ANSWERS_PATH}' first — run this once to create it:`,
          'gateforge init --planes',
        ]
      : []),
    'Then choose only the command for the boundary confirmed by the owner:',
    ...commands,
    'Owner-only alternative: only if this route is genuinely internal, edit `.gateforge/classification-policy.yml` under `internalRules`:',
    '  - match:',
    '      resourceKind: http.endpoint',
    `      resourceName: ${JSON.stringify(resourceName)}`,
    '    reason: "<owner-written reason and evidence for treating this route as internal>"',
    'An internal rule is certificate-checked; it is not an override.',
  ];
}

/**
 * Builds the owner-authored capability declaration for an endpoint whose
 * semantics no detector could prove, so the block that otherwise ends in
 * a read-only `discover --json` dump becomes answerable from the output
 * alone.
 *
 * The printed document IS the schema the compiler reads (see
 * `endpoint-config.ts`): one rule, scoped to THIS endpoint by its exact
 * method and canonical path, with the two owner-chosen fields marked and
 * their allowed values named. Nothing else is invented — the selectors
 * and the rule shape are the product's own, so a declaration copied out
 * of this block parses and applies.
 *
 * Args:
 *   detail: the blocking entry's detail (the compiler's own sentence).
 *   graph: the run's resource graph (the endpoint identity comes from it).
 *
 * Returns:
 *   string[]: the explanation, the exact entry, and the verify command;
 *   an empty array when the detail is not an unresolved endpoint or the
 *   graph carries no matching identity.
 */
function endpointSemanticsGuidance(detail: string, graph: ResourceGraph): string[] {
  if (!detail.startsWith(`${ENDPOINT_SEMANTICS_UNRESOLVED}:`)) return [];
  const route = graph.resources.find((resource) => {
    if (resource.kind !== HTTP_ENDPOINT_RESOURCE_KIND) return false;
    const identity = resource.attributes['identity'];
    return typeof identity === 'string' && detail.includes(`endpoint '${identity}'`);
  });
  if (route === undefined) return [];
  const method = route.attributes['method'];
  const canonicalPath = route.attributes['canonicalPath'];
  if (typeof method !== 'string' || typeof canonicalPath !== 'string') return [];
  // A DELETE is asked one question (archive or really delete); every
  // other verb is asked what the endpoint DOES at all. Both questions are
  // answerable in the SAME section — `endpoints:` — and the DELETE one
  // needs no linked model, so it is the only way to answer a DELETE route
  // that links no resource.
  const choices =
    method === 'DELETE'
      ? [
          "'crud-archive' (the record survives — the handler only sets an archived/deactivated state)",
          "'crud-delete' (the record is really removed)",
        ]
      : [`one of: ${ENDPOINT_CAPABILITIES.join(', ')}`];
  if (method === 'DELETE') {
    return [
      `about this block: ${method} ${canonicalPath} deletes a resource, but nothing Gateforge can read in the code`,
      'says whether the record survives — and only the owner can say.',
      `The answer is one rule in the owner-reviewed \`endpoints:\` section of '${OWNER_ANSWERS_PATH}'. Add it there`,
      '(add the section with exactly these contents if it is absent; append the rule to "rules" if it is there):',
      '```json',
      '{',
      '  "rules": [',
      '    {',
      `      "method": ${JSON.stringify(method)},`,
      `      "paths": [${JSON.stringify(canonicalPath)}],`,
      '      "capability": "<crud-archive or crud-delete>",',
      '      "reason": "<owner-written reason and evidence>"',
      '    }',
      '  ]',
      '}',
      '```',
      'The same answer can be declared per SOURCE instead, which is what a repository with many',
      'routes wants: `gateforge classify delete <file|folder|glob> <hard|archive> --reason "<why>" --confirm`',
      'writes the owner\'s `deleteRules` entry. Two `deleteRules` entries that match the same source',
      'with different semantics are a contradiction and resolve to nothing — never edit one to shadow',
      'the other.',
      ...(route.id === null
        ? []
        : [`Then prove the answer applied — \`gateforge explain ${shellQuote(route.id)}\``]),
    ];
  }
  return [
    `about this block: ${method} ${canonicalPath} is discovered, but nothing Gateforge can read in the code says what it DOES —`,
    'its logic sits behind a service call, and a method alone never decides semantics. Only the owner can',
    `answer, and the answer is one rule in the owner-reviewed \`endpoints:\` section of '${OWNER_ANSWERS_PATH}'. Add it there`,
    '(add the section with exactly these contents if it is absent; append the rule to "rules" if it is there):',
    '```json',
    '{',
    '  "rules": [',
    '    {',
    `      "method": ${JSON.stringify(method)},`,
    `      "paths": [${JSON.stringify(canonicalPath)}],`,
    '      "capability": "<owner choice>",',
    '      "reason": "<owner-written reason and evidence: what this handler really does>"',
    '    }',
    '  ]',
    '}',
    '```',
    `Then replace <owner choice> with the capability the handler really has — ${choices.join(', or ')} —`,
    'and write the reason as the evidence you read (the code, service contract or table that proves it).',
    ...(route.id === null
      ? []
      : [
          'Then prove the declaration applied — the capabilities line names the capability and the trace names the `endpoints:` declaration:',
          `gateforge explain ${shellQuote(route.id)}`,
        ]),
  ];
}

/**
 * Builds the answer for a `FASTAPI_PREFIX_UNRESOLVED` finding: an
 * `include_router(...)` mount the detector cannot follow, so no route
 * fact is emitted for it at all.
 *
 * Gateforge never guesses the effective path (a fabricated path is a
 * route the app does not serve), so the block names the ONE mechanism
 * that closes the reason it is actually reporting. The cause code covers
 * several DISTINCT reasons, and the guidance therefore keys on the
 * REASON in the detail, never on the code:
 *
 * - a COMPUTED prefix (`include_router prefix in <file> is computed`,
 *   `router '<x>' in <file> declares a computed prefix`): the value is
 *   hidden in an expression, so the fix is a literal at the mount site.
 *   Nothing else reaches it, and that is verified, not assumed — a
 *   `endpoints:` capability rule cannot match (no route
 *   fact is emitted for this mount, so a rule has no method/path to
 *   select on) and `gateforge waive` cannot resolve it (`waive: no
 *   obligation resolves for …`, exit 2).
 * - an UNRESOLVABLE or AMBIGUOUS target (`include_router target '<x>' in
 *   <file> cannot be resolved in the scanned set`, and the import-alias
 *   form of the same thing): the mount names a router the scanner cannot
 *   follow, so NO prefix edit can apply — the mount may carry no prefix
 *   at all. The remedy is a declaration,
 *   `scan.fastapi`'s `importRoots` in `.gateforge.yml`, naming the directory the
 *   absolute imports in that file are written relative to. Verified
 *   against the real python detector on the canonical template shape
 *   (`backend/app/main.py` including `app.api.main.api_router`, which
 *   includes `app.api.routes.<module>.router`): with the roots declared
 *   the whole mount resolves and every route carries its real prefix,
 *   with NO application edit — see
 *   `pack-fastapi/test/template-mount.test.ts`.
 * - an include CYCLE: no declaration reaches it, so the block says only
 *   that.
 *
 * Args:
 *   detail: the finding's `why` line (the reason code and its detail).
 *   cwd: the repository root, used to derive the import root from the
 *     file the finding names — and to print none when it cannot.
 *
 * Returns:
 *   string[]: the explanation and the real fix, or an empty array
 *     when the detail is not this cause.
 */
function fastapiPrefixGuidance(detail: string, cwd: string): string[] {
  if (!detail.startsWith(`${FASTAPI_PREFIX_UNRESOLVED}:`)) return [];
  // Every detail names the file the unprovable mount is written in, so
  // the owner is pointed at the exact file rather than at a guess.
  const site = /\bin (\S+) (?:is computed|declares a computed prefix|is an import alias)\b/.exec(
    detail,
  )?.[1] ?? '';
  if (/is computed|declares a computed prefix/.test(detail)) {
    return [
      'about this block: this mount writes its prefix from an expression, so the path every route under it ' +
        'serves cannot be read from the code — a settings attribute, a constant, or a concatenation all ' +
        'hide the value at scan time. Gateforge will not guess it: a made-up path would describe routes the ' +
        'application does not serve, so the whole mount stays unresolved until the prefix is provable.',
      `Fix it in ${site === '' ? 'the file the finding names' : site}: give the mount a literal string prefix ` +
        '(for example `app.include_router(router, prefix="/api/v1")`). A module-level constant does not help ' +
        '— the value must be written at the mount site.',
      'Nothing in Gateforge can close this finding on your behalf: a waiver needs an obligation and this has ' +
        'none, and a declared endpoint rule has no detected route to attach to. Re-run `gateforge next` after ' +
        'the edit — the routes then appear with their real prefix.',
    ];
  }
  const ambiguousRoots = ambiguousImportRoots(detail);
  const unresolvedSite =
    ambiguousRoots !== null
      ? site
      : (/\bin (\S+) (?:cannot be resolved in the scanned set|matches multiple scanned files)\b/.exec(
            detail,
          )?.[1] ?? site);
  if (ambiguousRoots !== null || /cannot be resolved in the scanned set/.test(detail)) {
    const derived = importRootForMountSite(unresolvedSite, cwd);
    const roots = ambiguousRoots ?? (derived === '' ? null : [derived]);
    const file = unresolvedSite === '' ? 'the file the finding names' : unresolvedSite;
    return [
      'about this block: this mount includes a router the scanner cannot follow, so the path every route under it',
      'serves is unknown — the module it names is not one of the scanned files. Gateforge will not guess it: a',
      'made-up path would describe routes the application does not serve. Making the prefix literal cannot help',
      'here: this mount is not written with a computed prefix, so there is no prefix expression to replace.',
      `Fix it with a declaration and NO application edit: the import roots tell the scanner which directory the`,
      `absolute imports in ${file} are written relative to.`,
      `Add this under \`${FASTAPI_SCAN_CONFIG_SECTION}\` in '.gateforge.yml' — and run \`gateforge next\` again:`,
      '```json',
      JSON.stringify(
        roots === null
          ? { importRoots: ['<the source directory that file is imported from>'] }
          : { importRoots: roots },
        null,
        2,
      ),
      '```',
      roots === null
        ? 'Replace the placeholder with that directory (one entry per import root). A root that does not hold the'
        : 'The routes under this mount then carry their real prefix and this finding is gone. A root that does not hold the',
      'unresolved module changes nothing — the scanned set stays closed, never guessed.',
    ];
  }
  if (/include cycle through/.test(detail)) {
    return [
      'about this block: the routers under this mount include each other in a cycle, so no order of mounts gives one',
      `effective path. No declaration reaches this: break the cycle at the include sites in ${site === '' ? 'the file the finding names' : site},`,
      'then re-run `gateforge next`.',
    ];
  }
  return [];
}

/**
 * The one-line `do:` that opens a `FASTAPI_PREFIX_UNRESOLVED` block. It
 * states the action of the reason {@link fastapiPrefixGuidance} explains:
 * a computed prefix is an application edit, an unfollowable target is a
 * declaration. `''` when the detail is not this cause.
 *
 * Args:
 *   detail: the finding's `why` line.
 *
 * Returns:
 *   string: the `do:` text, or `''`.
 */
function fastapiPrefixDo(detail: string): string {
  if (!detail.startsWith(`${FASTAPI_PREFIX_UNRESOLVED}:`)) return '';
  if (/is computed|declares a computed prefix/.test(detail)) {
    return 'make the mount prefix a literal at the site named below, then run `gateforge next` again';
  }
  if (ambiguousImportRoots(detail) !== null || /cannot be resolved in the scanned set/.test(detail)) {
    return `declare the import roots under \`${FASTAPI_SCAN_CONFIG_SECTION}\` in '.gateforge.yml' — the exact entry to add is below`;
  }
  return 'break the include cycle at the site named below, then run `gateforge next` again';
}

/**
 * The import roots an AMBIGUOUS-target detail already names, one per
 * conflicting file, sorted. `null` when the detail is not ambiguous — the
 * roots are then derived from the file the finding names instead.
 */
function ambiguousImportRoots(detail: string): string[] | null {
  const files = /\(([^)]*)\); the target router cannot be proven uniquely/.exec(detail)?.[1];
  if (files === undefined) return null;
  const roots = new Set<string>();
  for (const file of files.split(',')) {
    const trimmed = file.trim();
    const cut = trimmed.lastIndexOf('/');
    if (cut > 0) roots.add(trimmed.slice(0, cut));
  }
  return roots.size === 0 ? null : [...roots].sort();
}

/**
 * The source directory the finding's file is imported from, derived from
 * that file alone: the SHORTEST directory prefix under which one of its
 * own absolute imports is a real path on disk (`backend/app/api/main.py`
 * importing `app.api.routes` → `backend`). `''` when it cannot be
 * derived — the file is absent, has no absolute import, or every
 * candidate is the repository root itself — so the guidance then names
 * the declaration without inventing a directory.
 *
 * Args:
 *   file: the repo-relative file the finding names.
 *   cwd: the repository root.
 *
 * Returns:
 *   string: the repo-relative import root, or `''`.
 */
function importRootForMountSite(file: string, cwd: string): string {
  if (file === '' || file.startsWith('/')) return '';
  let source: string;
  try {
    source = readFileSync(join(cwd, file), 'utf8');
  } catch {
    return '';
  }
  const modules = new Set<string>();
  for (const match of source.matchAll(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/gmu)) {
    const dotted = match[1] as string;
    if (dotted !== '') modules.add(dotted);
  }
  if (modules.size === 0) return '';
  const segments = file.split('/');
  // Longest prefix first so the FIRST hit is the shortest root.
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const root = segments.slice(0, depth).join('/');
    const holds = [...modules].some((dotted) => {
      const base = join(cwd, root, dotted.replaceAll('.', '/'));
      return existsSync(`${base}.py`) || existsSync(join(base, '__init__.py'));
    });
    if (holds) return root;
  }
  return '';
}

/**
 * The `http.endpoint.requireObservation` scope note (plan Phase 4c,
 * E60), offered on the ONE item it can explain: an unmapped obligation
 * on a route the frontend never calls, while the pinned option is `all`.
 * That obligation exists only because the owner widened the scope, and
 * narrowing it back is a legitimate answer when the route is out of
 * scope. Anywhere else (option absent, consumed endpoints, other
 * causes) nothing is printed — the surface never adds noise.
 *
 * Args:
   candidate: the ranked next item.
   graph: the run's resource graph.
 *   observationScope: the effective pinned option.
 *   policiesPath: repo-relative policies document path.
 *
 * Returns:
 *   string[]: the note lines, or an empty array when it does not apply.
 */
function observationScopeNote(
  candidate: NextCandidate,
  graph: ResourceGraph,
  observationScope: 'consumed' | 'all',
  policiesPath: string,
): string[] {
  if (observationScope !== 'all' || candidate.cause !== 'TEST_MAPPING_MISSING') return [];
  const route = graph.resources.find(
    (resource) =>
      resource.id !== null &&
      resource.kind === HTTP_ENDPOINT_RESOURCE_KIND &&
      candidate.id.startsWith(`${resource.id}:`) &&
      resource.attributes['frontendConsumed'] !== true,
  );
  if (route === undefined) return [];
  const method = route.attributes['method'];
  const path = route.attributes['canonicalPath'];
  const name =
    typeof method === 'string' && typeof path === 'string' ? `${method} ${path}` : route.name;
  return [
    `scope: ${name} is not consumed by the frontend, so it owes this obligation only because the pinned`,
    `policy option 'http.endpoint.requireObservation' is 'all'. Prove it with a test, or set the option`,
    `back to 'consumed' in ${policiesPath} if this route is out of scope.`,
  ];
}

/**
 * The complete behavior setup `gateforge next` prints for a discovered
 * endpoint that has no approved cases yet (plan 2026-09-30 Phase 4).
 *
 * Every block is finished work, not a template: the resource id and
 * route are the ones discovery reported, the effect scope is the
 * repository's own adapter-backed entity, the recipe is the one declared
 * under `fixtures/`, and the case ids are the ids the compiler hashes.
 * When a fact the declaration needs is missing, nothing is printed as if
 * it were known — the reason is printed instead.
 *
 * Args:
 *   input: the repository root, the policies document path, the run's
 *   graph, and the endpoint's classified resource id.
 *
 * Returns:
 *   string[]: the ordered steps, or an empty array when this candidate
 *   is not a behavior declaration gap.
 */
function behaviorDeclarationGuidance(input: {
  cwd: string;
  policiesPath: string;
  graph: ResourceGraph;
  resourceId: string;
  runner: string;
}): string[] {
  const route = input.graph.resources.find(
    (resource) => resource.id === input.resourceId && resource.kind === HTTP_ENDPOINT_RESOURCE_KIND,
  );
  if (route === undefined) return [];
  const method = route.attributes['method'];
  const path = route.attributes['canonicalPath'];
  if (typeof method !== 'string' || typeof path !== 'string') return [];
  const effects: BehaviorEffectFacts[] = input.graph.resources
    .filter(
      (resource) =>
        resource.id !== null &&
        resource.id !== input.resourceId &&
        resource.classification?.evidenceAdapter !== undefined,
    )
    .map((resource) => {
      const writable = resource.attributes['updateableFields'];
      return {
        id: resource.name,
        resourceId: resource.id as string,
        adapter: resource.classification?.evidenceAdapter as string,
        identityFields: resource.classification?.primaryKey ?? [],
        fields:
          Array.isArray(writable) && writable.every((field) => typeof field === 'string')
            ? (writable as string[])
            : (resource.classification?.primaryKey ?? []),
      };
    });
  const endpoint: BehaviorEndpointFacts = {
    resourceId: input.resourceId,
    routeName: `${method} ${path}`,
    method,
    path,
    effects,
  };
  const declared: BehaviorDeclarationPrint = buildEndpointDeclaration({
    endpoint,
    requiredContracts: requiredContractsForEndpoints(input.cwd, input.policiesPath),
    recipe: loadBehaviorRecipes(input.cwd)[0] ?? null,
    caseIdFor: (resourceId, slug) =>
      sha256Canonical({ domain: BEHAVIOR_CASE_DOMAIN, resourceId, id: slug }),
    specFile: 'specs/gateforge-cases.spec.js',
    project: 'chromium',
    runner: input.runner,
  });
  if (declared.entry === null) {
    return [
      `about this gap: ${endpoint.routeName} (${input.resourceId}) has no approved behavior cases, and`,
      'the complete declaration cannot be printed from what this repository declares:',
      `  ${declared.incompleteReason ?? 'no reason recorded'}`,
      'next: fix that first, then re-run gateforge next',
    ];
  }
  return [
    `about this gap: ${endpoint.routeName} (${input.resourceId}) is discovered but has no approved`,
    'behavior cases, so nothing in this repository can prove what it must do. The steps below are',
    'the whole remaining setup — every block is complete, so paste each one exactly as printed.',
    "step 1 — declare the cases in .gateforge/behavior.yml (add this entry under 'endpoints:'):",
    '```yaml',
    declared.entry,
    '```',
    'step 2 — create specs/gateforge-cases.spec.js with exactly this content (one test per case;',
    'the ENGINE drives each case, and the test only asserts the engine sealed it):',
    '```js',
    renderProofSpec({ resourceId: input.resourceId, cases: declared.cases }),
    '```',
    'step 3 — map every case to its test in .gateforge/test-map.yml (add these entries under',
    "'tests:'; if the file does not exist yet, create it starting with 'schemaVersion: 1' and",
    "'tests:'):",
    '```yaml',
    renderTestMapEntries({
      cases: declared.cases,
      specFile: 'specs/gateforge-cases.spec.js',
      project: 'chromium',
      runner: input.runner,
    }),
    '```',
    'step 4 — run the gate:',
    '  npm run gate',
    'then re-run gateforge next to see what, if anything, is still open',
  ];
}

/**
 * The `task` behavior pack, offered under the same rule as every other
 * pack: it is named only when the repository actually shows the
 * machinery AND the engine can grade the claim. The engine's own
 * `queueObserver` is that second half — without it every `task:*` case
 * fails closed, so offering the pack would print a flag whose cases can
 * never be satisfied. Both halves are required, so a repository
 * without an observer is byte-identical to a repository with no
 * background work.
 *
 * Args:
 *   graph: the run's resource graph.
 *   queueObserverConfigured: whether the loaded config declares one.
 *
 * Returns:
 *   string[]: the offer lines, or an empty array when it does not apply.
 */
function taskPackOffer(graph: ResourceGraph, queueObserverConfigured: boolean): string[] {
  if (!queueObserverConfigured) return [];
  const taskResource = graph.resources.find(
    (resource) => resource.kind === 'task.resource' && resource.id !== null,
  );
  if (taskResource === undefined) return [];
  return [
    'the task behavior pack is gradable in this repository (a queueObserver is configured',
    `and '${taskResource.id}' is a discovered task resource), so its cases can be enabled:`,
    '  task — the engine reads the delivery queue itself to grade these contracts',
    '  gateforge init --behavior-packs task',
  ];
}

/**
 * The contracts the repository's policy document requires of every HTTP
 * endpoint. Unreadable or absent policies yield none, which keeps the
 * guidance quiet on a repository that has approved no behavior yet.
 *
 * Args:
 *   cwd: absolute repository root.
 *   policiesPath: repo-relative policies document path.
 *
 * Returns:
 *   string[]: the required contract names, deduplicated in print order.
 */
function requiredContractsForEndpoints(cwd: string, policiesPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(cwd, policiesPath), 'utf8');
  } catch {
    return [];
  }
  const parsed = PolicyFileSchema.safeParse(parseYaml(text));
  if (!parsed.success) return [];
  const contracts: string[] = [];
  for (const policy of parsed.data.policies) {
    const coversEndpoints =
      policy.when?.kind === undefined || policy.when.kind === HTTP_ENDPOINT_RESOURCE_KIND;
    if (!coversEndpoints) continue;
    for (const contract of policy.require) {
      if (!contracts.includes(contract)) contracts.push(contract);
    }
  }
  return contracts;
}
/**
 * Runs the `gateforge next` subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand.
 *
 * Returns:
 *   number: exit code — 0 clean, 1 a next action exists, 2
 *   config/usage.
 */
export async function nextCommand(io: Io, argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  if (options['help'] === true) {
    writeLine(io.stdout, NEXT_USAGE);
    return 0;
  }
  rejectUnknownFlags(options, ['changed', 'json', 'help'], NEXT_USAGE);
  if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
    throw new UsageError('no .gateforge.yml found — run gateforge init first');
  }
  const diffScoped = options['changed'] === true;
  const asJson = options['json'] === true;

  const witnessVerifierKey = io.env[VERIFIER_KEY_ENV];
  const config = loadConfigAt(io.cwd);
  const cacheExclusions = loadCacheExclusions(io.cwd, config);
  const providerIdentity: ChangedProvider = diffScoped
    ? resolveProvider(config.changed.provider, io.cwd, io.env).provider
    : 'all-files';
  const stateDir = resolveStateDir(io.cwd);

  // Trusted digest: the same pre/post inventory check `check` performs
  // so witnessed records authorize for the current bytes (next never
  // demands a gate receipt — navigation, not the gate).
  let preFiles: SnapshotFileEntry[] | null = null;
  let snapshotUnavailable = false;
  try {
    preFiles = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
  } catch (error) {
    if (error instanceof SnapshotUnavailableError) {
      snapshotUnavailable = true;
    } else if (error instanceof UnsupportedSnapshotError) {
      throw new UsageError(`unsupported input snapshot: ${error.message}`);
    } else {
      throw error;
    }
  }
  // A dangling symlink, or one pointing at a directory, is captured by
  // its link text, so the run continues; one plain notice line names what
  // does not resolve and whether an action is needed. In --json mode
  // stdout stays a single JSON document, so the notice goes to stderr
  // there.
  for (const notice of symlinkNotices(preFiles ?? [])) {
    writeLine(asJson ? io.stderr : io.stdout, notice);
  }

  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: providerIdentity,
    stateDir,
  });

  const httpRoutes = httpRoutesView(pipeline.graph);
  let expectedDigest: string | null = null;
  let changedInputs = false;
  if (!snapshotUnavailable) {
    try {
      const postFiles = collectInputFiles(io.cwd, config, stateDir, [], [], cacheExclusions);
      if (preFiles !== null && diffInputFiles(preFiles, postFiles).length > 0) {
        changedInputs = true;
      } else {
        expectedDigest = computeInputSnapshot({
          cwd: io.cwd,
          config,
          stateDir,
          classifications: pipeline.classificationsView.resources,
          obligations: pipeline.policy.obligations,
          httpRoutes,
          plugins: pipeline.manifest.plugins.map((plugin) => ({
            id: plugin.id,
            version: plugin.version,
          })),
          cacheExclusions,
        }).inputDigest;
      }
    } catch (error) {
      if (error instanceof SnapshotUnavailableError) {
        snapshotUnavailable = true;
      } else if (error instanceof UnsupportedSnapshotError) {
        throw new UsageError(`unsupported input snapshot: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  // One effective evaluation scope (same contract as check --changed):
  // gate-defining inputs expand to all; strict-mode unmapped files add
  // CHANGE_UNMAPPED blockers; staged/worktree divergence blocks loudly.
  let changedFiles: readonly string[] | null = null;
  let mismatchBlocking: BlockingEntry[] = [];
  let discoveryResult: DiscoverResult | undefined;
  if (diffScoped) {
    const sidecar = loadOptionalTestMap(io.cwd);
    const runnerConfig = findRunnerConfigPath(io.cwd, config.runner);
    let testFiles: string[] = [];
    if (runnerConfig !== null) {
      try {
        const discovered = await discoverTestCatalog({
          cwd: io.cwd,
          config,
          collectPytest: true,
          excludeFile: engineGeneratedStateFileFilter(io.cwd, stateDir),
        });
        discoveryResult = discovered;
        testFiles = discovered.catalog.entries
          .filter((entry) => entry.runner === config.runner)
          .map((entry) => entry.file);
      } catch (error) {
        if (error instanceof TestDiscoveryError) throw new UsageError(error.message);
        throw error;
      }
    }
    const knownSourceFiles = [
      ...new Set(
        pipeline.graph.resources.flatMap((resource) =>
          resource.id === null ? [] : sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog).get(resource.id) ?? [],
        ),
      ),
    ];
    const scopeDecision = computeEvaluationScope({
      config,
      changedFiles: pipeline.changedFiles,
      testFiles,
      runnerConfigs: runnerConfig === null ? [] : [runnerConfig],
      mappingSidecar: sidecar !== null,
      knownSourceFiles,
      strictE2E: config.enforcement?.strictE2E === true,
      // Gateforge's OWN scaffold/policy files are policy inputs (D2),
      // not product changes: without this `next --changed` would keep
      // listing `.gateforge/*.yml`, `GATEFORGE.md` and the CI/pre-commit
      // wiring as CHANGE_UNMAPPED — the exact thing D2 removes.
      // 0.9.1: the base-text reader reads `.gitignore` at the base
      // revision the provider diffs against, so the engine-state
      // block `init` appends counts as wiring too.
      policyInputs: [
        ...gateforgeOwnedInputs(
          io.cwd,
          pipeline.changedFiles,
          config,
          changeBaseTextReader(providerIdentity, io.cwd, io.env) ?? undefined,
        ).keys(),
      ],
    });
    changedFiles = scopeDecision.mode === 'all' ? null : scopeDecision.changedFiles;
    const sidecarCoveredFiles = new Set((sidecar?.tests ?? []).map((entry) => entry.selector.file));
    mismatchBlocking = [
      ...mismatchBlocking,
      ...scopeDecision.unmappedFiles
        .filter((file) => !sidecarCoveredFiles.has(file))
        .map((file): BlockingEntry => ({
          kind: 'finding',
          resourceId: null,
          name: file,
          detail:
            `changed file '${file}' has no safe obligation/journey scope — unknown behavior changes ` +
            'stay visible and blocking until mapped (strict E2E mode)',
          location: { file, line: 1, col: 0 },
          cause: 'CHANGE_UNMAPPED',
          nextAction: CAUSE_NEXT_ACTIONS.CHANGE_UNMAPPED,
        })),
    ];
    if (providerIdentity === 'local-staged') {
      const mismatched = detectStagedWorkingTreeMismatches(io.cwd, io.env);
      if (mismatched.length > 0) {
        changedFiles = null;
        mismatchBlocking = [
          ...mismatchBlocking,
          ...mismatched.map(
            (file): BlockingEntry => ({
              kind: 'finding',
              resourceId: null,
              name: null,
              detail:
                `staged verification cannot certify '${file}': staged (index) bytes differ ` +
                'from working-tree bytes, but discovery reads the working tree — commit or ' +
                'stash the worktree change, or run without --changed to verify the worktree',
              location: { file, line: 1, col: 0 },
            }),
          ),
        ];
      }
    }
  }

  const mapped = await resolveRepositoryMappings({
    cwd: io.cwd,
    config,
    stateDir,
    obligations: pipeline.policy.obligations,
    ...(discoveryResult !== undefined
      ? {
          catalog: discoveryResult.catalog,
          nativeClaims: discoveryResult.nativeClaims,
          nativeErrors: discoveryResult.nativeErrors,
          nativeInstances: discoveryResult.nativeInstances,
        }
      : {}),
    behaviorCatalog: pipeline.behaviorCatalog,
  });
  const claimInventory: Claim[] = mapped.claimInventory;
  const mappingBlockers = [
    ...mappingBlocking(mapped.resolution.problems),
    ...nativeInventoryBlocking(mapped.nativeLoadProblem),
  ];
  const mappedCoverage = mappedCoverageFrom(mapped.resolution, pipeline.policy.obligations, pipeline.graph);

  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    behaviorCatalog: pipeline.behaviorCatalog,
    obligations: pipeline.policy.obligations,
    blocking: [...pipeline.policy.blocking, ...mismatchBlocking, ...mappingBlockers],
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    changedFiles,
    claimInventory,
    mappedCoverage,
    witnessVerifierKey,
    baseline: resolveAdoptedBaseline(io.cwd, config.baselines),
    evidenceContext: {
      expectedInputDigest: expectedDigest,
      snapshotUnavailable,
      requireInvocationId: false,
      changedInputs,
    },
  });

  const candidates = rankBlockers(evaluated.blocking, evaluated.verdicts, focusedRouteKeys(pipeline.graph));
  // Unmatched by-id routes the owner graded as advisory (0.9.0, owner
  // decision D7): printed near the top whether or not anything blocks,
  // because `next` is where an owner looks to learn what a run is
  // reporting. They never block here (they are out of the blocking
  // channel), so a clean run still prints `next: none — clean` below.
  if (!asJson) {
    for (const line of unmatchedRouteBannerLines(
      pipeline.unmatchedRouteAdvisories,
      pipeline.unmatchedRoutesMode,
    )) {
      writeLine(io.stdout, line);
    }
  }
  if (candidates.length === 0) {
    if (asJson) {
      writeLine(
        io.stdout,
        JSON.stringify({ next: null, cause: null, why: 'clean', do: null, remainingBlocking: 0 }),
      );
    } else {
      writeLine(io.stdout, 'next: none — clean');
    }
    return 0;
  }
  const first = candidates[0] as NextCandidate;
  const unresolvedRoute = pipeline.classification.decisions.find(
    (decision) =>
      decision.name === first.id &&
      decision.kind === 'http.endpoint' &&
      decision.classification === null &&
      decision.blocks.some((block) => block.code === 'PLANE_UNRESOLVED'),
  );
  const routeResource =
    unresolvedRoute === undefined
      ? undefined
      : pipeline.graph.resources.find((resource) => resource.name === unresolvedRoute.name);
  const method = routeResource?.attributes['method'];
  const path = routeResource?.attributes['canonicalPath'];
  const routeName =
    typeof method === 'string' && typeof path === 'string'
      ? `${method} ${path}`
      : unresolvedRoute?.name;
  const routeGuidance =
    unresolvedRoute === undefined || routeName === undefined
      ? null
      : unresolvedRouteGuidance(routeName, unresolvedRoute.name, unresolvedRoute.source, io.cwd);
  // An endpoint whose semantics no detector could prove is answered by
  // the owner-authored capability rule, so the top item carries the exact
  // entry instead of the read-only dump the fallback `do:` names. A
  // FastAPI prefix no detector could read is answered the same way: the
  // block names the one edit that closes it, never a read-only command.
  const endpointGuidance =
    routeGuidance === null ? endpointSemanticsGuidance(first.why, pipeline.graph) : [];
  const prefixGuidance = routeGuidance === null ? fastapiPrefixGuidance(first.why, io.cwd) : [];
  const classifierBlocks = classifierBlockGuidance(first, pipeline.classification.decisions);
  const guide = ENVIRONMENT_GUIDES[first.cause as CauseCode] ?? null;
  const scopeNote = observationScopeNote(
    first,
    pipeline.graph,
    pipeline.observationScope,
    config.policies,
  );
  // The behavior setup is printed whenever the run still owes a behavior
  // DECLARATION and the top item is one of the three "this repository has
  // no proof yet" causes. A brand-new repository is usually missing all
  // three at once (no cases, no tests, no mapping), and answering only
  // the top one would send the owner back for a second `next` run with
  // the same answer.
  const behaviorGap = evaluated.blocking.find((entry) => entry.cause === 'ENDPOINT_BEHAVIOR_MISSING');
  const behaviorGuidance =
    behaviorGap !== undefined && SETUP_CAUSES.includes(first.cause as CauseCode)
      ? behaviorDeclarationGuidance({
          cwd: io.cwd,
          policiesPath: config.policies,
          graph: pipeline.graph,
          resourceId: behaviorGap.resourceId ?? behaviorGap.name ?? '',
          runner: config.runner,
        })
      : [];
  // The per-tenant singleton guidance (plan 2026-09-25 Phase 4b item 3)
  // rides the same advisory tail the other owner notes use, and is the
  // SAME {@link singletonPerTenantGuidanceLines} output `check` renders
  // as a finding — a graph with no tagged resource yields an empty list
  // and prints nothing at all, so the next action stays byte-identical.
  const singletonNote = singletonPerTenantGuidanceLines(pipeline.graph.resources);
  // The task pack is offered only when the engine could actually grade
  // it — a configured queueObserver plus a discovered task resource.
  const taskOffer = taskPackOffer(pipeline.graph, config.queueObserver !== undefined);
  if (asJson) {
    writeLine(
      io.stdout,
      JSON.stringify({
        next: first.id,
        cause: first.cause,
        why: first.why,
        do: first.do,
        remainingBlocking: candidates.length - 1,
        guide,
        ...(routeGuidance === null ? {} : { guidance: routeGuidance }),
        ...(behaviorGuidance.length === 0 ? {} : { behaviorGuidance }),
        ...(scopeNote.length === 0 ? {} : { scopeNote }),
        ...(singletonNote.length === 0 ? {} : { singletonGuidance: singletonNote }),
        ...(taskOffer.length === 0 ? {} : { taskPackOffer: taskOffer }),
        ...(endpointGuidance.length === 0 ? {} : { endpointSemanticsGuidance: endpointGuidance }),
        ...(prefixGuidance.length === 0 ? {} : { fastapiPrefixGuidance: prefixGuidance }),
        ...(classifierBlocks === null ? {} : { classifierBlockGuidance: classifierBlocks.lines }),
      }),
    );
  } else {
    writeLine(io.stdout, `next: ${first.id}`);
    writeLine(io.stdout, `cause: ${first.cause}`);
    writeLine(io.stdout, `why: ${first.why}`);
    if (guide !== null) writeLine(io.stdout, `guide: ${guide}`);
    if (routeGuidance !== null) {
      writeLine(io.stdout, 'do: confirm the route owner and run only the matching plane command below');
      for (const line of routeGuidance) writeLine(io.stdout, line);
    } else if (endpointGuidance.length > 0) {
      writeLine(
        io.stdout,
        `do: declare what this endpoint does in the \`endpoints:\` section of '${OWNER_ANSWERS_PATH}' — the exact entry to add is below`,
      );
      for (const line of endpointGuidance) writeLine(io.stdout, line);
    } else if (prefixGuidance.length > 0) {
      writeLine(io.stdout, `do: ${fastapiPrefixDo(first.why)}`);
      for (const line of prefixGuidance) writeLine(io.stdout, line);
    } else if (classifierBlocks !== null) {
      writeLine(io.stdout, `do: ${classifierBlocks.do}`);
      for (const line of classifierBlocks.lines) writeLine(io.stdout, line);
    } else {
      writeLine(io.stdout, `do: ${first.do}`);
    }
    for (const line of behaviorGuidance) writeLine(io.stdout, line);
    for (const line of scopeNote) writeLine(io.stdout, line);
    for (const line of singletonNote) writeLine(io.stdout, line);
    for (const line of taskOffer) writeLine(io.stdout, line);
  }
  return 1;
}
