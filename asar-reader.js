// Under Electron (VS Code's runtime) the patched fs treats .asar paths as folders and can't open the
// archive file itself; its unpatched original-fs can
let fs;
try { fs = require('original-fs'); } catch (e) { fs = require('fs'); }

// Minimal read-only asar reader, so files are served straight from the user's installed IDE
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  const header = JSON.parse(json.toString());
  const dataOffset = 8 + headerSize;

  // Returns a Buffer, or null if the path is not a file in the archive
  function read(filePath) {
    let node = header;
    for (const part of filePath.split('/').filter(Boolean)) {
      node = node.files && node.files[part];
      if (!node) return null;
    }
    if (node.files || node.link) return null;
    if (node.unpacked) return fs.readFileSync(asarPath + '.unpacked/' + filePath.replace(/^\//, ''));
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, dataOffset + Number(node.offset));
    return buf;
  }

  // Lists file paths (relative to dir) under a directory in the archive
  function list(dir) {
    let node = header;
    for (const part of dir.split('/').filter(Boolean)) node = node.files[part];
    const out = [];
    (function walk(n, prefix) {
      for (const [name, child] of Object.entries(n.files)) {
        if (child.files) walk(child, prefix + name + '/');
        else if (!child.link) out.push(prefix + name);
      }
    })(node, '');
    return out;
  }

  return { read, list, close: () => fs.closeSync(fd) };
}

module.exports = { openAsar };
