// Fault: receives discover but never answers → E_TIMEOUT (watchdog kills it).
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: () => {
    setTimeout(() => {}, 60_000); // keep the process alive, never respond
    return true;
  },
});
