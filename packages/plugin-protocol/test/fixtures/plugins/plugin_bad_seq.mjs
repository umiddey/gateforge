// Fault: result arrives with a jumped seq number → E_SCHEMA.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    send(
      makeEnvelope(plugin, 'result', 99, {
        requestId: frame.payload.requestId,
        resources: [],
        unresolved: [],
        findings: [],
      }, { seq: 99 }),
    );
    return true;
  },
});
