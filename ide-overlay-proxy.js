const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { openAsar } = require('./asar-reader');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const APPX_NG_PREFIX = '/lyra/appx-ng/';
const VENDOR_DIR = path.join(__dirname, 'vendor', 'appx-ng');

// Reads appx-ng files from the extension's own vendor/ copy (see scripts/pull-appx-ng.js)
function vendorSource() {
  if (!fs.existsSync(path.join(VENDOR_DIR, 'meta.json'))) return null;
  return {
    read(relPath) {
      const full = path.join(VENDOR_DIR, relPath);
      if (!full.startsWith(VENDOR_DIR) || !fs.existsSync(full)) return null;
      return fs.readFileSync(full);
    },
    close() {},
  };
}

// Reads appx-ng files live from the installed IDE's asar archive
function ideSource(ideAppPath) {
  const asarPath = path.join(ideAppPath, 'Contents', 'Resources', 'app', 'libs', 'simulator-default-lib.asar');
  if (!fs.existsSync(asarPath)) return null;
  const asar = openAsar(asarPath);
  return { read: (relPath) => asar.read('/appx-ng/' + relPath), close: () => asar.close() };
}

// Proxy in front of minidev's dev server that serves the appx-ng runtime from the extension's
// bundled copy if present, otherwise live from the installed IDE. Prefers the bundled copy so
// results are stable across IDE updates/uninstalls.
function startOverlayProxy({ target, ideAppPath }) {
  const source = vendorSource() || ideSource(ideAppPath);
  if (!source) throw new Error('No appx-ng source available (no vendor/appx-ng bundle and no IDE found)');
  const targetUrl = new URL(target);

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, target).pathname;
    if (pathname.startsWith(APPX_NG_PREFIX)) {
      const data = source.read(decodeURIComponent(pathname.slice(APPX_NG_PREFIX.length)));
      if (data) {
        res.writeHead(200, { 'content-type': MIME[path.extname(pathname)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-served-from': 'ide' });
        res.end(data);
        return;
      }
    }
    const upstream = http.request({ host: targetUrl.hostname, port: targetUrl.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  // Forward WebSocket upgrades as raw TCP
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetUrl.port, targetUrl.hostname, () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => { server.close(); source.close(); },
    }));
  });
}

// Point every reference to the dev server (plain and URL-encoded) at the proxy
function rewriteUrl(url, fromHost, toHost) {
  return url.split(fromHost).join(toHost).split(encodeURIComponent(fromHost)).join(encodeURIComponent(toHost));
}

module.exports = { startOverlayProxy, rewriteUrl };
