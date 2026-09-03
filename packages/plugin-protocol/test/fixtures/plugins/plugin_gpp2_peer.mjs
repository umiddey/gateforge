// Fault: a GPP/2 holdout — the handshake itself declares protocolVersion 2
// (with a correct digest), but the host speaks 3. Must fail closed at the
// handshake (E_PROTOCOL_VERSION) BEFORE any discovery can happen.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  helloOverrides: { protocolVersion: 2 },
});
