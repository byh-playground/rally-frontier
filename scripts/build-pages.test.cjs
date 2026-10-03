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
