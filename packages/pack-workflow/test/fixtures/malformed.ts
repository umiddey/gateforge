/**
 * Malformed FSM fixture for finding emission. A `createMachine` call
 * with NO `states` field — the detector must NOT emit a resource for
 * this and SHOULD emit an `UNKNOWN_FSM_STYLE` finding.
 */

/** Local stand-in (see xstate_contract.ts for the real shape). */
export function createMachine(config: unknown): unknown {
  return config;
}

export const broken = createMachine({
  id: 'broken',
  // no `states` property on purpose
  initial: 'unknown',
});

void broken;