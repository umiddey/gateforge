/**
 * Sample entity adapter for the gateforge example app (`example/`):
 * the `accounts` resource, read via `GET /api/accounts/:id`.
 *
 * DOCUMENTATION + SAMPLE ONLY — actual adapter loading is the engine
 * side (witness registry, ADR 0002): adapters live in the project's
 * `.gateforge/adapters/` directory as `<resourceId>.mjs` and are
 * executed ENGINE-SIDE with GET-only transport. Copy this file to
 * `.gateforge/adapters/example.accounts.mjs` in a project that runs the
 * example app and the witness service can prove `example.accounts`
 * persistence evidence.
 *
 * Adapter contract (interface pin #8; the pack's EntityAdapterSchema):
 *   - `read(ctx, id)`  — GET-only fetch of one entity; never mutates.
 *   - `normalize(body)` — project the raw body onto
 *     `{ entityId, fields }` (fields carry the classified primaryKey).
 *   - `deletion: 'archive'` — the example app archives; rows stay
 *     retrievable (no hard delete).
 *   - `environmentFingerprint` — the target-environment marker the
 *     witness compares against a probe GET (GF-13): the example app
 *     must answer with this value in the `x-gateforge-env` response
 *     header for the adapter's reads to be accepted.
 *   - `resourceId` — registry identity; must match the file name.
 */

/** Registry identity of the example accounts resource. */
const RESOURCE_ID = 'example.accounts';

/**
 * The marker the witness expects on any probe/read response: the
 * example app serves `x-gateforge-env: example-loopback-v1` on every
 * route once wired for gateforge (see the pack README).
 */
const ENVIRONMENT_FINGERPRINT = 'example-loopback-v1';

/**
 * GET-only entity read against the example app's read API.
 *
 * Args:
 *   ctx: Witness-provided context (loopback base URL; optional headers).
 *   id: The entity id (`acc-1`, ...).
 *
 * Returns:
 *   Promise<unknown>: The raw account object
 *     `{ id, first_name, last_name, status, created_at, updated_at }`.
 *
 * Throws:
 *   Error: On a fingerprint mismatch (environment attestation) or a
 *     non-200/404 status. 404 surfaces as `null` — the entity is gone.
 */
async function read(ctx, id) {
  const response = await fetch(`${ctx.baseUrl}/api/accounts/${encodeURIComponent(id)}`, {
    headers: ctx.headers ?? {},
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`example accounts adapter: GET /api/accounts/${id} -> ${response.status}`);
  }
  const marker = response.headers.get('x-gateforge-env');
  if (marker !== ENVIRONMENT_FINGERPRINT) {
    throw new Error(
      `example accounts adapter: environment fingerprint mismatch ` +
        `(expected ${ENVIRONMENT_FINGERPRINT}, got ${JSON.stringify(marker)})`,
    );
  }
  return response.json();
}

/**
 * Projects the raw account body onto the evidence shape.
 *
 * Args:
 *   body: The raw account object from `read`.
 *
 * Returns:
 *   { entityId, fields }: The entity id plus the classified primary-key
 *     columns and status (archive evidence keys on the status change).
 */
function normalize(body) {
  return {
    entityId: String(body.id),
    fields: {
      id: body.id,
      status: body.status,
    },
  };
}

export default {
  resourceId: RESOURCE_ID,
  read,
  normalize,
  deletion: 'archive',
  environmentFingerprint: ENVIRONMENT_FINGERPRINT,
};