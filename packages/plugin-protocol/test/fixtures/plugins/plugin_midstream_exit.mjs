// Fault: answers the first discover, then exits mid-stream before the second → E_EOF.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

let discoveries = 0;
serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: () => {
    discoveries += 1;
    if (discoveries >= 2) process.exit(3);
    return false; // first discover is answered normally by serve()
  },
});
