const vscode = require('vscode');
const { fork, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { registerMockView } = require('./mock-view');
const { registerPageMap } = require('./page-map-view');
const { prepareIdeCompilerDir, resolveIdeAppPath } = require('./ide-compiler');

// Runtime for the worker processes: "miniprogram.nodePath" if set, else VS Code's own binary run as
// plain Node (ELECTRON_RUN_AS_NODE), so no separate Node.js install or PATH setup is needed
function nodeRuntime() {
  const nodePath = vscode.workspace.getConfiguration('miniprogram').get('nodePath');
  if (nodePath) return { execPath: nodePath, env: process.env, extraEnv: {} };
  return { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
}

// Where minidev is pointed at the IDE's compiler (see ide-compiler.js); set in activate()
let compilerDirRoot = null;

// windowsHide: node.exe is a console program, so on Windows it would otherwise open its own window
function forkWorker(script, args) {
  const runtime = nodeRuntime();
  // The configured IDE path, or an auto-detected one when it's wrong for this machine (e.g. the macOS
  // default on Windows), so builds use the IDE's compiler on every platform
  const ideAppPath = resolveIdeAppPath(vscode.workspace.getConfiguration('miniprogram').get('ideAppPath'));
  const compileDir = prepareIdeCompilerDir(ideAppPath, compilerDirRoot);
  const env = compileDir ? { ...runtime.env, MINIDEV_COMPILEDIR: compileDir, MINIPROGRAM_IDE_APP: ideAppPath } : runtime.env;
  const worker = fork(path.join(__dirname, script), args, { execPath: runtime.execPath, env, windowsHide: true });
  return { worker, runtime };
}

let currentWorker = null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// The four-part build version a.b.c.d (see scripts/deploy.js); build-info.json is written at package time
function buildVersion() {
  const info = readJson(path.join(__dirname, 'build-info.json'));
  return (info && info.buildVersion) || `${(readJson(path.join(__dirname, 'package.json')) || {}).version || '?'} (dev)`;
}

// The folder holding app.json: mini.project.json may move the sources into "miniprogramRoot"
function miniRoot(folder) {
  const projectConfig = readJson(path.join(folder, 'mini.project.json'));
  return projectConfig && typeof projectConfig.miniprogramRoot === 'string'
    ? path.resolve(folder, projectConfig.miniprogramRoot)
    : folder;
}

// A mini program folder: app.json listing pages, app.js/app.ts, and either mini.project.json
// (the platform's project config) or .axml pages (WeChat projects use .wxml, so they don't match).
function isMiniProgram(folder) {
  const root = miniRoot(folder);
  const app = readJson(path.join(root, 'app.json'));
  if (!app || !Array.isArray(app.pages) || app.pages.length === 0) return false;
  if (!['app.js', 'app.ts'].some((f) => fs.existsSync(path.join(root, f)))) return false;
  return fs.existsSync(path.join(folder, 'mini.project.json')) || fs.existsSync(path.join(root, `${app.pages[0]}.axml`));
}

function findMiniProgramFolder() {
  const folder = (vscode.workspace.workspaceFolders || []).find((f) => isMiniProgram(f.uri.fsPath));
  return folder ? folder.uri.fsPath : null;
}

// Pages of the app, including subpackages, for the compile mode picker
function appPages(projectPath) {
  const app = readJson(path.join(miniRoot(projectPath), 'app.json')) || {};
  const pages = Array.isArray(app.pages) ? [...app.pages] : [];
  for (const sub of app.subPackages || app.subpackages || []) {
    for (const page of sub.pages || []) pages.push(`${sub.root.replace(/\/$/, '')}/${page}`);
  }
  return pages;
}

// Compile modes are kept where the IDE keeps them, so both share them:
// .mini-ide/compileMode.json → {modes: [{title, page, pageQuery, query, debugAppxSceneCode, …}]}
const compileModeFile = (projectPath) => path.join(projectPath, '.mini-ide', 'compileMode.json');
function readCompileModes(projectPath) {
  const content = readJson(compileModeFile(projectPath));
  return content && Array.isArray(content.modes) ? content.modes.filter((m) => m && m.title) : [];
}
function writeCompileModes(projectPath, modes) {
  const file = compileModeFile(projectPath);
  const content = readJson(file) || {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...content, modes }, null, 2)}\n`);
}
function describeCompileMode(mode) {
  const parts = [mode.pageQuery ? `${mode.page || 'first page'}?${mode.pageQuery}` : mode.page || 'first page'];
  if (mode.query) parts.push(`query: ${mode.query}`);
  if (mode.debugAppxSceneCode && mode.debugAppxSceneCode !== 'null') parts.push(`scene ${mode.debugAppxSceneCode}`);
  return parts.join(' · ');
}

// 'light' or 'dark', following VS Code's color theme
function currentTheme() {
  const lightThemes = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight];
  return lightThemes.includes(vscode.window.activeColorTheme.kind) ? 'light' : 'dark';
}

// Physical size of each display, for the simulator's "Physical size" zoom:
// [{mmWidth, mmHeight, width, height, x, y}] with width/height/x/y in screen points (0 when unknown)
const JXA_DISPLAYS = `ObjC.import("AppKit"); ObjC.import("CoreGraphics"); var out = []; var screens = $.NSScreen.screens;
for (var i = 0; i < screens.count; i++) { var s = screens.objectAtIndex(i);
  var mm = $.CGDisplayScreenSize(ObjC.unwrap(s.deviceDescription.objectForKey("NSScreenNumber")));
  out.push({ mmWidth: mm.width, mmHeight: mm.height, width: s.frame.size.width, height: s.frame.size.height, x: s.frame.origin.x, y: s.frame.origin.y }); }
JSON.stringify(out)`;
const PS_DISPLAYS = 'Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | ForEach-Object { "$($_.MaxHorizontalImageSize),$($_.MaxVerticalImageSize)" }';
function getDisplays() {
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  if (process.platform === 'darwin') {
    return run('osascript', ['-l', 'JavaScript', '-e', JXA_DISPLAYS]).then((out) => { try { return JSON.parse(out); } catch (e) { return []; } });
  }
  if (process.platform === 'win32') {
    // Monitors report centimetres; the page matches them to its screen by aspect ratio
    return run('powershell', ['-NoProfile', '-Command', PS_DISPLAYS]).then((out) => out.split(/\r?\n/)
      .map((line) => line.split(',').map(Number))
      .filter(([w, h]) => w > 0 && h > 0)
      .map(([w, h]) => ({ mmWidth: w * 10, mmHeight: h * 10, width: 0, height: 0, x: 0, y: 0 })));
  }
  return run('xrandr', ['--query']).then((out) => [...out.matchAll(/ connected.*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+).*?(\d+)mm x (\d+)mm/g)]
    .map((m) => ({ width: +m[1], height: +m[2], x: +m[3], y: +m[4], mmWidth: +m[5], mmHeight: +m[6] }))
    .filter((d) => d.mmWidth > 0));
}

// minidev prints each build error followed by "--> path:line:col" (relative to the mini program root)
function parseBuildErrors(text) {
  const errors = [];
  let heading = null;
  for (const line of text.split('\n')) {
    const location = line.match(/-->\s+(\S+?):(\d+):(\d+)/);
    if (location && heading) {
      errors.push({ file: location[1], line: Number(location[2]), column: Number(location[3]), message: heading });
    } else if (/^\s*error/i.test(line)) {
      heading = line.trim();
    }
  }
  return errors;
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// Ask the worker to stop minidev cleanly, force-kill if it doesn't exit in time
function stopWorker() {
  const worker = currentWorker;
  currentWorker = null;
  if (!worker || worker.exitCode !== null) return;
  if (worker.connected) worker.send('stop');
  setTimeout(() => {
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }, 3000);
}

// The simulator's DevTools (the IDE's DevTools front end), shown as its own view in the bottom
// panel next to Terminal. It points at the simulator that's currently running, if any.
class DevtoolsViewProvider {
  constructor() {
    this.view = null;
    this.url = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.onDidDispose(() => { this.view = null; });
    this.render();
  }

  setUrl(url) {
    this.url = url;
    this.render();
    if (!url) return;
    // Open the panel view without taking focus from the editor
    if (this.view) this.view.show(true);
    else vscode.commands.executeCommand('workbench.view.extension.miniprogramDevtools');
  }

  // Chrome DevTools applies its light/dark theme on load, so reload with VS Code's current theme
  setTheme(theme) {
    if (!this.url) return;
    const url = new URL(this.url);
    if (url.searchParams.get('theme') === theme) return;
    url.searchParams.set('theme', theme);
    this.url = url.toString();
    this.render();
  }

  render() {
    if (!this.view) return;
    if (!this.url) {
      this.view.webview.html = `<!DOCTYPE html><html><body style="font-family: var(--vscode-font-family); color: var(--vscode-descriptionForeground); padding: 8px 12px;">
        Start the simulator (Miniprogram: Start Simulator Preview) to inspect it here.</body></html>`;
      return;
    }
    const origin = new URL(this.url).origin;
    this.view.webview.html = `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';">
        <style>
          body, html { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-panel-background, var(--vscode-editor-background)); }
          iframe { width: 100%; height: 100%; border: none; }
        </style>
      </head>
      <body><iframe src="${escapeHtml(this.url)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"></iframe></body>
      </html>`;
  }
}

function messageHtml(text) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body, html { width: 100%; height: 100%; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; text-align: center; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
            .message { font-size: 1.1em; max-width: 80%; line-height: 1.5; }
        </style>
    </head>
    <body><div class="message">${text}</div></body>
    </html>`;
}

// The simulator view when nothing runs, with a button to start it
function startHtml(text) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return messageHtml(`${text}<p><button id="start">Start Simulator</button></p>
    <style nonce="${nonce}">button { font-family: inherit; padding: 5px 12px; border: none; border-radius: 2px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }</style>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('start').addEventListener('click', () => vscode.postMessage({ type: 'start' }));
    </script>`);
}

// The simulator page in an iframe, relaying VS Code's theme to it
function simulatorHtml(url) {
  const origin = new URL(url).origin;
  const nonce = crypto.randomBytes(16).toString('base64');
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Miniprogram Simulator</title>
        <style>
            body, html { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
            iframe { width: 100%; height: 100%; border: none; }
        </style>
    </head>
    <body>
        <iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" allow="camera; microphone; geolocation; clipboard-read; clipboard-write"></iframe>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const origin = ${JSON.stringify(origin)};
          const frame = document.querySelector('iframe');

          // VS Code's theme → the simulator UI's color slots (the same ones the IDE fills), live
          const THEME_VARS = {
            backgroundM1: 'editor-background', backgroundM2: 'editor-background',
            backgroundM3: 'sideBar-background', backgroundM4: 'input-background',
            backgroundM5: 'editorWidget-background', backgroundM6: 'button-secondaryBackground',
            backgroundM7: 'button-secondaryHoverBackground', backgroundM8: 'list-activeSelectionBackground',
            backgroundM10: 'list-hoverBackground', backgroundM11: 'toolbar-activeBackground',
            primaryB1: 'button-background', primaryB2: 'button-hoverBackground', primaryB3: 'focusBorder',
            splitB1: 'panel-border', splitB2: 'widget-border', splitB3: 'editorGroup-border',
            iconM1: 'icon-foreground', textColor: 'foreground', highlightColor1: 'editor-foreground',
          };
          function postTheme() {
            const css = getComputedStyle(document.documentElement);
            const vars = {};
            for (const [key, name] of Object.entries(THEME_VARS)) {
              const value = css.getPropertyValue('--vscode-' + name).trim();
              if (value) vars[key] = value;
            }
            const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
            frame.contentWindow.postMessage({
              type: 'mp-theme', theme: light ? 'light' : 'dark', vars,
              fontFamily: css.getPropertyValue('--vscode-font-family').trim() || 'sans-serif',
            }, origin);
          }
          frame.addEventListener('load', postTheme);
          new MutationObserver(postTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
          new MutationObserver(postTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
        </script>
    </body>
    </html>
  `;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log(`Miniprogram Preview extension is now active! (build ${buildVersion()})`);
  compilerDirRoot = path.join(context.globalStorageUri.fsPath, 'minidev');

  // The simulator runs in a view in the secondary side bar (not an editor tab, so files never open
  // beside it and its width is only what the user drags it to). Closing the side bar only hides it;
  // the Stop button (or Miniprogram: Stop Simulator) ends it.
  let simulatorRunning = false;
  let simulatorView = null;
  let simulatorViewHtml = startHtml('The mini program simulator runs here.');
  function setSimulatorHtml(html) {
    simulatorViewHtml = html;
    if (simulatorView) simulatorView.webview.html = html;
  }
  function showSimulatorView() {
    if (simulatorView) simulatorView.show(true);
    else vscode.commands.executeCommand('workbench.view.extension.miniprogramSimulator');
  }
  function setSimulatorRunning(running) {
    simulatorRunning = running;
    vscode.commands.executeCommand('setContext', 'miniprogram.simulatorRunning', running);
  }
  function stopSimulator(message) {
    if (!simulatorRunning) return;
    setSimulatorRunning(false);
    simulatorUrl = null;
    debugWhenReady = false;
    if (debugSession) vscode.debug.stopDebugging(debugSession);
    devtools.setUrl(null);
    diagnostics.clear();
    stopWorker();
    setSimulatorHtml(startHtml(message || 'The simulator is stopped.'));
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('miniprogram.simulator', {
    resolveWebviewView(view) {
      simulatorView = view;
      view.webview.options = { enableScripts: true };
      view.webview.html = simulatorViewHtml;
      view.webview.onDidReceiveMessage((msg) => { if (msg && msg.type === 'start') vscode.commands.executeCommand('miniprogram.simulator'); });
      view.onDidDispose(() => { simulatorView = null; });
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  let simulatorUrl = null;
  let debugSession = null;
  let debugWhenReady = false;
  let lastBuildError = null;

  const output = vscode.window.createOutputChannel('Miniprogram');
  const diagnostics = vscode.languages.createDiagnosticCollection('miniprogram');
  context.subscriptions.push(output, diagnostics);

  const devtools = new DevtoolsViewProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('miniprogram.devtools', devtools, {
    webviewOptions: { retainContextWhenHidden: true },
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => devtools.setTheme(currentTheme())));

  // Compile mode picker in the status bar, shown in mini program workspaces
  const compileModeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  compileModeItem.command = 'miniprogram.selectCompileMode';
  context.subscriptions.push(compileModeItem);

  // Show the simulator button in the editor title bar only in mini program workspaces
  let projectFolder = null;
  let detectTimer = null;
  const detect = () => {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      projectFolder = findMiniProgramFolder();
      vscode.commands.executeCommand('setContext', 'miniprogram.isProject', Boolean(projectFolder));
      updateCompileModeItem();
    }, 300);
  };
  detect();
  const watcher = vscode.workspace.createFileSystemWatcher('**/{app.json,mini.project.json,app.js,app.ts}');
  watcher.onDidCreate(detect);
  watcher.onDidChange(detect);
  watcher.onDidDelete(detect);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(detect));
  // The detected mini program folder, else the first workspace folder
  const projectPathFor = (workspaceFolders) => projectFolder || findMiniProgramFolder() || workspaceFolders[0].uri.fsPath;
  const currentProjectPath = () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      vscode.window.showErrorMessage('Please open a miniprogram workspace first.');
      return null;
    }
    return projectPathFor(folders);
  };

  // --- API mocks (bottom panel view, applied live by the simulator) ---
  const mockView = registerMockView(context, () => {
    const folders = vscode.workspace.workspaceFolders;
    return folders ? projectPathFor(folders) : null;
  });
  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.showMock', () => mockView.show()));

  // --- Page map (editor tab): pages, their functions, and the navigation between them ---
  const pageMap = registerPageMap(context, () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return null;
    const projectPath = projectPathFor(folders);
    const root = miniRoot(projectPath);
    const app = readJson(path.join(root, 'app.json'));
    if (!app) return null;
    const tabBar = app.tabBar || {};
    const tabPages = (tabBar.items || tabBar.list || []).map((item) => item.pagePath).filter(Boolean);
    return { root, pages: appPages(projectPath), tabPages };
  });
  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.showPageMap', () => pageMap.show()));

  // --- Compile modes ---

  const COMPILE_MODE_KEY = 'miniprogram.compileMode';
  function selectedCompileMode(projectPath) {
    const title = context.workspaceState.get(COMPILE_MODE_KEY);
    return (title && projectPath && readCompileModes(projectPath).find((m) => m.title === title)) || null;
  }
  function updateCompileModeItem() {
    if (!projectFolder) return compileModeItem.hide();
    const mode = selectedCompileMode(projectFolder);
    compileModeItem.text = `$(run) ${mode ? mode.title : 'Normal compile'}`;
    compileModeItem.tooltip = `Mini program compile mode${mode ? `: ${describeCompileMode(mode)}` : ''}\nClick to change`;
    compileModeItem.show();
  }
  // Tell a running simulator to restart on the selected mode
  let appliedCompileMode = null;
  function applyCompileMode(projectPath) {
    updateCompileModeItem();
    const mode = selectedCompileMode(projectPath);
    if (JSON.stringify(mode) === JSON.stringify(appliedCompileMode)) return;
    appliedCompileMode = mode;
    if (currentWorker && currentWorker.connected) currentWorker.send({ type: 'compileMode', mode });
  }
  const modeWatcher = vscode.workspace.createFileSystemWatcher('**/.mini-ide/compileMode.json');
  const onModesChanged = () => { if (projectFolder) applyCompileMode(projectFolder); };
  modeWatcher.onDidCreate(onModesChanged);
  modeWatcher.onDidChange(onModesChanged);
  modeWatcher.onDidDelete(onModesChanged);
  context.subscriptions.push(modeWatcher);

  async function addCompileMode(projectPath) {
    const title = await vscode.window.showInputBox({
      title: 'Add Compile Mode (1/5)', prompt: 'Name', placeHolder: 'e.g. Order detail',
      validateInput: (v) => (!v.trim() ? 'Enter a name'
        : readCompileModes(projectPath).some((m) => m.title === v.trim()) ? 'A compile mode with this name exists' : undefined),
    });
    if (!title) return;
    const page = await vscode.window.showQuickPick(appPages(projectPath), { title: 'Add Compile Mode (2/5)', placeHolder: 'Start page' });
    if (!page) return;
    const pageQuery = await vscode.window.showInputBox({
      title: 'Add Compile Mode (3/5)', prompt: "Page query, received by the page's onLoad (optional)", placeHolder: 'name=vendor&color=black',
    });
    if (pageQuery === undefined) return;
    const query = await vscode.window.showInputBox({
      title: 'Add Compile Mode (4/5)', prompt: "Global query, received by app.js's onLaunch (optional)", placeHolder: 'name=vendor&color=black',
    });
    if (query === undefined) return;
    const scene = await vscode.window.showInputBox({
      title: 'Add Compile Mode (5/5)', prompt: 'Scene value (optional)', placeHolder: 'e.g. 1011',
      validateInput: (v) => (v && !/^\d+$/.test(v.trim()) ? 'Scene values are numbers' : undefined),
    });
    if (scene === undefined) return;
    const mode = { title: title.trim(), page, pageQuery: pageQuery.trim(), query: query.trim(), debugAppxSceneCode: scene.trim() || 'null' };
    writeCompileModes(projectPath, [...readCompileModes(projectPath), mode]);
    await context.workspaceState.update(COMPILE_MODE_KEY, mode.title);
    applyCompileMode(projectPath);
  }

  async function editCompileModes(projectPath) {
    const file = compileModeFile(projectPath);
    if (!fs.existsSync(file)) writeCompileModes(projectPath, []);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.selectCompileMode', async () => {
    const projectPath = currentProjectPath();
    if (!projectPath) return;
    const current = selectedCompileMode(projectPath);
    const items = [
      { label: 'Normal compile', description: 'the first page', mode: null },
      ...readCompileModes(projectPath).map((mode) => ({ label: mode.title, description: describeCompileMode(mode), mode })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) Add Compile Mode…', action: 'add' },
      { label: '$(edit) Edit compileMode.json', action: 'edit' },
    ];
    items.forEach((item) => {
      if (!item.action && item.kind !== vscode.QuickPickItemKind.Separator && (item.mode ? item.mode.title : null) === (current ? current.title : null)) {
        item.label = `$(check) ${item.label}`;
      }
    });
    const picked = await vscode.window.showQuickPick(items, { title: 'Mini Program Compile Mode', placeHolder: 'Start the simulator and device preview with…' });
    if (!picked) return;
    if (picked.action === 'add') return addCompileMode(projectPath);
    if (picked.action === 'edit') return editCompileModes(projectPath);
    await context.workspaceState.update(COMPILE_MODE_KEY, picked.mode ? picked.mode.title : undefined);
    applyCompileMode(projectPath);
  }));

  // --- Simulator ---

  function showBuildError(projectPath, message) {
    output.appendLine(`\nBuild failed:\n${message}`);
    const byFile = new Map();
    for (const error of parseBuildErrors(message)) {
      const file = path.resolve(miniRoot(projectPath), error.file);
      const range = new vscode.Range(Math.max(0, error.line - 1), error.column, Math.max(0, error.line - 1), error.column + 1000);
      const diagnostic = new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'minidev';
      byFile.set(file, [...(byFile.get(file) || []), diagnostic]);
    }
    diagnostics.clear();
    byFile.forEach((list, file) => diagnostics.set(vscode.Uri.file(file), list));
    if (message === lastBuildError) return;
    lastBuildError = message;
    const firstLine = message.split('\n').find((l) => l.trim()) || 'unknown error';
    vscode.window.showErrorMessage(`Mini program build failed: ${firstLine.trim()}`, 'Show Output').then((choice) => {
      if (choice) output.show(true);
    });
  }

  // The page path clicked in the simulator's toolbar → its template (else script) in the editor
  async function openPageSource(projectPath, pagePath) {
    if (/^[a-z-]+:\/\//.test(pagePath)) return; // plugin pages aren't in this project
    const base = path.join(miniRoot(projectPath), pagePath.replace(/^\//, '').split('?')[0]);
    const file = ['.axml', '.js', '.ts'].map((ext) => base + ext).find((f) => fs.existsSync(f));
    if (!file) return vscode.window.showWarningMessage(`No source found for page "${pagePath}".`);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  }

  // Debugging runs the simulator page in VS Code's integrated browser under its JavaScript debugger
  // (breakpoints in the project's files, stepping, Debug Console, CPU profiles). The IDE attaches a
  // V8 debugger to its own webview instead; an extension can't do that to a VS Code webview.
  async function startDebug(projectPath) {
    const jsDebug = vscode.extensions.getExtension('ms-vscode.js-debug');
    const types = jsDebug ? ((jsDebug.packageJSON.contributes || {}).debuggers || []).map((d) => d.type) : [];
    const root = miniRoot(projectPath);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
    await vscode.debug.startDebugging(folder, {
      // Older VS Code has no integrated browser; the simulator then opens in Chrome
      type: types.includes('editor-browser') ? 'editor-browser' : 'chrome',
      request: 'launch',
      name: 'Mini Program Simulator',
      url: simulatorUrl,
      webRoot: root,
      // Source maps name the project's files app:///<path>
      sourceMapPathOverrides: { 'app:///*': `${root}/*` },
      miniprogramSimulator: true,
    });
  }
  context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
    if (!session.configuration.miniprogramSimulator) return;
    debugSession = session;
    // One simulator at a time: the debugged one replaces the one in the side bar
    if (simulatorRunning) setSimulatorHtml(messageHtml('The simulator is running in the debugger’s browser tab.<br>Stop debugging to bring it back here.'));
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
    if (session !== debugSession) return;
    debugSession = null;
    // The browser tab stays open after debugging; close it (titled by the simulator page) so only
    // the panel's simulator runs
    const browserTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((tab) => tab.label === 'Lyra Simulator' && !(tab.input instanceof vscode.TabInputWebview));
    if (browserTabs.length) vscode.window.tabGroups.close(browserTabs);
    if (simulatorRunning && simulatorUrl) setSimulatorHtml(simulatorHtml(simulatorUrl));
  }));

  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.debugSimulator', async () => {
    const projectPath = currentProjectPath();
    if (!projectPath) return;
    if (debugSession) return vscode.window.showInformationMessage('The simulator is already being debugged.');
    if (simulatorRunning && simulatorUrl) return startDebug(projectPath);
    debugWhenReady = true;
    vscode.commands.executeCommand('miniprogram.simulator');
  }));

  let disposableSimulator = vscode.commands.registerCommand('miniprogram.simulator', function () {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('Please open a miniprogram workspace first.');
      return;
    }

    const projectPath = projectPathFor(workspaceFolders);

    showSimulatorView();
    if (simulatorRunning) return;
    setSimulatorRunning(true);
    setSimulatorHtml(messageHtml('Booting dev server &amp; simulator...'));

    // Stop previous worker if exists
    stopWorker();

    // Run minidev in a separate process, isolated from the extension host
    const config = vscode.workspace.getConfiguration('miniprogram');
    const ideAppPath = config.get('useIdeAppxNg') ? config.get('ideAppPath') : '__disabled__';
    const simulatorUI = config.get('simulatorUI');
    const language = vscode.env.language.startsWith('zh') ? 'zh-CN' : 'en-US';
    appliedCompileMode = selectedCompileMode(projectPath);
    const { worker, runtime } = forkWorker('simulator-worker.js',
      [projectPath, ideAppPath, simulatorUI, language, currentTheme(), JSON.stringify(appliedCompileMode),
        context.workspaceState.get('miniprogram.appId') || '']);
    currentWorker = worker;
    let started = false;
    lastBuildError = null;
    diagnostics.clear();
    output.appendLine(`\n[${new Date().toLocaleTimeString()}] Starting the simulator for ${projectPath}`);

    const fail = (message) => {
      vscode.window.showErrorMessage('Simulator Error: ' + message);
      if (worker === currentWorker) stopSimulator(`The simulator stopped: ${escapeHtml(message)}`);
    };

    worker.on('error', (err) => {
      if (err.code === 'ENOENT') {
        fail(`Node.js not found at "${runtime.execPath}". Fix "miniprogram.nodePath", or clear it to use VS Code's built-in runtime.`);
      } else {
        fail(err.message);
      }
    });

    worker.on('exit', (code) => {
      if (!started && worker === currentWorker) {
        fail(`Simulator process exited (code ${code}) before the simulator started.`);
      }
    });

    worker.on('message', async (msg) => {
      if (worker !== currentWorker) return;
      if (msg.log) {
        output.append(stripAnsi(msg.log));
      } else if (msg.build === 'error') {
        showBuildError(projectPath, stripAnsi(msg.message || ''));
      } else if (msg.build === 'done') {
        lastBuildError = null;
        diagnostics.clear();
      } else if (msg.ui) {
        if (msg.ui.type === 'openPage') openPageSource(projectPath, msg.ui.path);
        else if (msg.ui.type === 'showLog') output.show(true);
      } else if (msg.error) {
        fail(msg.error);
      } else if (msg.warning) {
        vscode.window.showWarningMessage(msg.warning);
      } else if (msg.url && simulatorRunning) {
        started = true;
        // Map localhost to a reachable URI (needed for Remote-SSH / WSL / Codespaces)
        const external = await vscode.env.asExternalUri(vscode.Uri.parse(msg.url));
        if (!simulatorRunning || worker !== currentWorker) return;
        simulatorUrl = external.toString(true);
        if (msg.devtoolsUrl) {
          const devtoolsUrl = await vscode.env.asExternalUri(vscode.Uri.parse(msg.devtoolsUrl));
          if (simulatorRunning) devtools.setUrl(devtoolsUrl.toString(true));
        }
        setSimulatorHtml(simulatorHtml(simulatorUrl));
        // For the "Physical size" zoom
        getDisplays().then((displays) => {
          if (displays.length && worker.connected) worker.send({ type: 'displays', displays });
        });
        if (debugWhenReady) {
          debugWhenReady = false;
          startDebug(projectPath);
        }
      }
    });
  });

  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.stopSimulator', () => stopSimulator()));

  // --- Real-device preview ---

  const APP_ID_KEY = 'miniprogram.appId';
  // The QR code shows in the "Device Preview" view in the bottom panel (not an editor tab), which
  // keeps the last result, so it can be reopened from its panel tab at any time
  let previewView = null;
  let previewState = null;
  let previewProjectPath = null;
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('miniprogram.devicePreview', {
    resolveWebviewView(view) {
      previewView = view;
      view.webview.options = { enableScripts: true };
      view.onDidDispose(() => { previewView = null; });
      view.webview.onDidReceiveMessage((msg) => {
        const projectPath = previewProjectPath || currentProjectPath();
        if (!projectPath) return;
        if (msg.type === 'refresh') previewOnDevice(projectPath);
        else if (msg.type === 'change') previewOnDevice(projectPath, true);
        else if (msg.type === 'login') loginToActiveAccount().then((ok) => ok && previewOnDevice(projectPath));
        else if (msg.type === 'whitelist') askWhitelist().then((value) => value !== null && previewOnDevice(projectPath));
      });
      renderPreview(previewState);
    },
  }));
  function showPreviewView() {
    if (previewView) previewView.show(true);
    else vscode.commands.executeCommand('workbench.view.extension.miniprogramDevicePreview');
  }

  // Options go over IPC rather than argv, so passwords stay out of the process list
  function runPreviewWorker(projectPath, action, options = {}) {
    return new Promise((resolve) => {
      const { worker, runtime } = forkWorker('preview-worker.js', [projectPath, action]);
      let reply = null;
      worker.on('message', (msg) => { reply = msg; });
      worker.on('error', (err) => resolve({ error: err.code === 'ENOENT' ? `Node.js not found at "${runtime.execPath}".` : err.message }));
      worker.on('exit', (code) => resolve(reply || { error: `Preview process exited (code ${code}).` }));
      worker.send(options);
    });
  }
  const isAuthError = (error) => /auth\.|授权|登录|login/i.test(error || '');

  // Device preview goes through one account: the service provider's Open Platform (minidev) or an mPaaS
  // environment imported from the mPaaS console's config file, as in the IDE's login dialog.
  // Environments (config with its sign, and the logged-in user) are kept in secret storage.
  const ACCOUNT_KEY = 'miniprogram.account';        // 'alipay' | 'mpaas:<name>'
  const MPAAS_SECRET = 'miniprogram.mpaasEnvironments';
  const MPAAS_APP_KEY = 'miniprogram.mpaasApp';     // per workspace: {appId, appName, vhost}
  const WHITELIST_KEY = 'miniprogram.mpaasWhitelist';
  async function mpaasEnvironments() {
    try { return JSON.parse((await context.secrets.get(MPAAS_SECRET)) || '{}'); } catch (e) { return {}; }
  }
  const saveMpaasEnvironments = (envs) => context.secrets.store(MPAAS_SECRET, JSON.stringify(envs));
  // The mPaaS environment in use, or null for the Open Platform account
  async function activeMpaas() {
    const account = context.globalState.get(ACCOUNT_KEY) || 'alipay';
    if (!account.startsWith('mpaas:')) return null;
    const name = account.slice('mpaas:'.length);
    const env = (await mpaasEnvironments())[name];
    return env ? { name, ...env } : null;
  }

  // minidev's login prints a QR code to scan with your miniprogram service provider's app, so it runs in a terminal
  async function alipayLogin() {
    await context.globalState.update(ACCOUNT_KEY, 'alipay');
    const runtime = nodeRuntime();
    const terminal = vscode.window.createTerminal({
      name: 'Miniprogram Login',
      shellPath: runtime.execPath,
      shellArgs: [path.join(__dirname, 'node_modules', 'minidev', 'bin', 'minidev.js'), 'login'],
      env: runtime.extraEnv,
    });
    terminal.show();
  }

  // Adds an environment from the config file the mPaaS console downloads, then logs in to it
  async function importMpaasConfig() {
    const [file] = (await vscode.window.showOpenDialog({
      title: 'Select the mPaaS config file (downloaded from the mPaaS console)',
      openLabel: 'Select Config File',
      filters: { 'mPaaS config': ['json', 'config'] },
      canSelectMany: false,
    })) || [];
    if (!file) return;
    let config;
    try { config = JSON.parse(fs.readFileSync(file.fsPath, 'utf8')); } catch (e) {
      vscode.window.showErrorMessage(`That file isn't valid JSON: ${e.message}`);
      return;
    }
    const problem = require('./mpaas').checkConfig(config);
    if (problem) {
      vscode.window.showErrorMessage(`This doesn't look like an mPaaS config file: ${problem} Select the JSON file downloaded from the mPaaS console.`);
      return;
    }
    const envs = await mpaasEnvironments();
    const name = await vscode.window.showInputBox({
      title: 'Name This mPaaS Environment',
      prompt: 'A short name so you can tell it apart from other environments later, e.g. "Production" or "Staging".',
      value: path.basename(file.fsPath).replace(/(-default)?-config\.json$|\.json$/i, ''),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name for this environment.'),
    });
    if (!name) return;
    envs[name.trim()] = { config };
    await saveMpaasEnvironments(envs);
    return mpaasLogin(name.trim());
  }

  async function mpaasLogin(name) {
    const envs = await mpaasEnvironments();
    const env = envs[name];
    if (!env) return;
    const username = await vscode.window.showInputBox({
      title: `Log In to mPaaS (${name})`,
      prompt: 'Your mPaaS account (login name).',
      value: env.userInfo ? env.userInfo.loginName : '',
      ignoreFocusOut: true,
    });
    if (!username) return;
    const password = await vscode.window.showInputBox({
      title: `Log In to mPaaS (${name})`,
      prompt: `Password for "${username}". This is kept in VS Code's secret storage, never written to disk in plain text.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Logging in to mPaaS (${name})…` },
      () => runPreviewWorker('', 'mpaasLogin', { config: env.config, username, password }),
    );
    if (result.error) {
      const choice = await vscode.window.showErrorMessage(`Couldn't log in to mPaaS (${name}): ${result.error}`, 'Try Again');
      if (choice) return mpaasLogin(name);
      return;
    }
    envs[name] = { config: env.config, userInfo: result.userInfo };
    await saveMpaasEnvironments(envs);
    await context.globalState.update(ACCOUNT_KEY, `mpaas:${name}`);
    await context.workspaceState.update(MPAAS_APP_KEY, undefined);
    vscode.window.showInformationMessage(`Logged in to mPaaS (${name}) as ${result.userInfo.loginName || username}. Device preview now uploads there.`);
    return true;
  }

  // Picks the account for device preview, like the environment list of the IDE's login dialog
  async function login() {
    const envs = await mpaasEnvironments();
    const account = context.globalState.get(ACCOUNT_KEY) || 'alipay';
    const current = (id) => (id === account ? ' (in use)' : '');
    const items = [
      { label: '$(account) Open Platform', description: `minidev, scan a QR code${current('alipay')}`, run: alipayLogin },
      ...Object.entries(envs).map(([name, env]) => ({
        label: `$(cloud) mPaaS: ${name}`,
        description: (env.userInfo ? `logged in as ${env.userInfo.loginName}` : 'not logged in') + current(`mpaas:${name}`),
        detail: `${env.config.appId} · ${env.config.login_url}`,
        run: () => mpaasLogin(name),
      })),
      { label: '$(add) Add an mPaaS Environment…', description: 'import a config file from the mPaaS console', run: setupMpaasWizard },
    ];
    if (Object.keys(envs).length) items.push({ label: '$(trash) Remove an mPaaS Environment…', run: removeMpaasEnvironment });
    const picked = await vscode.window.showQuickPick(items, { title: 'Miniprogram: Log In', placeHolder: 'Choose the account device preview should use' });
    if (picked) return picked.run();
  }

  async function removeMpaasEnvironment() {
    const envs = await mpaasEnvironments();
    const name = await vscode.window.showQuickPick(Object.keys(envs), { title: 'Remove mPaaS environment' });
    if (!name) return;
    delete envs[name];
    await saveMpaasEnvironments(envs);
    if (context.globalState.get(ACCOUNT_KEY) === `mpaas:${name}`) await context.globalState.update(ACCOUNT_KEY, 'alipay');
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('miniprogram.login', login),
    vscode.commands.registerCommand('miniprogram.importMpaasConfig', importMpaasConfig),
  );

  // Logs in again to the mPaaS environment in use, else lets the user pick an account
  async function loginToActiveAccount() {
    const env = await activeMpaas();
    return env ? mpaasLogin(env.name) : login();
  }

  // mPaaS: one of the environment's mini programs (h5Id)
  async function chooseMpaasApp(projectPath, env) {
    if (!env.userInfo) {
      if (!(await mpaasLogin(env.name))) return null;
      env = await activeMpaas();
    }
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading mPaaS mini programs (${env.name})…` },
      () => runPreviewWorker(projectPath, 'mpaasApps', { config: env.config, userInfo: env.userInfo }),
    );
    if (result.error) {
      const choice = await vscode.window.showErrorMessage(`Couldn't load the mPaaS mini programs: ${result.error}`, 'Log In Again');
      if (choice) await mpaasLogin(env.name);
      return null;
    }
    if (!result.apps.length) {
      vscode.window.showWarningMessage(`The mPaaS environment "${env.name}" has no mini programs. Create one in the mPaaS console first.`);
      return null;
    }
    const picked = await vscode.window.showQuickPick(
      result.apps.map((a) => ({ label: a.appName || a.appId, description: a.appId, app: a })),
      { title: `mPaaS mini program to preview (${env.name})` },
    );
    if (!picked) return null;
    await context.workspaceState.update(MPAAS_APP_KEY, picked.app);
    return picked.app.appId;
  }

  // Development packages only open for the users on this whitelist (kept for all projects, as in the
  // IDE). Left empty, no whitelist is set for the upload, so only devices already on one (if any)
  // from an earlier upload or the mPaaS console can open it.
  async function askWhitelist() {
    const value = await vscode.window.showInputBox({
      title: 'Device Preview Whitelist (Optional)',
      prompt: 'Who can open development packages: comma-separated user IDs, as your app reports them to mPaaS. Leave empty to skip — you can set this later.',
      value: context.globalState.get(WHITELIST_KEY) || '',
      ignoreFocusOut: true,
    });
    if (value === undefined) return null;
    await context.globalState.update(WHITELIST_KEY, value.trim());
    return value.trim();
  }

  // Walks through mPaaS setup start to finish: config file, then login, then (optionally) a
  // whitelist. Used both for first-launch onboarding and for "Add an mPaaS environment…" later.
  async function setupMpaasWizard() {
    const loggedIn = await importMpaasConfig();
    if (!loggedIn) return false;
    await askWhitelist();
    vscode.window.showInformationMessage('mPaaS is set up. Run "Miniprogram: Preview on Device" anytime to get a fresh QR code for your phone.');
    return true;
  }
  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.setupMpaas', setupMpaasWizard));

  // First time the extension sees a mini program workspace, offer to set up an account for device
  // preview, instead of leaving the user to discover "Preview on Device" fails with an auth error.
  const SETUP_OFFERED_KEY = 'miniprogram.setupOffered';
  async function offerSetupIfNeeded() {
    if (context.globalState.get(SETUP_OFFERED_KEY)) return;
    if (!findMiniProgramFolder()) return;
    await context.globalState.update(SETUP_OFFERED_KEY, true);
    if (Object.keys(await mpaasEnvironments()).length) return; // already set up, e.g. via Settings Sync
    const choice = await vscode.window.showInformationMessage(
      'Set up an account now so you can preview this mini program on your phone?',
      'Import mPaaS Config…', 'Use Open Platform', 'Not Now',
    );
    if (choice === 'Import mPaaS Config…') await setupMpaasWizard();
    else if (choice === 'Use Open Platform') await alipayLogin();
  }

  // The mini program to preview: one of the logged-in account's apps, or typed in
  async function chooseAppId(projectPath) {
    const env = await activeMpaas();
    if (env) return chooseMpaasApp(projectPath, env);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading your mini programs…' },
      () => runPreviewWorker(projectPath, 'apps'),
    );
    if (result.error && isAuthError(result.error)) {
      const choice = await vscode.window.showWarningMessage('Device preview needs a login: Open Platform (scan a QR code) or mPaaS (import your config file).', 'Log In');
      if (choice) login();
      return null;
    }
    let appId;
    if (result.apps && result.apps.length) {
      const picked = await vscode.window.showQuickPick(
        [...result.apps.map((a) => ({ label: a.appName || a.appId, description: a.appId, appId: a.appId })), { label: '$(edit) Enter an App ID…', appId: null }],
        { title: 'Mini program to preview' },
      );
      if (!picked) return null;
      appId = picked.appId;
    }
    if (!appId) {
      appId = await vscode.window.showInputBox({ title: 'Mini program App ID', placeHolder: 'e.g. 2021001234567890', validateInput: (v) => (/^\d{6,}$/.test(v.trim()) ? undefined : 'App IDs are numbers') });
      if (!appId) return null;
    }
    appId = appId.trim();
    await context.workspaceState.update(APP_ID_KEY, appId);
    return appId;
  }
  context.subscriptions.push(vscode.commands.registerCommand('miniprogram.setAppId', async () => {
    const projectPath = currentProjectPath();
    if (projectPath) await chooseAppId(projectPath);
  }));

  function renderPreview(state) {
    previewState = state;
    if (!previewView) return;
    const nonce = crypto.randomBytes(16).toString('base64');
    const button = (id, label, secondary) => `<button id="${id}" class="${secondary ? 'secondary' : ''}">${label}</button>`;
    let body;
    if (!state) {
      body = `<p class="status">Run Preview on Device to build a QR code for your phone.</p><p>${button('refresh', 'Preview on Device')}</p>`;
    } else if (state.status === 'building') {
      body = '<p class="status">Building and uploading a preview…</p>';
    } else if (state.status === 'error') {
      body = `<p class="error">${escapeHtml(state.error)}</p>
        <p>${isAuthError(state.error) ? `${button('login', 'Log In')} ${button('refresh', 'Try Again', true)}` : button('refresh', 'Try Again')}</p>`;
    } else {
      body = `<p>Scan with ${state.mpaas ? 'your mPaaS app' : 'your miniprogram service provider\'s app'} to open this build on your phone.</p>
        <p class="meta">Version ${escapeHtml(state.version || '')}</p>
        <p>${button('refresh', 'Rebuild QR Code')}</p>`;
    }
    const qr = state && state.status === 'ready' ? `<img src="${escapeHtml(state.qrcodeUrl)}" alt="QR code">` : '';
    previewView.webview.html = `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
          body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 12px; margin: 0; }
          main { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
          img { width: 168px; height: 168px; background: #fff; padding: 8px; border-radius: 4px; flex: none; }
          main > div { flex: 1; min-width: 220px; }
          p { margin: 4px 0 8px; }
          .meta, .status { color: var(--vscode-descriptionForeground); }
          .error { color: var(--vscode-errorForeground); white-space: pre-wrap; text-align: left; display: inline-block; max-width: 520px; }
          button { font-family: inherit; padding: 5px 12px; margin: 4px; border: none; border-radius: 2px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
          button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
          a { color: var(--vscode-textLink-foreground); cursor: pointer; }
        </style>
      </head>
      <body><main>
        ${qr}
        <div>
        ${state ? `<p class="meta">${state.mpaas ? `mPaaS (${escapeHtml(state.mpaas)}) · ` : ''}App ID ${escapeHtml(state.appId)} (<a id="change">change</a>) · ${escapeHtml(state.modeTitle)}</p>` : ''}
        ${state && state.mpaas ? `<p class="meta">Whitelist: ${state.whiteList ? escapeHtml(state.whiteList) : 'none set'} (<a id="whitelist">${state.whiteList ? 'change' : 'add'}</a>)</p>` : ''}
        ${body}
        </div></main>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          for (const id of ['refresh', 'login', 'change', 'whitelist']) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', () => vscode.postMessage({ type: id }));
          }
        </script>
      </body>
      </html>`;
  }

  async function previewOnDevice(projectPath, forceChooseApp) {
    const env = await activeMpaas();
    const savedMpaasApp = context.workspaceState.get(MPAAS_APP_KEY);
    let appId = env ? savedMpaasApp && savedMpaasApp.appId : context.workspaceState.get(APP_ID_KEY);
    if (!appId || forceChooseApp) appId = await chooseAppId(projectPath);
    if (!appId) return;
    // The whitelist is asked once (an empty answer is remembered as "skipped", not "unanswered")
    let whiteList = '';
    if (env) {
      whiteList = context.globalState.get(WHITELIST_KEY);
      if (whiteList === undefined) whiteList = await askWhitelist();
      if (whiteList === null) return; // cancelled
    }
    previewProjectPath = projectPath;
    showPreviewView();
    const mode = selectedCompileMode(projectPath);
    const state = { appId, modeTitle: mode ? mode.title : 'Normal compile' };
    if (env) {
      // An mPaaS package starts at its app's main page; compile modes only apply to Open Platform previews
      Object.assign(state, { mpaas: env.name, whiteList, modeTitle: mode ? `${mode.title} (not applied to mPaaS)` : 'Normal compile' });
      renderPreview({ ...state, status: 'building' });
      // Re-read: choosing the app may have logged in again
      const current = await activeMpaas();
      if (!current.userInfo && !(await mpaasLogin(current.name))) {
        renderPreview({ ...state, status: 'error', error: 'Not logged in to this mPaaS environment.' });
        return;
      }
      const { config, userInfo } = await activeMpaas();
      const app = context.workspaceState.get(MPAAS_APP_KEY);
      const result = await runPreviewWorker(projectPath, 'mpaasPreview', { config, userInfo, app, whiteList });
      if (result.error) output.appendLine(`\nDevice preview (mPaaS) failed: ${result.error}`);
      else output.appendLine(`\nDevice preview (mPaaS ${env.name}) ${result.version}: ${result.debugUrl}`);
      renderPreview(result.error ? { ...state, status: 'error', error: result.error } : { ...state, status: 'ready', qrcodeUrl: result.qrcodeUrl, version: result.version });
      return;
    }
    renderPreview({ ...state, status: 'building' });
    // The selected compile mode applies to the device too
    const options = { appId };
    if (mode) {
      if (mode.page) options.page = mode.page;
      if (mode.pageQuery) options.pageQuery = mode.pageQuery;
      if (mode.query) options.query = mode.query;
      if (mode.debugAppxSceneCode && mode.debugAppxSceneCode !== 'null') options.scene = String(mode.debugAppxSceneCode);
    }
    const result = await runPreviewWorker(projectPath, 'preview', options);
    if (result.error) {
      output.appendLine(`\nDevice preview failed: ${result.error}`);
      renderPreview({ ...state, status: 'error', error: result.error });
    } else {
      renderPreview({ ...state, status: 'ready', qrcodeUrl: result.qrcodeUrl, version: result.version });
    }
  }

  let disposableQrCode = vscode.commands.registerCommand('miniprogram.qrcode', async function () {
    const projectPath = currentProjectPath();
    if (projectPath) await previewOnDevice(projectPath);
  });

  context.subscriptions.push(disposableSimulator, disposableQrCode);

  offerSetupIfNeeded().catch((e) => output.appendLine(`\nSetup prompt failed: ${e.message}`));
}

function deactivate() {
  stopWorker();
}

module.exports = {
  activate,
  deactivate
}
