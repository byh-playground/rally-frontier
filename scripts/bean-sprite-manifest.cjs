const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const names = [
    'pea-body',
    'red-body',
    'pea-arm-l',
    'pea-arm-r',
    'red-arm-l',
    'red-arm-r',
    'pea-leg-l',
    'pea-leg-r',
    'red-leg-l',
    'red-leg-r',
    'face-neutral',
    'face-happy',
    'face-hurt',
    'face-angry',
]
    .map((name) => name + '.png')
    .sort();
function readBeanSpriteManifest(root = path.resolve(__dirname, '..')) {
    const dir = path.join(root, 'assets/sprites/beans'),
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(names)
    )
        throw Error('Invalid bean sprite manifest');
    for (const file of names) {
        const entry = manifest.assets[file];
        if (
            !entry ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 524288 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        )
            throw Error('Invalid bean sprite metadata: ' + file);
        const bytes = fs.readFileSync(path.join(dir, file));
        if (
            bytes.length !== entry.bytes ||
            crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        )
            throw Error('Bean sprite byte length or SHA-256 mismatch: ' + file);
    }
    return manifest;
}
module.exports = { readBeanSpriteManifest };
