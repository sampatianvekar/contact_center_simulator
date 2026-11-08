'use strict';

const path = require('path');
const express = require('express');
const { createEngine, ivrPress } = require('./engine');

const app = express();
const engine = createEngine();

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Wrap a handler so engine errors become clean JSON responses.
function route(handler) {
  return (req, res) => {
    try {
      res.json(handler(req));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: status === 500 ? 'Server error' : err.message });
    }
  };
}

app.get('/api/state', route(() => engine.snapshot()));
app.get('/api/calls/:id', route((req) => engine.getCall(req.params.id)));

// One IVR key press. The client sends how many wrong keys the caller has pressed so far.
app.post('/api/ivr', route((req) => ivrPress(req.body.key, req.body.wrongCount)));

app.post('/api/calls', route((req) => engine.createCall(req.body)));
app.post('/api/calls/:id/end', route((req) => engine.endCall(req.params.id)));
app.post('/api/calls/:id/abandon', route((req) => engine.abandonCall(req.params.id)));
app.post('/api/agents/:id/status', route((req) => engine.setAgentStatus(req.params.id, req.body.status)));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Contact center simulator running at http://localhost:${port}`);
});
