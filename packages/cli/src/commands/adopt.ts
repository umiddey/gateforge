/**
 * `gateforge adopt` (phase 8 workstream C): retroactive enforcement for
 * existing repos. One command, three loud steps:
 *
 * 1. Runs the compile + static gate (the same pipeline as `check`,
 *    all-files scope) and captures every currently-unresolved
 *    fingerprint — blocking obligation verdicts via the pin-#2
 *    obligation fingerprint, blocking entries (unclassified/unresolved
 *    resources, detector/graph findings, stale references) via the
 *    whole-entry fingerprint — PLUS the classification-blocked RESOURCE
 *    identities ([classification] entries and their `unclassified`
 *    shadows) as the receipt's classification layer (two-layer
 *    adoption): resource-scoped, merge-stable identity where the
 *    whole-entry fingerprint is not (detail text and line numbers move
 *    in an upstream merge; a plane-unresolved resource has no
 *    plane-qualified id at all).
 * 2. Writes those fingerprints as the INITIAL baseline via
 *    `adoptBaseline` — THE ONE SANCTIONED BULK-ADD this engine ever
 *    performs. It is sanctioned by a loud sibling receipt,
 *    `.gateforge/baselines/adoption.json` (dated, count-annotated,
 *    commit-referenced, and carrying the adopted `classificationBlocked`
 *    resource set); `check` honors a baseline only when that record
 *    exists, so the bulk-add can never act silently. Everything after
 *    adoption stays fail-closed: `baseline update` remains
 *    subset-only (GF-07/08), new debt blocks, and both adopted layers
 *    are SHRINK-ONLY from here.
 *    Adoption is plane-ordered (R1-9): while any blocking
 *    entry is plane-unresolved the command exits 2 and
 *    writes nothing — a plane answer changes the resource's
 *    identity, so debt adopted before the answer would not
 *    match after it.
 * 3. Applies the enforcement wiring through the shared `init --blocking`
 *    path (pre-commit hook block + CI template + engine reference),
 *    idempotent like every gateforge write.
 *
 * Idempotence / invariant: a second `adopt` on an already-adopted repo
 * is a NO-OP SUCCESS (exit 0) that refuses the second bulk-add and
 * points at `gateforge baseline update` — never an error, never a
 * re-seed. Crash-consistency note: the baseline is written BEFORE the
 * record; a crash in between leaves an unrecorded baseline, which
 * forgives nothing (record-gated) and which the next `adopt` replaces
 * with the freshly verified red set — the record's existence, not the
 * file's, is what sanctions forgiveness.
 *
 * Family migration (0.13 pages rollout): `gateforge adopt --family
 * pages` revises an ALREADY-adopted repository — the one owner-approved
 * exception to the one-bulk-add invariant, scoped to a named family and
 * recorded inside the EXISTING receipt (a `families.pages` marker), not
 * in a second file and not in the baseline document. Preview by
 * default; `--confirm` performs ONE atomic receipt write whose
 * family-specific `forgiven` fingerprints the evaluator folds into the
 * baseline forgiveness (nothing else is writable, so no crash window
 * can expose unrecorded forgiveness — the old receipt would forgive a
 * union baseline BEFORE the new record existed, which is exactly the
 * shape this avoids). When `pages` is configured, the PLAIN initial
 * adopt records the family marker in the same receipt it already
 * writes: the family is then already adopted, and pages discovered
 * later are new work to prove, never debt to re-adopt.
 */
import { existsSync } from 'node:fs';
import {
  ADOPTION_RECORD_FILENAME,
  adoptBaseline,
  adoptClassificationBlocked,
  adoptFamily,
  blockingEntryFingerprint,
  BLOCKING_VERDICTS,
  classificationBlockedIdentity,
  loadAdoptionRecord,
  loadBaseline,
  writeAdoptionRecord,
  writeBaseline,
  type AdoptionFamily,
  type Obligation,
  type ObligationVerdict,
  type ResourceGraph,
} from '@gate-forge/core';
import { dirname, join } from 'node:path';
import type { Io } from '../io.js';
import { writeLine } from '../io.js';
import { UsageError } from '../errors.js';
import { parseArgs, stringFlag } from '../args.js';
import { evaluateRun, obligationFingerprint } from '../evaluate.js';
import { headSha, resolveRepoPath, runPipeline, sourcesByResourceId } from '../pipeline.js';
import {
  engineRootFromInvocation,
  ensureBlockingWiring,
  generatedHookGateArgs,
} from './blocking.js';
import { loadConfigAt } from './common.js';

export const ADOPT_USAGE = 'usage: gateforge adopt [--family pages [--confirm]]';

/**
 * What `gateforge adopt --help` prints. The command used to print only
 * its usage line, so its whole contract — what it forgives, for how
 * long, and the one case where an adopted obligation still blocks —
 * existed only in the source file.
 */
export const ADOPT_HELP = `${ADOPT_USAGE}

Adopts an EXISTING repository: run it once, after \`gateforge init\`, on a
project that already has code and therefore already has findings.

  what it records — the currently-blocking findings: unsatisfied
  obligation fingerprints (pin #2) plus every blocking entry, and, as a
  second layer, the classification-blocked resource identities. They go
  into .gateforge/baselines/obligations.json, sanctioned by a dated,
  count-annotated receipt (.gateforge/baselines/adoption.json). Without
  that receipt a baseline forgives nothing.

  shrink-only — the recorded set never grows on its own. It is the one
  sanctioned bulk-add this engine performs, and only once per repository:
  a second \`adopt\` is a no-op success. Resolve debt and shrink it with
  \`gateforge baseline update\`; new (never-adopted) work is never
  baselined and keeps blocking (\`check\` exits 1).

  strictE2E — with \`enforcement.strictE2E: true\` a baselined E2E
  obligation is NOT proof. It blocks with ENFORCEMENT_UNTRUSTED again
  as soon as a change touches what it proves. A change set that carries
  no product behaviour at all — tests, the mapping sidecar, runner
  configuration — keeps the adopted debt forgiven under the default
  \`enforcement.adoptedDebt: lenient\`; declare \`strict\` to re-grade it
  on every commit after this one.

  wiring — after recording, it applies the blocking wiring (pre-commit
  hook block + CI template) through the same idempotent path as
  \`gateforge init --blocking\`.

  plane-ordered — adoption refuses (exit 2, nothing written) while
  any blocking entry is plane-unresolved: a plane answer changes
  the resource's identity, so debt adopted before the answer
  would not match after it. Answer the planes first
  (\`gateforge classify plane <folder> <tenant|master|global> --confirm\`).

  families — \`gateforge adopt --family pages\` revises an ALREADY-adopted
  repository (an unadopted one is told to run plain \`adopt\` first; the
  family path never seeds a receipt). Preview by default — it prints what
  WOULD be recorded and writes nothing. \`--confirm\` performs ONE atomic
  write to .gateforge/baselines/adoption.json: a dated, commit-referenced
  \`families.pages\` marker recording EVERY page obligation discovered at
  that moment (proven pages included), with only the then-missing/unproven
  page fingerprints marked forgiven. The baseline document is never
  touched, so a crash cannot expose unrecorded forgiveness; the evaluator
  forgives the family's \`forgiven\` set from the receipt alone. The marker
  is permanent: a repeat records nothing (new pages are new work to
  prove), and the family debt shrinks through \`gateforge baseline update
  --family-pages <fingerprint>...\` (\`--family-pages=\` keeps none) while
  the marker is retained. Page routes with an unresolved audience or data
  plane refuse the migration (exit 2, nothing written) — declare each
  audience in .gateforge.yml pages.audiences with an explicit plane
  (\`plane: tenant|master|global\`; an audience name is a role, not a
  plane). Because the receipt is part of the approved policy revision,
  a confirmed migration changes the trusted-policy digest: strict gates
  stay untrusted until the owner repins the revision OUTSIDE the
  candidate (\`gateforge enforcement pin\`, the approved-digest env var,
  or the trusted config). A plain \`adopt\` on a repo with \`pages:\`
  configured records the family marker in the receipt it already writes,
  so the family is then already adopted.

Exit codes: 0 adopted (or an idempotent no-op), 2 config/usage or a plane-unresolved resource (R1-9).`;

/** Groups the adopted red set by source for the adoption report. */
function groupReds(reds: ReadonlyMap<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const label of reds.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(
    ([label, count]) => `  ${label}: ${count}`,
  );
}

/**
 * Runs the adopt subcommand.
 *
 * Args:
 *   io: process context.
 *   argv: flags after the subcommand: bare (the one bulk-add),
 *   `--family pages` (family migration preview), or `--family pages
 *   --confirm` (the migration itself). `--help` prints the contract.
 *
 * Returns:
 *   number: exit code — 0 adopted (or idempotent no-op), 2 config/usage
 *   or a plane-unresolved blocking entry (R1-9: nothing written).
 * @throws fail-closed errors (exit 2) from config/pipeline/baseline layers.
 */
export async function adoptCommand(io: Io, argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    writeLine(io.stdout, ADOPT_HELP);
    return 0;
  }
  const { options, positionals } = parseArgs(argv);
  if (positionals.length > 0) {
    throw new UsageError(`unknown arguments for adopt (${ADOPT_USAGE}): ${positionals.join(' ')}`);
  }
  for (const name of Object.keys(options)) {
    if (name !== 'family' && name !== 'confirm') {
      throw new UsageError(`unknown arguments for adopt (${ADOPT_USAGE}): --${name}`);
    }
  }
  const family = stringFlag(options, 'family');
  const confirm = options['confirm'] === true;
  if (confirm && family === undefined) {
    throw new UsageError(`--confirm is only valid with --family pages (${ADOPT_USAGE})`);
  }
  if (!existsSync(join(io.cwd, '.gateforge.yml'))) {
    throw new UsageError('no .gateforge.yml found — run `gateforge init` first');
  }
  if (family === undefined) return adoptWholeRepository(io);
  if (family !== 'pages') {
    throw new UsageError(
      `unknown adoption family '${family}' — only 'pages' exists (${ADOPT_USAGE})`,
    );
  }
  return adoptPagesFamily(io, confirm);
}

/**
 * The plain initial bulk-add (the pre-0.13 contract, unchanged except
 * for the pages-family marker the receipt may now carry).
 *
 * Args:
 *   io: process context.
 *
 * Returns:
 *   Promise<number>: 0 adopted (or idempotent no-op), 2 config/usage or
 *   plane-unresolved.
 */
async function adoptWholeRepository(io: Io): Promise<number> {
  const config = loadConfigAt(io.cwd);
  const baselinePath = resolveRepoPath(io.cwd, config.baselines);
  const recordPath = join(dirname(baselinePath), ADOPTION_RECORD_FILENAME);

  // INVARIANT: exactly one bulk-add per repo, keyed on the receipt's
  // existence. Already adopted → re-assert the wiring (idempotent),
  // refuse the re-seed, exit 0.
  const existingRecord = loadAdoptionRecord(recordPath);
  if (existingRecord !== null) {
    ensureBlockingWiring(io, engineRootFromInvocation(), generatedHookGateArgs(io.cwd) ?? undefined);
    const adoptedClassifications = existingRecord.classificationBlocked?.length ?? 0;
    writeLine(
      io.stdout,
      `already adopted at ${existingRecord.adoptedAt} — ${existingRecord.adopted} fingerprint(s) in the baseline` +
        (existingRecord.classificationBlocked !== undefined
          ? ` + ${adoptedClassifications} classification-blocked resource(s) in the receipt`
          : ' (receipt predates the classification layer: not adopted for it)') +
        '; a second bulk-add is refused (GF-07/08). Shrink as debt resolves: `gateforge baseline update`. ' +
        'New (never-adopted) work is never baselined — prove it with an overlay test in ' +
        'tests/e2e/gateforge/ or waive it (`gateforge waive`).',
    );
    return 0;
  }

  // Step 1: the compile + static gate, all-files — adoption captures
  // ALL current debt, not a diff's worth. The verdict pass runs through
  // the same evaluator `check` uses, with forgiveness DISABLED (baseline:
  // null) — the red set must be captured raw, never pre-forgiven.
  const stateDir = join(io.cwd, '.gateforge', 'test-gates');
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: pipeline.policy.blocking,
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    changedFiles: null,
    baseline: null,
  });
  // R1-9: adoption is plane-ordered. A plane-unresolved blocking
  // entry names a resource whose identity is NOT yet decided — a
  // plane answer changes it — so the red set captured now would
  // not match the repository that exists after the answer. Refuse
  // the whole command before any write: nothing is baselined,
  // nothing is wired, and the owner gets the exact answer to
  // give first.
  const planeUnresolved = evaluated.blocking.filter((entry) =>
    entry.detail.startsWith('[PLANE_UNRESOLVED]'),
  );
  if (planeUnresolved.length > 0) {
    const folders = [
      ...new Set(
        planeUnresolved.map((entry) =>
          entry.location === null ? null : dirname(entry.location.file),
        ),
      ),
    ]
      .filter((folder): folder is string => folder !== null)
      .sort()
      .slice(0, 3);
    writeLine(
      io.stderr,
      `adopt: ${planeUnresolved.length} resources have no data plane yet` +
        (folders.length > 0 ? ` (e.g. ${folders.join(', ')})` : '') +
        '. Answer them first — gateforge classify plane <folder> <tenant|master|global> --confirm — then adopt. ' +
        'Plane answers change resource identities, so debt adopted before them would not match afterwards.',
    );
    return 2;
  }
  const reds = new Map<string, string>();
  // The classification layer (two-layer adoption): the resource ids of
  // the classification-blocked ([classification] entries with a derived
  // identity, plus their `unclassified` shadows — the same resource's
  // definitional block), captured as the adopted starting point alongside
  // the fingerprint baseline. Identity, not the whole-entry fingerprint:
  // a plane-unresolved resource has no plane-qualified id, and its bare
  // name survives upstream merges that shift every line number.
  const classificationBlocked = new Set<string>();
  let proven = 0;
  for (const verdict of evaluated.verdicts) {
    if (!BLOCKING_VERDICTS.includes(verdict.verdict)) {
      proven += 1;
      continue;
    }
    reds.set(obligationFingerprint(verdict.obligation), `verdict:${verdict.verdict}`);
  }
  for (const entry of evaluated.blocking) {
    reds.set(blockingEntryFingerprint(entry), `entry:${entry.kind}`);
    const identity = classificationBlockedIdentity(entry);
    if (identity !== null) classificationBlocked.add(identity);
  }

  // An unadopted baseline can only be a crashed previous adopt or a
  // hand-edit; either way it is UNRECORDED, so it forgives nothing today
  // and is replaced (not merged — merging would launder unverified
  // fingerprints into the sanctioned set) by the freshly captured red set.
  if (existsSync(baselinePath)) {
    const existing = loadBaseline(baselinePath);
    if (existing.fingerprints.length > 0) {
      writeLine(
        io.stdout,
        `warning: replacing unrecorded baseline content (${existing.fingerprints.length} fingerprint(s) ` +
          'with no adoption record — unrecorded baselines forgive nothing) with the verified red set',
      );
    }
  }

  // Step 2: the sanctioned bulk-add, receipt written last (see module
  // doc for the crash window — the state in between forgives nothing).
  // The receipt carries BOTH adopted layers: the fingerprint baseline and
  // the classification-blocked resource ids (sorted, unique, possibly
  // empty — the field's presence is this receipt claiming the layer).
  // With `pages:` configured it ALSO carries the pages-family marker in
  // the same write: the family is then already adopted (the R1-9 check
  // above refused any unresolved page audience/plane before this), and
  // pages discovered later are new work to prove, never debt to re-adopt.
  const pagesFamily =
    config.pages === undefined
      ? null
      : capturePagesFamily(pipeline.graph, pipeline.policy.obligations, evaluated.verdicts, {
          // The initial bulk-add has no prior receipt, and the family's
          // `forgiven` set stays EMPTY: the red set is about to carry the
          // page debt in the baseline document, where the ordinary
          // shrink-only `baseline update` contract removes it. Recording
          // the same fingerprints as family forgiveness would duplicate
          // the sanction into two stores and let the family fold
          // resurrect fingerprints the document shrink had removed.
          knownObligationIds: new Set<string>(),
          documentFingerprints: new Set(reds.keys()),
        });
  writeBaseline(baselinePath, adoptBaseline([...reds.keys()]));
  const orderedObligations = [...pipeline.policy.obligations].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const obligationSources = sourcesByResourceId(pipeline.graph, pipeline.behaviorCatalog);
  writeAdoptionRecord(recordPath, {
    schemaVersion: 1,
    adoptedAt: pipeline.now,
    gitSha: headSha(io.cwd),
    adopted: reds.size,
    proven,
    classificationBlocked: adoptClassificationBlocked([...classificationBlocked]),
    obligationFingerprintsById: Object.fromEntries(
      orderedObligations.map((obligation) => [obligation.id, obligationFingerprint(obligation)]),
    ),
    obligationSourcesById: Object.fromEntries(
      orderedObligations.map((obligation) => [
        obligation.id,
        obligationSources.get(obligation.resourceId) ?? [],
      ]),
    ),
    ...(pagesFamily === null
      ? {}
      : {
          families: {
            pages: adoptFamily({
              adoptedAt: pipeline.now,
              gitSha: headSha(io.cwd),
              fingerprintsById: pagesFamily.fingerprintsById,
              forgiven: pagesFamily.forgiven,
            }),
          },
        }),
  });

  // Step 3: enforcement wiring through the shared init --blocking path.
  ensureBlockingWiring(io, engineRootFromInvocation(), generatedHookGateArgs(io.cwd) ?? undefined);

  // The adoption report: counts, groups, wiring, and the standing rule.
  writeLine(io.stdout, `adopted as forgiven: ${reds.size}; already proven: ${proven}`);
  if (reds.size > 0) {
    writeLine(io.stdout, 'adoption set (grouped):');
    for (const line of groupReds(reds)) writeLine(io.stdout, line);
  }
  writeLine(
    io.stdout,
    `classification layer adopted: ${classificationBlocked.size} blocked resource(s) recorded in the receipt ` +
      '(waived by identity; the set is shrink-only — a resource leaves it via `gateforge baseline update ' +
      '--classification-blocked` once it carries a real classification)',
  );
  if (pagesFamily !== null) {
    writeLine(
      io.stdout,
      `pages family recorded: ${Object.keys(pagesFamily.fingerprintsById).length} page obligation(s) in the marker ` +
        '(the marker forgives nothing — the page debt itself rides the baseline bulk-add above, ' +
        'shrink-only); ' +
        'the family is then already adopted — a repeat records nothing, and pages discovered later are new work to prove',
    );
  }
  writeLine(io.stdout, `adoption record: ${recordPath} (${pipeline.now})`);
  writeLine(
    io.stdout,
    'the baseline is shrink-only from here: resolve debt and run `gateforge baseline update` (GF-07/08 unchanged); ' +
      'new unproven work blocks (check exits 1).',
  );
  return 0;
}

/** The two page contracts a pages-family obligation can carry. */
const PAGE_CONTRACTS: readonly string[] = ['page:loads', 'page:data-ok'];

/** What one pages-family capture records: every initial id, plus the sanctioned subset. */
interface PagesFamilyCapture {
  /** EVERY initial page obligation id → its pin-#2 fingerprint (proven included). */
  fingerprintsById: Record<string, string>;
  /** The sanctioned subset: fingerprints of the currently blocking, not-already-adopted page debt. */
  forgiven: string[];
  /** How many page obligations were recorded without forgiveness (proven, waived, or already adopted). */
  provenCount: number;
  /** How many page obligation ids the ORIGINAL receipt already indexed (recorded, never re-adopted). */
  alreadyKnownCount: number;
}

/**
 * The page obligations of the current graph: ONLY the `ui.page`
 * resources' two page contracts (`page:loads`/`page:data-ok`). Every
 * other obligation — persistence contracts on other kinds, classification
 * debt, business rules — is by construction outside every pages-family
 * capture, so the migration can never fold non-page debt into the
 * sanctioned set.
 */
function pageObligationsOf(graph: ResourceGraph, obligations: readonly Obligation[]): Obligation[] {
  const pageResourceIds = new Set<string>();
  for (const resource of graph.resources) {
    if (resource.kind !== 'ui.page' || resource.id === null) continue;
    pageResourceIds.add(resource.id);
  }
  return obligations.filter(
    (obligation) =>
      pageResourceIds.has(obligation.resourceId) && PAGE_CONTRACTS.includes(obligation.contract),
  );
}

/**
 * Partitions the current page obligations into the family marker's
 * record: EVERY initial id with its fingerprint (proven pages included,
 * so the marker names the family's full starting point), and the
 * `forgiven` subset — exactly the obligations whose verdict is currently
 * blocking AND that the EXISTING adoption does not already speak about.
 * A proven page is recorded WITHOUT forgiveness, so a later break
 * blocks: forgiveness is decided once, at family adoption, from the raw
 * (baseline-null) verdict pass.
 *
 * The repeat guard (`knownObligationIds` = the existing receipt's
 * `obligationFingerprintsById` keys, `documentFingerprints` = the
 * current baseline document): an id the original receipt already indexed
 * was known at that adoption — proven pages there must NEVER flip to
 * adopted debt through this migration, and resolved debt must never
 * re-enter — so only page obligations UNKNOWN to the original receipt
 * (and not already forgiven via the document) can be sanctioned. A
 * receipt that predates page indexing carries no page ids, so the
 * genuine first pages rollout stays valid.
 */
function capturePagesFamily(
  graph: ResourceGraph,
  obligations: readonly Obligation[],
  verdicts: readonly ObligationVerdict[],
  guards: {
    knownObligationIds: ReadonlySet<string>;
    documentFingerprints: ReadonlySet<string>;
  },
): PagesFamilyCapture {
  const verdictByObligationId = new Map(verdicts.map((verdict) => [verdict.obligation.id, verdict]));
  const fingerprintsById: Record<string, string> = {};
  const forgiven: string[] = [];
  let provenCount = 0;
  let alreadyKnownCount = 0;
  for (const obligation of pageObligationsOf(graph, obligations)) {
    const fingerprint = obligationFingerprint(obligation);
    fingerprintsById[obligation.id] = fingerprint;
    const known = guards.knownObligationIds.has(obligation.id);
    if (known) alreadyKnownCount += 1;
    const verdict = verdictByObligationId.get(obligation.id);
    const blocking = verdict !== undefined && BLOCKING_VERDICTS.includes(verdict.verdict);
    if (blocking && !known && !guards.documentFingerprints.has(fingerprint)) {
      forgiven.push(fingerprint);
    } else {
      provenCount += 1;
    }
  }
  return { fingerprintsById, forgiven, provenCount, alreadyKnownCount };
}

/** One unresolved page route, with the attribute that left it undecided. */
function unresolvedPageRoutes(graph: ResourceGraph): string[] {
  const unresolved: string[] = [];
  for (const resource of graph.resources) {
    if (resource.kind !== 'ui.page') continue;
    const audience = resource.attributes['audience'];
    const plane = resource.attributes['plane'];
    if (
      resource.id === null ||
      typeof audience !== 'string' ||
      audience === '' ||
      audience === 'unknown' ||
      (plane !== 'tenant' && plane !== 'master' && plane !== 'global')
    ) {
      unresolved.push(
        resource.id === null
          ? `${resource.name ?? '<unnamed>'} (no resource id)`
          : `${resource.id} (audience ${typeof audience === 'string' ? audience : '<none>'}` +
            `${plane === undefined ? ', no plane' : ''})`,
      );
    }
  }
  return unresolved.sort();
}

/**
 * The pages-family migration (`gateforge adopt --family pages`): revise
 * an ALREADY-adopted repository with a dated, commit-referenced
 * `families.pages` marker inside the EXISTING receipt. Preview by
 * default; `--confirm` performs ONE atomic receipt write — the baseline
 * document is never touched, so there is no two-file window in which the
 * old receipt would forgive fingerprints the new record has not
 * sanctioned yet.
 *
 * Args:
 *   io: process context.
 *   confirm: false = preview (nothing written); true = record.
 *
 * Returns:
 *   Promise<number>: 0 recorded/previewed/no-op; 2 not adopted, no
 *   pages, or an unresolved page audience/plane (nothing written).
 */
async function adoptPagesFamily(io: Io, confirm: boolean): Promise<number> {
  const config = loadConfigAt(io.cwd);
  const baselinePath = resolveRepoPath(io.cwd, config.baselines);
  const recordPath = join(dirname(baselinePath), ADOPTION_RECORD_FILENAME);

  // The family path revises an existing receipt; it never seeds one (no
  // generic reseed — the one bulk-add stays one).
  const existingRecord = loadAdoptionRecord(recordPath);
  if (existingRecord === null) {
    writeLine(
      io.stderr,
      'adopt --family pages: this repository is not adopted yet — run `gateforge adopt` first. ' +
        'The family path revises an EXISTING adoption receipt; it never seeds one.',
    );
    return 2;
  }
  // INVARIANT: the family marker is permanent. Present → loud no-op
  // success (preview and --confirm are the same no-op): a repeat cannot
  // add newly discovered page routes or re-add resolved debt.
  const marked = existingRecord.families?.pages;
  if (marked !== undefined) {
    writeLine(
      io.stdout,
      `pages family already adopted at ${marked.adoptedAt} — ` +
        `${Object.keys(marked.fingerprintsById).length} page obligation(s) recorded, ` +
        `${marked.forgiven.length} forgiven in the receipt; a repeat records nothing. ` +
        'Shrink what resolved: `gateforge baseline update --family-pages <fingerprint>...` ' +
        '(`--family-pages=` keeps none) — the marker is retained.',
    );
    return 0;
  }

  // Raw capture: the same pipeline + evaluator the plain adopt uses,
  // forgiveness disabled (baseline: null) — the sanctioned set must be
  // captured raw, never pre-forgiven.
  const stateDir = join(io.cwd, '.gateforge', 'test-gates');
  const pipeline = await runPipeline({
    cwd: io.cwd,
    env: io.env,
    config,
    provider: 'all-files',
    stateDir,
  });
  const evaluated = evaluateRun({
    cwd: io.cwd,
    config,
    graph: pipeline.graph,
    obligations: pipeline.policy.obligations,
    blocking: pipeline.policy.blocking,
    stateDir,
    now: pipeline.now,
    engineAlembicRecords: pipeline.engineAlembicRecords,
    changedFiles: null,
    baseline: null,
  });

  // Fail closed BEFORE any write: a family marker is written only for a
  // pages family that exists, and only when every page identity is
  // decided — an audience or plane answered later changes the page's
  // identity, so debt recorded before the answer would not match after.
  const pageObligations = pageObligationsOf(pipeline.graph, pipeline.policy.obligations);
  if (pageObligations.length === 0) {
    writeLine(
      io.stderr,
      'adopt --family pages: no ui.page routes discovered — there is no pages family to adopt, ' +
        'so no marker is written (exit 2, nothing written). Configure .gateforge.yml `pages:` ' +
        '(router + audiences) and rerun when page routes exist.',
    );
    return 2;
  }
  const unresolved = unresolvedPageRoutes(pipeline.graph);
  if (unresolved.length > 0) {
    writeLine(
      io.stderr,
      `adopt --family pages: ${unresolved.length} page route(s) have an unresolved audience or data plane ` +
        `(e.g. ${unresolved.slice(0, 3).join('; ')}) — declare every audience in .gateforge.yml ` +
        'pages.audiences with an explicit plane (`plane: tenant|master|global`; an audience name is a ' +
        'role, not a plane), then rerun. A plane answer changes page identities, so nothing is ' +
        'recorded before it (exit 2, nothing written).',
    );
    return 2;
  }
  const capture = capturePagesFamily(
    pipeline.graph,
    pipeline.policy.obligations,
    evaluated.verdicts,
    {
      // THE repeat guard (receipt-level): an id the ORIGINAL receipt
      // indexed was known at that adoption — a proven page there never
      // flips to adopted debt through this migration, and resolved debt
      // never re-enters. A receipt that predates page indexing carries
      // no page ids, so the genuine first pages rollout stays valid.
      knownObligationIds: new Set(Object.keys(existingRecord.obligationFingerprintsById ?? {})),
      // Debt the current baseline document already forgives needs no
      // second sanction (and an already-resolved page debt was shrunk
      // from that same document — re-adding it is forbidden).
      documentFingerprints: new Set(loadBaseline(baselinePath).fingerprints),
    },
  );
  const sha = headSha(io.cwd);

  if (!confirm) {
    writeLine(io.stdout, 'adopt --family pages (preview — nothing written):');
    writeLine(io.stdout, `  page obligations discovered: ${pageObligations.length}`);
    writeLine(
      io.stdout,
      `  would record the family marker 'pages' in ${recordPath} (dated ${pipeline.now}, commit ${sha ?? '<no commit>'})`,
    );
    writeLine(
      io.stdout,
      `  would forgive ${capture.forgiven.length} currently-missing/unproven page fingerprint(s) via the receipt; ` +
        `${capture.provenCount} page obligation(s) recorded without forgiveness` +
        (capture.alreadyKnownCount > 0
          ? ` (${capture.alreadyKnownCount} already known to the original receipt — proven there stays proven, resolved stays resolved)`
          : ''),
    );
    writeLine(
      io.stdout,
      '  the baseline document stays untouched — the receipt alone carries the sanction, ' +
        'so no crash window can expose unrecorded forgiveness',
    );
    writeLine(io.stdout, 'confirm with: gateforge adopt --family pages --confirm');
    return 0;
  }

  // The ONE write: the existing receipt with the family marker folded in
  // (sorted families map — the receipt bytes are deterministic, and with
  // them the trusted-policy digest that binds the marker).
  const families: Record<string, AdoptionFamily> = {};
  for (const key of Object.keys(existingRecord.families ?? {}).sort()) {
    families[key] = existingRecord.families![key]!;
  }
  families['pages'] = adoptFamily({
    adoptedAt: pipeline.now,
    gitSha: sha,
    fingerprintsById: capture.fingerprintsById,
    forgiven: capture.forgiven,
  });
  const sortedFamilies: Record<string, AdoptionFamily> = {};
  for (const key of Object.keys(families).sort()) sortedFamilies[key] = families[key]!;
  writeAdoptionRecord(recordPath, { ...existingRecord, families: sortedFamilies });

  writeLine(
    io.stdout,
    `pages family adopted: ${pageObligations.length} page obligation(s) recorded ` +
      `(${capture.forgiven.length} forgiven as initial page debt, ${capture.provenCount} recorded without forgiveness` +
      (capture.alreadyKnownCount > 0
        ? `, ${capture.alreadyKnownCount} already known to the original receipt`
        : '') +
      '); the marker is permanent — a repeat records nothing, and pages discovered later are new work to prove',
  );
  writeLine(
    io.stdout,
    'one atomic receipt write: the baseline document was not touched, so no crash window can forgive unrecorded debt',
  );
  writeLine(
    io.stdout,
    'the trusted-policy digest changed (the receipt is part of the approved revision): strict gates stay ' +
      'untrusted until the owner repins OUTSIDE this candidate — `gateforge enforcement pin --pin-file <path> --confirm` ' +
      'after staging, or the approved-digest env var / trusted config',
  );
  writeLine(
    io.stdout,
    'shrink what resolves: `gateforge baseline update --family-pages <fingerprint>...` (`--family-pages=` keeps none) — ' +
      'the marker is retained',
  );
  return 0;
}
