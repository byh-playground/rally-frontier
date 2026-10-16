const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readGamekit } = require('./setup-gamekit.cjs');
const { readVectorAssetManifest } = require('./vector-assets-manifest.cjs');

const root = path.resolve(__dirname, '..');
const { modules } = readGamekit(root);
const moduleURL = `data:text/javascript;base64,${modules.vectorAssetsLoader.toString('base64')}`;
const loaderAPI = import(moduleURL);
const fingerprintFile = path.join(__dirname, 'fixtures/vector-assets-legacy-fingerprints.json');
const fingerprints = JSON.parse(fs.readFileSync(fingerprintFile, 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceManifest = readVectorAssetManifest(root);

test('SDK startup compilation preserves every PR #76 vector geometry fingerprint', async () => {
  const { createVectorAssetLoader } = await loaderAPI;
  assert.equal(typeof createVectorAssetLoader, 'function');
  assert.equal(fingerprints.curveSegments, 16);
  assert.equal(sourceManifest.assets.length, Object.keys(fingerprints.assets).length);
  const loader = createVectorAssetLoader({ maxEntries: sourceManifest.assets.length });
  try {
    for (const { sourceBytes, ...entry } of sourceManifest.assets) {
      const url = `data:image/svg+xml;base64,${sourceBytes.toString('base64')}`;
      const asset = await loader.load(url, {
        sourcePath: entry.sourcePath,
        expectedSha256: entry.sha256,
        maxBytes: entry.bytes,
        curveSegments: 16,
        includeSourcePaths: false,
      });
      assert.equal(asset.sourceSha256, entry.sha256, `${entry.id} source hash`);
      assert.equal(Object.hasOwn(asset, 'sourcePaths'), false, `${entry.id} should omit sourcePaths`);
      assert.equal(sha256(JSON.stringify({ metadata: asset.metadata, viewBox: asset.viewBox, geometry: asset.geometry })), fingerprints.assets[entry.id], `${entry.id} geometry`);
    }
    assert.equal(loader.size, sourceManifest.assets.length);
  } finally {
    loader.dispose();
  }
});

test('SDK loader checks source bytes before compilation and does not cache failures', async () => {
  const { createVectorAssetLoader } = await loaderAPI;
  const entry = sourceManifest.assets[0];
  const bytes = entry.sourceBytes;
  let fetches = 0;
  const loader = createVectorAssetLoader({ fetch: async () => { fetches++; return new Response(bytes); } });
  await assert.rejects(loader.load('https://rally.invalid/unit.svg', {
    sourcePath: entry.sourcePath,
    expectedSha256: '0'.repeat(64),
    maxBytes: entry.bytes,
    curveSegments: 16,
    includeSourcePaths: false,
  }), /SHA-256 mismatch/);
  assert.equal(fetches, 1);
  assert.equal(loader.size, 0);
  assert.equal(loader.pendingCount, 0);
  loader.dispose();
});

test('SDK loader deduplicates concurrent requests and returns the cached compilation', async () => {
  const { createVectorAssetLoader } = await loaderAPI;
  const entry = sourceManifest.assets[0];
  let fetches = 0, finish;
  const loader = createVectorAssetLoader({ fetch: () => {
    fetches++;
    return new Promise(resolve => { finish = () => resolve(new Response(entry.sourceBytes)); });
  } });
  const options = { sourcePath: entry.sourcePath, expectedSha256: entry.sha256, maxBytes: entry.bytes, curveSegments: 16, includeSourcePaths: false };
  const first = loader.load('https://rally.invalid/unit.svg', options);
  const second = loader.load('https://rally.invalid/unit.svg', options);
  assert.equal(fetches, 1);
  assert.equal(loader.pendingCount, 1);
  finish();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(loader.size, 1);
  assert.equal(await loader.load('https://rally.invalid/unit.svg', options), a);
  assert.equal(fetches, 1);
  loader.dispose();
});
