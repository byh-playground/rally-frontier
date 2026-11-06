const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readAcornSpriteManifest(root = path.resolve(__dirname, '..')) {
    const dir = path.join(root, 'assets/sprites/acorn');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const files = ['ammo.png', 'parts.png'];
    if (
        manifest?.schemaVersion !== 1 ||
        JSON.stringify(Object.keys(manifest.assets || {}).sort()) !== JSON.stringify(files)
    )
        throw Error('Invalid acorn sprite manifest');
    for (const file of files) {
        const entry = manifest.assets[file];
        if (
            !Number.isSafeInteger(entry?.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 2 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        )
            throw Error('Invalid acorn sprite metadata: ' + file);
        const bytes = fs.readFileSync(path.join(dir, file));
        if (
            bytes.length !== entry.bytes ||
            crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256
        )
            throw Error('Acorn sprite byte length or SHA-256 mismatch: ' + file);
    }
    return manifest;
}
module.exports = { readAcornSpriteManifest };
