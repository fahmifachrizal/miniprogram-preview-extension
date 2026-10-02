// Copies the simulator DevTools into vendor/devtools. Internal use only: these are the service provider's proprietary files.
//  - devtools-frontend/: the IDE's current DevTools (libs/devtools-frontend.asar). The simulator one is
//    mini-ide-emulator-devtools-frontend/index.html, built on the Chrome DevTools core in front_end/.
//  - bugme/: the BugMe agents injected into the app (render-uniweb handles both the appx route
//    framework used by appx-ng and older pages; render-web skips appx-ng). The IDE loads them from
//    https://hpmweb.alipay.com/bugme/assets/tinybugme-{render-web,worker-remote}; minidev caches the
//    same scripts in ~/.minidev/assets/tiny_bugme, so they're copied from there (run minidev's
//    simulator once first if that cache is missing).
// Usage: node scripts/pull-devtools.js [path/to/小程序开发者工具.app]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openAsar } = require('../asar-reader');

const ideAppPath = process.argv[2] || '/Applications/小程序开发者工具.app';
const frontEndAsar = path.join(ideAppPath, 'Contents', 'Resources', 'app', 'libs', 'devtools-frontend.asar');
const outDir = path.join(__dirname, '..', 'vendor', 'devtools');
const AGENTS = ['render-uniweb.js', 'worker-remote.js'];

// Most recently downloaded tiny_bugme cache folder
const bugmeRoot = path.join(os.homedir(), '.minidev', 'assets', 'tiny_bugme');
const bugmeDirs = fs.existsSync(bugmeRoot)
  ? fs.readdirSync(bugmeRoot).map((d) => path.join(bugmeRoot, d, 'dist', 'prod')).filter((d) => fs.existsSync(path.join(d, AGENTS[0])))
  : [];
if (!bugmeDirs.length) throw new Error(`BugMe agents not found in ${bugmeRoot} (start minidev's simulator once to download them)`);
const bugme = bugmeDirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

fs.rmSync(outDir, { recursive: true, force: true });
const asar = openAsar(frontEndAsar);
const files = asar.list('/');
for (const file of files) {
  const dest = path.join(outDir, 'devtools-frontend', file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, asar.read(`/${file}`));
}
asar.close();
fs.mkdirSync(path.join(outDir, 'bugme'), { recursive: true });
for (const agent of AGENTS) fs.copyFileSync(path.join(bugme, agent), path.join(outDir, 'bugme', agent));

console.log(`Copied ${files.length} DevTools files from ${frontEndAsar}\nCopied ${AGENTS.join(', ')} from ${bugme}\n→ ${outDir}`);
