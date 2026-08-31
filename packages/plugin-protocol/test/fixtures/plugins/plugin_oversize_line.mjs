// Fault: one stdout line longer than the 8 MiB cap → E_FRAME_JSON.
import { writeSync } from 'node:fs';
import { PLUGIN_ID, PLUGIN_VERSION, serve } from './_lib.mjs';

writeSync(1, 'a'.repeat(8 * 1024 * 1024 + 1) + '\n');
serve({ id: PLUGIN_ID, version: PLUGIN_VERSION });
