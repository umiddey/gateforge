// Fault: hello declares protocolVersion 1 (host speaks 2) → E_PROTOCOL_VERSION.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  helloOverrides: { protocolVersion: 1 },
});
