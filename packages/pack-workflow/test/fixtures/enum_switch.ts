/**
 * Fixture for the enum + switch transition-guard detector arm.
 *
 * Status enum:
 *
 *   open  --close-->  closed
 */
export enum TicketStatus {
  Open = 'open',
  InProgress = 'in_progress',
  Resolved = 'resolved',
  Closed = 'closed',
}

/**
 * Transition guard: returns the next status, or `null` for invalid
 * jumps. The switch covers the enum's allowed jumps.
 */
export function nextStatus(current: TicketStatus, event: string): TicketStatus | null {
  switch (current) {
    case TicketStatus.Open:
      if (event === 'start') return TicketStatus.InProgress;
      return null;
    case TicketStatus.InProgress:
      if (event === 'resolve') return TicketStatus.Resolved;
      return null;
    case TicketStatus.Resolved:
      if (event === 'close') return TicketStatus.Closed;
      return null;
    case TicketStatus.Closed:
      return null; // terminal
  }
}

// Audit sink mention keeps `auditEvent: true` on this fixture.
const audit = 'audit.json';
void audit;