// Patches minidev's own bundled simulator UI (node_modules/minidev/assets/web-sim) in place so it
// starts in English instead of minidev's hardcoded Chinese default. No proxy, no interception at
// runtime: minidev serves these files directly, and this just edits them ahead of time.
//
// What this changes and why:
//  - The simulator chrome (toolbar, device picker, status bar) reads its locale from
//    localStorage["VOL_NLS_CONFIG"], falling back to a hardcoded "zh-CN" if unset. A full "en-US"
//    pack already ships in the bundle, it's just never selected. We inject a tiny inline script
//    before main.js runs that sets that key.
//  - The DevTools panel (Elements/Console/Network/...) gets its own locale from a `lang=` query
//    param on its iframe URL, hardcoded to "zh-CN" in the bundle. We change that literal to
//    "en-US" (a full en-US locale pack for it is already fetched by the page regardless).
//
// Idempotent: safe to run multiple times, and re-run automatically via `npm install` (see the
// "postinstall" script in package.json), since npm reinstalling minidev would overwrite this.
//
// Usage: node scripts/patch-web-sim.js [locale]   (default: en-US)

const fs = require('fs');
const path = require('path');

const locale = process.argv[2] || 'en-US';
const webSimDir = path.join(__dirname, '..', 'node_modules', 'minidev', 'assets', 'web-sim');
const MARKER = 'VOL_NLS_CONFIG_PATCHED';

function patchIndexHtml(relPath) {
  const file = path.join(webSimDir, relPath);
  if (!fs.existsSync(file)) return { file: relPath, skipped: 'not found' };
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes(MARKER)) return { file: relPath, skipped: 'already patched' };
  const inject = `<script>/*${MARKER}*/try{localStorage.setItem('VOL_NLS_CONFIG','${locale}')}catch(e){}</script>`;
  if (!html.includes('<script defer="defer" src="main.js"></script>')) {
    return { file: relPath, skipped: 'expected script tag not found (minidev layout changed?)' };
  }
  html = html.replace('<script defer="defer" src="main.js"></script>', inject + '<script defer="defer" src="main.js"></script>');
  fs.writeFileSync(file, html);
  return { file: relPath, patched: true };
}

function patchDevtoolsLang(relPath) {
  const file = path.join(webSimDir, relPath);
  if (!fs.existsSync(file)) return { file: relPath, skipped: 'not found' };
  let js = fs.readFileSync(file, 'utf8');
  const needle = '&env=kaitian&lang=zh-CN';
  if (!js.includes(needle)) return { file: relPath, skipped: js.includes(`&env=kaitian&lang=${locale}`) ? 'already patched' : 'literal not found (minidev version changed?)' };
  js = js.split(needle).join(`&env=kaitian&lang=${locale}`);
  fs.writeFileSync(file, js);
  return { file: relPath, patched: true };
}

if (!fs.existsSync(webSimDir)) {
  console.log('minidev not installed yet (node_modules/minidev/assets/web-sim missing) — skipping web-sim patch.');
  process.exit(0);
}

const results = [
  patchIndexHtml('index.html'),
  patchIndexHtml('simulator/index.html'),
  patchDevtoolsLang('main.js'),
  patchDevtoolsLang('devtool/main.js'),
];
for (const r of results) {
  console.log(`${r.patched ? 'patched' : 'skip   '} ${r.file}${r.skipped ? ' (' + r.skipped + ')' : ''}`);
}
