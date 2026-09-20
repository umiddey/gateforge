/**
 * Owner-reviewed GET-only observer for the reference accounts store.
 * The fixture app exposes this read API specifically for engine-side state
 * observation; it is not a suite callback and never mints evidence.
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
};
