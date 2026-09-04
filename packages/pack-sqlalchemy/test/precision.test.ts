/**
 * Detector-precision suite (phase 2): table-candidate recognition.
 *
 * The old candidate predicate — `has_facts or bool(self.bases)` — turned
 * every class with ANY base (Pydantic models, settings, Enums, ABCs,
 * exceptions, plain project bases) into a SQLAlchemy table candidate; a
 * real dogfood produced ~1,100 false-positive BLOCKING entries from
 * Pydantic schema directories alone. These tests pin the precise
 * predicate in BOTH directions:
 *
 *   - negative: non-model shapes produce ZERO output (no symbol, no
 *     table, no unresolved entry) — guarded as a RED-PROBE pair whose
 *     broken branch re-introduces the old predicate on a patched copy of
 *     the python detector and requires the guard to FAIL there;
 *   - positive: every genuine declarative shape (legacy alias,
 *     DeclarativeBase subclass, registry-generated base, conventional
 *     cross-file `Base`, mixin mixing, inheritance closure across files)
 *     is still recognized, with unresolved classes keeping their typed
 *     `no_tablename_source` entries.
 *
 * Deterministic and offline: each test spawns the documented
 * `python3 -m gateforge_sqlalchemy_detector` subprocess over fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRedProbe } from '@gateforge/core';
import { PluginSession, type DiscoveryOutcome } from '@gateforge/plugin-protocol';
import { FIXTURE_ROOT, PACK_PYTHON, pythonEnv, runDiscover } from './helpers.js';
import { PACK_PLUGIN_ID, PACK_VERSION } from '../src/version.js';

const byKind = (outcome: DiscoveryOutcome, kind: string): unknown[] =>
  outcome.resources.filter((resource) => resource.kind === kind);

describe('phase 2: non-model classes are never candidates', () => {
  it('emits NOTHING for the non-model zoo (pydantic/enum/abc/exception/mixin shapes)', async () => {
    const outcome = await runDiscover(['non_models.py']);
    expect(outcome.resources).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.classificationSignals).toEqual([]);
    expect(outcome.findings).toEqual([]);
  }, 60_000);

  it('emits NOTHING when Base is aliased from a denylisted module (pydantic)', async () => {
    const outcome = await runDiscover(['denylisted_base.py']);
    expect(outcome.resources).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.classificationSignals).toEqual([]);
    expect(outcome.findings).toEqual([]);
  }, 60_000);

  it('keeps non-models silent even when scanned alongside real models', async () => {
    const outcome = await runDiscover([
      'candidates.py',
      'non_models.py',
      'denylisted_base.py',
    ]);
    const sources = new Set(outcome.resources.map((resource) => resource.source));
    expect(sources).toEqual(new Set(['candidates.py']));
    expect(outcome.unresolved.every((entry) => entry.location.file === 'candidates.py')).toBe(true);
  }, 60_000);
});

describe('phase 2: genuine candidates stay recognized', () => {
  it('recognizes every declarative style in the positive matrix', async () => {
    const outcome = await runDiscover(['candidates.py']);
    const tables = byKind(outcome, 'sqlalchemy.table') as Array<{
      attributes: Record<string, unknown>;
    }>;
    expect(tables.map((table) => table.attributes['resourceName']).sort()).toEqual([
      'candidate_accounts',
      'candidate_audit_rows',
      'candidate_event_log', // direct Table() declaration
    ]);
    const symbols = byKind(outcome, 'gateforge.class') as Array<{
      attributes: Record<string, unknown>;
    }>;
    const qnames = symbols.map((symbol) => symbol.attributes['qname']).sort();
    // Candidates + pure bases; TimestampMixin (no bases, no facts) is ABSENT.
    expect(qnames).toEqual([
      'AbstractShape',
      'Account',
      'AuditedRow',
      'ModernBase',
      'Profile',
      'SalariedEmployee',
      'Tenant',
      'User',
    ]);
    // Pure declarative bases (ModernBase, AbstractShape) never materialize
    // and never claim an unresolved tablename.
    for (const pure of ['ModernBase', 'AbstractShape']) {
      const symbol = symbols.find((symbol) => symbol.attributes['qname'] === pure);
      expect(symbol?.attributes['tablenameUnresolved']).toBe(false);
    }
  }, 60_000);

  it('keeps genuine-but-unnamed candidates typed unresolved (never auto-derived)', async () => {
    const outcome = await runDiscover(['candidates.py']);
    const codes = outcome.unresolved.map((entry) => `${entry.code}@${entry.location.line}`);
    // User (legacy alias), Profile (DeclarativeBase subclass),
    // SalariedEmployee (closure), Tenant (registry-generated base).
    expect(codes).toEqual([
      'no_tablename_source@30',
      'no_tablename_source@48',
      'no_tablename_source@54',
      'no_tablename_source@64',
    ]);
    const userSymbol = (byKind(outcome, 'gateforge.class') as Array<{
      attributes: Record<string, unknown>;
    }>).find((symbol) => symbol.attributes['qname'] === 'User');
    expect(userSymbol?.attributes['tablenameUnresolved']).toBe(true);
  }, 60_000);

  it('resolves multi-level inheritance ACROSS files through the closure', async () => {
    const outcome = await runDiscover(['candidates.py', 'candidate_closure.py']);
    const qnames = (byKind(outcome, 'gateforge.class') as Array<{
      attributes: Record<string, unknown>;
    }>).map((symbol) => symbol.attributes['qname']);
    expect(qnames).toContain('Contractor');
    const contractor = outcome.unresolved.find(
      (entry) => entry.location.file === 'candidate_closure.py',
    );
    expect(contractor?.code).toBe('no_tablename_source');
  }, 60_000);

  it('leaves a cross-file chain subclass silent when its base file is absent', async () => {
    // Flat-scan honesty: without candidates.py the closure cannot know
    // SalariedEmployee is a model — and guessing is the old bug.
    const outcome = await runDiscover(['candidate_closure.py']);
    expect(outcome.resources).toEqual([]);
    expect(outcome.unresolved).toEqual([]);
  }, 60_000);
});

describe('phase 2: local definition evidence bounds the closure', () => {
  it('a denylisted local namesake never inherits candidacy from a genuine remote model', async () => {
    // shadow_schemas.py defines `class WebhookEvent(BaseModel)` while
    // shadow_models.py defines a genuine `class WebhookEvent(Base)` — the
    // closure matches by simple name only, so the LOCAL denylisted
    // definition (and its subclasses) must veto the remote namesake.
    const outcome = await runDiscover(['shadow_schemas.py', 'shadow_models.py']);
    const sources = new Set(outcome.resources.map((resource) => resource.source));
    expect(sources).toEqual(new Set(['shadow_models.py']));
    const tables = byKind(outcome, 'sqlalchemy.table') as Array<{
      attributes: Record<string, unknown>;
    }>;
    expect(tables.map((table) => table.attributes['resourceName']).sort()).toEqual([
      'shadow_payment_receipts',
      'shadow_webhook_events',
    ]);
    const qnames = (byKind(outcome, 'gateforge.class') as Array<{
      attributes: Record<string, unknown>;
    }>)
      .map((symbol) => symbol.attributes['qname'])
      .sort();
    expect(qnames).toEqual(['PaymentReceipt', 'WebhookEvent']);
    expect(outcome.unresolved).toEqual([]);
    expect(outcome.findings).toEqual([]);
  }, 60_000);

  it('keeps the local subclass bound to its LOCAL genuine base', async () => {
    // The veto is per-file evidence, not a global name ban:
    // PaymentReceipt(WebhookEvent) in shadow_models.py still inherits
    // candidacy from its own file's genuine WebhookEvent.
    const outcome = await runDiscover(['shadow_models.py']);
    expect((byKind(outcome, 'sqlalchemy.table')).length).toBe(2);
    expect((byKind(outcome, 'gateforge.class')).length).toBe(2);
  }, 60_000);
});

describe('phase 2 red probe: the old bases-only predicate must fail the guard', () => {
  it('the zero-output guard fails against a deliberately broken detector', async () => {
    const sourceDir = fileURLToPath(new URL('../python/gateforge_sqlalchemy_detector', import.meta.url));
    const record = await runRedProbe({
      name: 'phase2-candidate-precision',
      green: async () => {
        const outcome = await runDiscover(['non_models.py']);
        expect(outcome.resources).toEqual([]);
        expect(outcome.unresolved).toEqual([]);
      },
      broken: async () => {
        // Re-introduce the OLD predicate (`… or bool(self.bases)`) on a
        // patched COPY of the python package (the copy shadows the real
        // one via PYTHONPATH order) and run the IDENTICAL guard — it
        // must FAIL (fake candidates reappear). If the source drifts so
        // the patch no longer applies, the guard would pass and the
        // probe reports a fake green: the loudest possible failure.
        const dir = mkdtempSync(join(tmpdir(), 'gateforge-probe-sqlalchemy-'));
        try {
          const patched = join(dir, 'gateforge_sqlalchemy_detector');
          mkdirSync(patched, { recursive: true });
          for (const file of ['__init__.py', '__main__.py']) {
            copyFileSync(join(sourceDir, file), join(patched, file));
          }
          const scanSource = readFileSync(join(sourceDir, 'scan.py'), 'utf8');
          const predicate =
            'return any(idx.base_is_declarative(base, model_names) for base in self.bases)';
          expect(scanSource).toContain(predicate);
          writeFileSync(
            join(patched, 'scan.py'),
            scanSource.replace(predicate, `${predicate} or bool(self.bases)`),
            'utf8',
          );
          const session = new PluginSession({
            command: ['python3', '-m', 'gateforge_sqlalchemy_detector'],
            pluginId: PACK_PLUGIN_ID,
            pluginVersion: PACK_VERSION,
            cwd: FIXTURE_ROOT,
            // The patched package shadows the real one (extra entries go
            // first); PACK_PYTHON stays as the GPP client fallback tail.
            env: pythonEnv([dir, PACK_PYTHON]),
            timeouts: { handshakeMs: 10_000, requestMs: 30_000, shutdownMs: 10_000 },
          });
          try {
            await session.start();
            const outcome = await session.discover(['non_models.py']);
            // The OLD predicate: guard expects zero output — this must THROW.
            expect(outcome.resources).toEqual([]);
            expect(outcome.unresolved).toEqual([]);
          } finally {
            await session.dispose();
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    });
    expect(record.greenPassed).toBe(true);
    expect(record.brokenFailed).toBe(true);
    expect(record.ok).toBe(true);
  }, 60_000);
});
