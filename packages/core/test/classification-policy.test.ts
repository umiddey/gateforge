import { describe, expect, it } from 'vitest';
import {
  ClassificationPolicySchema,
  DeleteRuleSchema,
  DeleteRulesSchema,
  LifecycleRuleSchema,
  LifecycleRulesSchema,
  sortLifecycleRules,
} from '../src/index.js';

// Since 0.11.0 the answers document holds ONLY owner answers; the scanner
// settings (`scanRoots`, `coverage`, `declarations`, `volatileFields`) live
// in `.gateforge.yml` under `scan:`, and this document rejects them.
const BASE_POLICY = {
  schemaVersion: 1,
  trustedInternalEntryPoints: [],
  internalRules: [],
};

describe('classification-policy lifecycleRules', () => {
  it('parses the consumer exact-resource policy shape', () => {
    const parsed = ClassificationPolicySchema.safeParse({
      ...BASE_POLICY,
      lifecycleRules: [
        {
          match: { resourceId: 'tenant.accounting_revisions' },
          disable: ['create', 'update', 'delete'],
          reason: 'Accounting revisions are retained as append-only internal history.',
        },
        {
          match: { resourceId: 'tenant.accounting_export_entries' },
          disable: ['create', 'update', 'delete'],
          reason: 'Export entries are retained as append-only internal history.',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lifecycleRules?.[0]?.match.resourceId).toBe(
        'tenant.accounting_revisions',
      );
    }
  });

  it('rejects empty, ambiguous, duplicate, and unsafe rules', () => {
    expect(
      LifecycleRuleSchema.safeParse({
        match: { resourceId: 'accounting_revisions' },
        disable: ['update'],
        reason: 'missing plane',
      }).success,
    ).toBe(false);
    expect(
      LifecycleRuleSchema.safeParse({
        match: { resourceId: 'tenant.accounting_revisions*' },
        disable: ['update'],
        reason: 'wildcard is ambiguous',
      }).success,
    ).toBe(false);
    expect(
      LifecycleRuleSchema.safeParse({
        match: { resourceId: 'tenant.accounting_revisions' },
        disable: [],
        reason: 'empty disable list',
      }).success,
    ).toBe(false);
    expect(
      LifecycleRuleSchema.safeParse({
        match: { resourceId: 'tenant.accounting_revisions' },
        disable: ['update', 'update'],
        reason: 'duplicate operation',
      }).success,
    ).toBe(false);
    expect(
      LifecycleRuleSchema.safeParse({
        match: { resourceId: 'tenant.accounting_revisions' },
        disable: ['update'],
        reason: '   ',
      }).success,
    ).toBe(false);

    expect(
      LifecycleRulesSchema.safeParse([
        {
          match: { resourceId: 'tenant.accounting_revisions' },
          disable: ['update'],
          reason: 'one rule',
        },
        {
          match: { resourceId: 'tenant.accounting_revisions' },
          disable: ['delete'],
          reason: 'same identity is ambiguous',
        },
      ]).success,
    ).toBe(false);
  });

  it('sorts rules and operations deterministically for authority minting', () => {
    const parsed = LifecycleRulesSchema.parse([
      {
        match: { resourceId: 'tenant.zed' },
        disable: ['delete', 'create'],
        reason: 'z',
      },
      {
        match: { resourceId: 'tenant.accounts' },
        disable: ['update', 'create'],
        reason: 'a',
      },
    ]);
    expect(sortLifecycleRules(parsed).map((rule) => [rule.match.resourceId, rule.disable])).toEqual([
      ['tenant.accounts', ['create', 'update']],
      ['tenant.zed', ['create', 'delete']],
    ]);
  });
});

describe('classification-policy deleteRules', () => {
  it('parses hard and archive rules over the resource source glob', () => {
    const parsed = ClassificationPolicySchema.safeParse({
      ...BASE_POLICY,
      deleteRules: [
        {
          match: 'backend/models/session/**',
          semantics: 'hard',
          reason: 'Sessions are removed the moment the tenant logs out.',
        },
        {
          match: 'backend/models/audit/**',
          semantics: 'archive',
          archiveFields: { status: 'archived' },
          reason: 'Audit rows are retained for the compliance window.',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deleteRules?.[0]?.semantics).toBe('hard');
      expect(parsed.data.deleteRules?.[1]?.archiveFields).toEqual({ status: 'archived' });
    }
  });

  it('refuses archive semantics without non-empty owner-owned archive fields', () => {
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/audit/**',
        semantics: 'archive',
        reason: 'Retained, but no archived state was declared.',
      }).success,
    ).toBe(false);
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/audit/**',
        semantics: 'archive',
        archiveFields: {},
        reason: 'Retained with an empty archived state.',
      }).success,
    ).toBe(false);
    // `hard` removal has no archived state to declare.
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/audit/**',
        semantics: 'hard',
        archiveFields: { status: 'archived' },
        reason: 'Permanent removal cannot carry an archived state.',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys, unsafe globs, and ambiguous duplicate patterns', () => {
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/**',
        semantics: 'hard',
        reason: 'Permanent removal.',
        mode: 'soft',
      }).success,
    ).toBe(false);
    expect(
      DeleteRuleSchema.safeParse({
        match: '/backend/models/**',
        semantics: 'hard',
        reason: 'Absolute paths are outside the repository.',
      }).success,
    ).toBe(false);
    expect(
      DeleteRuleSchema.safeParse({
        match: '../outside/**',
        semantics: 'hard',
        reason: 'A rule can never point outside the repository.',
      }).success,
    ).toBe(false);
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/**',
        semantics: 'soft',
        reason: 'Only hard or archive removal exists.',
      }).success,
    ).toBe(false);
    expect(
      DeleteRuleSchema.safeParse({
        match: 'backend/models/**',
        semantics: 'hard',
        reason: '   ',
      }).success,
    ).toBe(false);

    expect(
      DeleteRulesSchema.safeParse([
        { match: 'backend/models/**', semantics: 'hard', reason: 'Permanent removal.' },
        { match: 'backend/models/**', semantics: 'archive', archiveFields: { status: 'archived' }, reason: 'Retained.' },
      ]).success,
    ).toBe(false);
  });
});

describe('answers document after the 0.11.0 consolidation', () => {
  it('rejects the scanner settings that moved to .gateforge.yml scan:', () => {
    for (const [key, value] of [
      ['scanRoots', ['backend/**/*.py']],
      ['coverage', []],
      ['declarations', {}],
      ['volatileFields', []],
    ] as const) {
      const parsed = ClassificationPolicySchema.safeParse({ ...BASE_POLICY, [key]: value });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain(key);
    }
  });

  it('accepts the sections that moved IN from their own files, and the owner rules', () => {
    const parsed = ClassificationPolicySchema.safeParse({
      ...BASE_POLICY,
      planes: { rules: [{ match: 'backend/models/**', plane: 'tenant', reason: 'Reviewed.' }] },
      endpoints: { rules: [{ paths: ['/api/**'], capability: 'crud-read', reason: 'Reviewed.' }] },
      rules: [
        {
          id: 'invoice-cancel-only-unpaid',
          title: 'An invoice can only be cancelled while it is unpaid',
          cases: [{ id: 'paid-cannot-cancel', describe: 'Cancelling a paid invoice is refused' }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a planes/endpoints section that is not a rule list', () => {
    expect(ClassificationPolicySchema.safeParse({ ...BASE_POLICY, planes: { rules: {} } }).success).toBe(false);
    expect(ClassificationPolicySchema.safeParse({ ...BASE_POLICY, endpoints: [] }).success).toBe(false);
  });
});
