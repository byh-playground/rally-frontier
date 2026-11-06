const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FILES = ['parts.png', 'thorn.png', 'burr.png'].sort();
function readChestnutSpriteManifest(root = path.resolve(__dirname, '..')) {
    const dir = path.join(root, 'assets/sprites/chestnut'),
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(FILES)
    )
        throw Error('Invalid chestnut sprite manifest');
    for (const file of FILES) {
        const entry = manifest.assets[file];
        if (
            !entry ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > 3 * 1024 * 1024 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        )
            throw Error('Invalid chestnut sprite metadata: ' + file);
        const data = fs.readFileSync(path.join(dir, file));
        if (
            data.length !== entry.bytes ||
            crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256
        )
            throw Error('Chestnut sprite byte length or SHA-256 mismatch: ' + file);
    }
    return manifest;
}
module.exports = { readChestnutSpriteManifest };
