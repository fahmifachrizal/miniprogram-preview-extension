const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

// <web-view> pages are loaded through this proxy so a JS bridge can be put into them: the IDE injects
// its runtime into a native Electron webview instead, which an iframe can't do across origins.
// Each upstream origin gets its own local port, so the page keeps a stable origin of its own
// (relative URLs, cookies, storage and same-origin requests keep working). Per origin:
//   /__mp/bridge.js     the AlipayJSBridge for the page; it talks to the simulator page by postMessage
//   /__mp/appx/<file>   https://appx/<file> (web-view.min.js), an address that only resolves inside the miniprogram runtime
//   /__mp/fetch?url=    a request to another origin, made here so the page isn't blocked by CORS
//   /__mp/go?url=       navigation to another origin: redirects to that origin's proxy
// Everything else is forwarded to the upstream origin. HTML is rewritten (bridge, absolute links to
// the origin, https://appx/); the headers that forbid framing are dropped.

// Runs inside the web-view page (served as /__mp/bridge.js); never executed in Node.
function bridge() {
  var info = window.__mpWebviewInfo || {};
  var host = window.parent;
  if (window.__mpBridge || host === window) return;
  window.__mpBridge = true;
  var localOrigin = location.origin;

  // The user agent the IDE gives web-view pages (the device's plus " MiniProgram"); my.getEnv checks it
  if (info.userAgent) {
    try { Object.defineProperty(Navigator.prototype, 'userAgent', { get: function () { return info.userAgent; }, configurable: true }); } catch (e) { /* keep the real one */ }
  }

  var callbacks = {};
  var seq = 0;
  function post(msg) { host.postMessage({ __mpWebview: msg }, '*'); }
  function fire(name, data) {
    var ev = document.createEvent('Events');
    ev.initEvent(name, false, false);
    if (data !== undefined) ev.data = data;
    document.dispatchEvent(ev);
  }

  window.AlipayJSBridge = {
    startupParams: info.startupParams || {},
    call: function (apiName, params, callback) {
      if (typeof params === 'function') { callback = params; params = undefined; }
      var callId = ++seq;
      if (typeof callback === 'function') callbacks[callId] = callback;
      var data = {};
      try { if (params !== undefined) data = JSON.parse(JSON.stringify(params)); } catch (e) { /* not serialisable */ }
      post({ type: 'call', callId: callId, apiName: apiName, params: data });
    },
  };

  // Results of calls, and messages from the mini program (webViewContext.postMessage) and navigation
  // responses, which web-view.min.js receives as an "onToWebViewMessage" event
  window.addEventListener('message', function (e) {
    var m = e.source === host && e.data && e.data.__mpWebviewHost;
    if (!m) return;
    if (m.type === 'result') {
      var cb = callbacks[m.callId];
      delete callbacks[m.callId];
      if (cb) cb(m.result);
    } else if (m.type === 'toWebView') {
      fire('onToWebViewMessage', m.data);
    }
  });

  // The client shows the page's title in the navigation bar
  var lastTitle = null;
  function syncTitle() {
    if (document.title && document.title !== lastTitle) {
      lastTitle = document.title;
      post({ type: 'title', title: document.title });
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    syncTitle();
    new MutationObserver(syncTitle).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
  });

  // Requests to other origins go through the proxy: the client doesn't apply CORS to web-view pages
  function tunnel(url) {
    try {
      var u = new URL(url, location.href);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== localOrigin) {
        return localOrigin + '/__mp/fetch?url=' + encodeURIComponent(u.href);
      }
    } catch (e) { /* leave it */ }
    return url;
  }
  if (window.fetch) {
    var fetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === 'string' || input instanceof URL) input = tunnel(String(input));
      else if (input && input.url) input = new Request(tunnel(input.url), input);
      return fetch.call(this, input, init);
    };
  }
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = tunnel(String(url));
    return open.apply(this, args);
  };

  // Links to other origins stay in the proxy, so the next page has the bridge too
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || (a.target && a.target !== '_self')) return;
    var u;
    try { u = new URL(a.href); } catch (err) { return; }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== localOrigin) {
      e.preventDefault();
      location.href = localOrigin + '/__mp/go?url=' + encodeURIComponent(u.href);
    }
  });

  // For pages that wait for the bridge rather than check for it
  setTimeout(function () { fire('AlipayJSBridgeReady'); }, 0);
}
const BRIDGE_SCRIPT = `(${bridge.toString()})();\n`;

const DROPPED_HEADERS = ['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security'];
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cookies set by the upstream site, made valid for the local origin
function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*secure(?=;|$)/gi, '')
    .replace(/;\s*samesite=none/gi, '; SameSite=Lax');
}

function decode(body, encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(body);
    case 'deflate': return zlib.inflateSync(body);
    case 'br': return zlib.brotliDecompressSync(body);
    default: return body;
  }
}

// appxDir: where web-view.min.js is. rejectUnauthorized(): whether upstream certificates are checked.
function createWebviewProxy({ appxDir, rejectUnauthorized = () => true }) {
  const origins = new Map(); // upstream origin → Promise<{server, localOrigin}>
  // The latest page's user agent and startup params, given to the bridge
  let info = {};

  // The proxy's own address for a URL (other origins' addresses go through /__mp/go)
  function localFor(entry, url, tunnelled) {
    let target;
    try { target = new URL(url, entry.origin); } catch (e) { return url; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return url;
    if (tunnelled) return `${entry.localOrigin}/__mp/fetch?url=${encodeURIComponent(target.href)}`;
    if (target.origin === entry.origin) return entry.localOrigin + target.pathname + target.search + target.hash;
    return `${entry.localOrigin}/__mp/go?url=${encodeURIComponent(target.href)}`;
  }

  function rewriteHtml(html, entry) {
    const upstream = new URL(entry.origin);
    const local = new URL(entry.localOrigin);
    let text = html
      .split(entry.origin).join(entry.localOrigin)
      .split(`//${upstream.host}`).join(`//${local.host}`)
      .split('https://appx/').join('/__mp/appx/')
      .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
    const tag = '<script src="/__mp/bridge.js"></script>';
    const head = text.match(/<head[^>]*>/i) || text.match(/<html[^>]*>/i);
    text = head ? text.slice(0, head.index + head[0].length) + tag + text.slice(head.index + head[0].length) : tag + text;
    return text;
  }

  function errorPage(res, url, err) {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
      <body style="font:14px -apple-system,sans-serif;padding:16px;color:#333">Could not load ${escapeHtml(url)}<br><small>${escapeHtml(err.message)}</small>
      <script>parent.postMessage({__mpWebview:{type:'loadFail',url:${JSON.stringify(url)},message:${JSON.stringify(err.message)}}},'*')</script></body></html>`);
  }

  // Forward a request to `target`: as the page's own origin, or tunnelled for the page (/__mp/fetch)
  function forward(entry, req, res, target, tunnelled) {
    const url = new URL(target);
    const headers = { ...req.headers, host: url.host, 'accept-encoding': 'gzip, deflate, br' };
    if (headers.origin) headers.origin = entry.origin;
    if (headers.referer) headers.referer = headers.referer.split(entry.localOrigin).join(entry.origin);
    if (info.userAgent) headers['user-agent'] = info.userAgent;
    const mod = url.protocol === 'https:' ? https : http;
    const upstream = mod.request(url, { method: req.method, headers, rejectUnauthorized: rejectUnauthorized() }, (up) => {
      const out = { ...up.headers };
      DROPPED_HEADERS.forEach((h) => delete out[h]);
      if (out.location) out.location = localFor(entry, new URL(out.location, url).href, tunnelled);
      if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map(rewriteCookie);
      const isHtml = !tunnelled && /text\/html/i.test(out['content-type'] || '');
      if (!isHtml || req.method === 'HEAD' || [204, 304].includes(up.statusCode)) {
        res.writeHead(up.statusCode, out);
        return up.pipe(res);
      }
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('error', (err) => errorPage(res, target, err));
      up.on('end', () => {
        let html;
        try { html = decode(Buffer.concat(chunks), out['content-encoding']).toString('utf8'); } catch (err) { return errorPage(res, target, err); }
        const body = Buffer.from(rewriteHtml(html, entry));
        delete out['content-encoding'];
        delete out.etag;
        out['content-length'] = body.length;
        res.writeHead(up.statusCode, out);
        res.end(body);
      });
    });
    upstream.on('error', (err) => errorPage(res, target, err));
    req.pipe(upstream);
  }

  // WebSockets (e.g. a dev server's live reload) are passed through to the upstream origin
  function forwardUpgrade(entry, req, socket, head) {
    const url = new URL(req.url, entry.origin);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { ...req.headers, host: url.host };
    if (headers.origin) headers.origin = entry.origin;
    const upstream = mod.request(url, { method: req.method, headers, rejectUnauthorized: rejectUnauthorized() });
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    upstream.on('response', (res) => socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`));
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  function handle(entry, req, res) {
    const url = new URL(req.url, entry.localOrigin);
    if (url.pathname === '/__mp/bridge.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
      return res.end(`window.__mpWebviewInfo = ${JSON.stringify(info)};\n${BRIDGE_SCRIPT}`);
    }
    if (url.pathname.startsWith('/__mp/appx/')) {
      const file = path.join(appxDir, path.basename(url.pathname));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return fs.createReadStream(file).pipe(res);
    }
    const target = url.searchParams.get('url');
    if (url.pathname === '/__mp/go' && target) {
      return open({ url: target }).then((local) => { res.writeHead(302, { location: local }); res.end(); },
        (err) => errorPage(res, target, err));
    }
    if (url.pathname === '/__mp/fetch' && target) return forward(entry, req, res, target, true);
    return forward(entry, req, res, entry.origin + req.url, false);
  }

  function ensure(origin) {
    if (!origins.has(origin)) {
      origins.set(origin, new Promise((resolve, reject) => {
        const entry = { origin, localOrigin: null, server: null };
        entry.server = http.createServer((req, res) => handle(entry, req, res));
        entry.server.on('upgrade', (req, socket, head) => forwardUpgrade(entry, req, socket, head));
        entry.server.once('error', reject);
        entry.server.listen(0, '127.0.0.1', () => {
          entry.localOrigin = `http://127.0.0.1:${entry.server.address().port}`;
          resolve(entry);
        });
      }));
    }
    return origins.get(origin);
  }

  // The address to load `url` at; userAgent/startupParams are handed to the page's bridge
  async function open({ url, userAgent, startupParams }) {
    if (userAgent || startupParams) info = { userAgent: userAgent || info.userAgent, startupParams: startupParams || info.startupParams };
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return url;
    const entry = await ensure(target.origin);
    return entry.localOrigin + target.pathname + target.search + target.hash;
  }

  function close() {
    origins.forEach((p) => p.then((entry) => entry.server.close(), () => {}));
    origins.clear();
  }

  return { open, close };
}

module.exports = { createWebviewProxy };
