const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const files = Object.freeze({
    body: 'body-hat.png',
    parts: 'parts.png',
    expressions: 'expressions.png',
});
function readRiceSpriteManifest(root = path.resolve(__dirname, '..')) {
    const directory = path.join(root, 'assets/sprites/rice');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        Object.keys(manifest.assets).sort().join(',') !== Object.keys(files).sort().join(',')
    )
        throw Error('Invalid rice sprite manifest');
    for (const [name, file] of Object.entries(files)) {
        const entry = manifest.assets[name];
        if (
            !entry ||
            entry.file !== file ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 2 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        )
            throw Error('Invalid rice sprite metadata: ' + name);
        const bytes = fs.readFileSync(path.join(directory, file));
        if (
            bytes.length !== entry.bytes ||
            crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        )
            throw Error('Rice sprite byte length or SHA-256 mismatch: ' + name);
    }
    return manifest;
}
module.exports = { readRiceSpriteManifest };
