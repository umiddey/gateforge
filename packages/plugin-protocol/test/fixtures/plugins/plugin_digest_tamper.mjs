// Fault: result digest computed over the wrong payload (GF-18 tamper) → E_SCHEMA.
import { PLUGIN_ID, PLUGIN_VERSION, digestOf, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    const s = nextSeq();
    const payload = {
      requestId: frame.payload.requestId,
      resources: [],
      unresolved: [],
      findings: [],
    };
    send(makeEnvelope(plugin, 'result', s, payload, { digest: digestOf('result', s, {}) }));
    return true;
  },
});
