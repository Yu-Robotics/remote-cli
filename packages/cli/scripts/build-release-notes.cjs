const fs = require('fs');
const path = require('path');
const { buildReleaseIndex } = require('../dist/maintenance/ReleaseNotes');
const version = require('../package.json').version;
const source = fs.readFileSync(path.resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
const index = buildReleaseIndex(source, version);
fs.writeFileSync(path.resolve(__dirname, '../dist/maintenance/release-notes.json'), JSON.stringify(index));
