'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '../native');
const architecture = process.env.REMOTE_CLI_NATIVE_ARCH || process.arch;
if (!['x64', 'arm64'].includes(architecture) || !['linux', 'darwin', 'win32'].includes(process.platform)) {
  throw new Error('Unsupported native build target');
}
const gyp = require.resolve('node-gyp/bin/node-gyp.js');
execFileSync(process.execPath, [gyp, 'rebuild', `--arch=${architecture}`], { cwd: root, stdio: 'inherit' });
const output = path.join(root, 'prebuilds', `${process.platform}-${architecture}`);
fs.mkdirSync(output, { recursive: true });
const binary = fs.readFileSync(path.join(root, 'build/Release/managed_native.node'));
fs.writeFileSync(path.join(output, 'managed_native.node'), binary);
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ protocol: 1, platform: process.platform, arch: architecture,
  napi: 8, sha256: crypto.createHash('sha256').update(binary).digest('hex'),
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'managed_native.c'))).digest('hex') }) + '\n');
