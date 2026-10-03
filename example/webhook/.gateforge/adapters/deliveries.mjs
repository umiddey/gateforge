/**
 * Owner-reviewed GET-only observer for the receiver's delivery log.
 *
 * The receiver exposes `GET /delivery-log` specifically for engine-side
 * state observation; it is not a suite callback and never mints evidence.
 *
 * `snapshotScope` (the before/after scope a case is graded against)
 * deliberately does NOT use `ctx.get`: the witness refuses the candidate
 * GET transport there, so a scope can never be the app's own
 * unauthenticated answer. It performs its own engine-side fetch carrying
 * the operator-issued read credential (`ctx.headers`), which is the
 * documented adapter transport for state observation.
 */
const FINGERPRINT = 'example-webhook-v1';

export default {
  async read(ctx, id) {
    const response = await ctx.get(`/delivery-log/${encodeURIComponent(String(id))}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`delivery read failed: HTTP ${response.status}`);
    return response.json();
  },
  async list(ctx) {
    const response = await ctx.get('/delivery-log');
    if (response.status !== 200) throw new Error(`delivery list failed: HTTP ${response.status}`);
    return (await response.json()).deliveries;
  },
  normalize(body) {
    return {
      entityId: body.eventId,
      fields: { eventId: body.eventId, sideEffectCount: body.sideEffectCount },
    };
  },
  deletion: 'hard',
  environmentFingerprint: FINGERPRINT,
  async snapshotScope(ctx, input) {
    const response = await fetch(`${ctx.baseUrl}/delivery-log`, {
      headers: { accept: 'application/json', ...(ctx.headers ?? {}) },
    });
    if (response.status !== 200) throw new Error(`delivery scope read failed: HTTP ${response.status}`);
    const rows = (await response.json()).deliveries;
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: `d${String(rows.length)}`,
      entities: rows
        .map((row) => ({ entityId: row.eventId, fields: { ...row } }))
        .sort((a, b) => (String(a.entityId) < String(b.entityId) ? -1 : 1)),
      exhausted: true,
    };
  },
};
