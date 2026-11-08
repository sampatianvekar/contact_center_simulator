(function () {
  const LABELS = { billing: 'Billing', support: 'Technical Support', general: 'General Enquiries' };
  const $ = (id) => document.getElementById(id);

  let state = null;
  let selectedAgentId = null;

  async function api(path, options) {
    const res = await fetch(path, options);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  // Small DOM helpers. Text is always set with textContent, never as HTML.
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function badge(status) {
    return el('span', status, 'badge ' + status.replace(/\s+/g, ''));
  }

  function time(ms) {
    return ms ? new Date(ms).toLocaleTimeString() : 'n/a';
  }

  function table(headers, rows) {
    if (rows.length === 0) return el('p', 'Nothing here yet.', 'note');
    const t = el('table');
    const head = el('tr');
    headers.forEach((h) => head.appendChild(el('th', h)));
    t.appendChild(head);
    rows.forEach((cells) => {
      const tr = el('tr');
      cells.forEach((cell) => {
        const td = el('td');
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell === null || cell === undefined ? 'n/a' : cell;
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    return t;
  }

  async function refresh() {
    try {
      state = await api('/api/state');
      render();
    } catch (err) {
      $('actionError').textContent = err.message;
    }
  }

  async function run(action) {
    $('actionError').textContent = '';
    try {
      await action();
    } catch (err) {
      $('actionError').textContent = err.message;
    }
    refresh();
  }

  function render() {
    const select = $('agentSelect');
    if (select.options.length === 0) {
      state.agents.forEach((a) => {
        const option = el('option', a.name + ' (' + LABELS[a.department] + ')');
        option.value = a.id;
        select.appendChild(option);
      });
      selectedAgentId = state.agents[0].id;
    }
    select.value = String(selectedAgentId);

    const me = state.agents.find((a) => a.id === Number(selectedAgentId));

    // My status
    const statusSpan = $('myStatus');
    statusSpan.textContent = me.status;
    statusSpan.className = 'badge ' + me.status.replace(/\s+/g, '');

    const buttons = $('statusButtons');
    buttons.replaceChildren();
    ['Available', 'Busy', 'Offline'].forEach((status) => {
      const b = el('button', status, 'secondary' + (me.status === status ? ' chosen' : ''));
      b.disabled = me.status === 'On call';
      b.addEventListener('click', () => run(() => post('/api/agents/' + me.id + '/status', { status })));
      buttons.appendChild(b);
    });

    // My current call
    const callBox = $('myCall');
    callBox.replaceChildren();
    const current = state.calls.find((c) => c.id === me.currentCallId);
    if (current) {
      callBox.appendChild(el('p', 'On a call with ' + current.name + ' (' + current.phone + ')', 'big'));
      callBox.appendChild(el('p', 'Queue: ' + LABELS[current.department] + '. Customer waited ' + current.waitedSeconds + ' seconds.', 'note'));
      const end = el('button', 'End call', 'danger');
      end.addEventListener('click', () => run(() => post('/api/calls/' + current.id + '/end')));
      callBox.appendChild(end);
    } else {
      callBox.appendChild(el('p', 'No active call. Set yourself to Available to receive calls.', 'note'));
    }

    // Waiting in my queue
    const waiting = state.calls
      .filter((c) => c.status === 'Waiting' && c.department === me.department)
      .map((c) => [c.queuePosition, c.name, c.phone, Math.round((state.now - c.createdAt) / 1000) + ' s']);
    $('myQueue').replaceChildren(table(['Position', 'Customer', 'Phone', 'Waiting'], waiting));

    // Queue summary
    const stats = $('queueStats');
    stats.replaceChildren();
    Object.keys(state.queues).forEach((department) => {
      const q = state.queues[department];
      const box = el('div', null, 'stat');
      box.appendChild(el('span', LABELS[department]));
      box.appendChild(el('strong', q.waiting + ' waiting'));
      box.appendChild(el('span', q.availableAgents + (q.availableAgents === 1 ? ' agent' : ' agents') + ' available', 'note'));
      stats.appendChild(box);
    });

    // Agents
    const agentRows = state.agents.map((a) => [
      a.name,
      LABELS[a.department],
      badge(a.status),
      a.status === 'Available' ? time(a.availableSince) : 'n/a',
    ]);
    $('agentTable').replaceChildren(table(['Agent', 'Queue', 'Status', 'Available since'], agentRows));

    // History, newest first
    const history = state.calls
      .slice()
      .reverse()
      .slice(0, 20)
      .map((c) => [
        c.id,
        c.name,
        c.phone,
        LABELS[c.department],
        badge(c.status),
        c.agentName,
        c.waitedSeconds === null ? 'n/a' : c.waitedSeconds + ' s',
        time(c.createdAt),
      ]);
    $('historyTable').replaceChildren(
      table(['Call', 'Customer', 'Phone', 'Queue', 'Status', 'Agent', 'Waited', 'Started'], history)
    );
  }

  $('agentSelect').addEventListener('change', (event) => {
    selectedAgentId = Number(event.target.value);
    $('actionError').textContent = '';
    render();
  });

  refresh();
  setInterval(refresh, 3000);
})();
