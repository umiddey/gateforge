// Fault: result payload is missing the required `resources` field → E_SCHEMA.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    send(
      makeEnvelope(plugin, 'result', nextSeq(), {
        requestId: frame.payload.requestId,
        unresolved: [],
        findings: [],
      }),
    );
    return true;
  },
});
