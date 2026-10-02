// Copies the IDE's simulator UI (@ali/lyra-integration-ide, browser build) out of an installed
// the miniprogram service provider's IDE into vendor/lyra-ui. Internal use only: these are the service provider's proprietary files.
// Electron-only variants (webview build, preload) are skipped. lyra.node.js is kept: it's the
// matching service node (plain Node, HTTP + WebSocket) that the UI connects to.
// Usage: node scripts/pull-lyra-ui.js [path/to/小程序开发者工具.app]
const fs = require('fs');
const path = require('path');
const { openAsar } = require('../asar-reader');

const ideAppPath = process.argv[2] || '/Applications/小程序开发者工具.app';
const asarPath = path.join(ideAppPath, 'Contents', 'Resources', 'app', 'modules.asar');
const base = '/@ali/lyra-integration-ide/dist/ide';
const outDir = path.join(__dirname, '..', 'vendor', 'lyra-ui');
const SKIP = /^(wv-|preload\.bundle|index-wv\.html)/;

const asar = openAsar(asarPath);
fs.rmSync(outDir, { recursive: true, force: true });
let count = 0;
for (const file of asar.list(base)) {
  if (SKIP.test(file)) continue;
  const dest = path.join(outDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, asar.read(`${base}/${file}`));
  count++;
}
asar.close();

const runtime = fs.readFileSync(path.join(outDir, 'runtime.bundle.js'), 'utf8');
const version = (runtime.match(/"LYRA_INTEGRATION_VERSION":"([^"]+)"/) || [])[1];
console.log(`Copied ${count} files (Lyra UI ${version}) to ${outDir}`);
