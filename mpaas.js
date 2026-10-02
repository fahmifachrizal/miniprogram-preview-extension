const fs = require('fs');
const os = require('os');
const path = require('path');
const superagent = require('superagent');
const tar = require('tar');
const archiver = require('archiver');
const QRCode = require('qrcode');

// mPaaS mini program accounts, as the IDE's mPaaS adaptor does it for a "classic" config file
// (the JSON downloaded from the mPaaS console: login_url, upload_url, applist_url, appId, sign, …).
// The login returns the user; later calls send the config and user along with every request.

const REQUIRED_KEYS = ['login_url', 'upload_url', 'applist_url', 'appId', 'workspaceId', 'tenantId', 'sign'];
const API = {
  packageInfo: '/miniProgramPackage/getPackageInfoByApi',
  uploadPackage: '/miniProgramPackage/uploadPackageByApi',
  createWhiteList: '/whitelist/createWhiteListByApi',
};

// Returns a description of what's wrong, or null for a usable config
function checkConfig(config) {
  if (!config || typeof config !== 'object') return "it isn't a JSON object.";
  if (config.openapi) return "it's an OpenAPI-style config, which isn't supported yet.";
  const missing = REQUIRED_KEYS.filter((key) => !config[key]);
  return missing.length ? `it's missing ${missing.join(', ')}.` : null;
}

async function login(config, username, password) {
  const res = await superagent.post(config.login_url)
    .field({ loginName: username.toLowerCase(), password, sign: config.sign, config: JSON.stringify(config) })
    .accept('json');
  const { success, data, message } = (res.body && res.body.data) || {};
  if (!success) throw new Error(message || 'Login failed');
  data.userId = data.userId || data.id;
  return data;
}

// The adaptor's request(): config and user go along with every call; the result is body.data.data
async function request({ config, userInfo, url, method, req = {}, files = [] }) {
  const params = { ...req, config, appId: config.appId, workspaceId: config.workspaceId, tenantId: config.tenantId };
  if (userInfo.userId) params.userId = userInfo.userId;
  if (userInfo.loginName) params.loginName = userInfo.loginName;
  let res;
  if (method === 'FORM') {
    params.config = JSON.stringify(config);
    params.userInfo = JSON.stringify(userInfo);
    const fields = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
    const call = superagent.post(url).field(fields).accept('json');
    for (const { name, file } of files) call.attach(name, fs.createReadStream(file), { filename: path.basename(file), contentType: 'application/zip' });
    res = await call;
  } else {
    params.userInfo = userInfo;
    res = await superagent.get(url).query(params).accept('json');
  }
  const { data, success, resultMsg } = (res.body && res.body.data) || {};
  if (success !== true) throw new Error(resultMsg || 'Unknown error');
  return data;
}

// The adaptor joins upload_url and the API path with a "/" although the path starts with one
const apiUrl = (config, api) => `${config.upload_url}/${api}`;

async function appList(config, userInfo) {
  const list = await request({ config, userInfo, url: config.applist_url, method: 'GET', req: { miniType: '' } });
  return (list || []).map((app) => ({ appId: app.h5Id, appName: app.h5Name, vhost: app.vhost }));
}

// Loose JSON as the server sends it (sometimes HTML-escaped)
function parseLoose(value) {
  if (!value || typeof value !== 'string') return value || {};
  return JSON.parse(value.replace(/&amp;quot;|&quot;/gi, '"').replace(/&amp;/gi, '&'));
}

// Next development version: 1.0.0.3 → 1.0.0.4
function nextDevVersion(version = '1.0.0.0') {
  const [a, b, c, d = 0] = version.split('.');
  return [a, b, c, Number(d) + 1].join('.');
}

// The build's tar as a zip with everything under an <h5Id>/ folder, like the IDE uploads it
async function zipFromTar(tarFilePath, h5Id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-mpaas-'));
  const unpacked = path.join(dir, h5Id);
  fs.mkdirSync(unpacked);
  await tar.x({ file: tarFilePath, cwd: unpacked });
  const zipPath = path.join(dir, `${h5Id}.zip`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(unpacked, h5Id);
    archive.finalize();
  });
  return { zipPath, dir };
}

// Uploads a development package (type 4) and returns its QR code. tarFilePath is minidev's build.
// whiteList: the comma-separated whitelist allowed to open development packages, or empty/undefined
// to skip setting one (only devices already on an existing whitelist, if any, can open the package).
async function preview({ config, userInfo, app, tarFilePath, whiteList, extendInfo, appxVersion }) {
  const { appId: h5Id, appName: h5Name } = app;
  const info = (await request({ config, userInfo, url: apiUrl(config, API.packageInfo), method: 'GET', req: { h5Id, h5Name, packageTypes: '1,2,3,4' } })) || {};
  const vhost = info.vhost || app.vhost || 'h5app.com';
  const extraData = parseLoose(info.extraData);
  const h5Version = nextDevVersion(info.h5Version);

  if (whiteList) await request({ config, userInfo, url: apiUrl(config, API.createWhiteList), method: 'FORM', req: { whiteListValue: whiteList, h5Id } });

  const { zipPath, dir } = await zipFromTar(tarFilePath, h5Id);
  try {
    const fields = {
      h5Id, h5Name,
      mainUrl: info.mainUrl || '/index.html#pages/index/index',
      suburl: info.suburl || '',
      // The built package's extendInfo (launchParams: appxRouteFramework…), as the IDE uploads it,
      // falling back to whatever the server has on file
      extendInfo: String(extendInfo || info.extendInfo || '').replace(/&quot;|&amp;quot;/gi, '"'),
      autoInstall: info.autoInstall,
      resourceType: info.resourceType,
      installType: info.installType,
      platform: info.platform,
      clientVersionMin: info.clientVersionMin,
      clientVersionMax: info.clientVersionMax,
      enableTabBar: extraData.enableTabBar || '1',
      enableOptionMenu: extraData.enableOptionMenu || '1',
      enableKeepAlive: extraData.enableKeepAlive || '0',
      packageType: 4,
      // "2.0" for appx-ng packages, "1.0" otherwise — the IDE derives this from the built package's
      // launchParams.appxRouteFramework (see appxVersionFromExtendInfo in preview-worker.js)
      appxVersion: appxVersion || '1.0',
      vhost: `${h5Id}.${vhost}`,
      h5Version,
      uuid: 'mockuuid',
    };
    if (extraData.iconUrl) fields.iconUrl = extraData.iconUrl;
    let result = await request({ config, userInfo, url: apiUrl(config, API.uploadPackage), method: 'FORM', req: fields, files: [{ name: 'resourceFile', file: zipPath }] });
    if (typeof result === 'string') result = parseLoose(result);
    const debugUrl = result && result.debugUrl;
    if (!debugUrl) throw new Error(`The upload returned no preview URL: ${JSON.stringify(result)}`);
    const qrcodeUrl = await QRCode.toDataURL(debugUrl, { errorCorrectionLevel: 'L', margin: 1, width: 480 });
    return { qrcodeUrl, version: h5Version, debugUrl };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { checkConfig, login, appList, preview };
