/**
 * Owner-reviewed GET-only observer for the reference accounts store.
 * The fixture app exposes this read API specifically for engine-side state
 * observation; it is not a suite callback and never mints evidence.
 *
 * `snapshotScope` (the before/after scope a case is graded against)
 * deliberately does NOT use `ctx.get`: the witness refuses the candidate
 * GET transport there, so a scope can never be the app's own unauthenticated
 * answer. It performs its own engine-side fetch carrying the operator-issued
 * read credential (`ctx.headers`), which is the documented adapter
 * transport for state observation.
 */
export default {
  async read(ctx, id) {
    const response = await ctx.get(`/api/accounts/${encodeURIComponent(String(id))}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new Error(`accounts read failed: HTTP ${response.status}`);
    return response.json();
  },
  async list(ctx) {
    const response = await ctx.get('/api/accounts');
    if (response.status !== 200) throw new Error(`accounts list failed: HTTP ${response.status}`);
    const body = await response.json();
    return body.accounts;
  },
  normalize(body) {
    return {
      entityId: body.id,
      fields: {
        first_name: body.first_name,
        last_name: body.last_name,
        status: body.status,
      },
    };
  },
  deletion: 'archive',
  environmentFingerprint: 'behavior-loopback-v1',
  async snapshotScope(ctx, input) {
    const response = await fetch(`${ctx.baseUrl}/api/accounts`, {
      headers: { accept: 'application/json', ...(ctx.headers ?? {}) },
    });
    if (response.status !== 200) throw new Error(`accounts scope read failed: HTTP ${response.status}`);
    const rows = (await response.json()).accounts;
    return {
      scope: input.scope,
      fixtureNamespace: input.fixtureNamespace,
      complete: true,
      checkpoint: `a${rows.length}`,
      entities: rows
        .map((row) => ({ entityId: row.id, fields: { ...row } }))
        .sort((a, b) => (String(a.entityId) < String(b.entityId) ? -1 : 1)),
      exhausted: true,
    };
  },
};
