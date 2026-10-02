const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tar = require('tar');
const { minidev } = require('minidev');
const mpaas = require('./mpaas');
const { platformDir, appDir } = require('./ide-compiler');
const { openAsar } = require('./asar-reader');

// Real-device preview through minidev or an mPaaS config, run in its own process like the
// simulator worker. argv: projectPath, action. The options arrive as the first IPC message (JSON),
// so passwords stay out of the process list.
//   'apps'         → {apps: [{appId, appName}]}   the minidev account's mini programs
//   'preview'      → {qrcodeUrl, version}         options: {appId, page, pageQuery, query, scene}
//   'mpaasLogin'   → {userInfo}                   options: {config, username, password}
//   'mpaasApps'    → {apps: [{appId, appName, vhost}]}  options: {config, userInfo}
//   'mpaasPreview' → {qrcodeUrl, version}         options: {config, userInfo, app, whiteList}
// Failures are sent as {error}.

async function run(projectPath, action, options) {
  if (action === 'apps') {
    const list = await minidev.app.getList({});
    const apps = (Array.isArray(list) ? list : [list]).filter(Boolean).map((a) => ({ appId: a.appId, appName: a.appName }));
    return { apps };
  }
  if (action === 'preview') {
    const result = await minidev.preview({ project: projectPath, autoPush: false, ...options });
    return { qrcodeUrl: result.qrcodeUrl, version: result.version };
  }
  if (action === 'mpaasLogin') {
    return { userInfo: await mpaas.login(options.config, options.username, options.password) };
  }
  if (action === 'mpaasApps') {
    return { apps: await mpaas.appList(options.config, options.userInfo) };
  }
  if (action === 'mpaasPreview') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mpaas-'));
    try {
      const { tarFilePath, extendInfo, appxVersion } = await packLikeIde(projectPath, dir);
      return await mpaas.preview({ ...options, tarFilePath, extendInfo, appxVersion });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(`Unknown action "${action}"`);
}

// The package as the IDE makes it for a preview ("Reuse devserver package"): the dev build, its .js
// files minified with esbuild, the preview's BugMe agent injected into the worker, packed as a tar.
// minidev.build's production build is different code (more modules, different output) and breaks
// pages on mPaaS clients that work from the IDE.
async function packLikeIde(projectPath, dir) {
  const build = await minidev.dev({ project: projectPath });
  let out;
  let workers;
  let extendInfo = '';
  try {
    await new Promise((resolve, reject) => {
      build.devServer.once('done', (result) => (result && result.success === false ? reject(new Error('The build failed; see the Miniprogram output.')) : resolve()));
      build.devServer.once('error', (e) => reject(e instanceof Error ? e : new Error((e && e.message) || String(e))));
    });
    // minidev writes the app to a subfolder of build.dist (e.g. "ng-main")
    const sub = fs.readdirSync(build.dist).find((d) => fs.existsSync(path.join(build.dist, d, 'appConfig.json')));
    if (!sub) throw new Error('The build produced no app.');
    out = path.join(dir, 'app');
    fs.cpSync(path.join(build.dist, sub), out, { recursive: true });
    let root = projectPath;
    // mini.built.json has the built package's info: its miniprogramRoot, and the extendInfo the IDE
    // uploads (launchParams, including appxRouteFramework, which decides the client runtime version)
    const built = readJson(path.join(build.dist, 'mini.built.json'));
    root = (built.projectConfig && built.projectConfig.miniprogramRoot) || root;
    extendInfo = (built.packageInfo && built.packageInfo.extendInfo) || '';
    copyAssets(root, out);
    workers = readJson(path.join(root, 'app.json')).workers;
  } finally {
    await build.devServer.stop().catch(() => {});
  }
  // As minidev's own minify step: es5 unless the project skips transpiling, comments the runtime needs kept
  const jsFiles = listFiles(out).filter((f) => f.endsWith('.js') && !f.endsWith('.hot-update.js'));
  const result = spawnSync(findEsbuild(), [...jsFiles, '--minify', '--outdir=.', '--outbase=.', `--target=${skipsTranspile(projectPath) ? 'es6' : 'es5'}`,
    '--allow-overwrite', '--preserve-comments=(?i)PositionFor|CUBE_INSTANCE|"framework"'], { cwd: out, stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`Minifying failed: ${(result.stderr || result.error || '').toString()}`);
  injectPreviewCode(out, workers);
  const tarFile = path.join(dir, 'dist.tar');
  await tar.c({ file: tarFile, cwd: out, portable: true }, fs.readdirSync(out));
  return { tarFilePath: tarFile, extendInfo, appxVersion: appxVersionFromExtendInfo(extendInfo) };
}

// The IDE's getAppxVersion: a package built with the appx-ng route framework runs on the 2.0 client
// runtime, everything else on 1.0. Sending the wrong one gives a white screen on the device.
function appxVersionFromExtendInfo(extendInfo) {
  try {
    const launchParams = JSON.parse(extendInfo).launchParams || {};
    return launchParams.appxRouteFramework === 'YES' ? '2.0' : '1.0';
  } catch (e) {
    return '1.0';
  }
}

// The IDE's handlePreviewPackDist: its BugMe preview agent at the top of the worker (a development
// package opened from the QR code waits for it, so without it the app stays white), and console
// forwarding around app.json "workers"
const PLACEHOLDER = { workerTop: '[PositionForHostEntryCodeBegin]', customWorkerTop: '[PositionForCustomWorkerBegin]', customWorkerBottom: '[PositionForCustomWorkerEnd]' };
const CUSTOM_WORKER_TOP = "try{['log', 'info', 'error', 'warn', 'assert', 'count', 'countReset', 'debug', 'dir', 'table', 'clear'].forEach(type => {console[type] = (...args) => {try {const serializedArgs = JSON.stringify(args);worker.postMessage({ trigger: '_client_worker_', type, args: serializedArgs });} catch(err) {worker.postMessage({ trigger: '_client_worker_', type: 'error', args: JSON.stringify([err.message || 'Cannot serialize arguments']) });}}; });";
const CUSTOM_WORKER_BOTTOM = '}catch(err){if(console&&console.error){console.error(err)}}';
function injectPreviewCode(out, workers) {
  const edit = (file, fn) => { if (fs.existsSync(file)) fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'))); };
  const bugme = previewBugme();
  edit(path.join(out, 'index.worker.js'), (code) => code.split(PLACEHOLDER.workerTop).join(`${PLACEHOLDER.workerTop}*/ !(function(){${bugme}})(); /*`));
  for (const file of Array.isArray(workers) ? workers : []) {
    edit(path.join(out, file), (code) => code
      .split(PLACEHOLDER.customWorkerTop).join(`${PLACEHOLDER.customWorkerTop}*/ ${CUSTOM_WORKER_TOP}; /*`)
      .split(PLACEHOLDER.customWorkerBottom).join(`*/ ${CUSTOM_WORKER_BOTTOM};\n/*!\n${PLACEHOLDER.customWorkerBottom}`));
  }
}

// bugmeWPreview from the installed IDE's debug utilities (libs/debug-utils.asar), else minidev's copy
function previewBugme() {
  const maps = [];
  const app = appDir(process.env.MINIPROGRAM_IDE_APP);
  if (app) {
    const asarPath = path.join(app, 'libs', 'debug-utils.asar');
    if (fs.existsSync(asarPath)) {
      const asar = openAsar(asarPath);
      try { maps.push(asar.read('/offline/assets_map'), asar.read('/readonly/assets_map')); } finally { asar.close(); }
    }
  }
  const own = path.join(path.dirname(require.resolve('minidev/package.json')), 'assets', 'builder-debug-utils');
  for (const f of ['offline', 'readonly']) { try { maps.push(fs.readFileSync(path.join(own, f, 'assets_map'))); } catch (e) { /* missing */ } }
  for (const buf of maps) {
    try {
      const code = buf && JSON.parse(buf.toString('utf8')).bugmeWPreview;
      if (code) return code.trim();
    } catch (e) { /* damaged, try the next */ }
  }
  throw new Error('The BugMe preview agent was not found (minidev assets or the IDE\'s debug-utils).');
}

function listFiles(root, rel = '', skipDir = () => false) {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (!e.isDirectory()) return [p];
    return skipDir(e.name) ? [] : listFiles(root, p, skipDir);
  });
}

// The dev server serves images, fonts and media from the project, so the dev build has none; the IDE
// copies them into the package (kCopyIncludes / kCopyExcludes in its compile extension)
const ASSET_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.eot', '.woff', '.ttf', '.woff2', '.otf', '.mp3', '.mp4', '.wasm', '.wasm.br'];
const SKIPPED_DIRS = new Set(['node_modules', '.tea', '.git', '.svn', '.idea', '.vscode', '.entry']);
function copyAssets(root, out) {
  for (const file of listFiles(root, '', (name) => SKIPPED_DIRS.has(name))) {
    if (!ASSET_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext))) continue;
    const target = path.join(out, file);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; }
}

function skipsTranspile(projectPath) {
  const config = readJson(path.join(projectPath, 'mini.project.json'));
  return Boolean(config.developOptions && config.developOptions.skipTranspile);
}

// The esbuild that comes with the compiler minidev uses (the IDE's, see ide-compiler.js)
function findEsbuild() {
  const platform = platformDir();
  const name = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  for (const root of [process.env.MINIDEV_COMPILEDIR, path.join(os.homedir(), '.minidev')].filter(Boolean)) {
    const compilers = path.join(root, 'compilers');
    if (!fs.existsSync(compilers)) continue;
    for (const c of fs.readdirSync(compilers).filter((d) => d.startsWith('cubebuild@')).sort().reverse()) {
      const file = path.join(compilers, c, platform || 'win32', name);
      if (fs.existsSync(file)) return file;
    }
  }
  throw new Error('No esbuild found next to the mini program compiler (~/.minidev/compilers).');
}

// Exit once the reply has been delivered
const reply = (msg) => process.send(msg, () => process.exit(0));
process.once('message', (options) => {
  const [projectPath, action] = process.argv.slice(2);
  run(projectPath, action, options || {}).then(reply, (error) => reply({ error: (error && error.message) || String(error) }));
});
