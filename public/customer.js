(function () {
  const LABELS = { billing: 'Billing', support: 'Technical Support', general: 'General Enquiries' };
  const $ = (id) => document.getElementById(id);

  let wrongCount = 0;
  let callId = null;
  let timer = null;
  let customer = { name: '', phone: '' };

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

  function show(stepId) {
    for (const id of ['stepDetails', 'stepMenu', 'stepStatus']) {
      $(id).classList.toggle('hidden', id !== stepId);
    }
  }

  // Step 1: details
  $('callButton').addEventListener('click', () => {
    const name = $('name').value.trim();
    const phone = $('phone').value.replace(/\s+/g, '');
    if (!name) {
      $('detailsError').textContent = 'Please enter a name.';
      return;
    }
    if (!/^\d{10}$/.test(phone)) {
      $('detailsError').textContent = 'Please enter a fake 10 digit phone number.';
      return;
    }
    $('detailsError').textContent = '';
    customer = { name, phone };
    wrongCount = 0;
    $('menuMessage').textContent = '';
    show('stepMenu');
  });

  // Step 2: IVR keypad
  const keypad = $('keypad');
  for (let key = 1; key <= 9; key += 1) {
    const button = document.createElement('button');
    button.textContent = String(key);
    button.addEventListener('click', () => pressKey(String(key), button));
    keypad.appendChild(button);
  }

  async function pressKey(key) {
    keypad.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const result = await post('/api/ivr', { key, wrongCount });
      wrongCount = result.wrongCount;
      if (result.action === 'retry') {
        $('menuMessage').textContent =
          'Sorry, that is not a valid option. ' + result.triesLeft + ' tries left. Please choose again.';
        keypad.querySelectorAll('button').forEach((b) => (b.disabled = false));
        return;
      }
      if (result.fallback) {
        $('menuMessage').textContent = 'Too many wrong keys. Sending you to General Enquiries.';
      }
      await placeCall(result.department);
    } catch (err) {
      $('menuMessage').textContent = err.message;
      keypad.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  // Step 3: the call
  async function placeCall(department) {
    const call = await post('/api/calls', { ...customer, department });
    callId = call.id;
    show('stepStatus');
    $('hangUp').classList.remove('hidden');
    $('newCall').classList.add('hidden');
    renderCall(call);
    timer = setInterval(poll, 2000);
  }

  async function poll() {
    try {
      renderCall(await api('/api/calls/' + callId));
    } catch (err) {
      $('statusDetail').textContent = err.message;
    }
  }

  function renderCall(call) {
    const department = LABELS[call.department];
    if (call.status === 'Waiting') {
      $('statusLine').textContent = 'All agents are busy. You are number ' + call.queuePosition + ' in the ' + department + ' queue.';
      $('statusDetail').textContent = 'Please hold. This page updates by itself.';
    } else if (call.status === 'Active') {
      $('statusLine').textContent = 'Connected to ' + call.agentName + ' (' + department + ').';
      $('statusDetail').textContent = 'Waited ' + call.waitedSeconds + ' seconds. The agent will end the call when you are done.';
      $('hangUp').classList.add('hidden');
    } else {
      $('statusLine').textContent = call.status === 'Completed' ? 'The call has ended. Thank you.' : 'You hung up before an agent answered.';
      $('statusDetail').textContent = '';
      $('hangUp').classList.add('hidden');
      $('newCall').classList.remove('hidden');
      clearInterval(timer);
    }
  }

  $('hangUp').addEventListener('click', async () => {
    try {
      renderCall(await post('/api/calls/' + callId + '/abandon'));
    } catch (err) {
      $('statusDetail').textContent = err.message;
    }
  });

  $('newCall').addEventListener('click', () => {
    clearInterval(timer);
    callId = null;
    keypad.querySelectorAll('button').forEach((b) => (b.disabled = false));
    show('stepDetails');
  });
})();
