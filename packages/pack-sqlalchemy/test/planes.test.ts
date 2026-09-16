/**
 * Declarative plane-config suite (phase 5): `.gateforge/planes.json`.
 *
 * Every business resource must carry plane evidence (`tenant | master |
 * global`) — the classifier blocks `PLANE_UNRESOLVED` otherwise. The
 * config channel is the explicit, human-reviewed fix: JSON only, one
 * rule per reviewed decision (a non-empty `reason` is REQUIRED), read
 * exactly like the pack-fastapi/pack-http scan-config precedents:
 * absence is normal (byte-identical `NO_PLANE_MAPPING`), malformed /
 * unknown-key / non-repo-relative documents throw (fail closed).
 *
 * Evaluation semantics (pinned here, unit + end-to-end), two tiers
 * with explicit-beats-general precedence:
 *   - a table claimed by ANY `tables` rule resolves ONLY against
 *     `tables` rules — `match` (glob) rules are ignored for it (an
 *     enumeration is a more specific human claim than a directory glob,
 *     and a glob's `exclude` prunes source files, not table names);
 *   - a `match` rule may carry `exclude` (repo-root-relative globs):
 *     a source path matching ANY exclusion removes the rule entirely,
 *     BEFORE tier collection — the documented exception for a directory
 *     surface mixing planes (contractor-scoped routers beside
 *     global-ingress files), explicit and reviewed instead of resolved
 *     by silent precedence;
 *   - glob rules apply only to tables no explicit rule claims;
 *   - within the deciding tier, ALL matching rules are collected
 *     (config order); agreement → `attributes.plane` on the
 *     `sqlalchemy.table` resource (the graph then qualifies ids as
 *     `plane.name`);
 *   - conflict WITHIN the tier → blocking `PLANE_RULE_CONTRADICTION`
 *     finding naming the table, every plane, every reason, every rule
 *     index; NO plane;
 *   - no match → nothing (the resource stays plane-unresolved and the
 *     classifier blocks it — closed-world completeness).
 *
 * The offline unit half runs against temp files and pure functions; the
 * end-to-end half spawns the documented detector over a temp project
 * (fixture `planes/**`, copied into the project root).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiscoveryOutcome } from '@gate-forge/plugin-protocol';
import {
  DEFAULT_PLANES_CONFIG,
  PLANES_CONFIG_PATH,
  PLANE_RULE_CONTRADICTION,
  byTableName,
  createSqlalchemyDetector,
  NO_PLANE_MAPPING,
  planeRuleMatches,
  readPlanesConfigOrNull,
  resolvePlaneByRules,
  type PlaneConfigRule,
  type PlanesConfig,
  type SqlalchemyDetectorOptions,
} from '../src/index.js';
import { FIXTURE_ROOT } from './helpers.js';

const ORIGINAL_CWD = process.cwd();

/** Fixture files copied into every temp project (repo-relative). */
const PLANE_FIXTURES: Readonly<Record<string, string>> = {
  'planes/admin_models.py': 'planes/admin_models.py',
  'planes/erp/tenant_models.py': 'planes/erp/tenant_models.py',
};

/** Builds a temp project with the plane fixtures copied to `dir/`. */
function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), 'gateforge-planes-'));
  for (const relative of Object.keys(PLANE_FIXTURES)) {
    mkdirSync(dirname(join(project, relative)), { recursive: true });
    cpSync(join(FIXTURE_ROOT, relative), join(project, relative));
  }
  return project;
}

/** Writes `.gateforge/planes.json` (or an explicit name) into `project`. */
function writePlanesConfig(project: string, document: unknown, name = PLANES_CONFIG_PATH): string {
  mkdirSync(join(project, '.gateforge'), { recursive: true });
  const path = join(project, name);
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document), 'utf8');
  return path;
}

/** Discovers `paths` with the project as working directory (always restores cwd). */
async function discoverIn(
  project: string,
  paths: readonly string[],
  options: SqlalchemyDetectorOptions = {},
): Promise<DiscoveryOutcome> {
  process.chdir(project);
  try {
    return (await createSqlalchemyDetector(options).discover([...paths])) as DiscoveryOutcome;
  } finally {
    process.chdir(ORIGINAL_CWD);
  }
}

type TableResource = DiscoveryOutcome['resources'][number];

const tablesOf = (outcome: DiscoveryOutcome): TableResource[] =>
  outcome.resources.filter((resource) => resource.kind === 'sqlalchemy.table');
const symbolsOf = (outcome: DiscoveryOutcome): TableResource[] =>
  outcome.resources.filter((resource) => resource.kind === 'gateforge.class');
const byTableNameAttr = (outcome: DiscoveryOutcome, name: string): TableResource | undefined =>
  tablesOf(outcome).find((resource) => resource.attributes['resourceName'] === name);

const PATH_RULE: PlaneConfigRule = {
  match: 'planes/**',
  plane: 'master',
  reason: 'control-plane models',
};

describe('planes config reader (offline)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gateforge-planes-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readDoc = (document: unknown): PlanesConfig =>
    readPlanesConfigOrNull(writePlanesConfig(dir, document));

  it('null path and absent file both yield the default (no rules)', () => {
    expect(readPlanesConfigOrNull(null)).toBe(DEFAULT_PLANES_CONFIG);
    expect(readPlanesConfigOrNull(join(dir, 'missing.json'))).toBe(DEFAULT_PLANES_CONFIG);
  });

  it('parses a valid document with path and tables rules', () => {
    const config = readDoc({
      rules: [
        { match: 'backend/admin_platform/models/**', plane: 'master', reason: 'AdminBase control-plane models (master database)' },
        { tables: ['master_users', 'erp_client_configs'], plane: 'master', reason: 'platform control-plane tables' },
      ],
    });
    expect(config.rules).toEqual([
      { match: 'backend/admin_platform/models/**', plane: 'master', reason: 'AdminBase control-plane models (master database)' },
      { tables: ['master_users', 'erp_client_configs'], plane: 'master', reason: 'platform control-plane tables' },
    ]);
  });

  it('malformed JSON throws (fail closed, not the default)', () => {
    expect(() => readDoc('{"rules": [oops]')).toThrow();
  });

  it('non-object documents throw', () => {
    expect(() => readDoc([])).toThrow(/expected an object/);
    expect(() => readDoc(null)).toThrow(/expected an object/);
    expect(() => readDoc('42')).toThrow(/expected an object/);
  });

  it('unknown top-level keys throw', () => {
    expect(() => readDoc({ rules: [], planeMapping: [] })).toThrow(/unknown key\(s\) planeMapping/);
  });

  it('a missing or non-array rules key throws', () => {
    expect(() => readDoc({})).toThrow(/'rules' must be an array/);
    expect(() => readDoc({ rules: {} })).toThrow(/'rules' must be an array/);
    expect(() => readDoc({ rules: 'x' })).toThrow(/'rules' must be an array/);
  });

  it('non-object rules throw', () => {
    expect(() => readDoc({ rules: ['master'] })).toThrow(/rules\[0\] must be an object/);
    expect(() => readDoc({ rules: [[]] })).toThrow(/rules\[0\] must be an object/);
    expect(() => readDoc({ rules: [null] })).toThrow(/rules\[0\] must be an object/);
  });

  it('unknown rule keys throw (a typo must not silently un-cover tables)', () => {
    expect(() => readDoc({ rules: [{ match: 'a/**', plane: 'master', reason: 'x', glob: 'a/**' }] }))
      .toThrow(/rules\[0\] has unknown key\(s\) glob/);
  });

  it('a rule carrying BOTH match and tables throws; neither throws too', () => {
    expect(() =>
      readDoc({ rules: [{ match: 'a/**', tables: ['t'], plane: 'master', reason: 'x' }] }),
    ).toThrow(/exactly one of 'match' or 'tables'/);
    expect(() => readDoc({ rules: [{ plane: 'master', reason: 'x' }] })).toThrow(
      /exactly one of 'match' or 'tables'/,
    );
  });

  it('plane is strictly tenant | master | global', () => {
    for (const bad of ['Tenant', 'tenant ', 'shared', '', 1, null, undefined]) {
      expect(() => readDoc({ rules: [{ match: 'a/**', plane: bad, reason: 'x' }] })).toThrow(
        /plane must be one of: 'tenant', 'master', 'global'/,
      );
    }
  });

  it('reason is required and non-empty (the human review artifact)', () => {
    for (const bad of [undefined, '', '   ']) {
      expect(() => readDoc({ rules: [{ match: 'a/**', plane: 'master', reason: bad }] })).toThrow(
        /reason must be a non-empty string/,
      );
    }
  });

  it('tables must be a non-empty array of non-empty strings', () => {
    expect(() => readDoc({ rules: [{ tables: 't', plane: 'master', reason: 'x' }] })).toThrow(
      /tables must be a non-empty array/,
    );
    expect(() => readDoc({ rules: [{ tables: [], plane: 'master', reason: 'x' }] })).toThrow(
      /tables must be a non-empty array/,
    );
    expect(() => readDoc({ rules: [{ tables: [7], plane: 'master', reason: 'x' }] })).toThrow(
      /tables entries must be non-empty strings/,
    );
    expect(() => readDoc({ rules: [{ tables: [''], plane: 'master', reason: 'x' }] })).toThrow(
      /tables entries must be non-empty strings/,
    );
  });

  it('match patterns must be repo-root-relative posix globs', () => {
    for (const bad of ['', '/abs/x', 'C:/x', 'a\\b', '..', 'a/../b']) {
      expect(() => readDoc({ rules: [{ match: bad, plane: 'master', reason: 'x' }] })).toThrow(
        /rules\[0\]\.match/,
      );
    }
  });

  it('parses a valid match rule with exclude (round-trips verbatim)', () => {
    const rule = {
      match: 'backend/api/v1/**',
      exclude: ['backend/api/v1/public_payment.py', 'backend/api/v1/master_admin.py'],
      plane: 'tenant',
      reason: 'contractor-scoped routers except the global-ingress files',
    };
    expect(readDoc({ rules: [rule] }).rules).toEqual([rule]);
  });

  it('exclude is only valid together with match (a tables rule with exclude throws)', () => {
    expect(() =>
      readDoc({ rules: [{ tables: ['t'], exclude: ['a.py'], plane: 'master', reason: 'x' }] }),
    ).toThrow(/rules\[0\]\.exclude is only valid together with 'match'/);
  });

  it('exclude must be a non-empty array of non-empty strings', () => {
    expect(() =>
      readDoc({ rules: [{ match: 'a/**', exclude: 'a.py', plane: 'master', reason: 'x' }] }),
    ).toThrow(/rules\[0\]\.exclude must be a non-empty array/);
    expect(() =>
      readDoc({ rules: [{ match: 'a/**', exclude: [], plane: 'master', reason: 'x' }] }),
    ).toThrow(/rules\[0\]\.exclude must be a non-empty array/);
    expect(() =>
      readDoc({ rules: [{ match: 'a/**', exclude: [''], plane: 'master', reason: 'x' }] }),
    ).toThrow(/rules\[0\]\.exclude\[0\] must be a non-empty string/);
  });

  it('exclude patterns are validated like match patterns (each entry names its index)', () => {
    for (const bad of ['', '/abs/x', 'C:/x', 'a\\b', '..', 'a/../b']) {
      expect(() =>
        readDoc({
          rules: [{ match: 'a/**', exclude: ['ok.py', bad], plane: 'master', reason: 'x' }],
        }),
      ).toThrow(/rules\[0\]\.exclude\[1\]/);
    }
  });
});

describe('plane rule evaluation (offline, pure)', () => {
  const config = (rules: PlaneConfigRule[]): PlanesConfig => ({ rules });
  const admin = {
    sourcePath: 'planes/admin_models.py',
    tableName: 'planes_admin_users',
    classSimpleName: 'AdminUser',
  };
  const erp = {
    sourcePath: 'planes/erp/tenant_models.py',
    tableName: 'planes_erp_clients',
    classSimpleName: 'ErpClient',
  };

  it('glob semantics over the SOURCE FILE path (core classifier globs)', () => {
    const matches = (pattern: string, input: typeof admin | typeof erp): boolean =>
      planeRuleMatches({ match: pattern, plane: 'master', reason: 'r' }, input);
    // Trailing `**` matches everything under the prefix, across segments.
    expect(matches('planes/**', admin)).toBe(true);
    expect(matches('planes/**', erp)).toBe(true);
    expect(matches('planes/**/*.py', erp)).toBe(true);
    // `*` stays within ONE segment.
    expect(matches('planes/*.py', admin)).toBe(true);
    expect(matches('planes/*.py', erp)).toBe(false);
    expect(matches('planes/*/*.py', erp)).toBe(true);
    expect(matches('planes/*/*.py', admin)).toBe(false);
    // Interior `**` matches zero or more whole segments.
    expect(matches('planes/**/tenant_models.py', erp)).toBe(true);
    expect(matches('planes/**/tenant_models.py', admin)).toBe(false);
    // `?` matches exactly one non-separator character; `*` spans a name.
    expect(matches('planes/admin_model?.py', admin)).toBe(true);
    expect(matches('planes/erp/tenant_models.p?', erp)).toBe(true);
    // Matching is whole-path and case-sensitive.
    expect(matches('admin_models.py', admin)).toBe(false);
    expect(matches('Planes/**', admin)).toBe(false);
  });

  it('exclude prunes matching source files from a match rule (before tier collection)', () => {
    const rule: PlaneConfigRule = {
      match: 'planes/**',
      exclude: ['planes/erp/tenant_models.py'],
      plane: 'master',
      reason: 'control-plane models except the erp surface',
    };
    // The excluded file: the rule does not apply at all.
    expect(planeRuleMatches(rule, erp)).toBe(false);
    // Everything else under the glob still matches.
    expect(planeRuleMatches(rule, admin)).toBe(true);
    // Exclusion globs use the same classifier glob semantics as `match`.
    expect(
      planeRuleMatches(
        { match: 'planes/**', exclude: ['planes/erp/**'], plane: 'master', reason: 'r' },
        erp,
      ),
    ).toBe(false);
    // A non-matching exclude list leaves the rule untouched.
    expect(
      planeRuleMatches(
        { match: 'planes/**', exclude: ['nomatch/**'], plane: 'master', reason: 'r' },
        erp,
      ),
    ).toBe(true);
  });

  it('an all-excluded resource resolves nothing (stays classifier-blocked, no conflict)', () => {
    const resolution = resolvePlaneByRules(
      config([
        { match: 'planes/**', exclude: ['planes/erp/**'], plane: 'master', reason: 'r1' },
        { match: 'nomatch/**', plane: 'tenant', reason: 'r2' },
      ]),
      erp,
    );
    expect(resolution).toEqual({ plane: null, hits: [], conflict: false });
  });

  it('tables rules match the tableName AND the class simple name', () => {
    const names = (tables: string[]): PlaneConfigRule =>
      ({ tables, plane: 'tenant', reason: 'r' });
    // By table name…
    expect(planeRuleMatches(names(['planes_erp_clients']), erp)).toBe(true);
    // …or by class simple name (deliberate: both are identity evidence).
    expect(planeRuleMatches(names(['ErpClient']), erp)).toBe(true);
    expect(planeRuleMatches(names(['other']), erp)).toBe(false);
  });

  it('no matching rule → no plane, no conflict (stays classifier-blocked)', () => {
    const resolution = resolvePlaneByRules(
      config([{ match: 'backend/**', plane: 'master', reason: 'unrelated' }]),
      erp,
    );
    expect(resolution).toEqual({ plane: null, hits: [], conflict: false });
  });

  it('a tables-claimed table collects ONLY tables-tier hits (the overlapping glob is ignored)', () => {
    const resolution = resolvePlaneByRules(
      config([
        PATH_RULE,
        { tables: ['planes_admin_users'], plane: 'master', reason: 'platform table' },
      ]),
      admin,
    );
    expect(resolution.plane).toBe('master');
    expect(resolution.conflict).toBe(false);
    expect(resolution.hits).toEqual([
      { index: 1, plane: 'master', reason: 'platform table' },
    ]);
  });

  it('explicit beats general: a tables rule wins over an overlapping glob rule with a different plane', () => {
    // Both rules match `admin` (the glob hits its source path, the
    // tables rule its class simple name) and the planes differ — the
    // explicit enumeration decides alone; NO cross-tier contradiction.
    const resolution = resolvePlaneByRules(
      config([
        PATH_RULE,
        { tables: ['AdminUser'], plane: 'tenant', reason: 'tenant workspace users' },
      ]),
      admin,
    );
    expect(resolution.plane).toBe('tenant');
    expect(resolution.conflict).toBe(false);
    expect(resolution.hits.map((hit) => `${hit.index}:${hit.plane}`)).toEqual(['1:tenant']);
  });

  it('conflict WITHIN the tables tier still fails closed (a glob rule cannot rescue it)', () => {
    const resolution = resolvePlaneByRules(
      config([
        PATH_RULE, // glob, master — would agree with rule 1, but ignored
        { tables: ['AdminUser'], plane: 'master', reason: 'platform table' },
        { tables: ['planes_admin_users'], plane: 'tenant', reason: 'tenant workspace users' },
      ]),
      admin,
    );
    expect(resolution.plane).toBeNull();
    expect(resolution.conflict).toBe(true);
    expect(resolution.hits.map((hit) => `${hit.index}:${hit.plane}`)).toEqual(['1:master', '2:tenant']);
  });

  it('dogfood shape: five explicitly enumerated tables beat an overlapping catch-all glob; glob-only tables take the glob plane', () => {
    // Verbatim shape of a real consumer document: the five listed
    // tables ALSO match the catch-all glob, the planes differ, and the
    // glob author has no way to exclude them — so the explicit tier
    // must win instead of reporting a contradiction.
    const rules: PlaneConfigRule[] = [
      {
        tables: [
          'master_users',
          'erp_client_configs',
          'ai_provider_config',
          'e2e_test_runs',
          'e2e_test_schedules',
        ],
        plane: 'master',
        reason: 'platform control-plane tables',
      },
      { match: 'backend/models/**', plane: 'tenant', reason: 'contractor-scoped data' },
    ];
    const dogfoodInput = (tableName: string, className: string) => ({
      sourcePath: `backend/models/${tableName}.py`,
      tableName,
      classSimpleName: className,
    });
    for (const name of [
      'master_users',
      'erp_client_configs',
      'ai_provider_config',
      'e2e_test_runs',
      'e2e_test_schedules',
    ]) {
      const resolution = resolvePlaneByRules(config(rules), dogfoodInput(name, 'SomeClass'));
      expect(resolution.plane).toBe('master');
      expect(resolution.conflict).toBe(false);
      expect(resolution.hits).toEqual([
        { index: 0, plane: 'master', reason: 'platform control-plane tables' },
      ]);
    }
    // Tables NOT explicitly enumerated fall through to the glob tier.
    const globOnly = resolvePlaneByRules(
      config(rules),
      dogfoodInput('widget_configs', 'WidgetConfig'),
    );
    expect(globOnly.plane).toBe('tenant');
    expect(globOnly.conflict).toBe(false);
    expect(globOnly.hits).toEqual([
      { index: 1, plane: 'tenant', reason: 'contractor-scoped data' },
    ]);
  });

  it('conflict WITHIN the glob tier still fails closed for glob-only tables', () => {
    const resolution = resolvePlaneByRules(
      config([
        { match: 'planes/**', plane: 'master', reason: 'control-plane models' },
        { match: 'planes/erp/**', plane: 'tenant', reason: 'contractor-scoped data' },
      ]),
      erp,
    );
    expect(resolution.plane).toBeNull();
    expect(resolution.conflict).toBe(true);
    expect(resolution.hits.map((hit) => `${hit.index}:${hit.plane}`)).toEqual(['0:master', '1:tenant']);
  });

  it('dogfood shape: exclude lets a directory glob coexist with per-file global-ingress rules', () => {
    // Verbatim shape of a real consumer document: `backend/api/v1/`
    // mixes contractor-scoped routers with global-ingress files. Without
    // `exclude`, the per-file global rules collide with the directory
    // tenant glob inside the glob tier → PLANE_RULE_CONTRADICTION for
    // exactly the mixed files. With `exclude`, the exceptions are
    // documented on the directory rule and every file resolves alone.
    const input = (file: string) => ({
      sourcePath: `backend/api/v1/${file}`,
      tableName: '',
      classSimpleName: null,
    });
    const withoutExclude: PlaneConfigRule[] = [
      { match: 'backend/api/v1/**', plane: 'tenant', reason: 'contractor-scoped routers' },
      { match: 'backend/api/v1/public_payment.py', plane: 'global', reason: 'public ingress' },
    ];
    const conflicted = resolvePlaneByRules(config(withoutExclude), input('public_payment.py'));
    expect(conflicted.plane).toBeNull();
    expect(conflicted.conflict).toBe(true);

    const withExclude: PlaneConfigRule[] = [
      {
        match: 'backend/api/v1/**',
        exclude: ['backend/api/v1/public_payment.py', 'backend/api/v1/master_admin.py'],
        plane: 'tenant',
        reason: 'contractor-scoped routers except the global-ingress files',
      },
      { match: 'backend/api/v1/public_payment.py', plane: 'global', reason: 'public ingress' },
      { match: 'backend/api/v1/master_admin.py', plane: 'global', reason: 'master admin ingress' },
    ];
    // Each excluded file resolves ONLY against its per-file rule.
    for (const [file, plane, index] of [
      ['public_payment.py', 'global', 1],
      ['master_admin.py', 'global', 2],
    ] as const) {
      const resolution = resolvePlaneByRules(config(withExclude), input(file));
      expect(resolution.plane).toBe(plane);
      expect(resolution.conflict).toBe(false);
      expect(resolution.hits).toEqual([{ index, plane, reason: expect.any(String) }]);
    }
    // A contractor-scoped router (not excluded) keeps the directory plane.
    const contractor = resolvePlaneByRules(config(withExclude), input('accounts.py'));
    expect(contractor.plane).toBe('tenant');
    expect(contractor.conflict).toBe(false);
    expect(contractor.hits).toEqual([
      { index: 0, plane: 'tenant', reason: 'contractor-scoped routers except the global-ingress files' },
    ]);
  });
});

describe('planes config end-to-end (in-process transport)', () => {
  let project: string;
  beforeEach(() => {
    project = makeProject();
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('a path rule attaches attributes.plane to tables, never to class symbols', async () => {
    const outcome = await discoverIn(project, ['planes/admin_models.py', 'planes/erp/tenant_models.py'], {
      planesConfig: { rules: [PATH_RULE] },
    });
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('master');
    expect(byTableNameAttr(outcome, 'planes_erp_clients')?.attributes['plane']).toBe('master');
    for (const symbol of symbolsOf(outcome)) {
      expect(symbol.attributes['plane']).toBeUndefined();
    }
    expect(outcome.findings).toEqual([]);
  });

  it('a single-segment glob shows source-path depth matters end-to-end', async () => {
    const outcome = await discoverIn(project, ['planes/admin_models.py', 'planes/erp/tenant_models.py'], {
      planesConfig: { rules: [{ match: 'planes/*.py', plane: 'tenant', reason: 'shallow only' }] },
    });
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('tenant');
    expect(byTableNameAttr(outcome, 'planes_erp_clients')?.attributes['plane']).toBeUndefined();
    expect(outcome.findings).toEqual([]);
  });

  it('exclude carves a mixed-plane directory surface end-to-end: no contradiction, per-file planes', async () => {
    // The directory glob would collide with the per-file rule inside the
    // glob tier; the documented exclusion removes the erp file from the
    // directory rule BEFORE tier collection, so each file resolves alone.
    const outcome = await discoverIn(
      project,
      ['planes/admin_models.py', 'planes/erp/tenant_models.py'],
      {
        planesConfig: {
          rules: [
            {
              match: 'planes/**',
              exclude: ['planes/erp/tenant_models.py'],
              plane: 'master',
              reason: 'control-plane models except the erp surface',
            },
            { match: 'planes/erp/tenant_models.py', plane: 'tenant', reason: 'contractor-scoped data' },
          ],
        },
      },
    );
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('master');
    expect(byTableNameAttr(outcome, 'planes_erp_clients')?.attributes['plane']).toBe('tenant');
    expect(outcome.findings).toEqual([]);
  });

  it('a malformed exclude in the config file throws from discover (fail closed)', async () => {
    writePlanesConfig(project, {
      rules: [{ match: 'planes/**', exclude: ['/abs/x'], plane: 'master', reason: 'x' }],
    });
    await expect(discoverIn(project, ['planes/admin_models.py'], {})).rejects.toThrow(
      /rules\[0\]\.exclude\[0\] must be a repo-root-relative glob/,
    );
  });

  it('a tables rule matches by class simple name (tableName differs)', async () => {
    const outcome = await discoverIn(project, ['planes/erp/tenant_models.py'], {
      planesConfig: {
        rules: [{ tables: ['ErpClient'], plane: 'global', reason: 'reference data' }],
      },
    });
    expect(byTableNameAttr(outcome, 'planes_erp_clients')?.attributes['plane']).toBe('global');
  });

  it('an explicit tables rule decides even when the overlapping path rule agrees (same plane)', async () => {
    const outcome = await discoverIn(project, ['planes/admin_models.py'], {
      planesConfig: {
        rules: [
          PATH_RULE,
          { tables: ['AdminUser'], plane: 'master', reason: 'control-plane accounts' },
        ],
      },
    });
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('master');
    expect(outcome.findings).toEqual([]);
  });

  it('explicit beats general end-to-end: enumerated table takes the tables plane, glob-only tables the glob plane, no findings', async () => {
    // The dogfood shape: the enumerated table ALSO matches the
    // catch-all glob and the planes differ — the explicit tier wins,
    // the glob keeps covering only the tables it alone claims.
    const outcome = await discoverIn(
      project,
      ['planes/admin_models.py', 'planes/erp/tenant_models.py'],
      {
        planesConfig: {
          rules: [
            {
              tables: ['planes_admin_users'],
              plane: 'master',
              reason: 'platform control-plane tables',
            },
            { match: 'planes/**', plane: 'tenant', reason: 'contractor-scoped data' },
          ],
        },
      },
    );
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('master');
    expect(byTableNameAttr(outcome, 'planes_erp_clients')?.attributes['plane']).toBe('tenant');
    expect(outcome.findings).toEqual([]);
  });

  it('a conflict WITHIN the tables tier still emits a blocking PLANE_RULE_CONTRADICTION and NO plane', async () => {
    const outcome = await discoverIn(project, ['planes/admin_models.py'], {
      planesConfig: {
        rules: [
          {
            tables: ['planes_admin_users'],
            plane: 'master',
            reason: 'platform control-plane tables',
          },
          { tables: ['AdminUser'], plane: 'tenant', reason: 'tenant workspace users' },
        ],
      },
    });
    expect(outcome.findings).toHaveLength(1);
    const finding = outcome.findings[0] as {
      code: string;
      detail: string;
      locations: Array<{ file: string; line: number; col: number }>;
    };
    expect(finding.code).toBe(PLANE_RULE_CONTRADICTION);
    // Names the resource, both planes, both reasons, and both rule indexes.
    expect(finding.detail).toContain("table 'planes_admin_users'");
    expect(finding.detail).toContain('rule 0 (master, "platform control-plane tables")');
    expect(finding.detail).toContain('rule 1 (tenant, "tenant workspace users")');
    expect(finding.detail).toContain(PLANES_CONFIG_PATH);
    expect(finding.locations).toEqual([{ file: 'planes/admin_models.py', line: 16, col: 0 }]);
    // Fail closed: the conflicting table stays plane-unresolved.
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBeUndefined();
  });

  it('no matching rule leaves EVERY table plane-unresolved with no findings', async () => {
    const outcome = await discoverIn(project, ['planes/admin_models.py', 'planes/erp/tenant_models.py'], {
      planesConfig: { rules: [{ match: 'nomatch/**', plane: 'master', reason: 'unreachable' }] },
    });
    for (const table of tablesOf(outcome)) {
      expect(table.attributes['plane']).toBeUndefined();
    }
    expect(outcome.findings).toEqual([]);
  });

  it('config absence is byte-identical to the explicit NO_PLANE_MAPPING default', async () => {
    const paths = ['planes/admin_models.py', 'planes/erp/tenant_models.py'];
    const defaulted = await discoverIn(project, paths, {});
    const noop = await discoverIn(project, paths, { plane: NO_PLANE_MAPPING });
    expect(JSON.stringify(defaulted)).toBe(JSON.stringify(noop));
    for (const table of tablesOf(defaulted)) {
      expect(table.attributes['plane']).toBeUndefined();
    }
  });

  it('the programmatic plane option wins and the config file is not read at all', async () => {
    // The document would map the table to master; also deliberately
    // MALFORMED to prove the programmatic channel skips the file read.
    writePlanesConfig(project, { rules: [{ match: 'planes/**' }] });
    const outcome = await discoverIn(project, ['planes/admin_models.py'], {
      plane: byTableName({ planes_admin_users: 'global' }),
    });
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('global');
  });

  it('a malformed config file throws from discover (fail closed, CLI surfaces it)', async () => {
    writePlanesConfig(project, { planeMapping: { planes_admin_users: 'master' } });
    await expect(
      discoverIn(project, ['planes/admin_models.py'], {}),
    ).rejects.toThrow(/unknown key\(s\) planeMapping/);
  });

  it('an explicit planesConfig option overrides the document entirely', async () => {
    writePlanesConfig(project, {
      rules: [{ tables: ['planes_admin_users'], plane: 'tenant', reason: 'doc says tenant' }],
    });
    const outcome = await discoverIn(project, ['planes/admin_models.py'], {
      planesConfig: { rules: [PATH_RULE] },
    });
    expect(byTableNameAttr(outcome, 'planes_admin_users')?.attributes['plane']).toBe('master');
  });
});
