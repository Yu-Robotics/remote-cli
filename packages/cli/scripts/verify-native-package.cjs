'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../native');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const source = digest(fs.readFileSync(path.join(root, 'managed_native.c')));
for (const target of ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64']) {
  const directory = path.join(root, 'prebuilds', target);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.protocol !== 1 || manifest.napi !== 8 || `${manifest.platform}-${manifest.arch}` !== target
    || manifest.sourceSha256 !== source || manifest.sha256 !== digest(fs.readFileSync(path.join(directory, 'managed_native.node')))) {
    throw new Error(`Invalid or mismatched native helper: ${target}`);
  }
}
console.log('All five tested native helper artifacts match this source.');
