/**
 * Fixture for the XState v5 detector arm.
 *
 * Mirrors the production-style XState contract:
 *
 *   draft  --submit-->  pending  --sign-->  signed  --terminate-->  terminated
 *
 * The fixture does NOT import xstate — it uses lightweight local stubs
 * (`createMachine` and `setup().createMachine`) so the detector can
 * recognise the call patterns without dragging a real xstate dep into
 * the workspace. The detector matches on the function-call shape, not
 * the actual library behaviour.
 */

type StateConfig = {
  on?: Record<string, { target: string }>;
  type?: 'final' | 'atomic' | string;
};

/** Local stand-in for `import { createMachine } from 'xstate'`. */
export function createMachine(config: { states: Record<string, StateConfig> }): { id: string; config: typeof config } {
  return { id: 'machine', config };
}

/** Local stand-in for `import { setup } from 'xstate'`. */
export function setup<T>(_options: T): { createMachine: typeof createMachine } {
  return { createMachine };
}

export const contractMachine = createMachine({
  states: {
    draft: {
      on: { submit: { target: 'pending' } },
    },
    pending: {
      on: { sign: { target: 'signed' } },
    },
    signed: {
      on: { terminate: { target: 'terminated' } },
    },
    terminated: {
      type: 'final',
    },
  },
});

/** setup({}).createMachine variant to exercise the second detector arm. */
export const orderMachine = setup({}).createMachine({
  states: {
    placed: { on: { pay: { target: 'paid' } } },
    paid: { on: { ship: { target: 'shipped' } } },
    shipped: { on: { fulfill: { target: 'fulfilled' } } },
    fulfilled: { type: 'final' },
  },
});

// Audit sink mention keeps `auditEvent: true` even on this fixture.
const audit = 'audit.json';
void audit;