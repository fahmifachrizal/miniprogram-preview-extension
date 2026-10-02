const fs = require('fs');
const path = require('path');
const { minidev } = require('minidev');
const { startOverlayProxy, rewriteUrl } = require('./ide-overlay-proxy');
const { hasUi, startLyraUiServer } = require('./lyra-ui-server');

let build = null;
let simulator = null;
let proxy = null;
let lyraUi = null;
let stopping = false;

// Stop the simulator and dev server so their ports are released, then exit
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    if (proxy) proxy.close();
    if (lyraUi) lyraUi.close();
    if (simulator) await simulator.stop();
    if (build) await build.devServer.stop();
  } catch (e) {
    // exiting anyway
  }
  process.exit(0);
}

function errorText(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || err.stack || JSON.stringify(err);
}

// Build state for the UI. minidev.dev() resolves before the first build finishes, so its events are
// followed from then on; the last one is kept for the UI server, which starts a moment later.
let lastBuildEvent = null;
function onBuildEvent(event) {
  lastBuildEvent = event;
  if (event.type === 'error') process.send({ build: 'error', message: event.message });
  else if (event.type === 'done') process.send({ build: 'done' });
  if (lyraUi) applyBuildEvent(event);
}
function applyBuildEvent(event) {
  if (event.type === 'compile') lyraUi.notifyCompiling();
  else if (event.type === 'done') lyraUi.notifyRebuilt();
  else if (event.type === 'error') lyraUi.notifyBuildError(event.message);
}
function followBuild(target) {
  // Build output for VS Code's output channel
  target.devServer.on('log', (data) => process.send({ log: String(data) }));
  target.devServer.on('compile', () => onBuildEvent({ type: 'compile' }));
  // A failed build reports "error", then "done" with success: false
  target.devServer.on('done', (result) => { if (!result || result.success !== false) onBuildEvent({ type: 'done' }); });
  target.devServer.on('error', (err) => onBuildEvent({ type: 'error', message: errorText(err) }));
}

// Rebuild from scratch (the simulator's restart button while the build has errors). minidev's own
// devServer.restart() stops reporting build events afterwards, so start a new dev server instead.
let restarting = false;
async function restartBuild() {
  if (!build || restarting || stopping) return;
  restarting = true;
  try {
    if (lyraUi) lyraUi.notifyCompiling();
    const previous = build;
    await previous.devServer.stop().catch(() => {});
    build = await minidev.dev({ project: previous.project });
    followBuild(build);
    if (lyraUi) lyraUi.setBuild(build);
  } catch (e) {
    onBuildEvent({ type: 'error', message: errorText(e) });
  } finally {
    restarting = false;
  }
}

// Messages from VS Code: 'stop', or {type: 'compileMode' | 'displays' | 'restartBuild' | 'restartApp' | 'mcp'}
process.on('message', (msg) => {
  if (msg === 'stop') return shutdown();
  if (msg && msg.type === 'mcp') {
    // A request from the MCP server for the simulator page; answered with the same id
    const reply = (body) => process.send({ mcpResult: { id: msg.id, ...body } });
    if (!lyraUi) return reply({ error: 'The simulator is still starting (or uses the minidev UI, which the MCP tools don\'t support).' });
    lyraUi.callPage(msg.method, msg.params).then((result) => reply({ result }), (e) => reply({ error: errorText(e) }));
    return;
  }
  if (!msg || !lyraUi) return;
  if (msg.type === 'restartApp') return lyraUi.restartApp();
  if (msg.type === 'compileMode') lyraUi.setCompileMode(msg.mode);
  else if (msg.type === 'displays') lyraUi.setDisplays(msg.displays);
  else if (msg.type === 'restartBuild') restartBuild();
});
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);

async function run() {
  const projectPath = process.argv[2];
  // Installed miniprogram service provider's IDE to take the appx-ng runtime from; empty disables the overlay
  const ideAppPath = process.argv[3];
  // Simulator UI to show ("ide" = bundled IDE UI in vendor/lyra-ui, "minidev" = minidev's own), language,
  // theme, the compile mode to start with (JSON, see lyra-ui-server.js) and the App ID if known
  const [simulatorUI = 'ide', language = 'en-US', theme = 'dark', compileModeJson = 'null', appId = ''] = process.argv.slice(4);
  if (!projectPath) {
    process.send({ error: 'No project path provided' });
    process.exit(1);
  }

  try {
    // Start dev server
    build = await minidev.dev({ project: projectPath });
    followBuild(build);

    let url;
    if (simulatorUI === 'ide' && hasUi()) {
      // The IDE UI brings its own service node and serves the compiled output itself,
      // so minidev's web simulator (and its service node) isn't started
      let compileMode = null;
      try { compileMode = JSON.parse(compileModeJson); } catch (e) { /* normal compile */ }
      lyraUi = await startLyraUiServer({
        build, projectPath, language, theme, compileMode, appId,
        onMessage: (msg) => {
          if (msg.type === 'restartBuild') restartBuild();
          else process.send({ ui: msg });
        },
      });
      // From here the UI shows the compile state and restarts the app after each rebuild, as the IDE does
      if (lastBuildEvent) applyBuildEvent(lastBuildEvent);
      url = lyraUi.url;
    } else {
      // Start web simulator and get URL
      simulator = await minidev.devWebSimulator({ autoOpen: false }, build);
      url = simulator.bundled;
    }
    if (!lyraUi && ideAppPath !== '__disabled__') {
      const hasVendorCopy = fs.existsSync(path.join(__dirname, 'vendor', 'appx-ng', 'meta.json'));
      const hasIde = ideAppPath && fs.existsSync(path.join(ideAppPath, 'Contents', 'Resources', 'app', 'libs', 'simulator-default-lib.asar'));
      if (hasVendorCopy || hasIde) {
        const host = new URL(url).host;
        proxy = await startOverlayProxy({ target: 'http://' + host, ideAppPath });
        url = rewriteUrl(url, host, '127.0.0.1:' + proxy.port);
      } else if (ideAppPath) {
        process.send({ warning: `Miniprogram IDE not found at "${ideAppPath}", using minidev's appx-ng runtime.` });
      }
    }

    // Send URL back to VS Code
    process.send({ url, devtoolsUrl: lyraUi ? lyraUi.devtoolsUrl : null });

  } catch (error) {
    process.send({ error: error.message || String(error) });
  }
}

run();
