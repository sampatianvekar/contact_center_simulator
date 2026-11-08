'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createEngine, ivrPress } = require('../engine');

function newEngine() {
  let t = 1000000;
  const clock = () => (t += 1000); // every reading is one second later
  return createEngine({ clock });
}

const caller = (n, department) => ({ name: 'Caller' + n, phone: '9876543210', department });

function agentByName(engine, name) {
  return engine.snapshot().agents.find((a) => a.name === name);
}

test('IVR routes keys 1, 2 and 3 to the right department', () => {
  assert.strictEqual(ivrPress('1', 0).department, 'billing');
  assert.strictEqual(ivrPress('2', 0).department, 'support');
  assert.strictEqual(ivrPress('3', 0).department, 'general');
});

test('IVR asks again after a wrong key and counts tries', () => {
  const first = ivrPress('5', 0);
  assert.strictEqual(first.action, 'retry');
  assert.strictEqual(first.wrongCount, 1);
  assert.strictEqual(first.triesLeft, 2);
});

test('IVR sends the caller to general after three wrong keys', () => {
  const third = ivrPress('9', 2);
  assert.strictEqual(third.action, 'route');
  assert.strictEqual(third.department, 'general');
  assert.strictEqual(third.fallback, true);
});

test('IVR treats odd input as a wrong key, not a valid one', () => {
  assert.strictEqual(ivrPress('__proto__', 0).action, 'retry');
  assert.strictEqual(ivrPress('', 0).action, 'retry');
});

test('a new call goes straight to an available agent', () => {
  const engine = newEngine();
  const call = engine.createCall(caller(1, 'billing'));
  assert.strictEqual(call.status, 'Active');
  assert.strictEqual(call.agentName, 'Meera');
  assert.strictEqual(agentByName(engine, 'Meera').status, 'On call');
});

test('the agent who has been free the longest gets the call', () => {
  const engine = newEngine();
  const first = engine.createCall(caller(1, 'billing'));
  assert.strictEqual(first.agentName, 'Meera');
  const second = engine.createCall(caller(2, 'billing'));
  assert.strictEqual(second.agentName, 'Raj');
});

test('an agent who just finished a call goes to the back of the idle line', () => {
  const engine = newEngine();
  const first = engine.createCall(caller(1, 'billing')); // Meera
  engine.endCall(first.id); // Meera is free again, but Raj has waited longer
  const second = engine.createCall(caller(2, 'billing'));
  assert.strictEqual(second.agentName, 'Raj');
});

test('two calls arriving together never share one agent', () => {
  const engine = newEngine();
  engine.setAgentStatus(2, 'Offline'); // only Meera can take billing calls
  const a = engine.createCall(caller(1, 'billing'));
  const b = engine.createCall(caller(2, 'billing'));
  assert.strictEqual(a.status, 'Active');
  assert.strictEqual(b.status, 'Waiting');
  assert.strictEqual(b.queuePosition, 1);
});

test('waiting calls are served in first in, first out order', () => {
  const engine = newEngine();
  engine.setAgentStatus(1, 'Busy');
  engine.setAgentStatus(2, 'Busy');
  const a = engine.createCall(caller(1, 'billing'));
  const b = engine.createCall(caller(2, 'billing'));
  const c = engine.createCall(caller(3, 'billing'));
  assert.strictEqual(engine.getCall(c.id).queuePosition, 3);
  engine.setAgentStatus(1, 'Available');
  assert.strictEqual(engine.getCall(a.id).status, 'Active');
  engine.setAgentStatus(2, 'Available');
  assert.strictEqual(engine.getCall(b.id).status, 'Active');
  assert.strictEqual(engine.getCall(c.id).status, 'Waiting');
  assert.strictEqual(engine.getCall(c.id).queuePosition, 1);
});

test('ending a call frees the agent and picks up the next waiting call', () => {
  const engine = newEngine();
  engine.setAgentStatus(2, 'Offline');
  const a = engine.createCall(caller(1, 'billing'));
  const b = engine.createCall(caller(2, 'billing'));
  engine.endCall(a.id);
  assert.strictEqual(engine.getCall(a.id).status, 'Completed');
  assert.strictEqual(engine.getCall(b.id).status, 'Active');
  assert.strictEqual(engine.getCall(b.id).agentName, 'Meera');
});

test('Busy and Offline agents do not receive calls', () => {
  const engine = newEngine();
  engine.setAgentStatus(5, 'Busy');
  engine.setAgentStatus(6, 'Offline');
  const call = engine.createCall(caller(1, 'general'));
  assert.strictEqual(call.status, 'Waiting');
});

test('an agent on a call cannot change status by hand', () => {
  const engine = newEngine();
  engine.createCall(caller(1, 'billing'));
  assert.throws(() => engine.setAgentStatus(1, 'Offline'), { status: 409 });
});

test('setting the same status again does not reset the idle timer', () => {
  const engine = newEngine();
  const before = agentByName(engine, 'Raj').availableSince;
  engine.setAgentStatus(2, 'Available');
  assert.strictEqual(agentByName(engine, 'Raj').availableSince, before);
});

test('a customer can hang up while waiting, and is never assigned later', () => {
  const engine = newEngine();
  engine.setAgentStatus(5, 'Busy');
  engine.setAgentStatus(6, 'Busy');
  const call = engine.createCall(caller(1, 'general'));
  engine.abandonCall(call.id);
  engine.setAgentStatus(5, 'Available');
  assert.strictEqual(engine.getCall(call.id).status, 'Abandoned');
  assert.strictEqual(agentByName(engine, 'Kiran').status, 'Available');
});

test('an active call cannot be abandoned, and a waiting call cannot be ended', () => {
  const engine = newEngine();
  const active = engine.createCall(caller(1, 'billing'));
  assert.throws(() => engine.abandonCall(active.id), { status: 409 });
  engine.setAgentStatus(5, 'Busy');
  engine.setAgentStatus(6, 'Busy');
  const waiting = engine.createCall(caller(2, 'general'));
  assert.throws(() => engine.endCall(waiting.id), { status: 409 });
});

test('bad input is rejected', () => {
  const engine = newEngine();
  assert.throws(() => engine.createCall({ name: '', phone: '9876543210', department: 'billing' }), { status: 400 });
  assert.throws(() => engine.createCall({ name: 'Asha', phone: '12345', department: 'billing' }), { status: 400 });
  assert.throws(() => engine.createCall({ name: 'Asha', phone: '9876543210', department: 'sales' }), { status: 400 });
  assert.throws(() => engine.setAgentStatus(1, 'On call'), { status: 400 });
});
