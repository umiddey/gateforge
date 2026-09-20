/**
 * Thin overlay proofs for the behavior reference app (plan 2026-09-19
 * Phase 6 item 5): one test per endpoint sharing the accounts table.
 * Each test names ONE approved case id and calls `evidence.prove` —
 * the ENGINE executes the case, drives the principal (browser for
 * profile/admin, engine-http bulk for import), and seals the record.
 * Clicks and assertions in these bodies prove nothing by themselves.
 *
 * Case ids are canonical (`sha256({domain, resourceId, id})`, same
 * recipe the compiler uses). `resourceId` values are the normalized
 * endpoint ids from the approved discovery scope — the supervisor's
 * compiled catalog is authoritative, and a stale constant fails closed
 * (unknown case / missing mapping), never silently.
 *
 * Harness contract (Phase 6 verification): initialize the
 * complete-behavior profile on this example, approve the three cases,
 * map each test with `tests mark --case`, and run through real
 * witness/Chromium via `test-gates`.
 */
import { test as gateforgeTest, expect } from '@gate-forge/pack-playwright';
import { sha256Canonical, BEHAVIOR_CASE_DOMAIN } from '@gate-forge/core';
import { profileSurface, adminSurface, importSurface } from './behavior-surfaces.js';

const PROFILE_ENDPOINT = 'tenant.http-post-profile-accounts-id-d27ca586';
const ADMIN_ENDPOINT = 'tenant.http-post-admin-accounts-id-d2cbd1c4';
const IMPORT_ENDPOINT = 'tenant.http-post-imports-accounts-a4eac965';

function caseIdOf(resourceId, slug) {
  return sha256Canonical({ domain: BEHAVIOR_CASE_DOMAIN, resourceId, id: slug });
}

const profileTest = gateforgeTest.extend({ surface: profileSurface });
profileTest('profile editor updates an account', async ({ evidence }) => {
  const sealed = await evidence.prove(caseIdOf(PROFILE_ENDPOINT, 'profile-update'));
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

const adminTest = gateforgeTest.extend({ surface: adminSurface });
adminTest('admin editor updates an account', async ({ evidence }) => {
  const sealed = await evidence.prove(caseIdOf(ADMIN_ENDPOINT, 'admin-update'));
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});

const importTest = gateforgeTest.extend({ surface: importSurface });
importTest('bulk import creates two accounts', async ({ evidence }) => {
  const sealed = await evidence.prove(caseIdOf(IMPORT_ENDPOINT, 'import-two-accounts'));
  expect(sealed.state).toBe('sealed');
  expect(sealed.recordIds.length).toBeGreaterThan(0);
});
