// Fault: first stdout line is valid JSON but not an object → E_FRAME_JSON.
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

process.stdout.write('42\n');
serve({ id: PLUGIN_ID, version: PLUGIN_VERSION });
