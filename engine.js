'use strict';

// Core contact center logic. No web code in here, so it is easy to test.
// All state lives in memory. Every function that changes state runs from
// start to finish before Node handles the next request, so two calls that
// arrive close together can never be given the same agent.

const IVR_OPTIONS = new Map([
  ['1', 'billing'],
  ['2', 'support'],
  ['3', 'general'],
]);
const DEPARTMENTS = ['billing', 'support', 'general'];
const AGENT_STATUSES = ['Available', 'Busy', 'Offline']; // On call is set by the system only
const MAX_WRONG_KEYS = 3;
const MAX_STORED_CALLS = 200;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// One key press in the IVR menu. The caller's wrong key count travels with the request.
function ivrPress(key, wrongCount) {
  const count = Number.isInteger(wrongCount) && wrongCount >= 0 ? wrongCount : 0;
  const department = IVR_OPTIONS.get(String(key));
  if (department) {
    return { action: 'route', department, wrongCount: count };
  }
  const wrong = count + 1;
  if (wrong >= MAX_WRONG_KEYS) {
    return { action: 'route', department: 'general', fallback: true, wrongCount: wrong };
  }
  return { action: 'retry', wrongCount: wrong, triesLeft: MAX_WRONG_KEYS - wrong };
}

function defaultAgents(start) {
  const people = [
    ['Meera', 'billing'],
    ['Raj', 'billing'],
    ['Anita', 'support'],
    ['Sunil', 'support'],
    ['Kiran', 'general'],
    ['Divya', 'general'],
  ];
  return people.map(([name, department], i) => ({
    id: i + 1,
    name,
    department,
    status: 'Available',
    availableSince: start + i, // Meera has been free the longest
    currentCallId: null,
  }));
}

function createEngine(options = {}) {
  const clock = options.clock || Date.now;
  const agents = options.agents || defaultAgents(clock());
  const calls = [];
  let nextCallId = 1;
  const log = options.logger || (() => {});
  // Counters only go up, so metrics stay correct even after trimHistory() removes old calls.
  const counters = { created: 0, assigned: 0, completed: 0, abandoned: 0, totalWaitSeconds: 0 };

  function findAgent(id) {
    const agent = agents.find((a) => a.id === Number(id));
    if (!agent) throw fail(404, 'Agent not found');
    return agent;
  }

  function findCall(id) {
    const call = calls.find((c) => c.id === Number(id));
    if (!call) throw fail(404, 'Call not found');
    return call;
  }

  // The oldest waiting call in a department (calls are stored in arrival order, so this is FIFO).
  function oldestWaiting(department) {
    return calls.find((c) => c.department === department && c.status === 'Waiting');
  }

  // Among Available agents of the department, the one who has been free the longest.
  function longestIdleAgent(department) {
    let best = null;
    for (const agent of agents) {
      if (agent.department !== department || agent.status !== 'Available') continue;
      if (best === null || agent.availableSince < best.availableSince) best = agent;
    }
    return best;
  }

  // Match waiting calls with eligible agents until one side runs out.
  function dispatch(department) {
    for (;;) {
      const call = oldestWaiting(department);
      if (!call) return;
      const agent = longestIdleAgent(department);
      if (!agent) return;
      const now = clock();
      call.status = 'Active';
      call.agentId = agent.id;
      call.assignedAt = now;
      call.waitedSeconds = Math.round((now - call.createdAt) / 1000);
      agent.status = 'On call';
      agent.currentCallId = call.id;
      counters.assigned++;
      counters.totalWaitSeconds += call.waitedSeconds;
      log('call_assigned', { callId: call.id, department, agent: agent.name, waitedSeconds: call.waitedSeconds });
    }
  }

  function trimHistory() {
    while (calls.length > MAX_STORED_CALLS) {
      const index = calls.findIndex((c) => c.status === 'Completed' || c.status === 'Abandoned');
      if (index === -1) return;
      calls.splice(index, 1);
    }
  }

  function describeCall(call) {
    const result = { ...call, queuePosition: null, agentName: null };
    if (call.status === 'Waiting') {
      const ahead = calls.filter(
        (c) => c.department === call.department && c.status === 'Waiting' && c.id <= call.id
      );
      result.queuePosition = ahead.length;
    }
    if (call.agentId !== null) result.agentName = findAgent(call.agentId).name;
    return result;
  }

  function createCall({ name, phone, department }) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanPhone = typeof phone === 'string' ? phone.replace(/\s+/g, '') : '';
    if (cleanName.length < 1 || cleanName.length > 40) {
      throw fail(400, 'Enter a name of up to 40 characters');
    }
    if (!/^\d{10}$/.test(cleanPhone)) {
      throw fail(400, 'Enter a fake 10 digit phone number');
    }
    if (!DEPARTMENTS.includes(department)) {
      throw fail(400, 'Unknown department');
    }
    const call = {
      id: nextCallId++,
      name: cleanName,
      phone: cleanPhone,
      department,
      status: 'Waiting',
      agentId: null,
      createdAt: clock(),
      assignedAt: null,
      completedAt: null,
      waitedSeconds: null,
    };
    calls.push(call);
    counters.created++;
    log('call_created', { callId: call.id, department });
    dispatch(department);
    trimHistory();
    return describeCall(call);
  }

  function setAgentStatus(agentId, status) {
    const agent = findAgent(agentId);
    if (!AGENT_STATUSES.includes(status)) throw fail(400, 'Status must be Available, Busy or Offline');
    if (agent.status === 'On call') throw fail(409, 'Finish the current call first');
    if (agent.status === status) return agent; // no change, so the idle timer is not reset
    const from = agent.status;
    agent.status = status;
    log('agent_status', { agent: agent.name, from, to: status });
    if (status === 'Available') {
      agent.availableSince = clock();
      dispatch(agent.department);
    }
    return agent;
  }

  function endCall(callId) {
    const call = findCall(callId);
    if (call.status !== 'Active') throw fail(409, 'Only an active call can be ended');
    const agent = findAgent(call.agentId);
    call.status = 'Completed';
    call.completedAt = clock();
    counters.completed++;
    log('call_completed', { callId: call.id, agent: agent.name, talkSeconds: Math.round((call.completedAt - call.assignedAt) / 1000) });
    agent.status = 'Available';
    agent.currentCallId = null;
    agent.availableSince = clock();
    dispatch(agent.department);
    return describeCall(call);
  }

  function abandonCall(callId) {
    const call = findCall(callId);
    if (call.status !== 'Waiting') throw fail(409, 'Only a waiting call can be abandoned');
    call.status = 'Abandoned';
    call.completedAt = clock();
    counters.abandoned++;
    log('call_abandoned', { callId: call.id, department: call.department, waitedSeconds: Math.round((call.completedAt - call.createdAt) / 1000) });
    return describeCall(call);
  }

  function getCall(callId) {
    return describeCall(findCall(callId));
  }

  function snapshot() {
    const callList = calls.map(describeCall);
    const queues = {};
    for (const department of DEPARTMENTS) {
      queues[department] = {
        waiting: calls.filter((c) => c.department === department && c.status === 'Waiting').length,
        availableAgents: agents.filter((a) => a.department === department && a.status === 'Available').length,
      };
    }
    return {
      now: clock(),
      agents: agents.map((a) => ({ ...a })),
      calls: callList,
      queues,
    };
  }

  function metrics() {
    const now = clock();
    const departments = {};
    for (const department of DEPARTMENTS) {
      const waiting = calls.filter((c) => c.department === department && c.status === 'Waiting');
      departments[department] = {
        waiting: waiting.length,
        availableAgents: agents.filter((a) => a.department === department && a.status === 'Available').length,
        oldestWaitSeconds: waiting.length ? Math.round((now - waiting[0].createdAt) / 1000) : 0,
      };
    }
    const answeredOrLost = counters.assigned + counters.abandoned;
    return {
      now,
      totals: { ...counters },
      averageWaitSeconds: counters.assigned ? Math.round(counters.totalWaitSeconds / counters.assigned) : 0,
      abandonmentRate: answeredOrLost ? Number((counters.abandoned / answeredOrLost).toFixed(3)) : 0,
      departments,
    };
  }

  return { createCall, setAgentStatus, endCall, abandonCall, getCall, snapshot, metrics };
}

module.exports = { createEngine, ivrPress, DEPARTMENTS, MAX_WRONG_KEYS };