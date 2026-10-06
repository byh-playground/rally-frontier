const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stampHtml } = require('./build-pages.cjs');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const commit = 'a'.repeat(40);
const builtAt = '2026-10-03T04:10:20.000Z';

test('each deployment embeds its time and source revision without changing game code', () => {
  const first = stampHtml(source, { commit, builtAt });
  const later = stampHtml(source, { commit: 'b'.repeat(40), builtAt: '2026-10-04T00:00:00Z' });
  assert.equal(first.metadata.id, '20261003T041020+0000-rf-aaaaaaaaaaaa');
  assert.notEqual(first.metadata.id, later.metadata.id);
  assert.notEqual(first.metadata.id, stampHtml(source, { commit, builtAt: '2026-10-03T04:10:21Z' }).metadata.id);
  assert.equal(first.html.replace(`const BUILD_ID="${first.metadata.id}";`, 'const BUILD_ID="development";'), source);
  const declaration = first.html.match(/class BuildMetadata\{[\s\S]*?const BUILD_META=Object.freeze\([\s\S]*?\);/)[0];
  const sandbox = { BUILD_ID: first.metadata.id };
  vm.runInNewContext(declaration + ';globalThis.metadata=BUILD_META;', sandbox);
  assert.equal(new Date(sandbox.metadata.updatedAt).toISOString(), builtAt);
  for (const [, attrs, js] of first.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/type=["'](?:module|application\/json)/i.test(attrs)) new vm.Script(js);
  }
});

test('missing/duplicate marker and invalid provenance fail the build', () => {
  for (const html of ['', source.replace('const BUILD_ID="development";', 'const BUILD_ID="old";'), source + 'const BUILD_ID="development";']) {
    assert.throws(() => stampHtml(html, { commit, builtAt }), /marker/);
  }
  assert.throws(() => stampHtml(source, { commit: 'unknown', builtAt }), /commit/);
  assert.throws(() => stampHtml(source, { commit, builtAt: 'not-a-date' }), /timestamp/);
});

test('source checkout identifies itself as development rather than a stale release', () => {
  const declaration = source.match(/class BuildMetadata\{[\s\S]*?const BUILD_META=Object.freeze\([\s\S]*?\);/)[0];
  const sandbox = { BUILD_ID: 'development' };
  vm.runInNewContext(declaration + ';globalThis.metadata=BUILD_META;', sandbox);
  assert.equal(sandbox.metadata.updatedAt, null);
});

test('standalone build bundles verified modules, campaign and visual assets',()=>{
  const {bundleGame}=require('./bundle-gamekit.cjs');const root=path.resolve(__dirname,'..'),html=bundleGame(root,source);
  assert(html.includes('data:text/javascript;base64,'));assert(!html.includes('import(this.importAttempt?'));
  assert(!html.includes('href="./icons/'));assert(!html.includes('href="./manifest.webmanifest"'));
  for(const [,attrs,js]of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["'](?:module|application\/json)/i.test(attrs))new vm.Script(js);
});

const { bundleGame } = require('./bundle-gamekit.cjs');
const root = path.resolve(__dirname, '..');
const bundleMarkers = [
  ['module map', source.match(/const RALLY_GAMEKIT_MODULES=Object\.freeze\(\{[^\n]+\}\);/)[0]],
  ['provenance', source.match(/const RALLY_GAMEKIT_SOURCE=Object\.freeze\(\{[^\n]+\}\);/)[0]],
  ['campaign import', 'import(this.importAttempt?`./campaign/campaigns.js?retry=${this.importAttempt}`:"./campaign/campaigns.js")'],
  ['touch icon', 'href="./icons/rally-180.png"'],
  ['manifest link', '<link rel="manifest" href="./manifest.webmanifest">'],
];
for (const [name, marker] of bundleMarkers) {
  test(`standalone rejects missing, duplicate and unsupported-format ${name} markers`, () => {
    for (const html of [source.replace(marker, ''), source + marker, source.replace(marker, marker.replace(/([=(])/, '$1 '))]) {
      assert.throws(() => bundleGame(root, html), /Expected exactly one .* marker/);
    }
  });
}

test('standalone rejects newly introduced relative runtime dependencies', () => {
  for (const extra of [
    '<script>import("./extra.js")</script>',
    '<script>import ("extra.js")</script>',
    '<script>import x from "./extra.js"</script>',
    '<script>export {x} from "./extra.js"</script>',
    '<script>fetch("data/missions.json")</script>',
    '<script>new Worker("./worker.js")</script>',
    '<script>new URL("./texture.png", import.meta.url)</script>',
    '<script src="./extra.js"></script>',
    '<img src="images/extra.png">',
    '<script>image.src="./texture.png"</script>',
    '<div style="background: url(./extra.png)"></div>',
    '<style>@import "extra.css";</style>',
    '<link href="styles/extra.css" rel="stylesheet">',
    '<style>body { background: url(./extra.png) }</style>',
  ]) assert.throws(() => bundleGame(root, source + extra), /Unresolved .* (?:import|resource)/);
});

function fixture(t) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const asset of ['vendor', 'campaign', 'icons', 'manifest.webmanifest']) fs.cpSync(path.join(root, asset), path.join(dir, asset), { recursive: true });
  return dir;
}
function changeLock(dir, change) {
  const filename = path.join(dir, 'vendor/gamekit/provenance.json');
  const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
  change(lock);
  fs.writeFileSync(filename, JSON.stringify(lock));
}

test('standalone detects modified module bytes', t => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, 'vendor/gamekit/camera.js'), '\n// modified\n');
  assert.throws(() => bundleGame(dir, source), /integrity mismatch: camera.js/);
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
]) test(`standalone rejects invalid provenance: ${name}`, t => {
  const dir = fixture(t);
  changeLock(dir, change);
  assert.throws(() => bundleGame(dir, source), /Invalid Gamekit provenance/);
});

test('a new dependency fails even when its module hash is updated', t => {
  const dir = fixture(t);
  const filename = path.join(dir, 'vendor/gamekit/camera.js');
  fs.appendFileSync(filename, '\nimport "./extra.js";\n');
  changeLock(dir, lock => { lock.modules.camera.sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); });
  const manifestPath=path.join(dir,'vendor/gamekit/dist-manifest.json'), manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.modules.find(entry=>entry.file==='camera.js').sha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  changeLock(dir,lock=>{lock.distManifestSha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')});
  assert.throws(() => bundleGame(dir, source), /Unresolved runtime import in camera.js/);
});

test('authored campaigns cannot introduce hidden data-module dependencies', t => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, 'campaign/campaigns.js'), '\nexport {mission} from "./extra.js";\n');
  assert.throws(() => bundleGame(dir, source), /Unresolved runtime import in campaign/);
});

test('source checkout URL customization is untouched and standalone uses verified assets', () => {
  const customized = source.replace('./vendor/gamekit/camera.js', './custom/camera.js');
  const html = bundleGame(root, customized);
  assert(customized.includes('./custom/camera.js'));
  assert(!html.includes('./custom/camera.js'));
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), source);
});

test('bundled module bytes and embedded revision exactly match provenance', () => {
  const html = bundleGame(root, source);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'vendor/gamekit/provenance.json'), 'utf8'));
  const modules = JSON.parse(html.match(/const RALLY_GAMEKIT_MODULES=Object\.freeze\((\{[^\n]+\})\);/)[1]);
  const provenance = JSON.parse(html.match(/const RALLY_GAMEKIT_SOURCE=Object\.freeze\((\{[^\n]+\})\);/)[1]);
  assert.deepEqual(provenance, { repository: lock.repository, sourceCommit: lock.sourceCommit, distCommit: lock.distCommit });
  assert.deepEqual(Object.keys(modules).sort(), Object.keys(lock.modules).sort());
  for (const [name, entry] of Object.entries(lock.modules)) {
    const bytes = Buffer.from(modules[name].split(',')[1], 'base64');
    assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.deepEqual(bytes, fs.readFileSync(path.join(root, 'vendor/gamekit', entry.file)));
  }
});


test('distribution manifest digest and per-module provenance must agree',t=>{
 const dir=fixture(t),file=path.join(dir,'vendor/gamekit/dist-manifest.json'),bytes=fs.readFileSync(file);
 fs.appendFileSync(file,' ');assert.throws(()=>bundleGame(dir,source),/dist manifest integrity mismatch/);
 fs.writeFileSync(file,bytes);changeLock(dir,lock=>{lock.modules.camera.sha256='0'.repeat(64)});
 assert.throws(()=>bundleGame(dir,source),/dist manifest module mismatch: camera.js/);
});
