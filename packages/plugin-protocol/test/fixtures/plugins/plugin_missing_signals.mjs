// Fault: result payload omits the GPP/3-mandatory `classificationSignals`
// field → E_SCHEMA naming the offending path (no silent optional-field
// compatibility with the GPP/2 result shape).
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, scanFixture, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin, root }) => {
    // Reuse the shared scanner but strip the signals from the payload.
    const requestId = frame.payload.requestId;
    let resources = [];
    let findings = [];
    for (const rel of frame.payload.paths) {
      const out = scanFixture(root, rel);
      resources = resources.concat(out.resources);
      findings = findings.concat(out.findings);
    }
    send(
      makeEnvelope(plugin, 'result', nextSeq(), {
        requestId,
        resources,
        unresolved: [],
        findings,
      }),
    );
    return true;
  },
});
