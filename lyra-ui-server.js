const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { createDevtoolsRouter } = require('./devtools-router');
const { createWebviewProxy } = require('./webview-proxy');

// Serves the IDE's simulator UI (vendor/lyra-ui) and stands in for the IDE backend it talks to.
// The UI calls the backend over a WebSocket using the "lyra-rpc://" protocol; only a handful of
// methods are needed to run an app, the rest (cloud, login, payment) are answered with null.
// minidev still compiles the project; its output folder is served here as static files.
// The IDE drives the UI by calling its global API; here that's done by a script injected into the
// page, which talks to this server over /events (build state, restarts, <web-view>, display size).

const UI_DIR = path.join(__dirname, 'vendor', 'lyra-ui');
const APPX_NG_DIR = path.join(__dirname, 'vendor', 'appx-ng');
// Simulator DevTools (scripts/pull-devtools.js): BugMe agents + the IDE's DevTools front end
const DEVTOOLS_DIR = path.join(__dirname, 'vendor', 'devtools');
// The IDE's simulator DevTools page (full mode loads devtoolsFrontendDir/mini-ide-emulator-devtools-frontend)
const FRONT_END_PAGE = 'devtools-frontend/mini-ide-emulator-devtools-frontend/index.html';
const hasDevtools = () => fs.existsSync(path.join(DEVTOOLS_DIR, 'bugme', 'render-uniweb.js')) && fs.existsSync(path.join(DEVTOOLS_DIR, FRONT_END_PAGE));
const TOKEN = 'mp-preview';
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

// Runs inside the simulator page (injected into /lyra/index.html); never executed in Node.
// For agents (the MCP server): runs in the app's worker before any app code (prepended to
// index.worker.js), keeping what the page script then reads on request, in self.__mp:
//   logs: console output · api: every my.* call with params and result
function workerAgent() {
  if (self.__mp) return;
  var mp = self.__mp = { logs: [], api: [], logSeq: 0, apiSeq: 0 };
  var CAP = 500;
  var push = function (list, entry) { list.push(entry); if (list.length > CAP) list.shift(); };
  // JSON-safe copy: depth-limited, no cycles, long strings cut
  var safe = mp.safe = function (v, depth, seen) {
    if (depth === undefined) depth = 5;
    seen = seen || [];
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
    if (v === undefined) return null;
    if (typeof v === 'function') return '[Function]';
    if (typeof v !== 'object') return String(v);
    if (seen.indexOf(v) >= 0) return '[Circular]';
    if (depth <= 0) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
    seen = seen.concat([v]);
    if (Array.isArray(v)) return v.slice(0, 200).map(function (x) { return safe(x, depth - 1, seen); });
    var out = {};
    Object.keys(v).slice(0, 300).forEach(function (k) { try { out[k] = safe(v[k], depth - 1, seen); } catch (e) { out[k] = '[Unreadable]'; } });
    return out;
  };
  var fmt = function (a) {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(safe(a, 4)); } catch (e) { return String(a); }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try { push(mp.logs, { seq: ++mp.logSeq, time: Date.now(), source: 'worker', level: level, text: [].slice.call(arguments).map(fmt).join(' ') }); } catch (e) { /* never break logging */ }
      return orig.apply(this, arguments);
    };
  });
  // my.* calls: wrapped now, and again whenever a function is replaced (the mock patch does that)
  var SKIP = /^(_|on[A-Z]|off[A-Z]|create|canIUse$|SDKVersion$|reportAnalytics$)/;
  function wrap(name) {
    var orig = self.my[name];
    if (typeof orig !== 'function' || orig.__mpWrapped || SKIP.test(name)) return;
    var wrapped = function () {
      var args = [].slice.call(arguments);
      var entry = { seq: ++mp.apiSeq, time: Date.now(), api: name };
      try {
        if (name === 'call') {
          // my.call(api, params?, callback?)
          var cbIndex = typeof args[1] === 'function' ? 1 : 2;
          entry.params = safe({ api: args[0], params: typeof args[1] === 'function' ? undefined : args[1] }, 4);
          var cb = args[cbIndex];
          if (typeof cb === 'function') args[cbIndex] = function (res) { entry.outcome = 'callback'; entry.result = safe(res, 4); return cb.apply(this, arguments); };
        } else {
          entry.params = safe(args[0], 4);
          var opts = args[0];
          if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
            ['success', 'fail'].forEach(function (key) {
              var f = opts[key];
              opts[key] = function (res) { entry.outcome = key; entry.result = safe(res, 4); return typeof f === 'function' ? f.apply(this, arguments) : undefined; };
            });
          }
        }
        push(mp.api, entry);
      } catch (e) { /* never break the call */ }
      var ret = orig.apply(this, args);
      try {
        if (/Sync$/.test(name)) { entry.outcome = 'return'; entry.result = safe(ret, 4); }
        else if (ret && typeof ret.then === 'function') {
          ret.then(function (r) { if (!entry.outcome) { entry.outcome = 'resolved'; entry.result = safe(r, 4); } },
            function (e) { if (!entry.outcome) { entry.outcome = 'rejected'; entry.result = safe(e, 4); } });
        }
      } catch (e) { /* ignore */ }
      return ret;
    };
    wrapped.__mpWrapped = true;
    try { self.my[name] = wrapped; } catch (e) { /* read-only */ }
  }
  var wrapAll = function () { if (self.my) Object.keys(self.my).forEach(wrap); };
  wrapAll();
  setInterval(wrapAll, 1000);
}
const WORKER_AGENT = `;(${workerAgent.toString()})();\n`;

function pageScript() {
  var api = function () { return window.__LYRA_GLOBAL_RUNTIME_API__; };
  var container = function () { return api().runtime.getContainer(); };
  var ready = function () {
    var a = api();
    return a && a.runtime && a.runtime.runtimeLifeCycle && a.runtime.runtimeLifeCycle.isLyraStarted;
  };

  // Fill the view's width: the UI fixes its container to the wider of the phone and its toolbars, so
  // a narrow view clipped the toolbars. Here the container takes the page's width, the device and zoom
  // selectors shrink (with an ellipsis), the icons keep their size, and a toolbar wraps only when even
  // that doesn't fit. The layout is never narrower than MIN_WIDTH: in a narrower view (VS Code has no
  // minimum width for a view) the whole simulator is laid out MIN_WIDTH wide and drawn smaller.
  var MIN_WIDTH = 440;
  var layout = document.createElement('style');
  layout.textContent = [
    'html { overflow: hidden !important; }',
    'body { transform-origin: 0 0; }',
    '#__lyra-simulator-container { width: 100% !important; }',
    '.simulator-topbar, .simulator-toolbar { width: 100%; box-sizing: border-box; flex-wrap: wrap; row-gap: 2px; }',
    '.simulator-topbar .ordered-left, .simulator-toolbar .ordered-left { display: flex; flex: 1 1 0; min-width: 0; overflow: hidden; }',
    '.simulator-topbar .ordered-right, .simulator-toolbar .ordered-right { flex: none; }',
    '.simulator-topbar .ordered-left .ant-select { flex: 0 1 auto; min-width: 56px; }',
    '.simulator-topbar .ant-select-selection-selected-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(layout);
  function applyMinWidth() {
    var body = document.body;
    if (!body) return;
    var scale = Math.min(1, window.innerWidth / MIN_WIDTH);
    if (scale < 1) {
      body.style.width = MIN_WIDTH + 'px';
      body.style.height = (window.innerHeight / scale) + 'px';
      body.style.transform = 'scale(' + scale + ')';
    } else {
      body.style.width = body.style.height = body.style.transform = '';
    }
  }
  if (document.body) applyMinWidth();
  else document.addEventListener('DOMContentLoaded', applyMinWidth);
  window.addEventListener('resize', applyMinWidth);

  // Messages from the server: build state (the IDE shows its compiling overlay, then restarts the
  // app through the global API), restarts for a new compile mode, and the displays' physical size
  var eventsSocket = null;
  (function connect() {
    var ws = eventsSocket = new WebSocket('ws://' + location.host + '/events');
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      try { onEvent(msg); } catch (err) { /* ignore */ }
    };
    ws.onclose = function () { setTimeout(connect, 1000); };
  })();

  // --- Requests from the MCP server (agents), answered on the /events socket ---
  // The worker agent (workerAgent, prepended to the app's worker) keeps logs and my.* calls in the
  // worker frame's __mp; these read them and act on the running app.
  var launchInfo = {};
  var renderLogs = [];
  function needWorker() {
    var w = workerFrame();
    if (!w || typeof w.getCurrentPages !== 'function' || !w.__mp) throw new Error('The app is still starting; try again in a moment.');
    return w;
  }
  function topPage(w) {
    var pages = w.getCurrentPages();
    if (!pages.length) throw new Error('No page is open yet; try again in a moment.');
    return pages[pages.length - 1];
  }
  var delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // The top page once navigation has settled (the stack is briefly empty during switchTab/reLaunch)
  function settledPage(w, wait) {
    return delay(wait).then(function () {
      var tries = 0;
      return (function next() {
        if (w.getCurrentPages().length) return topPage(w);
        if (++tries > 20) return topPage(w);
        return delay(100).then(next);
      })();
    });
  }
  // The query a page was opened with (what its onLoad got)
  function pageQuery(w, page) {
    try { return w.__mp.safe(page.getLoadOptions() || {}, 3); } catch (e) { return {}; }
  }
  function pageSummary(w, page, depth) {
    return { route: page.route, query: pageQuery(w, page), data: depth ? w.__mp.safe(page.data, depth) : undefined };
  }
  // The page's own functions: its Page({...}) config sits on the instance's prototype
  function pageMethods(page) {
    var config = Object.getPrototypeOf(page);
    return Object.getOwnPropertyNames(config).filter(function (k) { return typeof config[k] === 'function' && k !== 'constructor'; });
  }
  // Console output of the pages (render frames); the worker's comes from the agent
  function hookRenderConsoles() {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      var win;
      try { win = frames[i].contentWindow; if (!win || win.APVIEWID === undefined || win.__mpConsole) continue; } catch (e) { continue; }
      win.__mpConsole = true;
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var orig = win.console[level];
        if (typeof orig !== 'function') return;
        win.console[level] = function () {
          try {
            var text = [].slice.call(arguments).map(function (x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(' ');
            renderLogs.push({ time: Date.now(), source: 'page', level: level, text: text });
            if (renderLogs.length > 200) renderLogs.shift();
          } catch (e) { /* ignore */ }
          return orig.apply(this, arguments);
        };
      });
    }
  }
  setInterval(function () { try { hookRenderConsoles(); } catch (e) { /* ignore */ } }, 500);

  // What a page renders: AXML components (a-view → view…), their classes and text, indented
  function viewTree(win, max) {
    var lines = [];
    (function walk(el, depth) {
      if (lines.length >= max) return;
      var tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link') return;
      var comp = null;
      var classes = [];
      (typeof el.className === 'string' ? el.className.trim().split(/\s+/) : []).forEach(function (c) {
        var m = /^a-([a-z-]+)$/.exec(c);
        if (m && !comp) comp = m[1];
        else if (c && !/^a-/.test(c) && c !== 'tiny-page') classes.push(c);
      });
      var text = [].slice.call(el.childNodes).filter(function (n) { return n.nodeType === 3; })
        .map(function (n) { return n.textContent.trim(); }).filter(Boolean).join(' ');
      if (text.length > 120) text = text.slice(0, 120) + '…';
      var src = el.getAttribute && (el.getAttribute('src') || '');
      var show = comp || text || classes.length || src;
      if (show) {
        lines.push(new Array(depth + 1).join('  ') + (comp || tag) + (classes.length ? '.' + classes.join('.') : '')
          + (text ? ' "' + text + '"' : '') + (src ? ' src=' + src.slice(0, 80) : ''));
      }
      for (var i = 0; i < el.children.length; i++) walk(el.children[i], show ? depth + 1 : depth);
    })(win.document.body, 0);
    if (lines.length >= max) lines.push('… (truncated)');
    return lines.join('\n');
  }

  // JS in the worker: its eval/Function are disabled, but a <script> added to its document runs there
  var evalSeq = 0;
  function runInWorker(w, code) {
    var key = '__mpEval' + (++evalSeq);
    var src = code.trim().replace(/;\s*$/, '');
    var body = /\breturn\b|;|\n/.test(src) ? code : 'return (' + src + ');';
    var script = w.document.createElement('script');
    script.textContent = 'window.' + key + ' = (function () { try { return { ok: true, value: (function () {\n' + body
      + '\n})() }; } catch (e) { return { ok: false, error: String(e) }; } })();';
    var syntaxError = null;
    var onError = function (ev) { syntaxError = ev.message; };
    w.addEventListener('error', onError);
    w.document.head.appendChild(script);
    w.removeEventListener('error', onError);
    script.remove();
    var out = w[key];
    try { delete w[key]; } catch (e) { w[key] = undefined; }
    if (!out) throw new Error(syntaxError || 'The code did not run (a syntax error?)');
    if (!out.ok) throw new Error(out.error);
    return Promise.resolve(out.value).then(function (v) { return w.__mp.safe(v, 6); });
  }

  var mcpHandlers = {
    ping: function () { var w = needWorker(); topPage(w); return { ready: true }; },
    currentPage: function (p) {
      var w = needWorker();
      var pages = w.getCurrentPages();
      var top = topPage(w);
      var launchOptions = null;
      try { launchOptions = w.__mp.safe(w.my.getLaunchOptionsSync(), 4); } catch (e) { /* older base library */ }
      var result = pageSummary(w, top, p.dataDepth || 6);
      result.stack = pages.map(function (pg) { return { route: pg.route, query: pageQuery(w, pg) }; });
      result.functions = pageMethods(top);
      result.launch = { options: launchOptions, compileMode: launchInfo };
      return result;
    },
    setData: function (p) {
      var w = needWorker();
      var top = topPage(w);
      top.setData(p.data || {});
      return delay(100).then(function () { return pageSummary(w, top, 6); });
    },
    trigger: function (p) {
      var w = needWorker();
      var top = topPage(w);
      if (typeof top[p.handler] !== 'function') {
        throw new Error('The page ' + top.route + ' has no function "' + p.handler + '". It has: ' + pageMethods(top).join(', '));
      }
      var dataset = p.dataset || {};
      var event = { type: 'tap', timeStamp: Date.now(), detail: p.detail || {}, currentTarget: { id: '', dataset: dataset }, target: { id: '', dataset: dataset } };
      var returned = top[p.handler].call(top, event);
      return Promise.resolve(returned).then(function (r) {
        return settledPage(w, 600).then(function (now) {
          return { returned: w.__mp.safe(r, 4), page: pageSummary(w, now, 0), navigated: now !== top };
        });
      });
    },
    openPage: function (p) {
      var w = needWorker();
      var url = '/' + String(p.path || '').replace(/^\//, '') + (p.query ? '?' + String(p.query).replace(/^\?/, '') : '');
      return new Promise(function (resolve, reject) {
        w.my.reLaunch({
          url: url,
          success: function () { settledPage(w, 600).then(function (page) { resolve(pageSummary(w, page, 4)); }, reject); },
          fail: function (e) { reject(new Error('reLaunch to ' + url + ' failed: ' + JSON.stringify(e))); },
        });
      });
    },
    view: function (p) {
      var w = needWorker();
      var top = topPage(w);
      var win = pageWindowFor(top.$viewId);
      if (!win) throw new Error('The page ' + top.route + ' has not rendered yet.');
      return { route: top.route, tree: viewTree(win, p.maxLines || 300) };
    },
    logs: function (p) {
      var w = needWorker();
      var since = p.since || 0;
      var entries = w.__mp.logs.filter(function (l) { return l.seq > since && (!p.level || l.level === p.level); });
      return { entries: entries, last: w.__mp.logSeq, pageLogs: renderLogs.slice(-50) };
    },
    apiLog: function (p) {
      var w = needWorker();
      var since = p.since || 0;
      var name = p.api ? String(p.api).replace(/^my\./, '') : null;
      var entries = w.__mp.api.filter(function (e) { return e.seq > since && (!name || e.api === name); });
      return { entries: entries.slice(-100), last: w.__mp.apiSeq };
    },
    storage: function (p) {
      var w = needWorker();
      var my = w.my;
      var safe = w.__mp.safe;
      if (p.action === 'info') return safe(my.getStorageInfoSync(), 4);
      if (p.action === 'get') return safe(my.getStorageSync({ key: p.key }), 6);
      if (p.action === 'set') { my.setStorageSync({ key: p.key, data: p.value }); return safe(my.getStorageSync({ key: p.key }), 6); }
      if (p.action === 'remove') { my.removeStorageSync({ key: p.key }); return safe(my.getStorageInfoSync(), 4); }
      if (p.action === 'clear') { my.clearStorageSync(); return safe(my.getStorageInfoSync(), 4); }
      throw new Error('Unknown storage action ' + p.action);
    },
    eval: function (p) { return runInWorker(needWorker(), String(p.code || '')); },
  };
  function handleMcp(msg) {
    var reply = function (body) {
      body.type = 'mcpResult';
      body.id = msg.id;
      try { eventsSocket.send(JSON.stringify(body)); } catch (e) { /* socket gone */ }
    };
    Promise.resolve().then(function () {
      var handler = mcpHandlers[msg.method];
      if (!handler) throw new Error('Unknown method ' + msg.method);
      return handler(msg.params || {});
    }).then(function (result) { reply({ result: result }); }, function (err) { reply({ error: String((err && err.message) || err) }); });
  }

  // Quick rebuilds would only flash the overlay, so it's shown once a compile takes a while
  var compilingTimer = null;
  var compilingShown = false;
  // API mocks: the runtime keeps them in its container and passes them to the app's worker, but only
  // loads them from the IDE on a fresh start, not on the reboots used here, so they're set directly
  var mockConfig = null;
  function applyMocks() {
    var a = api();
    if (!a || !mockConfig) return;
    try { Promise.resolve(a.setBuildinMockConfig(mockConfig)).catch(function () {}); } catch (e) { /* no app yet */ }
    // The runtime only pushes rules to the worker while mocks are on, so switching off clears them there
    var worker = workerFrame();
    if (!mockConfig.active && worker && typeof worker.__updateLyraMockProxyData === 'function') worker.__updateLyraMockProxyData({ active: false, rules: [] });
  }
  function workerFrame() {
    for (var i = 0; i < window.frames.length; i++) {
      try { if (/af-appx\.worker/.test(window.frames[i].location.href)) return window.frames[i]; } catch (e) { /* other origin */ }
    }
    return null;
  }
  function onEvent(msg) {
    var a = api();
    if (msg.type === 'mcp') return handleMcp(msg);
    if (msg.type === 'launch') { launchInfo = msg.launch || {}; return; }
    if (msg.type === 'compiling') {
      clearTimeout(compilingTimer);
      compilingTimer = setTimeout(function () {
        if (!api()) return;
        compilingShown = true;
        api().showDevServerCompiling();
      }, 400);
    } else if (msg.type === 'rebuilt' || msg.type === 'buildError') {
      clearTimeout(compilingTimer);
      // (hiding when it isn't shown throws inside the UI)
      if (compilingShown && a) { compilingShown = false; a.hideDevServerCompiling(); }
      showBuildError(msg.type === 'buildError' ? msg.message : null);
      if (msg.type === 'rebuilt' && a) Promise.resolve(a.startApp(true)).then(applyMocks, applyMocks);
    } else if (msg.type === 'restart') {
      if (a) Promise.resolve(a.startApp(true)).then(applyMocks, applyMocks);
    } else if (msg.type === 'mockConfig') {
      mockConfig = msg.config;
      // The mock patch is only injected into the worker when mocks are on as the page loads
      var worker = workerFrame();
      if (mockConfig.active && worker && typeof worker.__updateLyraMockProxyData !== 'function') location.reload();
      else applyMocks();
    } else if (msg.type === 'displays') {
      displays = msg.displays;
      applyPPI();
    }
  }

  // Build errors, over the simulator until the next successful build (the IDE lists them in its log)
  function showBuildError(message) {
    var box = document.getElementById('mp-build-error');
    if (!message) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'mp-build-error';
      box.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;max-height:45%;overflow:auto;z-index:2000;' +
        'padding:10px 12px;border-radius:4px;background:#5a1d1d;border:1px solid #be1100;color:#fff;' +
        'font:12px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,.4)';
      document.body.appendChild(box);
    }
    box.textContent = 'Build failed\n\n' + message;
  }

  // "Physical size" zoom needs the screen's CSS pixels per inch. The server sends each display's
  // size (mm) and layout; the one matching this window's screen gives the PPI.
  var displays = null;
  function applyPPI() {
    if (!displays || !displays.length || !ready()) return;
    var w = screen.width, h = screen.height;
    var match = displays.filter(function (d) { return Math.abs(d.width - w) < 2 && Math.abs(d.height - h) < 2; });
    if (match.length > 1) {
      var inside = match.filter(function (d) { return window.screenX >= d.x && window.screenX < d.x + d.width; });
      if (inside.length) match = inside;
    }
    var display = match[0];
    if (!display) {
      // No size match (e.g. Windows reports centimetres per monitor only): closest aspect ratio
      display = displays.slice().sort(function (a, b) {
        return Math.abs(a.mmWidth / a.mmHeight - w / h) - Math.abs(b.mmWidth / b.mmHeight - w / h);
      })[0];
    }
    if (!(display.mmWidth > 0)) return;
    var ppi = w / (display.mmWidth / 25.4);
    if (Math.abs((container().getData().currentPPI || 0) - ppi) < 0.5) return;
    container().setData({ currentPPI: ppi });
  }

  // <web-view>: the IDE puts a native Electron webview over the page and positions it from these
  // calls; here it's an iframe over the page, placed the same way, whose page gets its JS bridge
  // from webview-proxy.js
  var webviews = {};
  function webviewBridge(id, type, payload) {
    if (api()) api().evaluateJSBridgeInLyra({ apiName: 'postWebViewMessage', id: id, type: type, payload: payload });
  }
  var webviewCalls = {
    openWebview: function (p) {
      if (webviews[p.id]) return;
      // Inside the phone's (zoom-scaled) content, above the pages (z-index 0 layer) and below the
      // layer the app's dialogs and pickers open in (z-index 99), so those show over the web-view
      var layer = document.getElementById('__lyra-phone-content') || document.body;
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;display:none;overflow:hidden;z-index:50;background:#fff';
      var frame = document.createElement('iframe');
      frame.style.cssText = 'position:relative;top:0;left:0;border:none;background:#fff';
      frame.setAttribute('allow', 'camera; microphone; geolocation; clipboard-read; clipboard-write');
      frame.addEventListener('load', function () { webviewBridge(p.id, 'LoadFinish', p.url); });
      wrapper.appendChild(frame);
      layer.appendChild(wrapper);
      webviews[p.id] = { wrapper: wrapper, frame: frame, shown: false, pending: [] };
      // http(s) pages load through the server's proxy, which gives them the JS bridge. The user
      // agent is the one the IDE gives web-view pages: the device's plus " MiniProgram".
      var startupParams = {};
      try { startupParams = JSON.parse(JSON.stringify(p.startupParams || {})); } catch (e) { /* not plain data */ }
      // (absolute: the UI's fetch wrapper takes relative URLs for file access and refuses them)
      var src = !/^https?:/i.test(p.url) ? Promise.resolve(p.url) : fetch(location.origin + '/__webview/open', {
        method: 'POST',
        body: JSON.stringify({ url: p.url, userAgent: p.userAgent ? p.userAgent + ' MiniProgram' : '', startupParams: startupParams }),
      }).then(function (r) { return r.json(); }).then(function (r) { return r.url; }, function () { return p.url; });
      return src.then(function (url) {
        if (!webviews[p.id]) return;
        frame.src = url;
        // The IDE reports "loaded" once its webview exists; the UI then shows and lays it out
        webviewBridge(p.id, 'LoadDone', p.url);
      });
    },
    layoutWebview: function (p) {
      var w = webviews[p.id];
      if (!w) return;
      var i = p.info;
      var titleBar = i.statusAndTitleBarHeight, scroll = i.scrollTop, bottom = Math.max(i.scrollBottom, 0);
      var height = i.isTransparentTitle ? i.height - titleBar : i.height;
      // Same geometry as the IDE, in window pixels…
      var top, boxHeight, frameTop;
      if (titleBar < scroll) {
        top = i.isTransparentTitle ? i.top + scroll : i.top + scroll - titleBar;
        boxHeight = i.isTransparentTitle ? i.height - scroll - bottom : i.height - scroll + titleBar - bottom;
        frameTop = titleBar - scroll;
      } else {
        top = i.isTransparentTitle ? i.top + titleBar : i.top;
        boxHeight = height - bottom;
        frameTop = 0;
      }
      // …converted to the phone content's own (unscaled) pixels, since the overlay is inside it
      var layer = w.wrapper.parentElement;
      var box = layer.getBoundingClientRect();
      var scale = (layer.offsetWidth && box.width / layer.offsetWidth) || 1;
      var px = function (v) { return (v / scale) + 'px'; };
      var s = w.wrapper.style, f = w.frame.style;
      s.top = px(top - box.top);
      s.left = px(i.left - box.left);
      s.width = px(i.width);
      s.height = px(boxHeight);
      if (i.screenRadius) s.borderBottomLeftRadius = s.borderBottomRightRadius = px(i.screenRadius);
      f.position = frameTop ? 'absolute' : 'relative';
      f.top = px(frameTop);
      f.width = px(i.width);
      f.height = px(height);
    },
    showWebview: function (p) {
      var w = webviews[p.id];
      if (!w) return;
      w.wrapper.style.display = 'block';
      // Calls the page made before it first appeared (JSAPIs fail on a page that isn't shown yet)
      if (!w.shown) {
        w.shown = true;
        w.pending.splice(0).forEach(function (call) { call(); });
      }
    },
    hideWebview: function (p) { if (webviews[p.id]) webviews[p.id].wrapper.style.display = 'none'; },
    destoryWebview: function (p) {
      if (!webviews[p.id]) return;
      webviews[p.id].wrapper.remove();
      delete webviews[p.id];
    },
    destroyAllWebviews: function () { Object.keys(webviews).forEach(function (id) { webviewCalls.destoryWebview({ id: id }); }); },
    // The IDE swaps in a screenshot while a dialog covers its native webview; here dialogs already
    // show over the iframe, so nothing is captured and the page stays live
    captureWebview: function () { return null; },
    syncWebviewStore: function () {},
    // From the app to the page: webViewContext.postMessage ({res: {type: 'message'}}) and the results
    // of the page's navigation calls ({callback, res: {type: 'response'}}), already in the form
    // web-view.min.js expects on its "onToWebViewMessage" event
    postMessageToWebview: function (p) {
      var w = webviews[p.id];
      if (!w || !w.frame.contentWindow) return;
      var data = p.msgPayload;
      try { if (typeof data === 'string') data = JSON.parse(data); } catch (e) { /* pass as is */ }
      toWebview(w.frame.contentWindow, { type: 'toWebView', data: data });
    },
    openWebviewDevTool: function () {},
  };

  // Calls from a web-view page's bridge (webview-proxy.js)
  function toWebview(win, msg) {
    try { win.postMessage({ __mpWebviewHost: msg }, '*'); } catch (e) {
      try { win.postMessage({ __mpWebviewHost: JSON.parse(JSON.stringify(msg)) }, '*'); } catch (err) { /* page gone */ }
    }
  }
  function webviewIdFor(source) {
    for (var id in webviews) if (webviews[id].frame.contentWindow === source) return id;
    return null;
  }
  // The render window of the page holding the <web-view>; its bridge runs JSAPIs for that page
  function pageWindowFor(id) {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { if (String(frames[i].contentWindow.APVIEWID) === String(id)) return frames[i].contentWindow; } catch (e) { /* other origin */ }
    }
    return null;
  }
  function onWebviewCall(id, win, m) {
    var params = m.params || {};
    var reply = function (result) { toWebview(win, { type: 'result', callId: m.callId, result: result }); };
    if (m.apiName === 'postWebViewMessage') {
      // my.postMessage, and my.navigateTo/redirectTo/switchTab/reLaunch/navigateBack from the page:
      // to the <web-view> component (onMessage), or carried out by the app
      webviewBridge(id, 'PostMessage', params);
      // Navigation calls carry a callback id; the app doesn't report back (the IDE drops the result
      // too), so answer it as the client does once the navigation is under way
      if (params.callback) toWebview(win, { type: 'toWebView', data: { callback: params.callback, res: { type: 'response', res: { success: true } } } });
      return reply({ success: true });
    }
    if (m.apiName === 'getEmbedWebViewEnv') return reply({ miniprogram: true });
    if (m.apiName === 'onWebViewUrlChange') return reply({});
    // Everything else (alert, showLoading, storage, getLocation, chooseImage, my.call(…)) is a JSAPI
    var pageWin = pageWindowFor(id);
    if (!pageWin || !pageWin.AlipayJSBridge) return reply({ error: 3, errorMessage: 'The page is not available' });
    pageWin.AlipayJSBridge.call(m.apiName, params, reply);
  }
  window.addEventListener('message', function (e) {
    var m = e.data && e.data.__mpWebview;
    if (!m) return;
    var id = webviewIdFor(e.source);
    if (id === null) return;
    var source = e.source;
    try {
      if (m.type === 'call') {
        if (webviews[id].shown) onWebviewCall(id, source, m);
        else webviews[id].pending.push(function () { onWebviewCall(id, source, m); });
      }
      // The page's title in the navigation bar
      else if (m.type === 'title') { var pw = pageWindowFor(id); if (pw && pw.AlipayJSBridge) pw.AlipayJSBridge.call('setTitle', { title: m.title }, function () {}); }
      else if (m.type === 'loadFail') webviewBridge(id, 'LoadFail', m.url);
    } catch (err) { /* ignore */ }
  });
  function hookWebviews(keeper) {
    Object.keys(webviewCalls).forEach(function (name) {
      keeper[name] = function (params) {
        try { return Promise.resolve(webviewCalls[name](params || {})); } catch (e) { return Promise.resolve(null); }
      };
    });
  }

  // "Responsive" zoom is only computed when the UI starts, so the phone clips (or ends up negative
  // after starting in a hidden view) when the view is resized. Recompute it the way the UI's zoom
  // plugin applies it (scale + zoom, no app restart).
  function applyAutoZoom() {
    var store = container().getStore();
    if (!store.isAutoZooming) return;
    // The phone fills the page, keeping its aspect ratio: the smaller of the zoom the height allows
    // (the UI's own figure) and the one the width allows (the page is at least MIN_WIDTH wide, 20px
    // padding as the UI uses). Only the screen scales; the bezel around it keeps its size.
    var zoom = container().getAutoZoomByHeight() / 100;
    var shell = document.getElementById('__lyra-simulator-content');
    var screen = document.getElementById('__lyra-phone-content');
    if (shell && screen && screen.offsetWidth) {
      var bezel = shell.getBoundingClientRect().width - screen.getBoundingClientRect().width;
      var fit = (Math.max(window.innerWidth, MIN_WIDTH) - 20 - bezel) / screen.offsetWidth;
      if (fit > 0 && fit < zoom) zoom = fit;
    }
    if (!(zoom > 0) || Math.abs(zoom - store.zoom) < 0.005) return;
    container().setData({ scale: zoom });
    container().patchStore({ zoom: zoom });
  }

  // Theme from VS Code (relayed by the webview): light/dark plus colors, applied like the IDE does
  var pendingTheme = null;
  function applyTheme() {
    if (!pendingTheme || !ready()) return;
    var t = pendingTheme;
    pendingTheme = null;
    api().updateIDEState({ theme: t.theme, themeVars: t.vars });
    var style = document.getElementById('mp-vscode-font') || document.head.appendChild(document.createElement('style'));
    style.id = 'mp-vscode-font';
    // Text only: icons are drawn with an icon font (vol-iconfont → "volansIcon") and must keep it
    var text = ':not([class*="iconfont"]):not(.anticon)';
    style.textContent = ['.simulator-topbar', '.simulator-toolbar', '.ant-select-dropdown', '.ant-dropdown', '.ant-tooltip']
      .map(function (s) { return s + text + ', ' + s + ' *' + text; }).join(', ') +
      ' { font-family: ' + t.fontFamily + ' !important; }';
  }
  window.addEventListener('message', function (e) {
    if (e.source === window.parent && e.data && e.data.type === 'mp-theme') { pendingTheme = e.data; applyTheme(); }
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      try { if (ready()) applyAutoZoom(); } catch (e) { /* ignore */ }
    }, 150);
  });

  // Once the UI is up: fit the phone to the view, apply any theme
  var start = setInterval(function () {
    if (!ready() || !document.getElementById('__lyra-simulator-content')) return;
    clearInterval(start);
    // The UI reapplies its own zoom (device change, app start…) and then reports a resize
    var keeper = api().stateKeeper;
    var report = keeper.reportContainerEvent.bind(keeper);
    keeper.reportContainerEvent = function (event) {
      if (event && event.name === 'resize') setTimeout(function () { try { applyAutoZoom(); } catch (e) { /* ignore */ } }, 0);
      return report(event);
    };
    applyAutoZoom();
    applyTheme();
    applyPPI();
  }, 200);

  // The UI's <web-view> component calls these on the state keeper, which is created before the app
  // starts; replace them as soon as it exists
  var hookTimer = setInterval(function () {
    if (!api() || !api().stateKeeper) return;
    clearInterval(hookTimer);
    hookWebviews(api().stateKeeper);
  }, 20);
}
const PAGE_SCRIPT = `<script>(${pageScript.toString()})()</script>`;

const SERVICE_NODE = path.join(UI_DIR, 'lyra.node.js');

function hasUi() {
  return fs.existsSync(path.join(UI_DIR, 'index.html')) && fs.existsSync(SERVICE_NODE);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// Runs the IDE's service node (vendor/lyra-ui/lyra.node.js), the HTTP + WebSocket backend this UI
// expects; minidev's own is HTTP-only, which leaves the UI half-started (no reload, health-check loop).
// It's started through service-node-wrapper.js, which exits when its stdin closes (so it dies with
// the worker) and applies the network emulation sent on stdin.
async function startServiceNode() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'service-node-wrapper.js'), SERVICE_NODE], {
    cwd: UI_DIR, env: { ...process.env, PORT: String(port) }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const service = {
    endpoint,
    setNetwork: (condition) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ network: condition })}\n`); },
    close: () => child.kill(),
  };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Simulator service node exited (code ${child.exitCode})`);
    try {
      const res = await fetch(`${endpoint}/__lyraHealthCheck`);
      if (res.ok) return service;
    } catch (e) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Simulator service node did not start within 10s');
}

function readInside(dir, relPath) {
  const full = path.join(dir, relPath);
  if (!full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return fs.readFileSync(full);
}

// minidev writes the compiled app to a subfolder of build.dist (e.g. "ng-main")
function outputDir(build) {
  if (!fs.existsSync(build.dist)) return null;
  const sub = fs.readdirSync(build.dist).find((d) => fs.existsSync(path.join(build.dist, d, 'appConfig.json')));
  return sub ? path.join(build.dist, sub) : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// compileMode: the selected entry of the IDE's .mini-ide/compileMode.json ({title, page, pageQuery,
// query, debugAppxSceneCode, chInfo, referrerAppId, referrerExtraData}), or null for a normal compile.
// onMessage receives what the UI asks of the IDE: {type: 'openPage' | 'showLog' | 'restartBuild'}.
// The machine's IPv4 addresses, as the IDE reports them to the simulator
function dhcpInfos() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => ({ address: i.address, type: 'IPv4', netmask: i.netmask }));
}

// appId: the mini program's App ID if known (used for the app's file sandbox and getAccountInfoSync)
async function startLyraUiServer({ build, projectPath, language, theme, compileMode = null, appId = '', onMessage = () => {} }) {
  const serviceNode = await startServiceNode();
  const devtoolsOn = hasDevtools();
  const devtoolsToken = crypto.randomBytes(8).toString('hex');
  const devtools = devtoolsOn ? createDevtoolsRouter(devtoolsToken) : null;
  let port;
  // The UI caches the app's files by this hash, so it must change on every rebuild
  let buildHash = String(Date.now());
  let buildError = null;
  let network = null;
  let displays = null;
  const storage = new Map();
  const base = () => `http://127.0.0.1:${port}`;
  // <web-view> pages, proxied to give them the JS bridge (created on first use)
  let webviewProxy = null;
  const getWebviewProxy = () => webviewProxy || (webviewProxy = createWebviewProxy({
    appxDir: fs.existsSync(path.join(APPX_NG_DIR, 'web-view.min.js')) ? APPX_NG_DIR : path.join(UI_DIR, 'appx'),
    rejectUnauthorized: () => !projectLaunchParams().ignoreCertificateDomainCheck,
  }));

  // The worker agent and its console flag go in front of index.worker.js, so its source map needs
  // the same number of extra lines to still point at the right code (breakpoints in the debugger)
  // Our agent for the MCP server comes first, so the DevTools agent's console capture wraps it
  const workerPrefix = Buffer.concat([
    Buffer.from(WORKER_AGENT),
    ...(devtoolsOn ? [
      Buffer.from('self.__BUGME_CONSOLE_ENABLE__ = true;\n'),
      fs.readFileSync(path.join(DEVTOOLS_DIR, 'bugme', 'worker-remote.js')),
      Buffer.from('\n;\n'),
    ] : []),
  ]);
  const workerPrefixLines = workerPrefix.toString().split('\n').length - 1;

  // The project's IDE settings (Details → "ignore … domain check") the simulator honours
  function projectLaunchParams() {
    const prefs = readJson(path.join(projectPath, '.mini-ide', 'project-ide.json')) || {};
    return {
      ignoreHttpReqPermission: Boolean(prefs.ignoreHttpDomainCheck),
      ignoreWebViewDomainCheck: Boolean(prefs.ignoreWebViewDomainCheck),
      ignoreCertificateDomainCheck: Boolean(prefs.ignoreCertificateDomainCheck),
    };
  }

  // API mocks ({active, rules}), edited in the Mock view. The IDE keeps them in its own storage; here
  // they live in the project so they can be shared. The rules are applied by the IDE's mock patch,
  // which the simulator injects into the app's worker when mocks are active at start-up.
  const mockFile = path.join(projectPath, '.mini-ide', 'mockConfig.json');
  function readMockConfig() {
    const config = readJson(mockFile);
    return config && Array.isArray(config.rules) ? { active: Boolean(config.active), rules: config.rules } : { active: false, rules: [] };
  }

  // Scene and referrer from the compile mode, as the IDE adds them to the package info
  function compileModeLaunchParams() {
    const mode = compileMode || {};
    const params = {};
    if (mode.chInfo) params.chInfo = mode.chInfo;
    if (mode.debugAppxSceneCode) params.debugAppxSceneCode = String(mode.debugAppxSceneCode);
    if (mode.referrerAppId) {
      params.referrerInfo = JSON.stringify({ appId: mode.referrerAppId, ...(mode.referrerExtraData ? { extraData: mode.referrerExtraData } : {}) });
    }
    return params;
  }

  // Start page and its query (onLoad) from the compile mode, else the app's first page
  function startPage(out) {
    const mode = compileMode || {};
    const appConfig = out && readJson(path.join(out, 'appConfig.json'));
    const page = mode.page || (appConfig && appConfig.pages[0]);
    if (!page) return null;
    return { page, pageWithQuery: mode.pageQuery ? `${page}?${mode.pageQuery}` : page };
  }

  // Launch params the UI merges over its defaults, which otherwise start at pages/index/index
  function launchParams() {
    const start = startPage(outputDir(build));
    return {
      ...(start ? { url: `/index.html#${start.pageWithQuery}`, page: start.pageWithQuery, launchParamsTag: start.page } : {}),
      query: (compileMode && compileMode.query) || '',
      ...projectLaunchParams(), ...compileModeLaunchParams(),
    };
  }

  // Package metadata the UI reads first; minidev generates it on the fly, so it's built from appConfig.json
  function packageInfoV2(out) {
    const mode = compileMode || {};
    // Start page, and the global query (onLaunch), from the compile mode
    const { pageWithQuery } = startPage(out);
    return {
      appInfo: {
        deployVersion: 'dev', developerVersion: 'dev', mainUrl: `/index.html#${pageWithQuery}`, packageUrl: `${base()}/`,
        plugins: [], pluginList: [], templateConfig: {}, vhost: 'https://devAppId.hybrid.alipay-eco.com',
      },
      extendInfo: {
        launchParams: {
          // minidev writes the tab bar to its own file, not appConfig.json
          enableTabBar: fs.existsSync(path.join(out, 'tabBar.json')) ? 'YES' : 'NO',
          enableJSC: 'YES', page: pageWithQuery, enableKeepAlive: 'NO', enableWK: 'YES',
          appxRouteFramework: 'YES', appxRouteBizPrefix: '', bugmeNext: false, query: mode.query || '', devserverHost: base(),
          ...projectLaunchParams(), ...compileModeLaunchParams(),
        },
      },
      // With an error the UI's restart button restarts the build instead of the app
      buildContext: { hasError: Boolean(buildError), hash: buildHash },
    };
  }

  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const send = (data, ext) => {
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(data);
    };

    if (pathname.startsWith('/lyra/')) {
      const rel = pathname.slice('/lyra/'.length);
      // Newer appx-ng runtime (from the IDE's simulator lib) instead of the UI's own older copy
      let data = (rel.startsWith('appx-ng/') && readInside(APPX_NG_DIR, rel.slice('appx-ng/'.length))) || readInside(UI_DIR, rel);
      if (!data) { res.writeHead(404); return res.end(); }
      if (/\.(html|js|css)$/.test(rel)) {
        // The IDE build loads its files via Electron's lyra-resource:// protocol
        let text = data.toString().split('lyra-resource://').join(`${base()}/lyra/`);
        if (rel === 'index.html') text = text.replace('</body>', `${PAGE_SCRIPT}</body>`);
        data = text;
      }
      return send(data, path.extname(rel));
    }

    if (pathname === '/__webview/open' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', async () => {
        try {
          send(JSON.stringify({ url: await getWebviewProxy().open(JSON.parse(body)) }), '.json');
        } catch (e) {
          res.writeHead(400);
          res.end(String(e.message || e));
        }
      });
      return undefined;
    }
    if (pathname === '/__devtools/status' && devtools) return send(JSON.stringify(devtools.status()), '.json');
    if (pathname.startsWith('/__devtools/')) {
      const data = readInside(DEVTOOLS_DIR, pathname.slice('/__devtools/'.length));
      if (!data) { res.writeHead(404); return res.end(); }
      return send(data, path.extname(pathname));
    }

    const out = outputDir(build);
    if (!out) { res.writeHead(503); return res.end('build not ready'); }
    if (pathname === '/packageInfoV2.json') return send(JSON.stringify(packageInfoV2(out)), '.json');
    let data = readInside(out, pathname.slice(1));
    if (!data) { res.writeHead(404); return res.end(); }
    // DevTools agents: the UI gives each page and the worker the router URL; the IDE injects the
    // agent scripts itself, so do the same (page: Elements; worker: Console, AppData, Storage…)
    if (devtoolsOn && pathname === '/index.html') {
      // Before the render framework, as the IDE does: the agent connects on the page's first
      // "resume" event, which fires before scripts at the end of <body> run
      const agent = '<script src="/__devtools/bugme/render-uniweb.js"></script>';
      const html = data.toString();
      const appx = html.indexOf('<script src="https://appx/af-appx.min.js');
      data = appx >= 0 ? html.slice(0, appx) + agent + html.slice(appx) : html.replace('</head>', `${agent}</head>`);
    } else if (pathname === '/index.worker.js') {
      // Our agent for the MCP server, then (with DevTools) the BugMe agent: the IDE's Console comes
      // from a V8 debugger attached to the worker; there's none here, so the agent captures console
      // calls instead (it only does when its flag is set)
      data = Buffer.concat([workerPrefix, data]);
    } else if (pathname === '/index.worker.js.map') {
      try {
        const map = JSON.parse(data);
        map.mappings = ';'.repeat(workerPrefixLines) + map.mappings;
        data = JSON.stringify(map);
      } catch (e) { /* serve as is */ }
    }
    send(data, path.extname(pathname));
  });

  const events = new WebSocketServer({ noServer: true });
  const broadcast = (msg) => {
    const text = JSON.stringify(msg);
    events.clients.forEach((ws) => ws.send(text));
  };
  // Mock changes go to the page, which applies them to the running app
  const onMockFileChange = (now, before) => { if (now.mtimeMs !== before.mtimeMs) broadcast({ type: 'mockConfig', config: readMockConfig() }); };
  fs.watchFile(mockFile, { interval: 500 }, onMockFileChange);
  // A page that (re)connects gets the current state
  // The launch settings in effect (compile mode or an MCP launch), for the page's MCP answers
  const launchInfo = () => {
    const mode = compileMode || {};
    return { title: mode.title || null, page: mode.page || '', pageQuery: mode.pageQuery || '', query: mode.query || '', scene: mode.debugAppxSceneCode || '' };
  };
  // MCP requests to the page, answered on the same socket (the newest connected page answers)
  const pending = new Map();
  let requestSeq = 0;
  let latestPage = null;
  function callPage(method, params, timeoutMs = 10000) {
    const ws = latestPage;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('The simulator page is not open (it may still be loading).'));
    const id = ++requestSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The simulator did not answer ${method} in time.`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'mcp', id, method, params }));
    });
  }
  events.on('connection', (ws) => {
    latestPage = ws;
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      const waiting = msg && msg.type === 'mcpResult' && pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);
      clearTimeout(waiting.timer);
      if (msg.error) waiting.reject(new Error(msg.error)); else waiting.resolve(msg.result);
    });
    ws.on('close', () => { if (latestPage === ws) latestPage = null; });
    ws.send(JSON.stringify({ type: 'launch', launch: launchInfo() }));
    if (buildError) ws.send(JSON.stringify({ type: 'buildError', message: buildError }));
    if (displays) ws.send(JSON.stringify({ type: 'displays', displays }));
    ws.send(JSON.stringify({ type: 'mockConfig', config: readMockConfig() }));
  });

  const devServerConfig = () => ({ host: '127.0.0.1', port });
  const answers = {
    getDefaultState: () => ({
      language, theme, mode: 'embed', autoRefresh: true, sticky: false, touchEmulateEnabled: true,
      // What the app stored (my.setStorage, the simulator's own settings), so it survives a page reload
      storage: Object.fromEntries([...storage].filter(([, value]) => value !== null && value !== undefined)),
      isInner: false, isLite: false, extensionModuleConfig: {}, sceneConfig: {},
      // As the IDE passes them when no one is logged in. JSAPIs read these from the bridge state:
      // the file APIs, downloadFile, getClipboard and getLocation fail without appConfig/userInfo.
      userInfo: {}, certInfo: {}, httpWhiteList: [], dhcpInfos: dhcpInfos(), isWidgetProject: false,
      appConfig: { appId, appName: path.basename(projectPath), appVersion: 'dev', iconUrl: '', appType: 'alipay', clientName: 'Alipay' },
      rejectUnauthorized: !projectLaunchParams().ignoreCertificateDomainCheck,
      // Compile mode "simulate an update on the next compile" (my.getUpdateManager)
      appUpdate: Boolean(compileMode && compileMode.update),
      enableNoMock: false, enableSettings: true, enableVerboseLogger: false, switchConfigData: {}, trackerConfig: {},
      appxConfig: {}, projectConfig: { projectPath }, networkEmulationCondition: network, devServerConfig: devServerConfig(),
      // Turns on the UI's BugMe hooks, which point the agents at our DevTools router
      ...(devtoolsOn ? { devToolsConfig: { tinybugmeRenderPath: '', tinybugmeWorkerPath: '', localServerPort: port } } : {}),
    }),
    getServiceNodeEndpoint: () => serviceNode.endpoint,
    getDevServerConfig: devServerConfig,
    devServerReady: () => Boolean(outputDir(build)),
    getLaunchParams: launchParams,
    // Toolbar restart while the build has errors, and the compiling overlay's "View log"
    restartDevServer: () => onMessage({ type: 'restartBuild' }),
    reload: () => onMessage({ type: 'restartBuild' }),
    showLog: () => onMessage({ type: 'showLog' }),
    // Toolbox → Network: WiFi, 5G, 4G, 3G
    setNetworkEmulationCondition: (condition) => {
      network = condition || null;
      serviceNode.setNetwork(network);
    },
    // Clicking the page path opens that page's source in the IDE
    reportContainerEvent: (event) => {
      if (event && event.name === 'currentPageClick' && event.payload) onMessage({ type: 'openPage', path: String(event.payload) });
    },
    getAppMeta: () => ({ cdnBaseUrl: `${base()}/` }),
    getAppConfig: () => ({ cdnBaseUrl: `${base()}/` }),
    getTheme: () => theme,
    getMockConfig: () => readMockConfig(),
    checkIsInner: () => false,
    // In memory for this simulator session (the IDE keeps it on disk)
    getStorage: (key) => storage.get(key),
    hasStorage: (key) => storage.has(key) && storage.get(key) !== null,
    setStorage: (item) => { if (item && typeof item.key === 'string') storage.set(item.key, item.value); },
  };

  const rpc = new WebSocketServer({ noServer: true });
  rpc.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      const { token, protocol, method, args, callbackId } = msg;
      if (token !== TOKEN || protocol !== 'lyra-rpc://') return;
      // MP_RPC_LOG=1 lists the calls, marking those without an answer (for finding missing ones)
      if (process.env.MP_RPC_LOG) console.log(`[rpc] ${answers[method] ? '' : '(unanswered) '}${method} ${JSON.stringify(args === undefined ? null : args).slice(0, 200)}`);
      let data = null;
      try { data = answers[method] ? await answers[method](args) : null; } catch (e) { /* answer null */ }
      ws.send(JSON.stringify({ callbackId, data: data === undefined ? null : data }));
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (devtools && devtools.handles(pathname)) return devtools.handleUpgrade(req, socket, head);
    const target = pathname === '/rpc' ? rpc : pathname === '/events' ? events : null;
    if (!target) return socket.destroy();
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => { serviceNode.close(); reject(err); });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      const query = new URLSearchParams({ __lyra_internal_endPoint: `ws://127.0.0.1:${port}/rpc`, __lyra_internal_token: TOKEN, theme });
      resolve({
        url: `${base()}/lyra/index.html?${query}`,
        // Same page and parameters the IDE uses; the front end connects to ws://<ws>?_token=<token>
        devtoolsUrl: devtoolsOn ? `${base()}/__devtools/${FRONT_END_PAGE}?${new URLSearchParams({
          ws: `127.0.0.1:${port}`, _token: devtoolsToken, env: 'kaitian', lang: language, theme,
          project: path.basename(projectPath), hideMockPanel: 'true', winmode: 'full',
          // Sources, Performance and Profiler need a V8 debugger on the page, which a webview doesn't
          // give; debugging runs through VS Code's debugger instead (Miniprogram: Debug Simulator)
          blockPanels: JSON.stringify(['source', 'performance', 'profiler']),
          projectId: crypto.createHash('sha1').update(projectPath).digest('hex'),
        })}` : null,
        notifyCompiling: () => broadcast({ type: 'compiling' }),
        notifyRebuilt: () => {
          buildHash = String(Date.now());
          buildError = null;
          broadcast({ type: 'rebuilt' });
        },
        notifyBuildError: (message) => {
          buildError = message || 'Unknown error';
          broadcast({ type: 'buildError', message: buildError });
        },
        // Restart the app on the new compile mode (new hash, so the package info is fetched again)
        setCompileMode: (mode) => {
          compileMode = mode || null;
          buildHash = String(Date.now());
          broadcast({ type: 'launch', launch: launchInfo() });
          broadcast({ type: 'restart' });
        },
        restartApp: () => broadcast({ type: 'restart' }),
        callPage,
        setDisplays: (list) => {
          displays = list;
          broadcast({ type: 'displays', displays });
        },
        // After the dev server was restarted: serve the new one's output
        setBuild: (next) => { build = next; },
        close: () => {
          fs.unwatchFile(mockFile, onMockFileChange);
          rpc.close(); events.close(); if (devtools) devtools.close(); if (webviewProxy) webviewProxy.close();
          server.close(); serviceNode.close();
        },
      });
    });
  });
}

module.exports = { hasUi, startLyraUiServer };
