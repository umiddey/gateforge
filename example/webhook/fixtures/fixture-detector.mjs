/**
 * The example receiver's discovery facts.
 *
 * The receiver is a plain `node:http` server, so no bundled framework
 * detector can see its route: this module states the two facts the engine
 * needs — the webhook endpoint and the delivery-log entity it writes — and
 * the classification signals that say which plane they live in and how
 * the entity is identified. A real application gets these from its
 * framework pack; the receiver gets them from here.
 */
const SOURCE = 'server.js';
const LOCATION = { file: SOURCE, line: 1, col: 0 };
const DETECTOR = { id: 'gateforge.webhook-fixture', version: '1.0.0' };
const ENDPOINT = 'global.http-post-webhook-stripe-1fd2bace';
const DELIVERIES = 'global.deliveries';

/**
 * One classification signal, in the engine's wire shape.
 *
 * @param {string} resourceName detector identity the signal is about
 * @param {string} dimension classification dimension
 * @param {unknown} assertion the dimension's value
 * @returns {object} the signal
 */
function signal(resourceName, dimension, assertion) {
  return {
    schemaVersion: 1,
    target: { resourceName },
    dimension,
    assertion,
    basis: 'declaration',
    source: 'gateforge.webhook-fixture',
    location: LOCATION,
    detector: DETECTOR,
  };
}

export default {
  async discover() {
    return {
      resources: [
        {
          schemaVersion: 1,
          id: ENDPOINT,
          kind: 'http.endpoint',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: {
            resourceName: 'http-post-webhook-stripe-1fd2bace',
            method: 'POST',
            canonicalPath: '/webhook/stripe',
            identity: 'POST /webhook/stripe',
          },
        },
        {
          schemaVersion: 1,
          id: 'deliveries',
          kind: 'fixture.entity',
          source: SOURCE,
          location: LOCATION,
          detectorVersion: DETECTOR.version,
          attributes: { resourceName: 'deliveries', updateableFields: ['eventId', 'sideEffectCount'] },
        },
      ],
      unresolved: [],
      findings: [],
      classificationSignals: [
        signal('http-post-webhook-stripe-1fd2bace', 'plane', 'global'),
        signal('http-post-webhook-stripe-1fd2bace', 'identity', ['method', 'path']),
        signal('deliveries', 'plane', 'global'),
        signal('deliveries', 'identity', ['eventId']),
        signal('deliveries', 'adapter-binding', DELIVERIES),
        signal('deliveries', 'lifecycle.create', true),
        signal('deliveries', 'lifecycle.read', true),
        signal('deliveries', 'lifecycle.update', true),
        signal('deliveries', 'lifecycle.delete', true),
        signal('deliveries', 'delete-semantics', 'hard'),
      ],
    };
  },
};
