/**
 * Sample entity adapter for the gateforge auth example app
 * (`example/auth/`): the `example.billing.refund` resource, read via
 * `GET /api/billing/refund/:id`.
 *
 * DOCUMENTATION + SAMPLE ONLY — actual adapter loading is the engine
 * side (witness registry, ADR 0002): adapters live in the project's
 * `.gateforge/adapters/` directory as `<resourceId>.mjs` and are
 * executed ENGINE-SIDE with GET-only transport. Copy this file to
 * `.gateforge/adapters/example.billing.refund.mjs` in a project that
 * runs the example auth app and the witness service can prove
 * `example.billing.refund` persistence evidence for the
 * `auth:denied-no-side-effect` obligation.
 *
 * Adapter contract (interface pin #8; the pack's
 * `AuthEntityAdapterSchema`):
 *   - `read(ctx, id)`  — GET-only fetch of one entity; never mutates.
 *   - `normalize(body)` — project the raw body onto
 *     `{ entityId, fields }` (fields carry the classified primaryKey
 *     and the status / amount that prove "no side effect on deny").
 *   - `deletion: 'hard'` — the auth example does NOT soft-delete
 *     refunds; the only state change is the create itself.
 *   - `environmentFingerprint` — the target-environment marker the
 *     witness compares against a probe GET (GF-13): the example app
 *     serves `x-gateforge-env: auth-loopback-v1` on every route once
 *     wired for gateforge.
 *   - `resourceId` — registry identity; must match the file name.
 */

/** Registry identity of the example billing-refund resource. */
const RESOURCE_ID = 'example.billing.refund';

/**
 * The marker the witness expects on any probe/read response: the
 * example app serves `x-gateforge-env: auth-loopback-v1` on every
 * route.
 */
const ENVIRONMENT_FINGERPRINT = 'auth-loopback-v1';

/**
 * GET-only entity read against the example app's read API.
 *
 * Args:
 *   ctx: Witness-provided context (loopback base URL; optional headers).
 *   id: The entity id (`rfn-1`, ...).
 *
 * Returns:
 *   Promise<unknown>: The raw refund object
 *     `{ id, amount_cents, tenant_id, requested_by, status, created_at }`.
 *
 * Throws:
 *   Error: On a fingerprint mismatch (environment attestation) or a
 *     non-200/404 status. 404 surfaces as `null` — the entity is gone.
 */
async function read(ctx, id) {
  const response = await fetch(`${ctx.baseUrl}/api/billing/refund/${encodeURIComponent(id)}`, {
    headers: ctx.headers ?? {},
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`example billing adapter: GET /api/billing/refund/${id} -> ${response.status}`);
  }
  const marker = response.headers.get('x-gateforge-env');
  if (marker !== ENVIRONMENT_FINGERPRINT) {
    throw new Error(
      `example billing adapter: environment fingerprint mismatch ` +
        `(expected ${ENVIRONMENT_FINGERPRINT}, got ${JSON.stringify(marker)})`,
    );
  }
  return response.json();
}

/**
 * Projects the raw refund body onto the evidence shape.
 *
 * Args:
 *   body: The raw refund object from `read`.
 *
 * Returns:
 *   { entityId, fields }: The entity id plus the fields the
 *     `auth:denied-no-side-effect` obligation compares against the
 *     pre-deny snapshot.
 */
function normalize(body) {
  return {
    entityId: String(body.id),
    fields: {
      id: body.id,
      amount_cents: body.amount_cents,
      tenant_id: body.tenant_id,
      status: body.status,
    },
  };
}

export default {
  resourceId: RESOURCE_ID,
  read,
  normalize,
  deletion: 'hard',
  environmentFingerprint: ENVIRONMENT_FINGERPRINT,
};