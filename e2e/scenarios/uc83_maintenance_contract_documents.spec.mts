/**
 * UC-83: Maintenance-contract document lifecycle.
 * Real UI flow: create contract, upload/read/update/delete one document.
 * Persistence evidence comes only from the Gateforge engine adapter.
 */
import { expect, test as base, type Page } from 'playwright/test';
import { test as gateforgeTest } from '@gateforge/pack-playwright';
import { anchorUiAction, persistenceClaims, preObserve, verifyPersistence } from './gateforge-helpers.mts';

const RESOURCE = 'tenant.maintenance_contract_documents';
const CLAIMS = persistenceClaims(RESOURCE);

type Witness = { testId: string; preCreate(): Promise<string>; verifyCreate(id: string, before: string): Promise<void>; verifyRead(id: string): Promise<void>; preUpdate(id: string): Promise<string>; verifyUpdate(id: string, before: string): Promise<void>; verifyDelete(id: string): Promise<void> };

async function openDocuments(page: Page, title: string): Promise<void> {
  await page.goto('/contracts');
  await page.getByRole('button', { name: /Neuer Vertrag/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-field="customer_id"]').waitFor({ timeout: 30_000 });
  await dialog.locator('input').first().fill(title);
  await dialog.locator('[data-field="customer_id"]').selectOption({ index: 1 });
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/contractor/contracts'), { timeout: 30_000 }),
    dialog.getByRole('button', { name: /Vertrag anlegen/i }).click(),
  ]);
  const link = page.getByRole('link', { name: title }).first();
  await link.waitFor({ timeout: 30_000 });
  await link.click();
  await page.getByRole('button', { name: /Dokumente/i }).click();
}

async function uploadDocument(page: Page, filename: string): Promise<string> {
  const responsePromise = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/documents'), { timeout: 30_000 });
  await page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% Gateforge\n%%EOF\n') });
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function lifecycle(page: Page, witness: Witness | null): Promise<void> {
  const title = `Gateforge document contract ${Date.now()}`;
  const filename = `gateforge-${Date.now()}.pdf`;
  const updatedDescription = 'Updated gateforge contract document';
  await openDocuments(page, title);

  const beforeCreate = witness ? await witness.preCreate() : '';
  const documentId = await uploadDocument(page, filename);
  if (witness) {
    await witness.verifyCreate(documentId, beforeCreate);
    await anchorUiAction(CLAIMS.create, witness.testId, { operation: 'create', entityId: documentId, fields: { description: 'Initial gateforge contract document' } });
  }
  await expect(page.getByText(filename)).toBeVisible({ timeout: 20_000 });
  if (witness) {
    await witness.verifyRead(documentId);
    await anchorUiAction(CLAIMS.read, witness.testId, { operation: 'read', entityId: documentId, fields: { original_filename: filename } });
  }

  const beforeUpdate = witness ? await witness.preUpdate(documentId) : '';
  page.once('dialog', (dialog) => dialog.accept(updatedDescription));
  await page.getByTitle('Bearbeiten').last().click();
  await page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/documents/${documentId}`), { timeout: 30_000 });
  await expect(page.getByText(updatedDescription)).toBeVisible({ timeout: 20_000 });
  if (witness) {
    await witness.verifyUpdate(documentId, beforeUpdate);
    await anchorUiAction(CLAIMS.update, witness.testId, { operation: 'update', entityId: documentId, fields: { description: updatedDescription } });
  }

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTitle('Löschen').last().click();
  await page.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().includes(`/documents/${documentId}`), { timeout: 30_000 });
  await expect(page.getByText(filename)).not.toBeVisible({ timeout: 20_000 });
  if (witness) {
    await witness.verifyDelete(documentId);
    await anchorUiAction(CLAIMS.delete, witness.testId, { operation: 'delete', entityId: documentId, fields: {} });
  }
}

base('UC-83 raw: maintenance contract document lifecycle', async ({ page }) => lifecycle(page, null));

if (Boolean(process.env.GATEFORGE_WITNESS_URL || process.env.GATEFORGE_STATE_DIR)) {
  gateforgeTest('UC-83 [witnessed]: maintenance contract document lifecycle', { annotation: CLAIMS.all.map((description) => ({ type: 'gateforge', description })) }, async ({ page }) => {
    const testId = gateforgeTest.info().testId;
    const witness: Witness = {
      testId,
      preCreate: () => preObserve({ resourceId: RESOURCE, testId, claimId: CLAIMS.create }),
      verifyCreate: async (id, before) => { const r = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.create, preObservationId: before }); expect(r.found).toBe(true); },
      verifyRead: async (id) => { const r = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.read }); expect(r.found).toBe(true); },
      preUpdate: (id) => preObserve({ resourceId: RESOURCE, testId, claimId: CLAIMS.update, entityId: id }),
      verifyUpdate: async (id, before) => { const r = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.update, preObservationId: before }); expect(r.found).toBe(true); expect(r.fieldsMatch).toBe(true); },
      verifyDelete: async (id) => { const r = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.delete }); expect(r.found).toBe(false); },
    };
    await lifecycle(page, witness);
  });
}
