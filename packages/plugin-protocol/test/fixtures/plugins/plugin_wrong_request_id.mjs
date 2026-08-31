// Fault: result echoes a requestId that does not match the request → E_SCHEMA.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    send(
      makeEnvelope(plugin, 'result', nextSeq(), {
        requestId: 'req-999',
        resources: [],
        unresolved: [],
        findings: [],
      }),
    );
    return true;
  },
});
