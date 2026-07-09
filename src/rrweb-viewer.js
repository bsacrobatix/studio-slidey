'use strict';

const fs = require('fs');
const path = require('path');

const RRWEB_EXT = /\.rrweb\.json$/i;

function isRrwebFile(filePath) {
  return RRWEB_EXT.test(String(filePath || ''));
}

function titleFromPath(filePath) {
  return path.basename(filePath).replace(RRWEB_EXT, '').replace(/[-_]+/g, ' ').trim() || 'rrweb replay';
}

function siblingAudio(filePath) {
  const stem = filePath.replace(RRWEB_EXT, '');
  for (const ext of ['.mp3', '.m4a', '.wav', '.ogg']) {
    const candidate = `${stem}${ext}`;
    if (fs.existsSync(candidate)) return path.basename(candidate);
  }
  return null;
}

function assertRrwebSource(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const events = Array.isArray(raw) ? raw : raw && Array.isArray(raw.events) ? raw.events : null;
  if (!events || events.length < 2) throw new Error(`not an rrweb event log: ${filePath}`);
  return raw;
}

function rrwebSpecForFile(filePath) {
  assertRrwebSource(filePath);
  const title = titleFromPath(filePath);
  const scene = {
    type: 'video',
    mode: 'fullscreen',
    rrweb: path.basename(filePath),
    chapters: 'auto',
    cinematic: false,
    eyebrow: 'rrweb',
    title,
    caption: 'DOM session replay',
  };
  const audio = siblingAudio(filePath);
  if (audio) scene.audio = audio;
  return {
    meta: {
      title,
      mode: 'pitch',
      generatedFrom: path.basename(filePath),
    },
    scenes: [scene],
  };
}

function readSpecOrRrweb(filePath) {
  if (isRrwebFile(filePath)) return rrwebSpecForFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  isRrwebFile,
  rrwebSpecForFile,
  readSpecOrRrweb,
};
