/**
 * UC-83: Maintenance-contract document lifecycle.
 *
 * The browser creates a contract, uploads a document, reads it, edits its
 * description, and deletes it. Persistence evidence comes only from the
 * engine-side reviewed adapter; the test never writes the database directly.
 */
import { expect, test as base, type Page } from 'playwright/test';
import { test as gateforgeTest } from '@gateforge/pack-playwright';
import { anchorUiAction, persistenceClaims, preObserve, verifyPersistence } from './gateforge-helpers.mts';

const RESOURCE = 'tenant.maintenance_contract_documents';
const CLAIMS = persistenceClaims(RESOURCE);

type Witness = {
  testId: string;
  preCreate(): Promise<string>;
  verifyCreate(id: string, before: string): Promise<void>;
  verifyRead(id: string): Promise<void>;
  preUpdate(id: string): Promise<string>;
  verifyUpdate(id: string, before: string): Promise<void>;
  verifyDelete(id: string): Promise<void>;
};

async function openDocuments(page: Page, title: string): Promise<void> {
  await page.goto('/contracts');
  await page.getByRole('button', { name: /Neuer Vertrag/i }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('[data-field="customer_id"]').waitFor({ timeout: 30_000 });
  await dialog.locator('input').first().fill(title);
  await dialog.locator('[data-field="customer_id"]').selectOption({ index: 1 });
  await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/contractor/contracts'),
      { timeout: 30_000 },
    ),
    dialog.getByRole('button', { name: /Vertrag anlegen/i }).click(),
  ]);
  const contractLink = page.getByRole('link', { name: title }).first();
  await contractLink.waitFor({ timeout: 30_000 });
  await contractLink.click();
  await page.getByRole('button', { name: /Dokumente/i }).click();
}

async function uploadDocument(page: Page, filename: string): Promise<string> {
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/documents'),
    { timeout: 30_000 },
  );
  await page.locator('input[type="file"]').first().setInputFiles({
    name: filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Gateforge lifecycle\n%%EOF\n'),
  });
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { id: string };
  expect(body.id).toBeTruthy();
  return body.id;
}

async function runLifecycle(page: Page, witness: Witness | null): Promise<void> {
  const title = `Gateforge document contract ${Date.now()}`;
  const filename = `gateforge-${Date.now()}.pdf`;
  const initialDescription = 'Initial gateforge contract document';
  const updatedDescription = 'Updated gateforge contract document';

  await openDocuments(page, title);

  const beforeCreate = witness ? await witness.preCreate() : '';
  const documentId = await uploadDocument(page, filename);
  if (witness) await witness.verifyCreate(documentId, beforeCreate);
  if (witness) await anchorUiAction(CLAIMS.create, witness.testId, {
    operation: 'create', entityId: documentId, fields: { description: initialDescription },
  });

  await expect(page.getByText(filename)).toBeVisible({ timeout: 20_000 });
  if (witness) await witness.verifyRead(documentId);
  if (witness) await anchorUiAction(CLAIMS.read, witness.testId, {
    operation: 'read', entityId: documentId, fields: { original_filename: filename },
  });

  const beforeUpdate = witness ? await witness.preUpdate(documentId) : '';
  page.once('dialog', (dialog) => dialog.accept(updatedDescription));
  await page.getByTitle('Bearbeiten').last().click();
  await page.waitForResponse(
    (response) => response.request().method() === 'PUT' && response.url().includes(`/documents/${documentId}`),
    { timeout: 30_000 },
  );
  await expect(page.getByText(updatedDescription)).toBeVisible({ timeout: 20_000 });
  if (witness) await witness.verifyUpdate(documentId, beforeUpdate);
  if (witness) await anchorUiAction(CLAIMS.update, witness.testId, {
    operation: 'update', entityId: documentId, fields: { description: updatedDescription },
  });

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTitle('Löschen').last().click();
  await page.waitForResponse(
    (response) => response.request().method() === 'DELETE' && response.url().includes(`/documents/${documentId}`),
    { timeout: 30_000 },
  );
  await expect(page.getByText(filename)).not.toBeVisible({ timeout: 20_000 });
  if (witness) await witness.verifyDelete(documentId);
  if (witness) await anchorUiAction(CLAIMS.delete, witness.testId, {
    operation: 'delete', entityId: documentId, fields: {},
  });
}

base('UC-83 raw: maintenance contract document lifecycle', async ({ page }) => {
  await runLifecycle(page, null);
});

if (Boolean(process.env.GATEFORGE_WITNESS_URL || process.env.GATEFORGE_STATE_DIR)) {
  gateforgeTest('UC-83 [witnessed]: maintenance contract document lifecycle', {
    annotation: CLAIMS.all.map((description) => ({ type: 'gateforge', description })),
  }, async ({ page }) => {
    const testId = gateforgeTest.info().testId;
    const witness: Witness = {
      testId,
      preCreate: () => preObserve({ resourceId: RESOURCE, testId, claimId: CLAIMS.create }),
      verifyCreate: async (id, before) => {
        const result = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.create, preObservationId: before });
        expect(result.found, 'document exists after upload').toBe(true);
      },
      verifyRead: async (id) => {
        const result = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.read });
        expect(result.found, 'document is readable').toBe(true);
      },
      preUpdate: (id) => preObserve({ resourceId: RESOURCE, testId, claimId: CLAIMS.update, entityId: id }),
      verifyUpdate: async (id, before) => {
        const result = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.update, preObservationId: before });
        expect(result.found, 'document remains after update').toBe(true);
        expect(result.fieldsMatch, 'description update is observed').toBe(true);
      },
      verifyDelete: async (id) => {
        const result = await verifyPersistence({ resourceId: RESOURCE, entityId: id, testId, claimId: CLAIMS.delete });
        expect(result.found, 'hard delete removes document').toBe(false);
      },
    };
    await runLifecycle(page, witness);
  });
}
