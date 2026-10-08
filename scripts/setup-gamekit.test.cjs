const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cacheDirectory, readGamekit, setupGamekit } = require('./setup-gamekit.cjs');
const root = path.resolve(__dirname, '..');
const pinned = readGamekit(root);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-gamekit-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('rally-gamekit-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(root, 'gamekit.lock.json'), path.join(dir, 'gamekit.lock.json'));
  return dir;
}

function downloads(change = bytes => bytes) {
  const requests = [];
  const fetchBytes = async (url, options) => {
    const prefix = `https://raw.githubusercontent.com/${pinned.lock.repository}/${pinned.lock.distCommit}/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const file = url.slice(prefix.length);
    requests.push(file);
    const entry = Object.entries(pinned.lock.modules).find(([, entry]) => entry.file === file);
    const bytes = file === 'manifest.json' ? pinned.manifestBytes : pinned.modules[entry?.[0]];
    assert.ok(bytes, `Only pinned files may be fetched: ${file}`);
    return new Response(change(bytes, file));
  };
  return { requests, fetchBytes };
}

test('an empty checkout downloads immutable dist bytes, verifies them, and reuses them offline', async t => {
  const dir = fixture(t), mock = downloads();
  assert.throws(() => readGamekit(dir), /npm run setup:gamekit/);
  assert.deepEqual(await setupGamekit(dir, mock), { distCommit: pinned.lock.distCommit, cached: false });
  assert.deepEqual(mock.requests.sort(), ['manifest.json', ...Object.values(pinned.lock.modules).map(entry => entry.file)].sort());
  const result = readGamekit(dir);
  assert.deepEqual(result.lock, pinned.lock);
  assert.deepEqual(result.manifestBytes, pinned.manifestBytes);
  assert.deepEqual(result.modules, pinned.modules);
  assert.deepEqual(await setupGamekit(dir, { fetchBytes: () => { throw Error('Unexpected network'); } }), { distCommit: pinned.lock.distCommit, cached: true });
});

test('an invalid lock is rejected before downloading', async t => {
  const dir = fixture(t), lock = structuredClone(pinned.lock), mock = downloads();
  lock.distCommit = 'main';
  fs.writeFileSync(path.join(dir, 'gamekit.lock.json'), JSON.stringify(lock));
  await assert.rejects(setupGamekit(dir, mock), /Invalid Gamekit lock distCommit/);
  assert.deepEqual(mock.requests, []);
});

test('a corrupt manifest prevents module downloads and never installs a partial cache', async t => {
  const dir = fixture(t), mock = downloads(bytes => Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(setupGamekit(dir, mock), /dist manifest integrity mismatch/);
  assert.deepEqual(mock.requests, ['manifest.json']);
  assert.equal(fs.existsSync(cacheDirectory(dir)), false);
});

test('a corrupt module cannot be installed and a damaged cache can be restored', async t => {
  const dir = fixture(t), mock = downloads((bytes, file) => file === 'camera.js' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
  await assert.rejects(setupGamekit(dir, mock), /integrity mismatch: camera.js/);
  assert.equal(fs.existsSync(cacheDirectory(dir)), false);
  await setupGamekit(dir, downloads());
  fs.appendFileSync(path.join(cacheDirectory(dir), 'camera.js'), ' ');
  assert.throws(() => readGamekit(dir), /integrity mismatch: camera.js/);
  await setupGamekit(dir, downloads());
  assert.deepEqual(readGamekit(dir).modules, pinned.modules);
});

test('HTTP errors and oversized responses fail visibly without populating the cache', async t => {
  const dir = fixture(t);
  await assert.rejects(setupGamekit(dir, { fetchBytes: async () => new Response('', { status: 404 }) }), /download failed \(404\)/);
  await assert.rejects(setupGamekit(dir, { fetchBytes: async () => new Response('', { headers: { 'content-length': String(3 * 1024 * 1024) } }) }), /exceeds byte limit/);
  await assert.rejects(setupGamekit(dir, { fetchBytes: async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1)) }), /exceeds byte limit/);
  assert.equal(fs.existsSync(cacheDirectory(dir)), false);
});
