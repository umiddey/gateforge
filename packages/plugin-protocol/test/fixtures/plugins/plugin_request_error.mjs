// Fault: answers discover with a request-scoped error frame → E_PLUGIN_ERROR.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin }) => {
    send(
      makeEnvelope(plugin, 'error', nextSeq(), {
        requestId: frame.payload.requestId,
        code: 'E_NO_ROUTES',
        message: 'no route tables found',
      }),
    );
    return true;
  },
});
