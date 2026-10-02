const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// "API Mock" view (bottom panel): edits the project's .mini-ide/mockConfig.json, {active, rules}, which
// the simulator applies live through the IDE's mock patch. A rule:
//   {uid, name, active, api, match: [{type: 'full'|'regex'|'path', name, value}], response: {success, payload}}
// `api` is a my.* API name (request, getLocation…) or, for my.call('name', params, callback), that name.
// match compares fields of the call's params (full: equal, regex: RegExp.test, path: lodash-style path equal).

// The APIs the IDE's mock panel offers
const BUILTIN_APIS = ['getAuthCode', 'getAuthUserInfo', 'tradePay', 'getOpenUserInfo', 'getPhoneNumber', 'getIDNumber', 'getSetting', 'openSetting', 'showAuthGuide', 'addCardAuth', 'zmCreditBorrow', 'openChatWindow', 'chooseAddress', 'openTaobao', 'chooseInvoiceTitle', 'prompt', 'confirm', 'choosePhoneContact', 'chooseContact', 'chooseCity', 'datePicker', 'pageScrollTo', 'hideKeyboard', 'hideAllAddToDesktopMenu', 'hideAddToDesktopMenu', 'hideAllFavoriteMenu', 'hideFavoriteMenu', 'hideShareMenu', 'showBackToHomepage', 'setCustomPopMenu', 'setBackButton', 'setBackgroundColor', 'getNetworkType', 'getSystemInfo', 'getSystemInfoSync', 'getServerTime', 'watchShake', 'vibrate', 'vibrateLong', 'vibrateShort', 'makePhoneCall', 'setClipboard', 'getClipboard', 'setKeepScreenOn', 'getScreenBrightness', 'setScreenBrightness', 'isLowPowerMode', 'getBatteryInfo', 'getBatteryInfoSync', 'getCarrierName', 'httpRequest', 'uploadFile', 'request', 'rpc', 'downloadFile', 'connectSocket', 'sendSocketMessage', 'closeSocket', 'chooseImage', 'previewImage', 'saveImage', 'compressImage', 'chooseVideo', 'saveVideoToPhotosAlbum', 'startRecord', 'stopRecord', 'cancelRecord', 'playVoice', 'pauseVoice', 'resumeVoice', 'stopVoice', 'getLocation', 'openLocation', 'chooseLocation', 'setStorage', 'getStorage', 'removeStorage', 'clearStorage', 'getStorageInfo', 'setStorageSync', 'getStorageSync', 'removeStorageSync', 'clearStorageSync', 'getStorageInfoSync'];

const { mockFile, readConfig, writeConfig } = require('./mock-config');

// Names passed to my.call('name', …) in the project's scripts
async function findCallNames(projectPath) {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(projectPath, '**/*.{js,ts,sjs}'), '**/node_modules/**', 2000);
  const names = new Set();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file.fsPath, 'utf8'); } catch (e) { continue; }
    for (const m of text.matchAll(/\bmy\.call\(\s*['"`]([\w.$-]+)['"`]/g)) names.add(m[1]);
  }
  return [...names].sort();
}

function registerMockView(context, getProjectPath) {
  let view = null;
  let lastWritten = null;

  async function load() {
    if (!view) return;
    const projectPath = getProjectPath();
    if (!projectPath) {
      view.webview.postMessage({ type: 'noProject' });
      return;
    }
    view.webview.postMessage({
      type: 'load',
      config: readConfig(projectPath),
      apis: { calls: await findCallNames(projectPath), builtin: BUILTIN_APIS },
      file: path.relative(projectPath, mockFile(projectPath)),
    });
  }

  function save(config) {
    const projectPath = getProjectPath();
    if (!projectPath) return;
    lastWritten = writeConfig(projectPath, config);
  }

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('miniprogram.mock', {
    resolveWebviewView(webviewView) {
      view = webviewView;
      view.webview.options = { enableScripts: true };
      view.onDidDispose(() => { view = null; });
      view.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'ready' || msg.type === 'refresh') load();
        else if (msg.type === 'save') save(msg.config);
        else if (msg.type === 'openJson') {
          const projectPath = getProjectPath();
          if (!projectPath) return;
          if (!fs.existsSync(mockFile(projectPath))) save(readConfig(projectPath));
          vscode.window.showTextDocument(vscode.Uri.file(mockFile(projectPath)));
        }
      });
      view.webview.html = mockHtml();
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  // Edits made elsewhere (the JSON file, git) show up in the view; its own saves don't re-render it
  const watcher = vscode.workspace.createFileSystemWatcher('**/.mini-ide/mockConfig.json');
  const onChange = (uri) => {
    const projectPath = getProjectPath();
    if (!projectPath || uri.fsPath !== mockFile(projectPath)) return;
    let text = null;
    try { text = fs.readFileSync(uri.fsPath, 'utf8'); } catch (e) { /* deleted */ }
    if (text !== lastWritten) load();
  };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  return {
    show: () => {
      if (view) view.show(true);
      else vscode.commands.executeCommand('workbench.view.extension.miniprogramMock');
    },
  };
}

function mockHtml() {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; padding: 0; }
  header { display: flex; align-items: center; gap: 12px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  header .spacer { flex: 1; }
  .muted { color: var(--vscode-descriptionForeground); }
  main { display: flex; min-height: 0; height: calc(100vh - 37px); }
  #list { width: 240px; flex: none; overflow-y: auto; border-right: 1px solid var(--vscode-panel-border); }
  #editor { flex: 1; overflow-y: auto; padding: 8px 12px; min-width: 0; }
  .rule { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; }
  .rule:hover { background: var(--vscode-list-hoverBackground); }
  .rule.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .rule .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rule .api { opacity: .75; font-family: var(--vscode-editor-font-family); font-size: 0.92em; }
  .rule.off .text { opacity: .5; }
  label.field { display: block; margin: 8px 0 3px; font-weight: 600; }
  input[type=text], select, textarea { font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 3px 6px; box-sizing: border-box; }
  input[type=text]:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  textarea { width: 100%; min-height: 110px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); resize: vertical; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .grow { flex: 1; min-width: 0; }
  button { font-family: inherit; font-size: inherit; padding: 3px 10px; border: none; border-radius: 2px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.icon { background: transparent; color: var(--vscode-foreground); padding: 2px 6px; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  .hint { color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
  .error { color: var(--vscode-errorForeground); margin: 3px 0 0; }
  .empty { padding: 12px; color: var(--vscode-descriptionForeground); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
<header>
  <label><input type="checkbox" id="active"> Mocks on</label>
  <span class="muted" id="status"></span>
  <span class="spacer"></span>
  <button id="add">Add rule</button>
  <a id="json">Edit JSON</a>
</header>
<main>
  <div id="list"></div>
  <div id="editor"></div>
</main>
<datalist id="apis"></datalist>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let config = { active: false, rules: [] };
  let apis = { calls: [], builtin: [] };
  let selected = null;
  const payloadText = new Map();   // the payload as typed, kept while it isn't valid JSON
  const $ = (id) => document.getElementById(id);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => vscode.postMessage({ type: 'save', config }), 300);
    renderStatus();
  }
  function renderStatus() {
    const on = config.rules.filter((r) => r.active).length;
    $('status').textContent = config.rules.length ? on + ' of ' + config.rules.length + ' rules on' : '';
  }
  const rule = () => config.rules.find((r) => r.uid === selected);

  function renderList() {
    $('active').checked = config.active;
    if (!config.rules.length) {
      $('list').innerHTML = '<div class="empty">No rules yet.</div>';
      return;
    }
    $('list').innerHTML = config.rules.map((r) =>
      '<div class="rule' + (r.uid === selected ? ' selected' : '') + (r.active ? '' : ' off') + '" data-uid="' + esc(r.uid) + '">' +
      '<input type="checkbox" data-toggle="' + esc(r.uid) + '"' + (r.active ? ' checked' : '') + ' title="Rule on">' +
      '<span class="text">' + esc(r.name || 'Unnamed rule') + ' <span class="api">' + esc(r.api) + '</span></span></div>').join('');
    renderStatus();
  }

  function renderEditor() {
    const r = rule();
    if (!r) {
      $('editor').innerHTML = '<div class="empty">' + (config.rules.length ? 'Select a rule.' :
        'Add a rule to return your own result for a my.* API or a my.call(\\'name\\') the simulator can\\'t run. ' +
        'Rules apply to the running simulator right away.') + '</div>';
      return;
    }
    const text = payloadText.has(r.uid) ? payloadText.get(r.uid) : JSON.stringify(r.response && r.response.payload !== undefined ? r.response.payload : {}, null, 2);
    const success = !r.response || r.response.success !== false;
    $('editor').innerHTML =
      '<div class="row"><input type="text" class="grow" id="name" placeholder="Rule name" value="' + esc(r.name) + '">' +
      '<button class="secondary" id="dup">Duplicate</button><button class="secondary" id="del">Delete</button></div>' +
      '<label class="field" for="api">API</label>' +
      '<input type="text" id="api" list="apis" style="width:100%" placeholder="request, getLocation… or the name given to my.call" value="' + esc(r.api) + '">' +
      '<p class="hint">For <code>my.call(\\'name\\', params, callback)</code>, enter <code>name</code>.</p>' +
      '<label class="field">Only when the params match <span class="muted">(all conditions; none = every call)</span></label>' +
      '<div id="match"></div><button class="secondary" id="addMatch">Add condition</button>' +
      '<label class="field">Result</label>' +
      '<div class="row"><select id="success"><option value="1"' + (success ? ' selected' : '') + '>Success (success callback)</option>' +
      '<option value="0"' + (success ? '' : ' selected') + '>Fail (fail callback)</option></select></div>' +
      '<label class="field" for="payload">Returned data (JSON)</label>' +
      '<textarea id="payload" spellcheck="false">' + esc(text) + '</textarea><div class="error" id="payloadError"></div>';
    renderMatch();
    validatePayload();
  }

  function renderMatch() {
    const r = rule();
    $('match').innerHTML = (r.match || []).map((m, i) =>
      '<div class="row" data-i="' + i + '">' +
      '<select data-k="type"><option value="full"' + (m.type === 'full' ? ' selected' : '') + '>equals</option>' +
      '<option value="regex"' + (m.type === 'regex' ? ' selected' : '') + '>matches regex</option>' +
      '<option value="path"' + (m.type === 'path' ? ' selected' : '') + '>path equals</option></select>' +
      '<input type="text" data-k="name" placeholder="param, e.g. url" value="' + esc(m.name) + '">' +
      '<input type="text" class="grow" data-k="value" placeholder="value" value="' + esc(m.value) + '">' +
      '<button class="icon" data-remove="' + i + '" title="Remove">✕</button></div>').join('');
  }

  function validatePayload() {
    const r = rule();
    const box = $('payload');
    if (!r || !box) return;
    try {
      const payload = box.value.trim() ? JSON.parse(box.value) : {};
      payloadText.delete(r.uid);
      $('payloadError').textContent = '';
      return { ok: true, payload };
    } catch (e) {
      payloadText.set(r.uid, box.value);
      $('payloadError').textContent = 'Not valid JSON, not saved: ' + e.message;
      return { ok: false };
    }
  }

  function renderApis() {
    const opts = apis.calls.map((n) => '<option value="' + esc(n) + '">my.call in your code</option>')
      .concat(apis.builtin.map((n) => '<option value="' + esc(n) + '">my.' + esc(n) + '</option>'));
    $('apis').innerHTML = opts.join('');
  }

  function addRule(api) {
    const r = { uid: uid(), name: '', active: true, api: api || 'request', match: [], response: { success: true, payload: {} } };
    config.rules.push(r);
    selected = r.uid;
    renderList(); renderEditor(); save();
    setTimeout(() => { const name = $('name'); if (name) name.focus(); }, 0);
  }

  // --- events ---
  $('active').addEventListener('change', (e) => { config.active = e.target.checked; save(); });
  // A new rule starts on the first my.call name in the code that has no rule yet
  $('add').addEventListener('click', () => addRule(apis.calls.find((n) => !config.rules.some((r) => r.api === n)) || 'request'));
  $('json').addEventListener('click', () => vscode.postMessage({ type: 'openJson' }));
  $('list').addEventListener('click', (e) => {
    const toggle = e.target.getAttribute('data-toggle');
    if (toggle) {
      const r = config.rules.find((x) => x.uid === toggle);
      r.active = e.target.checked; renderList(); save();
      return;
    }
    const item = e.target.closest('.rule');
    if (item) { selected = item.getAttribute('data-uid'); renderList(); renderEditor(); }
  });
  $('editor').addEventListener('input', (e) => {
    const r = rule(); if (!r) return;
    const t = e.target;
    if (t.id === 'name') { r.name = t.value; renderList(); }
    else if (t.id === 'api') { r.api = t.value.trim().replace(/^my\\./, ''); renderList(); }
    else if (t.id === 'payload') {
      const v = validatePayload();
      if (!v.ok) return;
      r.response = { success: r.response ? r.response.success !== false : true, payload: v.payload };
    } else if (t.getAttribute('data-k')) {
      const i = Number(t.closest('.row').getAttribute('data-i'));
      r.match[i][t.getAttribute('data-k')] = t.value;
    } else return;
    save();
  });
  $('editor').addEventListener('change', (e) => {
    const r = rule(); if (!r) return;
    if (e.target.id === 'success') {
      r.response = Object.assign({}, r.response, { success: e.target.value === '1' });
      save();
    } else if (e.target.getAttribute('data-k') === 'type') {
      const i = Number(e.target.closest('.row').getAttribute('data-i'));
      r.match[i].type = e.target.value; save();
    }
  });
  $('editor').addEventListener('click', (e) => {
    const r = rule(); if (!r) return;
    if (e.target.id === 'del') {
      config.rules = config.rules.filter((x) => x.uid !== r.uid);
      selected = config.rules.length ? config.rules[0].uid : null;
      renderList(); renderEditor(); save();
    } else if (e.target.id === 'dup') {
      const copy = JSON.parse(JSON.stringify(r)); copy.uid = uid(); copy.name = (r.name || 'Unnamed rule') + ' (copy)';
      config.rules.splice(config.rules.indexOf(r) + 1, 0, copy); selected = copy.uid;
      renderList(); renderEditor(); save();
    } else if (e.target.id === 'addMatch') {
      r.match = r.match || []; r.match.push({ type: 'full', name: r.api === 'request' ? 'url' : '', value: '' });
      renderMatch(); save();
    } else if (e.target.getAttribute('data-remove') !== null) {
      r.match.splice(Number(e.target.getAttribute('data-remove')), 1); renderMatch(); save();
    }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'load') {
      config = msg.config; apis = msg.apis;
      config.rules.forEach((r) => { if (!r.uid) r.uid = uid(); if (!Array.isArray(r.match)) r.match = []; });
      if (!config.rules.some((r) => r.uid === selected)) selected = config.rules.length ? config.rules[0].uid : null;
      payloadText.clear();
      renderApis(); renderList(); renderEditor(); renderStatus();
      $('json').title = msg.file;
    } else if (msg.type === 'noProject') {
      $('list').innerHTML = ''; $('editor').innerHTML = '<div class="empty">Open a mini program folder to set up API mocks.</div>';
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { registerMockView };
