/**
 * The gateforge Playwright reporter (plan §4.6/§4.7, GF-23/GF-24;
 * Phase 4 adds claim injection, runner-outcome capture, and the honest
 * aggregate).
 *
 * Per test it extracts claims from `{type: 'gateforge', description:
 * '<obligation id>'}` annotations AND from the CLI-written claim
 * injections (`claim-injections.json` — the resolved sidecar/native
 * mappings, Phase 4): injections are carried on the session-open path so
 * a mapped test's evidence lands on the right claims; native annotations
 * keep working unchanged. At run end it writes the run-state artifacts
 * the CLI's verifier consumes:
 *
 * - `claims.json`  — Claim-shaped entries (schemaVersion, obligationId,
 *   testId, testFile, location) extracted from annotations + injections.
 * - `records.json` — the WITNESS-ISSUED ledger verbatim: the witness is
 *   the only issuer of recordIds, and the reporter copies `GET
 *   /records` — it never reconstructs records from test-side data, so a
 *   fabricated bundle never enters this file (GF-23).
 * - `ledger.json`  — per-claim verdicts for downstream tools.
 * - runner-outcomes doc (`GATEFORGE_OUTCOMES_FILE`) — per-instance
 *   outcomes, attempts, expected failures, and the run-level
 *   fixture/teardown outcome for trusted runner supervision (ADR 0005
 *   D2: input only, never signature authority).
 *
 * It then computes a per-claim ledger with the REAL verdict engine
 * (`evaluateObligation`, G3) — never trusting the test — and prints a
 * per-claim summary. The summary is HONEST BY CONSTRUCTION (plan Phase 4
 * item 7): it NEVER prints an overall gate pass while unclaimed
 * obligations remain — the authoritative CLI result is the only final
 * gate result. Exit-code semantics: the AUTHORITATIVE code comes from
 * `gateforge test-gates` (contract 4); the reporter only writes
 * `process.exitCode = 1` when a blocking verdict exists AND
 * `GATEFORGE_REPORTER_FAIL_RUN=1` is explicitly set (best-effort in
 * standalone runs, where Playwright's own exit handling may clobber it).
 *
 * Claim-registry vs records mismatch (GF-24): obligations in the run
 * document with no claim, and records with no matching claim, are
 * printed as ledger notes — the CLI grades the former `missing`, so
 * bypassing the fixture can never read satisfied.
 *
 * Phase 1 — session identity is supervisor-issued: evidence primitives
 * resolve their session by the exact (workerIndex, testId) pair, and the
 * witness mints sessions ONLY for the supervisor channel. Since the
 * enforcement review (fix 3), the runner child holds NO supervisor
 * rights: `onTestBegin`/`onTestEnd` write lifecycle events (testBegin/
 * testEnd with the observed outcome) to the run-state SPOOL
 * (`<stateDir>/spool/<runId>/events.jsonl`, NUL-safe JSON lines) and the
 * TRUSTED CLI drains the spool, performing the witness's session
 * open/close with supervisor credentials that exist only in the CLI
 * process. Session RPC failures are therefore impossible here by
 * construction; a missing drain leaves no sessions open, and the
 * witness rejects every submission fail-closed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalOf } from '../json.js';
import type { Classification, HttpRouteCandidate } from '@gate-forge/core';
import {
  CLAIM_ANNOTATION_TYPE,
  CLAIM_INJECTIONS_FILE,
  ENV_OBLIGATIONS,
  ENV_OUTCOMES_FILE,
  ENV_REPORTER_FAIL_RUN,
  ENV_RUN_ID,
  ENV_STATE_DIR,
  ENV_WITNESS_URL,
} from '../constants.js';
import { appendSpoolEvent, spoolPathFor } from '../supervisor/spool.js';
import { WitnessClient, type IssuedLedgerRecord } from '../fixture/witness-client.js';
import { resolveWitnessUrl } from '../fixture/witness-client.js';
import {
  claimOf,
  isBlocking,
  ledgerRowFor,
  parseObligationsDocument,
  type LedgerRow,
  type ObligationsDocument,
} from './ledger.js';

/** One collected claim row (test identity + its claims). */
interface ClaimRow {
  testId: string;
  testFile: string;
  location: { file: string; line: number; col: number } | null;
  claims: string[];
  status: string;
}

/** One captured runner outcome row (supervision input, ADR 0005 D2). */
interface RunnerOutcomeRow {
  testId: string;
  file: string;
  titlePath: string[];
  project: string | null;
  status: string;
  attempt: number;
  expectedFailure: boolean;
}

/** The runner-outcomes document (schema mirrored by supervised-run.ts). */
interface RunnerOutcomesDocument {
  schemaVersion: 1;
  runStatus: string | null;
  runnerErrors: string[];
  outcomes: RunnerOutcomeRow[];
  shard: { index: number; total: number } | null;
}

/** The claim-injections document the orchestrating CLI writes. */
interface ClaimInjectionsDocument {
  schemaVersion: 1;
  /** reconciliation key `<file>#<titlePath.join('>')>` → obligation ids. */
  injections: Record<string, string[]>;
}

/** Minimal reporter-side test shape (Playwright's TestCase in practice). */
export interface ReporterTest {
  id: string;
  title?: string;
  titlePath?: () => string[];
  annotations?: Array<{ type: string; description?: string }>;
  location?: { file: string; line: number; column: number };
  /** Project name when the runner exposes it (best effort). */
  project?: { name?: string } | null;
  /**
   * The enclosing suite (playwright's reporter hierarchy
   * root → project → file → describe), when the runner exposes it —
   * the describe-stack source for the catalog-identity title path.
   */
  parent?: ReporterSuiteLike | null;
}

/** Structural subset of the runner's suite node (see {@link ReporterTest}). */
export interface ReporterSuiteLike {
  /** Suite title ('' for root, project-less, and file suites). */
  title?: string;
  /** Source location; MISSING for root and project suites. */
  location?: { file: string; line: number; column: number } | null;
  /** Suite kind when the runner exposes it (`root`/`project`/`file`/`describe`). */
  type?: 'root' | 'project' | 'file' | 'describe';
  parent?: ReporterSuiteLike | null;
}

/**
 * Computes the honest aggregate line (plan Phase 4 item 7, §2 row): the
 * reporter NEVER prints an overall gate pass based only on claimed rows
 * while unclaimed obligations block. Pure and deterministic — exported
 * so the honesty contract is directly testable.
 *
 * Args:
 *   rows: the per-claim ledger rows.
 *   unclaimedObligations: count of run obligations with no claim row.
 *
 * Returns:
 *   string: the aggregate summary line.
 */
export function gateSummaryLine(rows: readonly LedgerRow[], unclaimedObligations: number): string {
  const blocking = rows.filter((row) => isBlocking(row.verdict));
  const authority =
    'final gate result: the gateforge CLI (test-gates/check), never this reporter';
  if (blocking.length > 0) {
    return `GATEFORGE GATE: FAIL (${String(blocking.length)}/${String(rows.length)} claimed obligations not satisfied; ${authority})`;
  }
  if (unclaimedObligations > 0) {
    return (
      `GATEFORGE GATE: NOT PASSED (${String(rows.length)} claimed obligation(s) satisfied, ` +
      `${String(unclaimedObligations)} unclaimed obligation(s) still block; ${authority})`
    );
  }
  if (rows.length === 0) {
    return `GATEFORGE GATE: NO CLAIMS (no gateforge claims found in this run; ${authority})`;
  }
  return `GATEFORGE GATE: PASS (${String(rows.length)}/${String(rows.length)} claimed obligations satisfied; ${authority})`;
}

/** Constructor options for the gateforge reporter (trusted-config path). */
export interface GateforgeReporterOptions {
  /** Run-state dir override (precedence over GATEFORGE_STATE_DIR env). */
  stateDir?: string;
  /** Run id override (precedence over GATEFORGE_RUN_ID env). */
  runId?: string;
  /** Runner-outcomes path override (precedence over GATEFORGE_OUTCOMES_FILE env). */
  outcomesPath?: string;
  /** Obligations document path override (precedence over GATEFORGE_OBLIGATIONS env). */
  obligationsPath?: string;
}

/**
 * The gateforge reporter. No options today; the constructor signature is
 * the Playwright reporter contract (`(options: object)`).
 */
export class GateforgeReporter {
  private readonly rows: ClaimRow[] = [];
  /**
   * Phase 4 claim injections (reconciliation key → obligation ids),
   * loaded once from the CLI-written run-state document. Declarations
   * only — they never satisfy anything by themselves.
   */
  private readonly injections: Map<string, string[]>;
  /** Phase 4 runner-outcome capture (supervision input, ADR 0005 D2). */
  private readonly runnerOutcomes: RunnerOutcomeRow[] = [];
  private runStatus: string | null = null;
  private readonly runnerErrors: string[] = [];
  /** The lifecycle spool file (null when the run has no state dir). */
  private readonly spoolFile: string | null;
  /** Resolved run-state paths (options win, env is the legacy fallback). */
  private readonly resolved: { stateDir: string | null; runId: string | null; outcomesPath: string | null; obligationsPath: string | null };

  constructor(options: GateforgeReporterOptions = {}) {
    const stateDir = options.stateDir ?? process.env[ENV_STATE_DIR];
    const runId = options.runId ?? process.env[ENV_RUN_ID];
    const outcomesPath = options.outcomesPath ?? process.env[ENV_OUTCOMES_FILE];
    const obligationsPath = options.obligationsPath ?? process.env[ENV_OBLIGATIONS];
    this.resolved = {
      stateDir: stateDir !== undefined && stateDir !== '' ? stateDir : null,
      runId: runId !== undefined && runId !== '' ? runId : null,
      outcomesPath: outcomesPath !== undefined && outcomesPath !== '' ? outcomesPath : null,
      obligationsPath: obligationsPath !== undefined && obligationsPath !== '' ? obligationsPath : null,
    };
    const wired =
      (process.env[ENV_WITNESS_URL] ?? '') !== '' ||
      (this.resolved.stateDir ?? '') !== '';
    if (!wired) {
      console.warn(
        `[gateforge] no witness/state wiring (${ENV_WITNESS_URL} or ${ENV_STATE_DIR}); ` +
          'claims/records will not be written and evidence primitives fail closed',
      );
    }
    this.injections = readClaimInjections(this.resolved.stateDir ?? undefined);
    // The lifecycle spool (enforcement-review fix 3): the trusted CLI
    // drains these events and drives the witness supervisor channel.
    // Without a state dir or run id there is nothing to drain — the
    // supervisor then never opens sessions and submissions fail closed.
    this.spoolFile =
      this.resolved.stateDir !== null && this.resolved.runId !== null
        ? spoolPathFor(this.resolved.stateDir, this.resolved.runId)
        : null;
  }

  /**
   * Lifecycle spool write (enforcement-review fix 3): announces the
   * STARTED test to the trusted CLI's drain — which opens the witness
   * session on the supervisor channel, carrying the mapped obligation
   * claims for sidecar/native-mapped tests (Phase 4 claim injection) —
   * and binds worker → session there. The runner itself performs no
   * privileged call. Synchronous API: the CLI's poll cadence absorbs
   * the dispatch latency (the fixture's session resolve waits up to 5s).
   */
  onTestBegin(
    test: ReporterTest,
    result: { workerIndex?: number },
  ): void {
    if (this.spoolFile === null) return;
    const workerIndex = typeof result.workerIndex === 'number' ? result.workerIndex : 0;
    const claims = [...new Set([...this.annotationClaimsOf(test), ...this.injectedClaimsFor(test)])].sort();
    appendSpoolEvent(this.spoolFile, {
      kind: 'testBegin',
      testId: test.id,
      workerIndex,
      file: this.repoRelativeOf(test),
      titlePath: this.titlePathOf(test),
      project: this.projectOf(test),
      ...(claims.length > 0 ? { claims } : {}),
    });
  }

  /** Runner-level error hook: a global setup/teardown/runner error. */
  onError(error: { message?: string }): void {
    this.runnerErrors.push(typeof error?.message === 'string' ? error.message : String(error));
  }

  /** Collects claims + test identity + the outcome row at test end (synchronous). */
  onTestEnd(test: ReporterTest, result: { status: string; workerIndex?: number; retry?: number }): void {
    // Phase 4: capture the outcome row for trusted runner supervision
    // (every test, claimed or not — the expected set includes them all).
    const titlePath = this.titlePathOf(test);
    const file = this.repoRelativeOf(test);
    this.runnerOutcomes.push({
      testId: test.id,
      ...(file !== null ? { file } : { file: '' }),
      titlePath,
      project: this.projectOf(test),
      status: result.status,
      attempt: (typeof result.retry === 'number' ? result.retry : 0) + 1,
      expectedFailure: (test.annotations ?? []).some((annotation) => annotation.type === 'fail'),
    });
    // Lifecycle spool write (fix 3): the CLI drains this and seals the
    // session with the OBSERVED outcome on the supervisor channel.
    // Sealing is final, so records cannot be injected after the test.
    if (this.spoolFile !== null) {
      appendSpoolEvent(this.spoolFile, {
        kind: 'testEnd',
        testId: test.id,
        workerIndex: typeof result.workerIndex === 'number' ? result.workerIndex : 0,
        file,
        titlePath,
        project: this.projectOf(test),
        outcome: result.status,
        attempt: (typeof result.retry === 'number' ? result.retry : 0) + 1,
      });
    }
    // Claims: native annotations keep working unchanged; Phase 4 adds
    // the injected claims (reconciled by file + title path) so a mapped
    // test's evidence lands on the right claims. Both merge into one row
    // (deduplicated, sorted) with the runner's own testId.
    const claims = [...new Set([...this.annotationClaimsOf(test), ...this.injectedClaimsFor(test)])].sort();
    if (claims.length === 0) return;
    this.rows.push({
      testId: test.id,
      testFile: file ?? '',
      location:
        test.location === undefined || test.location === null
          ? null
          : { file: test.location.file, line: test.location.line, col: test.location.column },
      claims,
      status: result.status,
    });
  }

  /** Playswright `onEnd`: seal the run-level outcome + write artifacts. */
  async onEnd(result?: { status?: string }): Promise<void> {
    this.runStatus = typeof result?.status === 'string' ? result.status : null;
    // (Session settlement moved to the trusted CLI's spool drain —
    // enforcement-review fix 3; nothing awaits here.)
    this.writeRunnerOutcomes();
    const stateDir = this.resolved.stateDir;
    if (stateDir === null) {
      if (this.rows.length > 0) {
        console.warn('[gateforge] claims collected but no state dir: artifacts not written');
      }
      return;
    }

    // claims.json — the claim registry (GF-24's left side). Empty when
    // the suite bypassed the fixture (GF-24) — the CLI still grades the
    // run's obligations `missing`.
    const claims = this.rows.flatMap((row) =>
      row.claims.map((obligationId) => ({
        schemaVersion: 1,
        obligationId,
        testId: row.testId,
        ...(row.testFile === '' ? {} : { testFile: row.testFile }),
        ...(row.location === null ? {} : { location: row.location }),
      })),
    );
    writeJson(stateDir, 'claims.json', claims);

    // records.json — ONLY the witness-issued ledger (GF-23 enforcement).
    let records: IssuedLedgerRecord[] = [];
    try {
      const client = new WitnessClient(resolveWitnessUrl());
      const ledger = (await client.listRecords()) as { records?: IssuedLedgerRecord[] };
      records = Array.isArray(ledger.records) ? ledger.records : [];
    } catch (error) {
      console.warn(`[gateforge] cannot fetch the witness ledger: ${(error as Error).message}`);
    }
    writeJson(stateDir, 'records.json', records);

    const obligationsRaw = readObligationsRaw(this.resolved.obligationsPath);
    const obligations = obligationsRaw === null ? null : parseObligationsDocument(obligationsRaw);
    const classifications = await this.fetchClassifications();
    const now = this.runInstant(stateDir);
    // Advisory route inventory (plan §9): the CLI-derived
    // `http-routes.json` when present. Absent → null, and the core
    // resolver returns its blocking missing-context result for HTTP
    // rows. Never authoritative: the CLI recomputes from source.
    const httpRoutes = readHttpRoutes(stateDir);

    const ledger = this.ledgerRows(obligations, classifications, records, now, httpRoutes);
    writeJson(stateDir, 'ledger.json', ledger);
    const unclaimed =
      obligations === null
        ? 0
        : new Set(
            obligations.obligations
              .filter((entry) => !this.rows.some((row) => row.claims.includes(entry.id)))
              .map((entry) => entry.id),
          ).size;
    this.printLedger(ledger, unclaimed);
    this.printRegistryMismatches(obligations, records);

    const blocking = ledger.some((row) => isBlocking(row.verdict));
    if (blocking && process.env[ENV_REPORTER_FAIL_RUN] === '1') {
      // Playwright overrides `process.exitCode` after reporters run, so
      // setting it here does not fail the run (1.58.2 observed; the
      // spike documented the same). GATEFORGE_REPORTER_FAIL_RUN=1 is an
      // explicit opt-in to hard-exit: the gate ledger above is already
      // printed, so exiting here loses nothing but the runner summary.
      process.exit(1);
    }
  }

  /** Full title path of a test (runner API when present, else [title]). */
  /**
   * The catalog-identity title path: describe titles + the test title —
   * NOT the runner's full path. Playwright's suite hierarchy is
   * root → project → file → describe; identity joins (supervision,
   * claim injections) use the SAME shape the native `--list` enumeration
   * reports (describes + title), so the root/project/file suites are
   * stripped here — by suite `type` when exposed, else by the location
   * heuristic (root/project suites carry no source location; the file
   * suite is the outermost suite that does). A project name or file name
   * must never leak into the identity. Without a parent chain, the bare
   * title keeps the row visible (never misjoined).
   */
  private titlePathOf(test: ReporterTest): string[] {
    const title = test.title ?? test.id;
    const describes: string[] = [];
    let suite = test.parent ?? null;
    while (suite !== null) {
      if (this.isDescribeBoundary(suite)) break;
      if (typeof suite.title === 'string' && suite.title.length > 0) describes.unshift(suite.title);
      suite = suite.parent ?? null;
    }
    return [...describes, title];
  }

  /**
   * The runner project name for the supervision identity: the
   * `project`-typed ancestor's title (reporter-API `TestCase` carries no
   * `project` member), else the first location-less ancestor, else the
   * runner-provided `project.name` best-effort. Absence stays `null` —
   * never a fabricated project.
   */
  private projectOf(test: ReporterTest): string | null {
    let suite = test.parent ?? null;
    while (suite !== null) {
      if (suite.type !== undefined) {
        if (suite.type === 'project') {
          return typeof suite.title === 'string' && suite.title.length > 0 ? suite.title : null;
        }
        if (suite.type === 'root') break;
      } else if (suite.location === undefined || suite.location === null) {
        return typeof suite.title === 'string' && suite.title.length > 0 ? suite.title : null;
      }
      suite = suite.parent ?? null;
    }
    return typeof test.project?.name === 'string' && test.project.name.length > 0 ? test.project.name : null;
  }

  /**
   * Whether this suite is at or above the describe level (root, project,
   * or the file suite itself) — walking must stop here. By `type` when
   * exposed; otherwise the file suite is the OUTERMOST suite with a
   * source location (its parent is root/project or absent).
   */
  private isDescribeBoundary(suite: ReporterSuiteLike): boolean {
    if (suite.type !== undefined) {
      return suite.type !== 'describe';
    }
    const locationless = suite.location === undefined || suite.location === null;
    if (locationless) return true;
    const parent = suite.parent ?? null;
    if (parent === null) return true;
    if (parent.type !== undefined) return parent.type !== 'describe';
    return parent.location === undefined || parent.location === null;
  }

  /** Repo-relative posix file of a test (null when unknown). */
  private repoRelativeOf(test: ReporterTest): string | null {
    if (test.location?.file === undefined || test.location.file === null) return null;
    const raw = test.location.file;
    if (raw.length === 0) return null;
    return relative(process.cwd(), raw).split(sep).join('/');
  }

  /** Native annotation claims of one test (`{type: 'gateforge'}`). */
  private annotationClaimsOf(test: ReporterTest): string[] {
    return (test.annotations ?? [])
      .filter((annotation) => annotation.type === CLAIM_ANNOTATION_TYPE)
      .map((annotation) => annotation.description ?? '')
      .filter((description) => description.length > 0);
  }

  /** Injection-key lookup for one test: `<file>#<titlePath.join('>')>`. */
  private injectedClaimsFor(test: ReporterTest): string[] {
    const file = this.repoRelativeOf(test);
    if (file === null || this.injections.size === 0) return [];
    const key = `${file}#${this.titlePathOf(test).join('>')}`;
    return this.injections.get(key) ?? [];
  }

  /** Writes the runner-outcomes document when the supervisor asked for it. */
  private writeRunnerOutcomes(): void {
    const outcomesPath = this.resolved.outcomesPath;
    if (outcomesPath === null) return;
    const shardRaw = process.env['TEST_SHARD'] ?? '';
    const shardMatch = /^(\d+)\/(\d+)$/.exec(shardRaw);
    const document: RunnerOutcomesDocument = {
      schemaVersion: 1,
      runStatus: this.runStatus,
      runnerErrors: [...this.runnerErrors],
      outcomes: [...this.runnerOutcomes].sort(
        (a, b) =>
          (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
          (a.titlePath.join('>') < b.titlePath.join('>') ? -1 : 1) ||
          (a.testId < b.testId ? -1 : 1),
      ),
      shard:
        shardMatch !== null
          ? { index: Number(shardMatch[1]), total: Number(shardMatch[2]) }
          : null,
    };
    try {
      mkdirSync(join(outcomesPath, '..'), { recursive: true });
      writeFileSync(outcomesPath, `${canonicalOf(document as unknown as Record<string, unknown>)}\n`, 'utf8');
    } catch (error) {
      // The outcomes document is supervision input; failing to write it
      // must not crash the run — supervision then sees NO outcomes
      // document and fails closed on its own.
      console.warn(`[gateforge] cannot write runner outcomes: ${(error as Error).message}`);
    }
  }

  /** The witness classification projection (real lifecycle + primaryKey). */
  private async fetchClassifications(): Promise<
    Record<
      string,
      {
        primaryKey: string[];
        exposure: string;
        plane: string;
        evidenceAdapter?: string;
        evidenceLane?: 'adapter' | 'claims';
        lifecycle: Classification['lifecycle'];
      }
    >
  > {
    try {
      const client = new WitnessClient(resolveWitnessUrl());
      const response = (await authenticatedFetch(client.url, '/classifications', client.token)) as {
        resources?: unknown;
      };
      if (typeof response !== 'object' || response === null) return {};
      const resources = response['resources'];
      if (typeof resources !== 'object' || resources === null) return {};
      const out: Record<
        string,
        {
          primaryKey: string[];
          exposure: string;
          plane: string;
          evidenceAdapter?: string;
          evidenceLane?: 'adapter' | 'claims';
          lifecycle: Classification['lifecycle'];
        }
      > = {};
      for (const [resourceId, view] of Object.entries(resources as Record<string, unknown>)) {
        const entry = view as {
          primaryKey?: unknown;
          exposure?: unknown;
          plane?: unknown;
          evidenceAdapter?: unknown;
          evidenceLane?: unknown;
          lifecycle?: unknown;
        };
        const lifecycle = (entry['lifecycle'] ?? {}) as Record<string, unknown>;
        out[resourceId] = {
          primaryKey: Array.isArray(entry['primaryKey'])
            ? (entry['primaryKey'] as unknown[]).filter(
                (key): key is string => typeof key === 'string',
              )
            : ['id'],
          exposure: typeof entry['exposure'] === 'string' ? entry['exposure'] : 'user-facing',
          plane: typeof entry['plane'] === 'string' ? entry['plane'] : 'tenant',
          ...(typeof entry['evidenceAdapter'] === 'string'
            ? { evidenceAdapter: entry['evidenceAdapter'] }
            : {}),
          // The claims lane (http.endpoint resources) MUST reach the
          // engine: without it a user-facing adapter-free entry fails the
          // engine's classification validation and grades unclassified.
          ...(entry['evidenceLane'] === 'adapter' || entry['evidenceLane'] === 'claims'
            ? { evidenceLane: entry['evidenceLane'] }
            : {}),
          lifecycle: {
            create: lifecycle['create'] === true,
            read: lifecycle['read'] === true,
            update: lifecycle['update'] === true,
            delete: lifecycle['delete'] === true,
            ...(lifecycle['deleteSemantics'] === 'hard' || lifecycle['deleteSemantics'] === 'archive'
              ? { deleteSemantics: lifecycle['deleteSemantics'] }
              : {}),
            // Owner-owned archived state must reach the engine: it grades
            // archive postconditions against it (audit round 5).
            ...(typeof lifecycle['archiveFields'] === 'object' &&
            lifecycle['archiveFields'] !== null &&
            !Array.isArray(lifecycle['archiveFields'])
              ? {
                  archiveFields: lifecycle['archiveFields'] as Record<
                    string,
                    string | number | boolean
                  >,
                }
              : {}),
            ...(Array.isArray(lifecycle['updateableFields'])
              ? {
                  updateableFields: lifecycle['updateableFields'].filter(
                    (field): field is string => typeof field === 'string',
                  ),
                }
              : {}),
          },
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private ledgerRows(
    obligations: ObligationsDocument | null,
    classifications: Record<
      string,
      {
        primaryKey: string[];
        exposure: string;
        plane: string;
        evidenceAdapter?: string;
        evidenceLane?: 'adapter' | 'claims';
        lifecycle: Classification['lifecycle'];
      }
    >,
    records: readonly IssuedLedgerRecord[],
    now: string,
    httpRoutes: readonly HttpRouteCandidate[] | null,
  ): LedgerRow[] {
    const classMap: Record<string, Classification> = {};
    for (const [resourceId, view] of Object.entries(classifications)) {
      const primaryKey = view.primaryKey.length > 0 ? view.primaryKey : ['id'];
      classMap[resourceId] = {
        exposure: view.exposure === 'internal' ? 'internal' : 'user-facing',
        plane: view.plane === 'master' ? 'master' : view.plane === 'global' ? 'global' : 'tenant',
        ...(view.evidenceAdapter === undefined ? {} : { evidenceAdapter: view.evidenceAdapter }),
        ...(view.evidenceLane === undefined ? {} : { evidenceLane: view.evidenceLane }),
        lifecycle: view.lifecycle,
        primaryKey,
      };
    }
    const rows: LedgerRow[] = [];
    for (const row of this.rows) {
      for (const obligationId of row.claims) {
        rows.push(
          ledgerRowFor(
            claimOf(obligationId, {
              id: row.testId,
              location:
                row.location === null
                  ? null
                  : {
                      file: row.location.file,
                      line: row.location.line,
                      column: row.location.col,
                    },
            }),
            obligations,
            classMap,
            records,
            now,
            httpRoutes,
          ),
        );
      }
    }
    return rows.sort((a, b) =>
      a.claim === b.claim ? (a.testId < b.testId ? -1 : 1) : a.claim < b.claim ? -1 : 1,
    );
  }

  /** Deterministic instant: the run manifest's injected `startedAt`. */
  private runInstant(stateDir: string): string {
    try {
      const manifest = JSON.parse(readFileSync(join(stateDir, 'manifest.json'), 'utf8')) as {
        startedAt?: unknown;
      };
      if (typeof manifest.startedAt === 'string') return manifest.startedAt;
    } catch {
      // fall through
    }
    return new Date().toISOString();
  }

  /**
   * Prints the per-claim verdict ledger + the HONEST aggregate line
   * (plan Phase 4 item 7): never an overall pass while unclaimed
   * obligations block; the authoritative CLI remains the only final
   * gate result.
   */
  private printLedger(rows: LedgerRow[], unclaimedObligations: number): void {
    const width = Math.max('CLAIMED OBLIGATION'.length, ...rows.map((row) => row.claim.length));
    console.log('\n=== GATEFORGE VERDICTS ===');
    if (rows.length === 0) {
      console.log('no gateforge claims found in this run');
    }
    for (const row of rows) {
      console.log(
        `${String(row.verdict).toUpperCase().padEnd(10)} ${row.claim.padEnd(width)}  ${row.testFile}`,
      );
      if (row.reason !== null) {
        console.log(`           - ${row.reason}`);
      }
      if (row.recordIds.length > 0) {
        console.log(`           - records: ${row.recordIds.join(', ')}`);
      }
    }
    console.log(gateSummaryLine(rows, unclaimedObligations));
    console.log('==========================\n');
  }

  /** GF-24 observability: obligations nobody claimed + records nobody claimed. */
  private printRegistryMismatches(
    obligations: ReturnType<typeof parseObligationsDocument>,
    records: readonly IssuedLedgerRecord[],
  ): void {
    const claimed = new Set(this.rows.flatMap((row) => row.claims));
    if (obligations !== null) {
      const unclaimed = obligations.obligations
        .filter((entry) => !claimed.has(entry.id))
        .map((entry) => entry.id)
        .sort();
      if (unclaimed.length > 0) {
        console.warn(
          `[gateforge] obligations without any claim (will grade missing): ${unclaimed.join(', ')}`,
        );
      }
    }
    const claimedPairs = new Set(
      this.rows.flatMap((row) => row.claims.map((claim) => `${claim}\u0000${row.testId}`)),
    );
    const orphans = records
      .filter((record) => !claimedPairs.has(`${record.obligationId}\u0000${record.testId}`))
      .map((record) => `${record.obligationId} (${record.testId})`)
      .sort();
    if (orphans.length > 0) {
      console.warn(
        `[gateforge] witness records with no matching claim (claim-registry mismatch, GF-24): ${orphans.join(', ')}`,
      );
    }
  }
}

// Playwright custom reporters MUST be the module's default export.
export default GateforgeReporter;

export type { LedgerRow };

/**
 * Reads the CLI-derived advisory route inventory (`http-routes.json`,
 * written by `test-gates` beside the obligations document). Returns
 * null when absent or malformed — the core resolver then returns its
 * blocking missing-context result for HTTP rows. Advisory only: the
 * authoritative CLI recomputes this list from source.
 *
 * Args:
 *   stateDir: absolute run-state directory.
 *
 * Returns:
 *   readonly HttpRouteCandidate[] | null: the advisory inventory or null.
 */
function readHttpRoutes(stateDir: string): readonly HttpRouteCandidate[] | null {
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, 'http-routes.json'), 'utf8');
  } catch {
    return null;
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return null;
  const routes = (document as Record<string, unknown>)['routes'];
  if (!Array.isArray(routes)) return null;
  const candidates: HttpRouteCandidate[] = [];
  for (const entry of routes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate['resourceId'] !== 'string' ||
      typeof candidate['method'] !== 'string' ||
      typeof candidate['canonicalPath'] !== 'string'
    ) {
      return null;
    }
    candidates.push({
      resourceId: candidate['resourceId'],
      method: candidate['method'],
      canonicalPath: candidate['canonicalPath'],
    });
  }
  return candidates;
}

/** Reads the obligations document path from options/env (null when unset/broken). */
function readObligationsRaw(obligationsPath: string | null): string | null {
  const path = obligationsPath ?? process.env[ENV_OBLIGATIONS] ?? null;
  if (path === null || path === '') return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Loads the CLI-written claim-injections document (Phase 4): a
 * reconciliation key → obligation ids map for sidecar/native-mapped
 * tests. Malformed documents contribute NOTHING (never a partial map) —
 * injected claims are declarations, and a broken declaration must not
 * silently redirect evidence.
 *
 * Args:
 *   stateDir: absolute run-state directory, when wired.
 *
 * Returns:
 *   Map<string, string[]>: reconciliation key → sorted obligation ids.
 */
function readClaimInjections(stateDir: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (stateDir === undefined || stateDir === '') return out;
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, CLAIM_INJECTIONS_FILE), 'utf8');
  } catch {
    return out; // absent: annotation-only run (the common case)
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return out;
  const injections = (document as Record<string, unknown>)['injections'];
  if (typeof injections !== 'object' || injections === null || Array.isArray(injections)) return out;
  for (const [key, value] of Object.entries(injections as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const claims = value.filter((claim): claim is string => typeof claim === 'string' && claim.length > 0);
    if (claims.length === 0) continue;
    out.set(key, [...new Set(claims)].sort());
  }
  return out;
}

/** Writes one GF-canonical JSON state artifact. */
function writeJson(stateDir: string, name: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, name), `${canonicalOf(value)}\n`, 'utf8');
}

/** Authenticated GET helper for reporter-side witness calls. */
async function authenticatedFetch(
  url: string,
  path: string,
  token: string,
): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    headers: { 'x-gateforge-run': token, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`witness ${path} answered HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}