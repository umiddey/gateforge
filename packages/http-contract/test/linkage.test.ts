/**
 * Phase 4 engine tests: the path-derived resource-name candidate
 * (ADR 0004 D5). Deterministic and offline. The candidate is a
 * NON-authoritative linkage hint: name-form normalization (dashes to
 * underscores) only — it never guesses planes or mints identities.
 */
import { describe, expect, it } from 'vitest';
import { derivePathResourceName } from '../src/index.js';

describe('derivePathResourceName (last non-param segment, name-form normalized)', () => {
  it('normalizes a kebab-case segment to the snake_case resource form', () => {
    // The portal-repo shape: `/email-accounts/{id}` fronts the
    // snake_case `email_accounts` table; without normalization the
    // candidate can never equal a discovered table name.
    expect(derivePathResourceName('/email-accounts/{id}')).toBe('email_accounts');
    expect(derivePathResourceName('/notification-templates/{template_id}')).toBe(
      'notification_templates',
    );
  });

  it('normalizes every dash in a multi-dash segment', () => {
    expect(derivePathResourceName('/api/v1/sub-process-types/{type_id}')).toBe('sub_process_types');
    expect(derivePathResourceName('/work-order-line-items/{item_id}')).toBe('work_order_line_items');
  });

  it('leaves already-snake_case and plain segments unchanged', () => {
    expect(derivePathResourceName('/email_accounts/{id}')).toBe('email_accounts');
    expect(derivePathResourceName('/api/v1/accounts')).toBe('accounts');
  });

  it('normalizes after stripping a file extension', () => {
    expect(derivePathResourceName('/api/email-accounts.json')).toBe('email_accounts');
    // The last segment wins: extension stripping applies to it alone.
    expect(derivePathResourceName('/email-accounts/list.json')).toBe('list');
  });

  it('normalizes before query/hash tails are considered', () => {
    expect(derivePathResourceName('/email-accounts?page=1')).toBe('email_accounts');
    expect(derivePathResourceName('/email-accounts#section')).toBe('email_accounts');
  });

  it('skips parameter, numeric, and unresolved-slot segments then normalizes', () => {
    expect(derivePathResourceName('/api/v1/email-accounts/{account_id}/:param')).toBe(
      'email_accounts',
    );
    expect(derivePathResourceName('/email-accounts/123')).toBe('email_accounts');
    expect(derivePathResourceName('/v2/email-accounts')).toBe('email_accounts');
  });

  it('still returns null when every segment is a parameter or empty', () => {
    expect(derivePathResourceName('/{id}')).toBeNull();
    expect(derivePathResourceName('/')).toBeNull();
    expect(derivePathResourceName('')).toBeNull();
  });

  it('is deterministic under repetition (pure name-form function)', () => {
    const once = derivePathResourceName('/email-accounts/{id}');
    expect(derivePathResourceName('/email-accounts/{id}')).toBe(once);
  });
});
