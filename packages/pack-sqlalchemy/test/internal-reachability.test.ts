import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqlalchemyDetector } from '../src/detector.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const F1 = join(HERE, 'fixtures', 'reachability');
const F2 = join(HERE, 'fixtures', 'reachability-rules');
const ALL = [
  { category: 'migration', detector: 'gateforge.pack-sqlalchemy' },
  { category: 'maintenance-command', detector: 'gateforge.pack-sqlalchemy' },
  { category: 'worker', detector: 'gateforge.pack-sqlalchemy' },
];

interface Sig {
  dimension?: string;
  assertion?: string;
  basis?: string;
  location?: unknown;
  target?: { resourceName?: string; symbol?: string };
}

function pyFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.py')) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

async function discover(root: string, sections?: Record<string, unknown>, command?: readonly string[]): Promise<Sig[]> {
  const detector = createSqlalchemyDetector({ command });
  const previous = process.cwd();
  process.chdir(root);
  try {
    const context = sections === undefined ? undefined : { sections };
    const result = await detector.discover(pyFiles(root), context as never);
    return (result.classificationSignals ?? []) as Sig[];
  } finally {
    process.chdir(previous);
  }
}

const internality = (sigs: Sig[]) => sigs.filter((s) => s.dimension === 'internality');

function hits(sigs: Sig[], table: string, cls?: string): Sig[] {
  const clsRe = cls === undefined ? undefined : new RegExp(`(^|[.:/])${cls}$`);
  return internality(sigs).filter(
    (s) => s.target?.resourceName === table || (clsRe !== undefined && clsRe.test(s.target?.symbol ?? '')),
  );
}

describe('fixture 1: internal reachability positives and pins', () => {
  it('R1 seed_codes is migration at upgrade in 0001_seed.py', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'seed_codes');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('migration');
    expect(found[0]?.basis).toBe('code-positive');
    expect(JSON.stringify(found[0]?.location)).toContain('migrations/versions/0001_seed.py');
    const loc = found[0]?.location as { file: string; line: number };
    const revisionFile = 'migrations/versions/0001_seed.py';
    const defLine = readFileSync(join(F1, revisionFile), 'utf8').split('\n').findIndex((l) => l.startsWith('def upgrade(')) + 1;
    expect(defLine).toBeGreaterThan(0);
    expect(loc.file.endsWith(revisionFile)).toBe(true);
    expect(loc.line).toBe(defLine);
  });

  it('R2 ExportLog is worker at nightly_export in app/tasks.py, symbol-only target', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'export_logs', 'ExportLog');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('worker');
    expect(JSON.stringify(found[0]?.location)).toContain('app/tasks.py');
    expect(found[0]?.target).not.toHaveProperty('resourceName');
  });

  it('R3 ledger_entries is maintenance-command in rebuild_ledger.py', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'ledger_entries', 'LedgerEntry');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('maintenance-command');
    expect(JSON.stringify(found[0]?.location)).toContain('scripts/maintenance/rebuild_ledger.py');
  });

  it('R4 orphan_rows, route_notes, indirect_rows, dup_rows get no signal', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'orphan_rows', 'OrphanRow')).toHaveLength(0);
    expect(hits(sigs, 'route_notes', 'RouteNote')).toHaveLength(0);
    expect(hits(sigs, 'indirect_rows', 'IndirectRow')).toHaveLength(0);
    expect(hits(sigs, 'dup_rows')).toHaveLength(0);
  });

  it('R5 no section, empty array, or detector-less binding gives zero signals and identical output', async () => {
    const none = await discover(F1);
    const empty = await discover(F1, { trustedInternalEntryPoints: [] });
    const noDetector = await discover(F1, { trustedInternalEntryPoints: [{ category: 'migration' }] });
    expect(internality(none)).toHaveLength(0);
    expect(internality(empty)).toHaveLength(0);
    expect(internality(noDetector)).toHaveLength(0);
    expect(JSON.stringify(noDetector)).toBe(JSON.stringify(none));
  });

  it('R6 binding only migration yields only the seed_codes signal', async () => {
    const sigs = await discover(F1, {
      trustedInternalEntryPoints: [{ category: 'migration', detector: 'gateforge.pack-sqlalchemy' }],
    });
    expect(internality(sigs).length).toBeGreaterThan(0);
    for (const s of internality(sigs)) expect(s.assertion).toBe('migration');
    expect(hits(sigs, 'export_logs', 'ExportLog')).toHaveLength(0);
    expect(hits(sigs, 'ledger_entries', 'LedgerEntry')).toHaveLength(0);
  });

  it('R7 two runs are byte-identical', async () => {
    const a = await discover(F1, { trustedInternalEntryPoints: ALL });
    const b = await discover(F1, { trustedInternalEntryPoints: ALL });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('R8 malformed sections reject naming trustedInternalEntryPoints', async () => {
    await expect(
      discover(F1, { trustedInternalEntryPoints: { 'gateforge.pack-sqlalchemy': 'migration' } }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
    await expect(
      discover(F1, { trustedInternalEntryPoints: [{ category: 'migrate', detector: 'gateforge.pack-sqlalchemy' }] }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R9 dedupe_codes.py gives no signal', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    expect(internality(sigs).filter((s) => JSON.stringify(s.location).includes('dedupe_codes.py'))).toHaveLength(0);
  });

  it('R10 serve_api.py gives no signal', async () => {
    const sigs = await discover(F1, { trustedInternalEntryPoints: ALL });
    expect(internality(sigs).filter((s) => JSON.stringify(s.location).includes('serve_api.py'))).toHaveLength(0);
  });
});

describe('unit: trustedInternalEntryPoints validation', () => {
  it('R45 empty category rejects', async () => {
    await expect(
      discover(F1, { trustedInternalEntryPoints: [{ category: '', detector: 'gateforge.pack-sqlalchemy' }] }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R46 foreign detector is dropped without rejection', async () => {
    const sigs = await discover(F1, {
      trustedInternalEntryPoints: [{ category: 'migration', detector: 'other.detector' }],
    });
    expect(internality(sigs)).toHaveLength(0);
  });

  it('R65 null element rejects', async () => {
    await expect(discover(F1, { trustedInternalEntryPoints: [null] })).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R66 non-string category rejects', async () => {
    await expect(
      discover(F1, { trustedInternalEntryPoints: [{ category: 7, detector: 'gateforge.pack-sqlalchemy' }] }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R67 uppercase category rejects', async () => {
    await expect(
      discover(F1, { trustedInternalEntryPoints: [{ category: 'Migration', detector: 'gateforge.pack-sqlalchemy' }] }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R68 one valid plus one invalid element rejects the whole section', async () => {
    await expect(
      discover(F1, {
        trustedInternalEntryPoints: [
          { category: 'migration', detector: 'gateforge.pack-sqlalchemy' },
          { category: '' },
        ],
      }),
    ).rejects.toThrow(/trustedInternalEntryPoints/);
  });

  it('R69 unknown category with foreign detector is dropped without rejection', async () => {
    const sigs = await discover(F1, {
      trustedInternalEntryPoints: [{ category: 'migrate', detector: 'other.detector' }],
    });
    expect(internality(sigs)).toHaveLength(0);
  });
});

describe('fixture 2: rule coverage', () => {
  const positives: Array<[string, string, string, string]> = [
    ['sql_insert_rows', 'SqlInsertRow', 'migration', 'migrations/versions/0002_sql_writes.py'],
    ['sql_update_rows', 'SqlUpdateRow', 'migration', 'migrations/versions/0002_sql_writes.py'],
    ['sql_delete_rows', 'SqlDeleteRow', 'migration', 'migrations/versions/0002_sql_writes.py'],
    ['lower_rows', 'LowerRow', 'migration', 'migrations/versions/0002_sql_writes.py'],
    ['quoted_rows', 'QuotedRow', 'migration', 'migrations/versions/0002_sql_writes.py'],
    ['text_insert_rows', 'TextInsertRow', 'maintenance-command', 'scripts/maintenance/text_sql.py'],
    ['text_update_rows', 'TextUpdateRow', 'maintenance-command', 'scripts/maintenance/text_sql.py'],
    ['text_delete_rows', 'TextDeleteRow', 'maintenance-command', 'scripts/maintenance/text_sql.py'],
    ['table_insert_rows', 'TableInsertRow', 'maintenance-command', 'scripts/maintenance/table_attr.py'],
    ['table_update_rows', 'TableUpdateRow', 'maintenance-command', 'scripts/maintenance/table_attr.py'],
    ['table_delete_rows', 'TableDeleteRow', 'maintenance-command', 'scripts/maintenance/table_attr.py'],
    ['bare_rows', 'BareRow', 'maintenance-command', 'scripts/maintenance/table_attr.py'],
    ['table_arg_rows', 'TableAttrRow', 'maintenance-command', 'scripts/maintenance/table_attr.py'],
    ['add_all_rows', 'AddAllRow', 'maintenance-command', 'scripts/maintenance/add_all.py'],
    ['param_rows', 'ParamRow', 'maintenance-command', 'scripts/maintenance/session_receivers.py'],
    ['maker_rows', 'MakerRow', 'maintenance-command', 'scripts/maintenance/session_receivers.py'],
    ['plain_rows', 'PlainRow', 'maintenance-command', 'scripts/maintenance/session_receivers.py'],
    ['orm_session_rows', 'OrmSessionRow', 'maintenance-command', 'scripts/maintenance/session_receivers.py'],
    ['helper_rows', 'HelperRow', 'maintenance-command', 'scripts/maintenance/mod_call.py'],
    ['shared_rows', 'SharedRow', 'worker', 'scripts/maintenance/workers_rules.py'],
    ['worker_call_rows', 'WorkerCallRow', 'worker', 'scripts/maintenance/workers_rules.py'],
    ['cycle_rows', 'CycleRow', 'maintenance-command', 'scripts/maintenance/cycle_rules.py'],
    ['order_rows', 'OrderRow', 'maintenance-command', 'scripts/maintenance/a_entry.py'],
    ['func_update_rows', 'UpdRow', 'maintenance-command', 'scripts/maintenance/func_forms.py'],
    ['func_delete_rows', 'DelRow', 'maintenance-command', 'scripts/maintenance/func_forms.py'],
    ['class_rows', 'ClassRow', 'maintenance-command', 'scripts/maintenance/class_rows.py'],
  ];
  const negatives: Array<[string, string]> = [
    ['ambiguous_rows', 'AmbiguousRow'], ['dynamic_rows', 'DynamicRow'], ['dyn_rows', 'DynRow'],
    ['missing_rows', 'MissingRow'], ['unbound_rows', 'UnboundRow'], ['local_insert_rows', 'LocalRow'],
    ['fake_op_rows', 'FakeOpRow'], ['norev_rows', 'NorevRow'], ['attr_rows', 'AttrRow'],
    ['alias_rows', 'AliasRow'], ['helper_session_rows', 'HelperSessionRow'], ['shadow_rows', 'ShadowRow'],
    ['twice_rows', 'TwiceRow'], ['add_all_neg_rows', 'AddAllNegRow'], ['text_select_rows', 'TextSelectRow'],
    ['helper_server_rows', 'HelperServerRow'], ['classdup_rows', 'ClassDup'], ['nested_main_rows', 'NestedMainRow'],
    ['decorated_rows', 'DecoRow'], ['serve_rows', 'ServeRow'], ['serve_forever_rows', 'ServeForeverRow'],
    ['bare_run_rows', 'BareRunRow'], ['downgrade_rows', 'DowngradeRow'], ['nonstring_rows', 'NonStrRow'],
    ['nested_rev_rows', 'NestedRevRow'], ['local_shared_rows', 'LocalSharedRow'], ['foreign_shared_rows', 'ForeignSharedRow'],
    ['fake_update_rows', 'UpdFakeRow'], ['fake_delete_rows', 'DelFakeRow'], ['fake_exec_rows', 'FakeExecRow'],
    ['local_exec_rows', 'LocalExecRow'], ['fake_text_rows', 'FakeTextRow'], ['local_text_rows', 'LocalTextRow'],
    ['foreign_session_rows', 'ForeignSessionRow'], ['foreign_orm_session_rows', 'ForeignOrmSessionRow'],
  ];

  let rules: Sig[] = [];
  it('loads fixture 2 with all bindings', async () => {
    rules = await discover(F2, { trustedInternalEntryPoints: ALL });
    expect(Array.isArray(rules)).toBe(true);
  });

  for (const [table, cls, assertion, file] of positives) {
    it(`positive ${table} (${assertion}) at ${file}`, () => {
      const found = hits(rules, table, cls);
      expect(found).toHaveLength(1);
      expect(found[0]?.assertion).toBe(assertion);
      expect(JSON.stringify(found[0]?.location)).toContain(file);
    });
  }

  for (const [table, cls] of negatives) {
    it(`negative ${table} has no signal`, () => {
      expect(hits(rules, table, cls)).toHaveLength(0);
    });
  }
});

describe('argv: internal entry categories and the root', () => {
  const PY = ['python3', '-m', 'gateforge_sqlalchemy_detector'];
  const SQL: Array<[string, string]> = [['sql_insert_rows', 'SqlInsertRow'], ['sql_update_rows', 'SqlUpdateRow'], ['sql_delete_rows', 'SqlDeleteRow']];
  const PY_DIR = join(HERE, '..', 'python');

  it('R23 flag before the root selects the migration category by name', async () => {
    const sigs = await discover(F2, undefined, [...PY, '--internal-entry-categories=migration', F2]);
    for (const [table, cls] of SQL) {
      expect(hits(sigs, table, cls).length).toBeGreaterThan(0);
    }
  });

  it('R24 the root alone (no flag) yields no internality signal', async () => {
    const sigs = await discover(F2, undefined, [...PY, F2]);
    expect(internality(sigs)).toHaveLength(0);
  });

  it('R25 an unknown category exits non-zero with the exact stderr line', () => {
    const run = spawnSync('python3', ['-m', 'gateforge_sqlalchemy_detector', '--internal-entry-categories=bogus', F2], {
      cwd: PY_DIR,
      input: '',
      // The candidate tree seals gitignored bytes too: a bytecode cache written here would change it mid-run.
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr.split('\n')).toContain('unknown internal entry category: bogus');
  });

  it('R51 a flag after the root gives the same internality signals as a flag before it', async () => {
    const before = await discover(F2, undefined, [...PY, '--internal-entry-categories=migration', F2]);
    const after = await discover(F2, undefined, [...PY, F2, '--internal-entry-categories=migration']);
    expect(internality(before).length).toBeGreaterThan(0);
    expect(internality(after).map((s) => JSON.stringify(s)).toSorted()).toEqual(
      internality(before).map((s) => JSON.stringify(s)).toSorted(),
    );
  });
});

describe('golden output', () => {
  it('R54 no-flag output is byte-identical to the v0.20.1 golden file', async () => {
    const rules = join(HERE, 'fixtures', 'reachability-rules');
    const previous = process.cwd();
    process.chdir(rules);
    try {
      const result = await createSqlalchemyDetector().discover(pyFiles(rules));
      const golden = readFileSync(join(HERE, 'fixtures', 'reachability-rules.golden.json'), 'utf8');
      expect(`${JSON.stringify(result, null, 2)}\n`).toBe(golden);
    } finally {
      process.chdir(previous);
    }
  });
});

describe('version pin', () => {
  it('R55 pack VERSION stays 0.2.0', () => {
    const src = readFileSync(join(HERE, '..', 'python', 'gateforge_sqlalchemy_detector', '__init__.py'), 'utf8');
    expect(src).toMatch(/VERSION\s*=\s*["']0\.2\.0["']/);
  });
});

describe('fixture 3: shadowed sqlalchemy names are not the import', () => {
  const F3 = join(HERE, 'fixtures', 'reachability-shadow');

  it('R77 a parameter named insert shadows the import: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_param_rows', 'ShadowParamRow')).toHaveLength(0);
  });

  it('R78 a module-level rebinding of insert overrides the import: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_def_rows', 'ShadowDefRow')).toHaveLength(0);
  });

  it('R79 a local def named insert shadows the import: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_local_rows', 'ShadowLocalRow')).toHaveLength(0);
  });

  it('R80 control: the unshadowed import still gives the migration signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'shadow_real_rows', 'ShadowRealRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('migration');
  });
});

describe('literal sql and celery names', () => {
  const F3 = join(HERE, 'fixtures', 'reachability-shadow');

  it('R81 a quoted name with a space is its own table, not the word before it: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'route', 'Route')).toHaveLength(0);
  });

  it('R82 control: UPDATE ONLY names the table after ONLY: migration signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'only_rows', 'OnlyRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('migration');
  });

  it('R83 a local class Celery is not celery.Celery: its @app.task gives no worker signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_task_rows', 'ShadowTaskRow')).toHaveLength(0);
  });

  it('R84 control: from celery import Celery makes @app.task a worker signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'shadow_real_task_rows', 'ShadowRealTaskRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('worker');
  });
});

describe('session and table names are scope-checked', () => {
  const F3 = join(HERE, 'fixtures', 'reachability-shadow');

  it('R85 a parameter named Session is not the sqlalchemy Session', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_param_session_rows', 'ShadowParamSessionRow')).toHaveLength(0);
  });

  it('R86 a local Session assignment is not the sqlalchemy Session', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_local_session_rows', 'ShadowLocalSessionRow')).toHaveLength(0);
  });

  it('R87 a parameter named sessionmaker is not the sqlalchemy sessionmaker', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_sessionmaker_rows', 'ShadowSessionmakerRow')).toHaveLength(0);
  });

  it('R88 a parameter named table is not the sqlalchemy table', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_literal_rows', 'ShadowLiteralRow')).toHaveLength(0);
  });

  it('R89 a module-level Session rebinding is not the sqlalchemy Session', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_module_session_rows', 'ShadowModuleSessionRow')).toHaveLength(0);
  });

  it('R90 control: the real sqlalchemy.orm Session still makes a write signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_real_session_rows', 'ShadowRealSessionRow')).toHaveLength(1);
  });

  it('R91 control: the real sqlalchemy table still makes a literal write signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_real_literal_rows', 'ShadowRealLiteralRow')).toHaveLength(1);
  });

  it('R92 control: the real sqlalchemy.orm sessionmaker still makes a write signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'shadow_real_sessionmaker_rows', 'ShadowRealSessionmakerRow')).toHaveLength(1);
  });
});

describe('local table bindings', () => {
  const F3 = join(HERE, 'fixtures', 'reachability-shadow');

  it('R93 bulk_insert of a name bound once to table("name") is a migration write', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'local_table_rows', 'LocalTableRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('migration');
    expect(JSON.stringify(found[0]?.location)).toContain('migrations/versions/0003_local_table.py');
  });

  it('R94 a name bound twice to table("name") is not resolved: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'twice_table_rows', 'TwiceTableRow')).toHaveLength(0);
  });

  it('R95 a local rebinding of an imported model name decides, not the import: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'local_shadow_rows', 'LocalShadowRow')).toHaveLength(0);
  });
});

describe('DBAPI cursor literal writes', () => {
  const F3 = join(HERE, 'fixtures', 'reachability-shadow');

  it('R96 a literal write on a `with X.cursor() as cur` cursor is a maintenance-command write', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'cursor_with_rows', 'CursorWithRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('maintenance-command');
    expect(JSON.stringify(found[0]?.location)).toContain('cursor_writes.py');
  });

  it('R97 a literal write on a `cur = X.cursor()` cursor is a maintenance-command write', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    const found = hits(sigs, 'cursor_assign_rows', 'CursorAssignRow');
    expect(found).toHaveLength(1);
    expect(found[0]?.assertion).toBe('maintenance-command');
    expect(JSON.stringify(found[0]?.location)).toContain('cursor_writes.py');
  });

  it('R98 a cursor passed in as a parameter is not a known cursor: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'cursor_param_rows', 'CursorParamRow')).toHaveLength(0);
  });

  it('R99 execute on a receiver that is not a cursor binding: no signal', async () => {
    const sigs = await discover(F3, { trustedInternalEntryPoints: ALL });
    expect(hits(sigs, 'cursor_conn_rows', 'CursorConnRow')).toHaveLength(0);
  });
});
