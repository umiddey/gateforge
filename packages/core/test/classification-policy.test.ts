import { describe, expect, it } from 'vitest';
import {
  ClassificationPolicySchema,
  LifecycleRuleSchema,
  LifecycleRulesSchema,
  sortLifecycleRules,
} from '../src/index.js';

const BASE_POLICY = {
  schemaVersion: 1,
  scanRoots: ['backend/**/*.py'],
  trustedInternalEntryPoints: [],
  internalRules: [],
  declarations: {},
  volatileFields: [],
};

describe('classification-policy lifecycleRules', () => {
  it('parses the Contractor Portal exact-resource policy shape', () => {
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
