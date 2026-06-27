'use strict';

const fs = require('fs');
const path = require('path');

function tempRoot() {
  const root = path.resolve(process.env.SLIDEY_TEMP_ROOT || path.join(process.cwd(), '.artifacts', 'tmp'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(tempRoot(), String(prefix || 'slidey-')));
}

module.exports = { tempRoot, mkdtemp };
