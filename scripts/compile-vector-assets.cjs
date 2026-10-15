const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sourceCommit = '4150109c7732a734e155b6d1e2cd83c13c1f1d0c';
const compilerFiles = Object.freeze({
  'compiler.js': '1dfa99e9ce11afb9a9de18290ec049cbaecc3c720e3f6bd6ec7a7eb5913775cb',
  'schema.js': '989bb4eee231b973adcc2c0744c63055692399c3dfb592bd46457dadb2b3b1fd',
});
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const maximumSourceBytes = 2 * 1024 * 1024;

async function fetchVerified(url, expectedHash) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Official SVG compiler download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumSourceBytes) throw new Error(`Official SVG compiler source exceeds ${maximumSourceBytes} bytes`);
  if (sha256(bytes) !== expectedHash) throw new Error(`Official SVG compiler source hash mismatch: ${url}`);
  return bytes;
}

async function compileVectorAssets(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  const assetDirectory = path.join(root, 'assets', 'units');
  const sourceFiles = fs.readdirSync(assetDirectory).filter(name => /^[a-z0-9][a-z0-9-]*\.svg$/.test(name)).sort();
  if (!sourceFiles.length) throw new Error('No SVG unit assets found in assets/units');
  const outputDirectory = path.join(root, '.cache');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(outputDirectory, 'vector-compiler-'));
  if (path.dirname(temporaryRoot) !== outputDirectory || !path.basename(temporaryRoot).startsWith('vector-compiler-')) throw new Error('Invalid official compiler temporary directory');
  try {
    for (const [file, hash] of Object.entries(compilerFiles)) {
      const url = `https://raw.githubusercontent.com/byh-playground/bloom-gamekit/${sourceCommit}/modules/vector-assets/${file}`;
      fs.writeFileSync(path.join(temporaryRoot, file), await fetchVerified(url, hash));
    }
    fs.writeFileSync(path.join(temporaryRoot, 'package.json'), '{"type":"module"}\n');
    const { compileVectorAssetFile, compiledAssetModuleSource } = await import(pathToFileURL(path.join(temporaryRoot, 'compiler.js')));
    const assets = {};
    for (const file of sourceFiles) {
      const id = path.basename(file, '.svg');
      const compiled = await compileVectorAssetFile(path.join(assetDirectory, file), `assets/units/${file}`);
      const { sourcePaths, ...runtimeAsset } = compiled;
      assets[id] = runtimeAsset;
    }
    const header = `export const VECTOR_ASSET_COMPILER_SOURCE = ${JSON.stringify(sourceCommit)};\nexport const VECTOR_ASSET_COMPILER_FILES = Object.freeze(${JSON.stringify(compilerFiles)});\n`;
    const generated = header + compiledAssetModuleSource(Object.freeze(assets), 'compiledVectorAssets');
    const output = path.join(outputDirectory, 'vector-assets.compiled.js');
    fs.writeFileSync(output, generated);
    return { output, assetCount: sourceFiles.length, bytes: Buffer.byteLength(generated), sourceCommit };
  } finally {
    if (path.dirname(temporaryRoot) !== path.join(root, '.cache') || !path.basename(temporaryRoot).startsWith('vector-compiler-')) throw new Error('Refusing to remove unexpected compiler temporary path');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const { pathToFileURL } = require('node:url');
module.exports = { compileVectorAssets, compilerFiles, sourceCommit };
if (require.main === module) compileVectorAssets().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });