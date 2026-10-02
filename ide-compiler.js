const fs = require('fs');
const os = require('os');
const path = require('path');

// Builds with the installed miniprogram service provider's IDE compiler instead of the one minidev downloads.
// minidev runs <MINIDEV_COMPILEDIR or ~/.minidev>/compilers/cubebuild@<version>/<platform>/mini-pkg-builder,
// with <version> from a remote schedule or its default (0.100.12). That compiler is older than the IDE's
// (kits/mini-pkg-builder, e.g. 0.109.0) and its output differs: unminified, larger, and pages that work
// from the IDE's preview fail on an mPaaS client. So the workers get MINIDEV_COMPILEDIR pointing at a
// folder of our own where every cubebuild@<version> links to the IDE's kits, and everything else to
// minidev's own compilers. ~/.minidev isn't changed. Works on macOS, Linux and Windows (Windows uses
// hard links / junctions, which don't need admin), and only when the IDE is installed; otherwise
// minidev uses its own compiler.

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const MINIDEV_DEFAULT_CUBE = '0.100.12';
const KIT_FILES = ['mini-pkg-builder', 'esbuild', 'packer'];

// minidev's folder name for this platform's compiler binaries
function platformDir() {
  if (WIN) return 'win32';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin_arm64' : 'darwin';
  if (process.platform === 'linux') return 'linux';
  return null;
}

// The IDE's app resources folder: macOS keeps it under Contents/Resources/app, Windows/Linux under resources/app
function appDir(ideAppPath) {
  if (!ideAppPath) return null;
  for (const base of [['Contents', 'Resources', 'app'], ['resources', 'app']]) {
    const dir = path.join(ideAppPath, ...base);
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function kitsDir(ideAppPath) {
  const app = appDir(ideAppPath);
  const dir = app && path.join(app, 'kits');
  return dir && fs.existsSync(path.join(dir, `mini-pkg-builder${EXE}`)) ? dir : null;
}

// A folder that looks like the miniprogram service provider's IDE (has the compiler kits)
const looksLikeIde = (dir) => Boolean(kitsDir(dir));

// Find the IDE when the configured path is missing: the setting if it's valid, else common install
// locations. On Windows the English/Chinese folder name varies, so scan the usual parents.
function resolveIdeAppPath(configured) {
  if (configured && looksLikeIde(configured)) return configured;
  const names = ['小程序开发者工具', 'Alipay Mini Program Studio', 'MiniProgramStudio', 'mini-ide'];
  const parents = WIN
    ? [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    : process.platform === 'darwin' ? ['/Applications', path.join(os.homedir(), 'Applications')]
      : ['/opt', '/usr/local', path.join(os.homedir(), '.local', 'share')];
  for (const parent of parents.filter(Boolean)) {
    for (const name of names) {
      const dir = path.join(parent, WIN ? name : `${name}.app`);
      if (looksLikeIde(dir)) return dir;
    }
    // Any subfolder that carries the kits (name we didn't guess)
    try {
      for (const entry of fs.readdirSync(parent)) {
        const dir = path.join(parent, entry);
        if (looksLikeIde(dir)) return dir;
      }
    } catch (e) { /* parent missing or unreadable */ }
  }
  return null;
}

// Link a file so minidev finds it: symlink on macOS/Linux; on Windows a hard link (no admin needed),
// falling back to a copy across volumes. Left in place when it already points at the same content.
function linkFile(target, at) {
  try {
    const st = fs.lstatSync(at);
    if (st.isSymbolicLink()) { if (fs.readlinkSync(at) === target) return; }
    else if (st.size === fs.statSync(target).size) return;
  } catch (e) { /* missing */ }
  fs.rmSync(at, { force: true });
  if (WIN) {
    try { fs.linkSync(target, at); return; } catch (e) { fs.copyFileSync(target, at); return; }
  }
  fs.symlinkSync(target, at);
}

// Link a directory: symlink on macOS/Linux, junction on Windows (no admin needed)
function linkDir(target, at) {
  try { if (fs.readlinkSync(at) === target) return; } catch (e) { /* missing/not a link */ }
  fs.rmSync(at, { recursive: true, force: true });
  fs.symlinkSync(target, at, WIN ? 'junction' : undefined);
}

// → the folder to use as MINIDEV_COMPILEDIR, or null to leave minidev on its own compiler
function prepareIdeCompilerDir(ideAppPath, dir) {
  const kits = kitsDir(ideAppPath);
  const platform = platformDir();
  if (!kits || !platform || !dir) return null;
  try {
    const compilers = path.join(dir, 'compilers');
    fs.mkdirSync(compilers, { recursive: true });
    const own = path.join(os.homedir(), '.minidev', 'compilers');
    const entries = fs.existsSync(own) ? fs.readdirSync(own) : [];
    const cubeVersions = new Set([`cubebuild@${MINIDEV_DEFAULT_CUBE}`, ...entries.filter((e) => e.startsWith('cubebuild@'))]);
    for (const name of cubeVersions) {
      const bin = path.join(compilers, name, platform);
      fs.mkdirSync(bin, { recursive: true });
      for (const f of KIT_FILES) {
        const src = path.join(kits, `${f}${EXE}`);
        if (fs.existsSync(src)) linkFile(src, path.join(bin, `${f}${EXE}`));
      }
    }
    // The other compilers (tiny, …) stay minidev's own
    for (const name of entries) if (!cubeVersions.has(name)) linkDir(path.join(own, name), path.join(compilers, name));
    return dir;
  } catch (e) {
    return null;
  }
}

module.exports = { prepareIdeCompilerDir, platformDir, appDir, resolveIdeAppPath };
