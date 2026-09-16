// Fault: result payload carries a `classificationSignals` array whose
// element violates the frozen @gate-forge/core ClassificationSignal shape
// (missing location + unknown field) → E_SCHEMA naming the offending
// signal path. Proves malformed signal payloads fail closed with the
// existing schema diagnostics instead of riding into the graph.
import { PLUGIN_ID, PLUGIN_VERSION, makeEnvelope, scanFixture, scanSignals, send, serve } from './_lib.mjs';

serve({ id: PLUGIN_ID, version: PLUGIN_VERSION }, {
  onDiscover: ({ frame, nextSeq, plugin, root }) => {
    const requestId = frame.payload.requestId;
    let resources = [];
    let findings = [];
    for (const rel of frame.payload.paths) {
      const out = scanFixture(root, rel);
      resources = resources.concat(out.resources);
      findings = findings.concat(out.findings);
    }
    // Corrupt the first signal: drop its source location and smuggle an
    // undeclared `confidence` key (both are schema violations — a signal
    // is source-located and carries a basis, never a confidence score).
    const signals = scanSignals(resources).map((signal, index) => {
      if (index !== 0) return signal;
      const { location: _omitted, ...withoutLocation } = signal;
      return { ...withoutLocation, confidence: 0.99 };
    });
    send(
      makeEnvelope(plugin, 'result', nextSeq(), {
        requestId,
        resources,
        unresolved: [],
        findings,
        classificationSignals: signals,
      }),
    );
    return true;
  },
});
