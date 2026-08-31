// Fault: exits nonzero right after a clean bye → E_EXIT_STATUS.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onShutdown: () => process.exit(7),
});
