const { WebSocketServer } = require('ws');

// Routes Chrome DevTools Protocol messages between the DevTools front end and the BugMe agents
// injected into the simulator, with the same rules as the IDE's mini-devtools-extension:
// Elements (DOM/CSS/Overlay) go to the active page's agent, everything else to the worker agent.
// The IDE sends Runtime/Debugger to a real V8 debugger attached to the worker; a webview has none,
// so those go to the worker agent too, and requests it never answers get an empty result.
// Agents connect on /webview?view_id=<page> and /channel/worker (URLs the UI hands them); the
// IDE's DevTools front end connects on /?_token=<token>.

const PATHS = ['/webview', '/channel/worker', '/'];
const UNANSWERED_TIMEOUT = 1500;
const isToRender = (method) => /(CSS|DOM|Overlay)\./.test(method) || /Tiny\.Elements/.test(method);

function createDevtoolsRouter(token) {
  const wss = new WebSocketServer({ noServer: true });
  const frontends = new Set();
  const renders = new Map();
  let activeRender = null;
  let worker = null;
  const queued = { render: [], worker: [] };
  const pending = new Map(); // worker-bound request id → fallback timer
  let getDocumentId = null; // the front end's last DOM.getDocument, re-sent to each new page agent

  function sendTo(kind, data) {
    const ws = kind === 'render' ? renders.get(activeRender) : worker;
    if (ws && ws.readyState === ws.OPEN) ws.send(data);
    else queued[kind].push(data);
  }

  function fromAgent(data) {
    const text = String(data);
    try {
      const msg = JSON.parse(text);
      if (msg.id != null && pending.has(msg.id)) { clearTimeout(pending.get(msg.id)); pending.delete(msg.id); }
    } catch (e) { /* forward as is */ }
    frontends.forEach((ws) => ws.send(text));
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/webview') {
      const id = url.searchParams.get('view_id');
      renders.set(id, ws);
      activeRender = id;
      ws.on('message', (data) => {
        // Like the IDE: the page that reports a new document becomes the one Elements shows
        try {
          const msg = JSON.parse(String(data));
          if (msg.method === 'DOM.documentUpdated' && msg.params && msg.params.bugmeAgentId != null) {
            activeRender = String(msg.params.bugmeAgentId);
          }
        } catch (e) { /* forward as is */ }
        fromAgent(data);
      });
      ws.on('close', () => { if (renders.get(id) === ws) renders.delete(id); });
      const flushed = queued.render.splice(0);
      flushed.forEach((d) => sendTo('render', d));
      // After an app restart the new page's agent is never asked for its tree (the front end
      // already has one), so re-send the front end's DOM.getDocument, as the IDE does
      if (getDocumentId != null && !flushed.some((d) => d.includes('"DOM.getDocument"'))) {
        ws.send(JSON.stringify({ id: getDocumentId, method: 'DOM.getDocument', params: {} }));
      }
    } else if (url.pathname === '/channel/worker') {
      worker = ws;
      ws.on('message', fromAgent);
      ws.on('close', () => { if (worker === ws) worker = null; });
      queued.worker.splice(0).forEach((d) => sendTo('worker', d));
    } else {
      if (url.searchParams.get('_token') !== token) return ws.close(1003, 'invalid token');
      frontends.add(ws);
      ws.on('close', () => frontends.delete(ws));
      ws.on('message', (data) => {
        const text = String(data);
        let msg;
        try { msg = JSON.parse(text); } catch (e) { return; }
        if (msg.method === 'DOM.getDocument') getDocumentId = msg.id;
        if (isToRender(msg.method)) return sendTo('render', text);
        if (msg.id != null) {
          pending.set(msg.id, setTimeout(() => {
            pending.delete(msg.id);
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }, UNANSWERED_TIMEOUT));
        }
        sendTo('worker', text);
      });
    }
  });

  return {
    status: () => ({
      frontends: frontends.size, renders: [...renders.keys()], activeRender, worker: Boolean(worker),
      queued: { render: queued.render.length, worker: queued.worker.length },
    }),
    handles: (pathname) => PATHS.includes(pathname),
    handleUpgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)),
    close: () => { pending.forEach(clearTimeout); wss.close(); },
  };
}

module.exports = { createDevtoolsRouter };
