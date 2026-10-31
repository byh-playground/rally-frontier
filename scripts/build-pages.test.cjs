const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { verifySource, buildPages, sourcePaths } = require('./build-pages.cjs');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-source-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('rally-source-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const asset of sourcePaths) fs.cpSync(path.join(root, asset), path.join(dir, asset), { recursive: true });
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'source fixture'], { cwd: dir });
  return dir;
}
function compareTree(original, copied) {
  if (fs.statSync(original).isDirectory()) {
    assert.deepEqual(fs.readdirSync(copied), fs.readdirSync(original));
    for (const name of fs.readdirSync(original)) compareTree(path.join(original, name), path.join(copied, name));
  } else assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(original), original);
}
test('Pages artifact preserves every source byte and records separate revision provenance', t => {
  const dir = fixture(t), metadata = buildPages(dir);
  for (const asset of sourcePaths) compareTree(path.join(dir, asset), path.join(dir, '_site', asset));
  assert.equal(metadata.format, 'source-esm');
  assert.equal(metadata.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim());
  assert(Number.isFinite(Date.parse(metadata.builtAt)));
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'gamekit.lock.json')));
  assert.deepEqual(metadata.gamekit, { repository: lock.repository, sourceCommit: lock.sourceCommit, distCommit: lock.distCommit });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '_site/build.json'))), metadata);
  assert(!fs.existsSync(path.join(dir, '_site/.cache')));
  assert(fs.readFileSync(path.join(dir, '_site/src/main.js'), 'utf8').includes('const BUILD_ID="development";'));
  fs.writeFileSync(path.join(dir, '_site/stale.html'), 'old');
  buildPages(dir);
  assert(!fs.existsSync(path.join(dir, '_site/stale.html')));
});
test('missing source entrypoint fails and removes stale artifact before verification', t => {
  const dir = fixture(t);
  buildPages(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>old executable</html>');
  assert.throws(() => buildPages(dir), /Original entrypoint/);
  assert(!fs.existsSync(path.join(dir, '_site')));
});
test('source SDK module map must exactly match validated lock provenance', t => {
  const dir = fixture(t), main = path.join(dir, 'src/main.js');
  fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('"camera":"camera.js"', '"camera":"extra.js"'));
  assert.throws(() => verifySource(dir), /module map mismatch: camera/);
});
test('source packaging rejects tampered original SVGs', t => {
  const dir = fixture(t), manifest = JSON.parse(fs.readFileSync(path.join(dir, 'assets/units/manifest.json')));
  fs.writeFileSync(path.join(dir, manifest.assets[0].sourcePath), 'tampered');
  assert.throws(() => buildPages(dir), /Unit SVG (?:byte length|SHA-256) mismatch/);
});
for (const [name, change] of [
 ['repository', lock => { lock.repository = 'unexpected/repository'; }],
 ['source commit', lock => { lock.sourceCommit = 'unknown'; }],
 ['dist commit', lock => { lock.distCommit = null; }],
 ['manifest digest', lock => { lock.distManifestSha256 = 'bad'; }],
 ['missing module', lock => { delete lock.modules.camera; }],
 ['extra module', lock => { lock.modules.extra = lock.modules.camera; }],
 ['path traversal', lock => { lock.modules.camera.file = '../../camera.js'; }],
 ['invalid hash', lock => { lock.modules.camera.sha256 = 'bad'; }],
]) test(`source packaging rejects invalid provenance: ${name}`, t => {
 const dir=fixture(t), file=path.join(dir,'gamekit.lock.json'), lock=JSON.parse(fs.readFileSync(file));
 change(lock);fs.writeFileSync(file,JSON.stringify(lock));assert.throws(()=>buildPages(dir),/Invalid Gamekit lock/);
});

test('native source provenance reads only the canonical dependency lock', t => {
 const dir=fixture(t), file=path.join(dir,'src/main.js');
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace("lock:'./gamekit.lock.json'","lock:'./other-lock.json'"));
 assert.throws(()=>verifySource(dir),/lock descriptor mismatch/);
});
