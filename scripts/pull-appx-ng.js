// Copies the appx-ng runtime out of an installed miniprogram service provider's IDE into vendor/appx-ng,
// so machines without the IDE can use it. Internal use only: these are the service provider's proprietary files.
// Usage: node scripts/pull-appx-ng.js [path/to/小程序开发者工具.app]
const fs = require('fs');
const path = require('path');
const { openAsar } = require('../asar-reader');

const ideAppPath = process.argv[2] || '/Applications/小程序开发者工具.app';
const asarPath = path.join(ideAppPath, 'Contents', 'Resources', 'app', 'libs', 'simulator-default-lib.asar');
const outDir = path.join(__dirname, '..', 'vendor', 'appx-ng');

const asar = openAsar(asarPath);
fs.rmSync(outDir, { recursive: true, force: true });
const files = asar.list('/appx-ng');
for (const file of files) {
  const dest = path.join(outDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, asar.read('/appx-ng/' + file));
}
asar.close();

const { appxVersion } = JSON.parse(fs.readFileSync(path.join(outDir, 'meta.json'), 'utf8'));
console.log(`Copied ${files.length} files (appx-ng ${appxVersion}) to ${outDir}`);
