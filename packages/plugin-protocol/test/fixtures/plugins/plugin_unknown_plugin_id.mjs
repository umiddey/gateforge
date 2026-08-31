// Fault: hello declares an unknown pluginId (GF-18) → E_UNKNOWN_PLUGIN.
import { PLUGIN_VERSION, serve } from './_lib.mjs';

serve({ id: 'impostor-detector', version: PLUGIN_VERSION });
