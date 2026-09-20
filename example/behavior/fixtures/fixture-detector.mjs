/**
 * Emits the business resource declaration for the reference app.
 * Route discovery remains delegated to the bundled HTTP detector; this small
 * fixture detector only supplies the explicit resource/identity/adapter facts
 * that a generic JavaScript detector cannot infer safely.
 */
export default {
  async discover() {
    const source = 'server.js';
    const location = { file: source, line: 1, col: 0 };
    const detector = { id: 'gateforge.behavior-fixture', version: '1.0.0' };
    const resource = {
      schemaVersion: 1,
      id: 'accounts',
      kind: 'fixture.entity',
      source,
      location,
      detectorVersion: detector.version,
      attributes: {
        resourceName: 'accounts',
        updateableFields: ['first_name', 'last_name', 'status'],
      },
    };
    const dimensions = [
      ['plane', 'tenant'],
      ['identity', ['id']],
      ['adapter-binding', 'tenant.accounts'],
      ['lifecycle.create', true],
      ['lifecycle.read', true],
      ['lifecycle.update', true],
      ['lifecycle.delete', true],
      ['delete-semantics', 'archive'],
      ['archive-state', { status: 'archived' }],
    ];
    const classificationSignals = dimensions.map(([dimension, assertion]) => ({
      schemaVersion: 1,
      target: { resourceName: 'accounts' },
      dimension,
      assertion,
      basis: 'declaration',
      source: 'gateforge.behavior-fixture',
      location,
      detector,
    }));
    return { resources: [resource], unresolved: [], findings: [], classificationSignals };
  },
};
