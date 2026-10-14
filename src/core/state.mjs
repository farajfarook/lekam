// Request state machine. Pure, exhaustive, and the only authority on what may follow what.
export const STATES = Object.freeze([
  'NEW', 'PENDING_APPROVAL', 'APPROVED', 'INVESTIGATING', 'RUNNING', 'DONE', 'FAILED',
  'RELEASED', 'DISCARDED', 'DENIED', 'EXPIRED', 'DROPPED', 'IGNORED',
]);

export const TRANSITIONS = Object.freeze({
  NEW: ['PENDING_APPROVAL', 'IGNORED'],
  PENDING_APPROVAL: ['APPROVED', 'INVESTIGATING', 'DENIED', 'EXPIRED'],
  APPROVED: ['RUNNING'],
  INVESTIGATING: ['RUNNING', 'DROPPED'],
  RUNNING: ['DONE', 'FAILED'],
  DONE: ['RELEASED', 'DISCARDED'],
  FAILED: [], RELEASED: [], DISCARDED: [], DENIED: [], EXPIRED: [], DROPPED: [], IGNORED: [],
});

export const TERMINAL = Object.freeze(new Set(Object.entries(TRANSITIONS).filter(([, v]) => v.length === 0).map(([k]) => k)));
/** States in which a thread counts as "engaged": follow-ups are listened to. */
export const ENGAGED = Object.freeze(new Set(['PENDING_APPROVAL', 'APPROVED', 'INVESTIGATING', 'RUNNING', 'DONE']));

export class IllegalTransition extends Error {
  constructor(from, to) { super(`illegal transition ${from} -> ${to}`); this.from = from; this.to = to; }
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function transition(from, to) {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  return to;
}

export const isTerminal = (s) => TERMINAL.has(s);
export const isEngaged = (s) => ENGAGED.has(s);
