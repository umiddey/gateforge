// Fault: first stdout line is not JSON at all → E_FRAME_JSON.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

process.stdout.write('this is not json\n');
serve({ id: PLUGIN_ID, version: PLUGIN_VERSION });
