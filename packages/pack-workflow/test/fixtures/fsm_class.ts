/**
 * Fixture for the hand-rolled FSM class detector arm.
 *
 *   placed -> paid -> shipped -> fulfilled
 */
export class OrderStateMachine {
  readonly initial = 'placed';
  readonly transitions = {
    placed: {
      on: {
        pay: 'paid',
      },
    },
    paid: {
      on: {
        ship: 'shipped',
      },
    },
    shipped: {
      on: {
        fulfill: 'fulfilled',
      },
    },
    fulfilled: {
      on: {},
    },
  };
}

// Audit sink reference (used to flag `auditEvent: true`).
const audit = 'audit.json';
void audit;