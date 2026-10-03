/**
 * `gateforge adapters scaffold` planning accuracy, at the planner level.
 *
 * The measured failure modes of the generator, one test each: a
 * per-parent sub-collection sold as the complete collection, path
 * naming that ignores hyphens, a soft-delete table scaffolded as a
 * hard delete, a field list too narrow to observe read-only columns
 * the obligations grade, a route that only NAMES the resource turned
 * into a written readPath, a literal segment before the id taken as a
 * by-id read, a list-only resource refused although the kit resolves
 * the member out of the collection, and a route that exists behind an
 * unanswered plane reported as absent.
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
import type { UnresolvedRoute } from '../src/adapter-audit.js';

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
  /** Route paths no app mounts (the endpoint is standalone). */
  standalonePaths?: string[];
  handWritten: HandWritten | null;
  deleteSemantics: AdapterTarget['deleteSemantics'];
  /** Compiled routes the runtime inventory omits (plane unanswered). */
  unresolvedRoutes?: UnresolvedRoute[];
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
    unresolvedRoutes: fixture.unresolvedRoutes ?? [],
    standalonePaths: fixture.standalonePaths ?? [],
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
        get('/api/v1/contracts/:contractId/invoices', 'invoices'),
        get('/api/v1/invoices', 'invoices'),
        get('/api/v1/invoices/:id', 'invoices'),
        get('/api/v1/contracts/:contractId/invoices/:invoiceId', 'invoices'),
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
        get('/api/v1/customer-accounts/:customerAccountId/tasks', 'tasks'),
        get('/api/v1/customer-accounts/:customerAccountId/tasks/:id', 'tasks'),
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
      routes: [
        get('/api/v1/work-reports', 'work_reports'),
        get('/api/v1/work-reports/:id', 'work_reports'),
      ],
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
    // Only engine-linked routes reach a file, and the file says which
    // ones they were.
    expect(plan.guesses.join('\n')).toContain("routes linked to 'work_reports'");
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
      routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
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
      routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
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
      routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
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
      routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
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
      routes: [get('/api/v1/orders', 'orders'), get('/api/v1/orders/:id', 'orders')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'fields')).toBe('[]');
    expect(plan.needsYou.join('\n')).toContain('declares no columns');
  });

  it('keeps the primary key out of the projected fields when only the table declares it', () => {
    const plan = planFor({
      resource: table(
        'accounts',
        { columnNames: ['id', 'email', 'status'], primaryKeyColumns: ['id'] },
        [],
      ),
      routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
      handWritten: {
        readPath: '/api/v1/accounts/{id}',
        listPath: '/api/v1/accounts',
        fields: ['email', 'status'],
        deletion: 'hard',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    const fields = [...(declared(plan, 'fields').matchAll(/"([^"]+)"/g))].map((match) => match[1]);
    // The declared primary key IS the entity id, never a projected
    // field — whichever layer of the graph declared it.
    expect(fields).toEqual(['email', 'status']);
  });

  it('omits the exclusion clause when nothing was excluded', () => {
    const plan = planFor({
      resource: table('orders', { columnNames: ['label', 'total'] }, []),
      routes: [get('/api/v1/orders', 'orders'), get('/api/v1/orders/:id', 'orders')],
      handWritten: {
        readPath: '/api/v1/orders/{id}',
        listPath: '/api/v1/orders',
        fields: ['label', 'total'],
        deletion: 'hard',
      },
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(plan.guesses.join('\n')).toContain('fields [label, total]');
    // An empty exclusion list says nothing: the clause must not print.
    expect(plan.guesses.join('\n')).not.toContain('excluded:');
  });
});

describe('the scaffolder writes only what engine evidence supports', () => {
  it('never writes an adapter from a route that merely names the resource', () => {
    const plan = planFor({
      resource: table('webhooks', { updateableFields: ['event'] }),
      routes: [get('/api/v1/webhooks'), get('/api/v1/webhooks/attempts/:id')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    const text = plan.needsYou.join('\n');
    // Nothing is linked to `webhooks`, so the candidates are listed for
    // a human to confirm and no path is invented from the name.
    expect(text).toContain('nothing is written from a name match');
    expect(text).toContain('GET /api/v1/webhooks');
    expect(text).toContain('GET /api/v1/webhooks/attempts/:id');
  });

  it('never takes a route with a literal segment before the id as a by-id read', () => {
    const plan = planFor({
      resource: table('shipments', { updateableFields: ['weight'] }),
      routes: [
        get('/api/v1/shipments', 'shipments'),
        get('/api/v1/shipments/carrier/:id', 'shipments'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    const text = plan.needsYou.join('\n');
    expect(text).toContain('GET /api/v1/shipments/carrier/:id');
    expect(text).toContain('literal segment');
    expect(text).toContain('readPath');
  });

  it('never takes a route the compiler linked to a different resource', () => {
    const plan = planFor({
      resource: table('attachments', { updateableFields: ['filename'] }),
      routes: [
        get('/api/v1/attachments', 'attachments'),
        // Linked to `media_attachments`, so it is someone else's route
        // even though its path names `attachments`.
        get('/api/v1/media/attachments/:id', 'media_attachments'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    expect(plan.needsYou.join('\n')).toContain('GET /api/v1/media/attachments/:id');
  });
});

describe('the scaffolder writes a list-only adapter when no by-id route exists', () => {
  it('generates a collection-only adapter and says in the header that it is slower', () => {
    const plan = planFor({
      resource: table('categories', {
        columnNames: ['id', 'name', 'published_at'],
        updateableFields: ['name'],
      }),
      routes: [get('/api/v1/categories', 'categories')],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'listPath')).toBe('"/api/v1/categories"');
    // The kit resolves the member out of the complete collection, so no
    // readPath is declared — and the header carries the cost.
    expect(declared(plan, 'readPath')).toBe('');
    expect(plan.source ?? '').toContain('LIST-ONLY');
    expect(plan.source ?? '').toContain('slower');
    const guesses = plan.guesses.join('\n');
    expect(guesses).toContain('readPath omitted');
    expect(guesses).toContain('collectionKey guessed');
    expect(guesses).toContain('paging guessed');
  });

  it('still asks the human when a by-id-shaped route was rejected', () => {
    const plan = planFor({
      resource: table('sensors', { updateableFields: ['label'] }),
      routes: [
        get('/api/v1/sensors', 'sensors'),
        get('/api/v1/sites/:siteId/sensors/:id', 'sensors'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    // A per-parent read is not "no by-id route": the app DOES serve one,
    // so the slower list-only shape must not be written silently.
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    expect(plan.needsYou.join('\n')).toContain('per-parent route');
  });

  it('takes the by-id route when the resource segment is the route’s own level', () => {
    const plan = planFor({
      resource: table('sensors', { updateableFields: ['label'] }),
      routes: [
        get('/api/v1/sensors', 'sensors'),
        get('/api/v1/sites/sensors/:id', 'sensors'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(declared(plan, 'readPath')).toBe('"/api/v1/sites/sensors/{id}"');
  });
});

describe('the scaffolder names a route that exists behind an unanswered plane', () => {
  it('names the route and the blocker instead of reporting no route at all', () => {
    const plan = planFor({
      resource: table('accounts', { updateableFields: ['email'] }),
      routes: [],
      unresolvedRoutes: [
        { method: 'GET', canonicalPath: '/api/v2/accounts', linkedResourceName: 'accounts' },
        { method: 'GET', canonicalPath: '/api/v2/accounts/{}', linkedResourceName: 'accounts' },
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    const text = plan.needsYou.join('\n');
    expect(text).toContain(
      'GET /api/v2/accounts, GET /api/v2/accounts/{} exist but their plane is unanswered',
    );
    expect(text).toContain('answer the plane first');
    // The false negative this replaces: both routes are compiled.
    expect(text).not.toContain('no GET route serves one accounts entity');
    expect(text).not.toContain('no GET collection route serves accounts');
  });

  it('waits for the plane instead of writing a slower list-only adapter', () => {
    const plan = planFor({
      resource: table('accounts', { updateableFields: ['email'] }),
      routes: [get('/api/v2/accounts', 'accounts')],
      unresolvedRoutes: [
        { method: 'GET', canonicalPath: '/api/v2/accounts/{}', linkedResourceName: 'accounts' },
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('needs-you');
    expect(plan.source).toBeNull();
    expect(plan.needsYou.join('\n')).toContain(
      'GET /api/v2/accounts/{} exists but its plane is unanswered',
    );
  });
});

describe('the scaffolder marks a path no app mounts', () => {
  it('declares the guess in the file and asks the human to confirm it', () => {
    const plan = planFor({
      resource: table('webhook_deliveries', { updateableFields: ['status'] }),
      routes: [
        get('/api/v1/webhook-deliveries', 'webhook_deliveries'),
        get('/webhook-deliveries/:id', 'webhook_deliveries'),
      ],
      // The router file is never included anywhere: the route exists in
      // the source tree and no app serves it.
      standalonePaths: ['/webhook-deliveries/:id'],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    const guesses = plan.guesses.join('\n');
    expect(guesses).toContain('GET /webhook-deliveries/:id');
    expect(guesses).toContain('no app mounts');
    expect(plan.needsYou.join('\n')).toContain('router no app mounts');
    // Only the unmounted route is questioned.
    expect(plan.needsYou.join('\n')).not.toContain('/api/v1/webhook-deliveries');
  });

  it('says nothing when every route is mounted', () => {
    const plan = planFor({
      resource: table('webhook_deliveries', { updateableFields: ['status'] }),
      routes: [
        get('/api/v1/webhook-deliveries', 'webhook_deliveries'),
        get('/api/v1/webhook-deliveries/:id', 'webhook_deliveries'),
      ],
      handWritten: null,
      deleteSemantics: null,
    });
    expect(plan.status).toBe('create');
    expect(plan.guesses.join('\n')).not.toContain('no app mounts');
    expect(plan.needsYou.join('\n')).not.toContain('no app mounts');
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
      get('/api/v1/contracts/:contractId/invoices', 'invoices'),
      get('/api/v1/invoices', 'invoices'),
      get('/api/v1/invoices/:id', 'invoices'),
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
      softDeleteCandidateFields: ['is_active'],
    }),
    routes: [
      get('/api/v1/work-reports', 'work_reports'),
      get('/api/v1/work-reports/:id', 'work_reports'),
    ],
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
    routes: [get('/api/v1/accounts', 'accounts'), get('/api/v1/accounts/:id', 'accounts')],
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
    routes: [get('/api/v1/orders', 'orders'), get('/api/v1/orders/:id', 'orders')],
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
    routes: [
      get('/api/v1/ledger-entries', 'ledger_entries'),
      get('/api/v1/ledger-entries/:entryId/:lineNo', 'ledger_entries'),
    ],
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
