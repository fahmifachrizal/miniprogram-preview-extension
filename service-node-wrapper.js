// Runs the IDE's service node (the script path is argv[2]) as a child of the simulator worker.
// The service node makes the app's network requests (my.request, downloadFile…), so the simulator's
// network emulation is applied here, to its outgoing HTTP(S) responses. The worker sends conditions
// as JSON lines on stdin ({"network":"3G"}); stdin closing means the worker is gone, so exit too.
const http = require('http');
const https = require('https');

// Same presets as the IDE (bytes/s, ms); WiFi and 5G are not throttled
const PRESETS = {
  '4G': { latency: 0, download: 3145728 },
  '3G': { latency: 100, download: 209715.2 },
  '2G': { latency: 300, download: 19200 },
};
let condition = null;

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  pending += data;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    try {
      const msg = JSON.parse(line);
      if ('network' in msg) condition = PRESETS[msg.network] || null;
    } catch (e) { /* ignore malformed lines */ }
  }
});
process.stdin.on('end', () => process.exit());

// Delay the response by the latency, then release its chunks no faster than the download rate
function throttle(req, c) {
  const emitRequest = req.emit;
  req.emit = function (event, ...args) {
    if (event !== 'response') return emitRequest.call(this, event, ...args);
    const res = args[0];
    const emitResponse = res.emit;
    let next = Date.now() + c.latency; // when the next chunk may be delivered
    res.emit = function (resEvent, ...resArgs) {
      if (resEvent !== 'data' && resEvent !== 'end') return emitResponse.call(this, resEvent, ...resArgs);
      if (resEvent === 'data') next = Math.max(next, Date.now()) + (resArgs[0].length / c.download) * 1000;
      setTimeout(() => emitResponse.call(this, resEvent, ...resArgs), Math.max(0, next - Date.now()));
      return true;
    };
    setTimeout(() => emitRequest.call(this, event, ...args), c.latency);
    return true;
  };
}

for (const mod of [http, https]) {
  const request = mod.request;
  mod.request = function (...args) {
    const req = request.apply(this, args);
    if (condition) throttle(req, condition);
    return req;
  };
  // http.get calls the module's own request binding, so route it through the patched one
  mod.get = function (...args) {
    const req = mod.request(...args);
    req.end();
    return req;
  };
}

require(process.argv[2]);
