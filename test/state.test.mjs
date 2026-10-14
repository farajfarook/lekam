import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATES, TRANSITIONS, transition, canTransition, isTerminal, isEngaged, IllegalTransition } from '../src/core/state.mjs';

test('every state is in the transition table and every target is a state', () => {
  for (const s of STATES) assert.ok(s in TRANSITIONS, s);
  for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) assert.ok(STATES.includes(to), `${from}->${to}`);
});
test('allowed edges', () => {
  const edges = [['NEW','PENDING_APPROVAL'],['NEW','IGNORED'],['PENDING_APPROVAL','APPROVED'],['PENDING_APPROVAL','INVESTIGATING'],['PENDING_APPROVAL','DENIED'],['PENDING_APPROVAL','EXPIRED'],['APPROVED','RUNNING'],['INVESTIGATING','RUNNING'],['INVESTIGATING','DROPPED'],['RUNNING','DONE'],['RUNNING','FAILED'],['DONE','RELEASED'],['DONE','DISCARDED']];
  for (const [a,b] of edges) assert.equal(transition(a,b), b);
  assert.equal(edges.length, Object.values(TRANSITIONS).flat().length, 'no undeclared edges');
});
test('illegal edges throw', () => {
  for (const [a,b] of [['DONE','RUNNING'],['NEW','RUNNING'],['DENIED','APPROVED'],['RUNNING','APPROVED'],['EXPIRED','PENDING_APPROVAL']]) assert.throws(() => transition(a,b), IllegalTransition);
  assert.equal(canTransition('NEW','DONE'), false);
});
test('terminal and engaged sets', () => {
  for (const s of ['FAILED','RELEASED','DISCARDED','DENIED','EXPIRED','DROPPED','IGNORED']) assert.ok(isTerminal(s), s);
  for (const s of ['PENDING_APPROVAL','APPROVED','INVESTIGATING','RUNNING','DONE']) assert.ok(isEngaged(s), s);
  assert.ok(!isEngaged('DENIED'));
});
