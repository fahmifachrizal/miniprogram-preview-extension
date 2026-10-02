// Build and install the extension into VS Code. Version is four parts, a.b.c.d:
//   a release · b staging · c feature order  (package.json "version", what VS Code requires — 3 parts)
//   d commit version   (commits since the last release tag; 0 right after tagging, so a tagged
//                        release like v1.0.0 builds as 1.0.0.0, then 1.0.0.1, 1.0.0.2, …)
// VS Code extension versions must be 3-part semver, so d can't live in "version"; it goes in the
// .vsix filename, build-info.json (baked into the package, shown on activation) and is available for
// the mPaaS package version. `--force` reinstalls even when a.b.c is unchanged.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function commitVersion() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (tag) return execFileSync('git', ['rev-list', '--count', `${tag}..HEAD`], { cwd: root }).toString().trim();
  } catch (e) { /* no tags yet — fall back to the total count */ }
  try { return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root }).toString().trim() || '0'; }
  catch (e) { return '0'; }
}

function commitHash() {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); }
  catch (e) { return ''; }
}

// Where the `code` CLI is: on PATH, or VS Code's bundled binary (macOS / Linux / Windows)
function codeBin() {
  const candidates = [
    'code',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    path.join(process.env.HOME || '', '.vscode/bin/code'),
    '/usr/share/code/bin/code',
    'C:/Program Files/Microsoft VS Code/bin/code.cmd',
  ];
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return c; } catch (e) { /* try next */ }
  }
  return null;
}

(function main() {
  const buildVersion = `${pkg.version}.${commitVersion()}`;
  // Baked into the package so the installed extension knows its full build version
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ buildVersion, commit: commitHash(), builtAt: new Date().toISOString() }, null, 2) + '\n');

  // Keep only the build we're about to make (the hook runs on every commit, so these accumulate)
  for (const f of fs.readdirSync(root)) {
    if (/^miniprogram-preview-.*\.vsix$/.test(f)) fs.rmSync(path.join(root, f), { force: true });
  }

  const vsix = path.join(root, `miniprogram-preview-${buildVersion}.vsix`);
  console.log(`Packaging ${buildVersion}…`);
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', vsix], { cwd: root, stdio: 'inherit' });

  const code = codeBin();
  if (!code) {
    console.log(`\nPackaged ${path.basename(vsix)}. The \`code\` CLI wasn't found, so install it manually:\n  Extensions: Install from VSIX… → ${path.basename(vsix)}`);
    return;
  }
  console.log(`Installing into VS Code (${code})…`);
  execFileSync(code, ['--install-extension', vsix, '--force'], { stdio: 'inherit' });
  console.log(`\nInstalled ${buildVersion}. Run "Developer: Reload Window" in VS Code to load it.`);
})();
