const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SOURCE_BYTES = 512 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function readVectorAssetManifest(root) {
  const directory = path.resolve(root, 'assets/units');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'assets,schemaVersion' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length || manifest.assets.length > 1024) {
    throw new Error('Invalid unit SVG manifest');
  }
  const listed = new Set();
  const ids = new Set();
  const assets = manifest.assets.map((entry, index) => {
    if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,id,sha256,sourcePath,url') throw new Error(`Invalid unit SVG manifest entry ${index}`);
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error(`Invalid or duplicate unit SVG id: ${entry.id}`);
    const sourcePath = `assets/units/${entry.id}.svg`;
    if (entry.sourcePath !== sourcePath || entry.url !== `./${sourcePath}`) throw new Error(`Invalid unit SVG path: ${entry.id}`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > MAX_SOURCE_BYTES) throw new Error(`Invalid unit SVG byte length: ${entry.id}`);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Invalid unit SVG SHA-256: ${entry.id}`);
    ids.add(entry.id);
    listed.add(`${entry.id}.svg`);
    const sourceBytes = fs.readFileSync(path.join(directory, `${entry.id}.svg`));
    if (sourceBytes.byteLength !== entry.bytes) throw new Error(`Unit SVG byte length mismatch: ${sourcePath}`);
    if (digest(sourceBytes) !== entry.sha256) throw new Error(`Unit SVG SHA-256 mismatch: ${sourcePath}`);
    return { ...entry, sourceBytes };
  });
  const svgEntries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.svg'));
  if (svgEntries.some(entry => !entry.isFile())) throw new Error('Unit SVG assets must be regular files');
  const actual = svgEntries.map(entry => entry.name).sort();
  if (actual.length !== listed.size || actual.some(name => !listed.has(name))) throw new Error('Unit SVG manifest does not enumerate the exact assets/units SVG set');
  if (assets.some((entry, i) => i > 0 && assets[i - 1].id.localeCompare(entry.id) >= 0)) throw new Error('Unit SVG manifest entries must be sorted by id');
  return { manifest, assets };
}

module.exports = { MAX_SOURCE_BYTES, readVectorAssetManifest };
