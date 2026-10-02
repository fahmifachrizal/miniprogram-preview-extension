const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// "Page Map" editor tab: the pages as nodes (with their functions) and the navigation between them,
// drawn by the React Flow app in media/page-map.js (built from webview/page-map). The graph comes from
// page-graph.js and is refreshed when the project's scripts, templates or app.json change.
//   getProject() → {root, pages, tabPages} or null
function registerPageMap(context, getProject) {
  let panel = null;
  let refreshTimer = null;
  const POSITIONS_KEY = 'miniprogram.pageMapPositions';

  function analyze() {
    const project = getProject();
    if (!project) return null;
    // Loaded on first use: the parser isn't needed until the map is opened
    const { analyzeProject } = require('./page-graph');
    const wrapperNames = vscode.workspace.getConfiguration('miniprogram').get('pageMap.wrappers') || [];
    return { project, graph: analyzeProject({ ...project, wrapperNames }) };
  }

  function sendGraph() {
    if (!panel) return;
    let result;
    try { result = analyze(); } catch (e) {
      vscode.window.showErrorMessage(`Couldn't read the project for the page map: ${e.message}`);
      return;
    }
    if (!result) return;
    panel.webview.postMessage({ type: 'graph', graph: result.graph, positions: context.workspaceState.get(POSITIONS_KEY) || {} });
  }
  const scheduleRefresh = () => {
    if (!panel) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(sendGraph, 500);
  };

  async function openAt(file, line) {
    const project = getProject();
    if (!project) return;
    const doc = await vscode.workspace.openTextDocument(path.join(project.root, file));
    const position = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: new vscode.Range(position, position) });
  }

  function show() {
    if (panel) { panel.reveal(); return; }
    if (!getProject()) {
      vscode.window.showWarningMessage('Open a mini program folder (with app.json) to see its page map.');
      return;
    }
    panel = vscode.window.createWebviewPanel('miniprogramPageMap', 'Page Map', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
    });
    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'page-map-icon.svg'));
    panel.webview.html = html(panel.webview, context.extensionPath);
    panel.onDidDispose(() => { panel = null; clearTimeout(refreshTimer); });
    panel.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.type === 'ready' || msg.type === 'refresh') sendGraph();
      else if (msg.type === 'openSource') openAt(msg.file, msg.line);
      else if (msg.type === 'openPage') {
        const project = getProject();
        const file = project && ['.axml', '.js', '.ts'].map((ext) => msg.path + ext).find((f) => fs.existsSync(path.join(project.root, f)));
        if (file) openAt(file, 1);
      } else if (msg.type === 'savePositions') context.workspaceState.update(POSITIONS_KEY, msg.positions);
    });
  }

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{js,ts,axml,json}');
  const onChange = (uri) => { if (!/[\\/](node_modules|\.mini-ide|\.git)[\\/]/.test(uri.fsPath)) scheduleRefresh(); };
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('miniprogram.pageMap')) scheduleRefresh();
  }));

  return { show };
}

function html(webview, extensionPath) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const asset = (name) => webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'media', name)));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('page-map.css')}">
<title>Page Map</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('page-map.js')}"></script>
</body>
</html>`;
}

module.exports = { registerPageMap };
