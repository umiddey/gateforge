// Fault: answers discover with an unknown message type (digest intact) → E_UNKNOWN_TYPE.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    send(
      makeEnvelope(plugin, 'result', nextSeq(), {
        requestId: frame.payload.requestId,
        resources: [],
        unresolved: [],
        findings: [],
      }, { type: 'resulkt' }),
    );
    return true;
  },
});
