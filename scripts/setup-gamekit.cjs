const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Rally consumes only these dependency-free dist entry points.
const moduleFiles = Object.freeze({ rollback: 'rollback.js', deterministic: 'deterministic.js', simloop: 'simloop.js', transport: 'transport.js', interpolation: 'interpolation.js', input: 'input.js', rendering: 'rendering.js', camera: 'camera.js', events: 'presentation-events.js', hud: 'hud.js', debug: 'debug-tools.js' });
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cacheDirectory = root => path.join(root, '.cache', 'gamekit');

function validateLock(lock) {
  if (!lock || lock.repository !== 'byh-playground/bloom-gamekit') throw Error('Invalid Gamekit lock repository');
  for (const key of ['sourceCommit', 'distCommit', 'upstreamRollbackCommit']) if (!/^[a-f0-9]{40}$/.test(lock[key] || '')) throw Error(`Invalid Gamekit lock ${key}`);
  if (!/^[a-f0-9]{64}$/.test(lock.distManifestSha256 || '')) throw Error('Invalid Gamekit lock distManifestSha256');
  if (!lock.modules || Object.keys(lock.modules).sort().join(',') !== Object.keys(moduleFiles).sort().join(',')) throw Error('Invalid Gamekit lock module set');
  for (const [name, file] of Object.entries(moduleFiles)) {
    const entry = lock.modules[name];
    if (!entry || entry.file !== file || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw Error(`Invalid Gamekit lock module: ${name}`);
  }
}

function readLock(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'gamekit.lock.json'), 'utf8'));
  validateLock(lock);
  return lock;
}

function validateManifest(bytes, lock) {
  if (sha256(bytes) !== lock.distManifestSha256) throw Error('Gamekit dist manifest integrity mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.modules)) throw Error('Invalid Gamekit dist manifest');
  for (const entry of Object.values(lock.modules)) {
    const matches = manifest.modules.filter(item => item.file === entry.file);
    if (matches.length !== 1 || matches[0].sha256 !== entry.sha256) throw Error(`Gamekit dist manifest module mismatch: ${entry.file}`);
  }
}

// Synchronous consumers never fetch implicitly. Setup is a separate build step.
function readGamekit(root, directory = cacheDirectory(root)) {
  const lock = readLock(root);
  try {
    const manifestBytes = fs.readFileSync(path.join(directory, 'manifest.json'));
    validateManifest(manifestBytes, lock);
    const modules = {};
    for (const [name, entry] of Object.entries(lock.modules)) {
      const bytes = fs.readFileSync(path.join(directory, entry.file));
      if (sha256(bytes) !== entry.sha256) throw Error(`Gamekit integrity mismatch: ${entry.file}`);
      modules[name] = bytes;
    }
    return { lock, manifestBytes, modules };
  } catch (error) {
    if (error.code === 'ENOENT') throw Error('Gamekit dependency cache is missing. Run npm run setup:gamekit before building or running QA.', { cause: error });
    throw error;
  }
}

async function download(url, fetchBytes) {
  const response = await fetchBytes(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`Gamekit download failed (${response.status}): ${url}`);
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw Error(`Gamekit download exceeds byte limit: ${url}`);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw Error(`Gamekit download exceeds byte limit: ${url}`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

async function setupGamekit(root = path.resolve(__dirname, '..'), { fetchBytes = globalThis.fetch } = {}) {
  root = path.resolve(root);
  const lock = readLock(root);
  try { readGamekit(root); return { distCommit: lock.distCommit, cached: true }; } catch (_) { /* Restore an absent or invalid cache from the immutable dist. */ }
  const base = `https://raw.githubusercontent.com/${lock.repository}/${lock.distCommit}/`;
  const manifestBytes = await download(base + 'manifest.json', fetchBytes);
  validateManifest(manifestBytes, lock);
  const modules = await Promise.all(Object.entries(lock.modules).map(async ([name, entry]) => {
    const bytes = await download(base + entry.file, fetchBytes);
    if (sha256(bytes) !== entry.sha256) throw Error(`Gamekit integrity mismatch: ${entry.file}`);
    return [name, bytes];
  }));
  const cache = cacheDirectory(root), parent = path.dirname(cache);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, 'gamekit-'));
  try {
    fs.writeFileSync(path.join(staging, 'manifest.json'), manifestBytes);
    for (const [name, bytes] of modules) fs.writeFileSync(path.join(staging, lock.modules[name].file), bytes);
    readGamekit(root, staging);
    // Both paths are fixed descendants of this checkout's ignored cache directory.
    if (path.dirname(cache) !== path.join(root, '.cache') || path.dirname(staging) !== parent) throw Error('Invalid Gamekit cache directory');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.renameSync(staging, cache);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return { distCommit: lock.distCommit, cached: false };
}

module.exports = { moduleFiles, cacheDirectory, readLock, readGamekit, setupGamekit };
if (require.main === module) setupGamekit().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
