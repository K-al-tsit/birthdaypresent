const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('main document IDs satisfy every app.js $() reference', () => {
  const html = read('index.html');
  const app = read('assets/app.js');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
  const missing = [...refs].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('stability stylesheet loads after the historical base stylesheet', () => {
  const html = read('index.html');
  const base = html.indexOf('assets/styles.css');
  const stability = html.indexOf('assets/stability.css');
  assert.ok(base >= 0);
  assert.ok(stability > base);
});

test('playlist contains exactly 21 playable tracks with unique track numbers', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('assets/content.js'), sandbox);
  const tracks = sandbox.window.SITE_CONTENT.tracks;
  assert.equal(tracks.length, 21);
  assert.equal(new Set(tracks.map((track) => track.no)).size, 21);
  assert.ok(tracks.every((track) => track.media === true));
});

test('lyrics requests are refreshable and unicode filename fallback is present', () => {
  const app = read('assets/app.js');
  assert.match(app, /cache:\s*"no-store"/);
  assert.match(app, /normalize\("NFD"\)/);
  assert.match(app, /normalize\("NFC"\)/);
});

test('archive page honors reduced motion', () => {
  const archive = read('memory/20/index.html');
  assert.match(archive, /prefers-reduced-motion:\s*reduce/);
  assert.match(archive, /position:\s*fixed;/);
});
