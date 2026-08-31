// Fault: hello declares an unknown pluginVersion (GF-18) → E_UNKNOWN_PLUGIN.
import { PLUGIN_ID, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: '9.9.9' });
