/**
 * `gateforge adapters scaffold` planning accuracy, at the planner level.
 *
 * The four measured failure modes of the generator, one test each:
 * a per-parent sub-collection sold as the complete collection, path
 * naming that ignores hyphens, a soft-delete table scaffolded as a
 * hard delete, and a field list too narrow to observe read-only
 * columns the obligations grade.
 *
 * The fixture reproduces the SHAPES those failures were measured on
 * (nested + flat collections, a hyphenated path, an `is_active`
 * soft-delete table, read-only columns, a secret column) with neutral
 * names; the accuracy block scores the generated plans against the
 * hand-written adapters a human would have written for the same app.
 */
import { describe, expect, it } from 'vitest';
import type { GraphResource, HttpRouteCandidate } from '@gate-forge/core';
import { planAdapters, type AdapterTarget, type ScaffoldPlan } from '../src/adapter-scaffold.js';

const FINGERPRINT = 'fixture-loopback-v1';

/** One hand-written adapter's decisions, the yardstick for the plan. */
interface HandWritten {
  readPath: string;
  listPath: string;
  fields: string[];
  deletion: string;
}

/** One fixture resource: its graph, its routes, and its hand-written adapter. */
interface FixtureResource {
  resource: GraphResource;
  routes: HttpRouteCandidate[];
  handWritten: HandWritten | null;
  deleteSemantics: AdapterTarget['deleteSemantics'];
}

/**
 * Builds one business-resource graph entry.
 *
 * Args:
 *   name: the table/resource name.
 *   attributes: the detector attributes (column facts, updateable fields).
 *   primaryKey: the classified identity columns.
 *
 * Returns:
 *   GraphResource: a minimal, schema-shaped business resource.
 */
function table(
  name: string,
  attributes: Record<string, unknown>,
  primaryKey: string[] = ['id'],
): GraphResource {
  return {
    schemaVersion: 1,
    id: `sqlalchemy.table:src/models.py:${name}`,
    name,
    plane: 'tenant',
    kind: 'sqlalchemy.table',
    source: 'src/models.py',
    location: { file: 'src/models.py', line: 1, col: 0 },
    exposure: 'user-facing',
    classification: {
      exposure: 'user-facing',
      plane: 'tenant',
      lifecycle: { create: true, read: true, update: true, delete: true, deleteSemantics: 'hard' },
      primaryKey,
    },
    classificationTrace: null,
    detector: { id: 'gateforge.sqlalchemy', version: '1.0.0' },
    attributes: { resourceName: name, ...attributes },
  } as unknown as GraphResource;
}

/**
 * Builds one compiled GET route.
 *
 * Args:
 *   canonicalPath: the compiled path shape (`:id` positional segments).
 *   linkedResourceName: the business resource the engine linked it to.
 *
 * Returns:
 *   HttpRouteCandidate: one GET route candidate.
 */
function get(canonicalPath: string, linkedResourceName?: string): HttpRouteCandidate {
  return {
    resourceId: `http.endpoint:GET ${canonicalPath}`,
    method: 'GET',
    canonicalPath,
    ...(linkedResourceName === undefined ? {} : { linkedResourceName }),
  };
}

/**
 * Plans one fixture resource on its own.
 *
 * Args:
 *   fixture: the resource, its routes, and its delete semantics.
 *
 * Returns:
 *   ScaffoldPlan: the single plan the planner produced.
 */
function planFor(fixture: FixtureResource): ScaffoldPlan {
  const plans = planAdapters({
    targets: [
      {
        resource: fixture.resource,
        adapterId: `tenant.${fixture.resource.name}`,
        deleteSemantics: fixture.deleteSemantics,
      },
    ],
    routes: fixture.routes,
    existing: [],
    environmentFingerprint: FINGERPRINT,
  });
  const plan = plans[0];
  if (plan === undefined) throw new Error(`no plan for ${fixture.resource.name}`);
  return plan;
}

/** The value the generated source declares for one adapter key. */
function declared(plan: ScaffoldPlan, key: string): string {
  const match = new RegExp(`^  ${key}: (.*),$`, 'm').exec(plan.source ?? '');
  return match?.[1] ?? '';
}

describe('the scaffolder never sells a per-parent sub-collection as the collection', () => {
  it('prefers the flat collection that shares the by-id read prefix', () => {
    const plan = planFor({
      resource: table('invoices', { updateableFields: ['total'] }),
      routes: [
        get('/api/v1/contracts/:contractId/invoices'),
        get('/api/v1/invoices'),
        get('/api/v1/invoices/:id'),
        get('/api/v1/contracts/:contractId/invoices/:invoiceId'),
      ],
      handWritten: {
        readPath: '/api/v1/invoices/{id}',
        listPath: '/api/v1/invoices',
        fields: ['total'],
        deletion: 'hard',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'readPath')).toBe('"/api/v1/invoices/{id}"');
    expect(declared(plan, 'listPath')).toBe('"/api/v1/invoices"');
  });

  it('asks the human when only per-parent collections serve the resource', () => {
    const plan = planFor({
      resource: table('tasks', { updateableFields: ['title'] }),
      routes: [
        get('/api/v1/customer-accounts/:customerAccountId/tasks'),
        get('/api/v1/customer-accounts/:customerAccountId/tasks/:id'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    // A per-parent sub-collection is never the complete collection, and
    // a per-parent read is never a by-id read of the resource itself.
    expect(plan.needsYou.join('\n')).toContain('only per-parent collections');
    expect(plan.needsYou.join('\n')).toContain('listPath');
    expect(plan.needsYou.join('\n')).toContain('per-parent');
    expect(plan.needsYou.join('\n')).not.toContain('customer-accounts/:customerAccountId/tasks/{id}');
  });
});

describe('the scaffolder matches route names across hyphens and underscores', () => {
  it('finds the hyphenated path of an underscored table', () => {
    const plan = planFor({
      resource: table('work_reports', { updateableFields: ['summary'] }),
      routes: [get('/api/v1/work-reports'), get('/api/v1/work-reports/:id')],
      handWritten: {
        readPath: '/api/v1/work-reports/{id}',
        listPath: '/api/v1/work-reports',
        fields: ['summary'],
        deletion: 'hard',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'readPath')).toBe('"/api/v1/work-reports/{id}"');
    expect(declared(plan, 'listPath')).toBe('"/api/v1/work-reports"');
    // A name match stays a guess, and says so.
    expect(plan.guesses.join('\n')).toContain('name-matched only');
  });

  it('never matches a name as a path segment substring', () => {
    const plan = planFor({
      resource: table('tasks', { updateableFields: ['title'] }),
      routes: [get('/api/v1/tasks-archive'), get('/api/v1/tasks-archive/:id')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.needsYou.join('\n')).toContain('no GET route serves one tasks entity');
  });
});

describe('the scaffolder reads the delete semantics the graph can see', () => {
  it('archives when the graph declares a soft-delete column, marked as a guess', () => {
    const plan = planFor({
      resource: table('accounts', {
        columnNames: ['id', 'email', 'role', 'is_active'],
        softDeleteCandidateFields: ['is_active'],
      }),
      routes: [get('/api/v1/accounts'), get('/api/v1/accounts/:id')],
      handWritten: {
        readPath: '/api/v1/accounts/{id}',
        listPath: '/api/v1/accounts',
        fields: ['email', 'role', 'is_active'],
        deletion: 'archive',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'deletion')).toBe('"archive"');
    expect(plan.guesses.join('\n')).toContain('soft-delete');
  });

  it('never silently hard-deletes a table that merely LOOKS soft-deleted', () => {
    const plan = planFor({
      resource: table('accounts', { columnNames: ['id', 'email', 'is_active'] }),
      routes: [get('/api/v1/accounts'), get('/api/v1/accounts/:id')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    // The graph proves nothing here, so the value stays the default and
    // the human is told exactly which column raised the question.
    expect(declared(plan, 'deletion')).toBe('"hard"');
    expect(plan.needsYou.join('\n')).toContain("table has is_active");
    expect(plan.needsYou.join('\n')).toContain("set deletion: 'archive'");
    expect(plan.guesses.join('\n')).toContain('is_active');
  });

  it('keeps the classification-proven delete semantics authoritative', () => {
    const plan = planFor({
      resource: table('accounts', {
        columnNames: ['id', 'email', 'is_active'],
        softDeleteCandidateFields: ['is_active'],
      }),
      routes: [get('/api/v1/accounts'), get('/api/v1/accounts/:id')],
      handWritten: null,
      deleteSemantics: 'hard',
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'deletion')).toBe('"hard"');
    expect(plan.guesses.join('\n')).toContain("taken from the classification's delete semantics");
    expect(plan.needsYou.join('\n')).not.toContain('table has is_active');
  });
});

describe('the scaffolder projects every declared column, minus the secrets', () => {
  it('includes read-only and foreign-key columns and names the exclusions', () => {
    const plan = planFor({
      resource: table('accounts', {
        columnNames: [
          'id',
          'email',
          'first_name',
          'role',
          'owner_id',
          'is_active',
          'created_at',
          'password_hash',
          'api_key',
        ],
        updateableFields: ['email', 'first_name'],
        foreignKeyReferences: [{ column: 'owner_id', references: 'users.id' }],
      }),
      routes: [get('/api/v1/accounts'), get('/api/v1/accounts/:id')],
      handWritten: {
        readPath: '/api/v1/accounts/{id}',
        listPath: '/api/v1/accounts',
        fields: ['email', 'first_name', 'role', 'owner_id', 'is_active'],
        deletion: 'hard',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    const fields = [...(declared(plan, 'fields').matchAll(/"([^"]+)"/g))].map((match) => match[1]);
    // The primary key is the id, not a projected field.
    expect(fields).not.toContain('id');
    // Read-only columns the obligations observe are projected too.
    expect(fields).toEqual(
      expect.arrayContaining(['email', 'first_name', 'role', 'owner_id', 'is_active', 'created_at']),
    );
    // Secrets never reach a generated file, and the exclusion is visible.
    expect(fields).not.toContain('password_hash');
    expect(fields).not.toContain('api_key');
    expect(plan.source ?? '').toContain('excluded');
    expect(plan.source ?? '').toContain('password_hash');
  });

  it('asks for the fields when the graph declares no column at all', () => {
    const plan = planFor({
      resource: table('orders', {}),
      routes: [get('/api/v1/orders'), get('/api/v1/orders/:id')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'fields')).toBe('[]');
    expect(plan.needsYou.join('\n')).toContain('declares no columns');
  });
});

/** The fixture app: the shapes the generator was measured failing on. */
const FIXTURE: FixtureResource[] = [
  // Flat collection next to per-parent sub-collections.
  {
    resource: table('invoices', {
      columnNames: ['id', 'number', 'total', 'is_active', 'customer_id', 'secret_note'],
      updateableFields: ['total'],
      foreignKeyReferences: [{ column: 'customer_id', references: 'customers.id' }],
      softDeleteCandidateFields: ['is_active'],
    }),
    routes: [
      get('/api/v1/contracts/:contractId/invoices'),
      get('/api/v1/invoices'),
      get('/api/v1/invoices/:id'),
    ],
    handWritten: {
      readPath: '/api/v1/invoices/{id}',
      listPath: '/api/v1/invoices',
      fields: ['number', 'total', 'is_active', 'customer_id'],
      deletion: 'archive',
    },
    deleteSemantics: null,
  },
  // Hyphenated path for an underscored table.
  {
    resource: table('work_reports', {
      columnNames: ['id', 'summary', 'author_id', 'is_active'],
      updateableFields: ['summary'],
    }),
    routes: [get('/api/v1/work-reports'), get('/api/v1/work-reports/:id')],
    handWritten: {
      readPath: '/api/v1/work-reports/{id}',
      listPath: '/api/v1/work-reports',
      fields: ['summary', 'author_id', 'is_active'],
      deletion: 'archive',
    },
    deleteSemantics: null,
  },
  // Unlinked routes that still name the table, in a nested-only shape.
  {
    resource: table('tasks', {
      columnNames: ['id', 'title', 'account_id', 'is_active'],
      updateableFields: ['title'],
    }),
    routes: [
      get('/api/v1/accounts/:accountId/tasks'),
      get('/api/v1/accounts/:accountId/tasks/:id'),
    ],
    handWritten: null,
    deleteSemantics: null,
  },
  // Read-only and secret columns on an otherwise ordinary table.
  {
    resource: table('accounts', {
      columnNames: [
        'id',
        'email',
        'role',
        'is_active',
        'password_hash',
        'last_login_at',
      ],
      updateableFields: ['email'],
      softDeleteCandidateFields: ['is_active'],
    }),
    routes: [get('/api/v1/accounts'), get('/api/v1/accounts/:id')],
    handWritten: {
      readPath: '/api/v1/accounts/{id}',
      listPath: '/api/v1/accounts',
      fields: ['email', 'role', 'is_active', 'last_login_at'],
      deletion: 'archive',
    },
    deleteSemantics: null,
  },
  // A proven hard delete stays a hard delete.
  {
    resource: table('orders', {
      columnNames: ['id', 'reference', 'total', 'customer_id'],
      updateableFields: ['total'],
      foreignKeyReferences: [{ column: 'customer_id', references: 'customers.id' }],
    }),
    routes: [get('/api/v1/orders'), get('/api/v1/orders/:id')],
    handWritten: {
      readPath: '/api/v1/orders/{id}',
      listPath: '/api/v1/orders',
      fields: ['reference', 'total', 'customer_id'],
      deletion: 'hard',
    },
    deleteSemantics: 'hard',
  },
  // A flat table with a composite key: the read needs a human.
  {
    resource: table('ledger_entries', {
      columnNames: ['entry_id', 'line_no', 'amount'],
      updateableFields: ['amount'],
    }, ['entry_id', 'line_no']),
    routes: [get('/api/v1/ledger-entries'), get('/api/v1/ledger-entries/:entryId/:lineNo')],
    handWritten: null,
    deleteSemantics: 'hard',
  },
];

describe('the generated plans score against hand-written adapters', () => {
  it('matches the hand-written adapter on every derivable resource', () => {
    const scores = { readPath: 0, listPath: 0, fields: 0, deletion: 0, equivalent: 0, total: 0 };
    const missed: string[] = [];
    for (const fixture of FIXTURE) {
      const handWritten = fixture.handWritten;
      if (handWritten === null) continue;
      scores.total += 1;
      const plan = planFor(fixture);
      if (plan.status !== 'create') {
        missed.push(`${fixture.resource.name}: ${plan.status}`);
        continue;
      }
      const fields = [...(declared(plan, 'fields').matchAll(/"([^"]+)"/g))].map(
        (match) => match[1] ?? '',
      );
      const readPath = declared(plan, 'readPath');
      const listPath = declared(plan, 'listPath');
      const deletion = declared(plan, 'deletion');
      const readOk = readPath === JSON.stringify(handWritten.readPath);
      const listOk = listPath === JSON.stringify(handWritten.listPath);
      const fieldsOk = handWritten.fields.every((field) => fields.includes(field));
      const deletionOk = deletion === JSON.stringify(handWritten.deletion);
      scores.readPath += readOk ? 1 : 0;
      scores.listPath += listOk ? 1 : 0;
      scores.fields += fieldsOk ? 1 : 0;
      scores.deletion += deletionOk ? 1 : 0;
      scores.equivalent += readOk && listOk && fieldsOk && deletionOk ? 1 : 0;
      if (!(readOk && listOk && fieldsOk && deletionOk)) {
        missed.push(
          `${fixture.resource.name}: read=${readOk} list=${listOk} fields=${fieldsOk} deletion=${deletionOk}`,
        );
      }
    }
    expect(missed).toEqual([]);
    expect(scores).toEqual({
      readPath: scores.total,
      listPath: scores.total,
      fields: scores.total,
      deletion: scores.total,
      equivalent: scores.total,
      total: scores.total,
    });
  });

  it('refuses the resources a human must decide, without inventing a path', () => {
    for (const name of ['tasks', 'ledger_entries']) {
      const plan = planFor(FIXTURE.find((entry) => entry.resource.name === name) as FixtureResource);
      expect(plan.status, name).toBe('needs-you');
      expect(plan.needsYou.length, name).toBeGreaterThan(0);
    }
  });
});
