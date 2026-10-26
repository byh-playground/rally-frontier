const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readLock } = require('./setup-gamekit.cjs');
const { readVectorAssetManifest } = require('./vector-assets-manifest.cjs');
const sourcePaths = ['index.html', 'gamekit.lock.json', 'manifest.webmanifest', 'src', 'assets', 'campaign', 'icons'];

function verifySource(root = path.resolve(__dirname, '..')) {
  const lock = readLock(root);
  readVectorAssetManifest(root);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
  if (!html.includes('src="./src/main.js"') || !html.includes('href="./src/styles/main.css"')) throw Error('Original entrypoint missing');
  const moduleMap = JSON.parse(main.match(/const RALLY_GAMEKIT_MODULES=Object\.freeze\((\{[^\n]+\})\);/)?.[1] || 'null');
  if (!moduleMap || JSON.stringify(Object.keys(moduleMap).sort()) !== JSON.stringify(Object.keys(lock.modules).sort())) throw Error('Pinned SDK module map mismatch');
  for (const [name, entry] of Object.entries(lock.modules)) if (moduleMap[name] !== entry.file) throw Error('Pinned SDK module map mismatch: ' + name);
  if (!/const RALLY_GAMEKIT_SOURCE=Object\.freeze\(\{lock:['"]\.\/gamekit\.lock\.json['"]\}\);/.test(main)) throw Error('Pinned SDK lock descriptor mismatch');
  if (!main.includes('Gamekit module SHA-256 mismatch') || !main.includes("fetch(gamekitSource.lock")) throw Error('Pinned SDK source verification missing');
  const modules = ['src', 'campaign'].flatMap(folder => fs.readdirSync(path.join(root, folder), { recursive: true }).filter(file => file.endsWith('.js')).map(file => path.join(folder, file)));
  for (const file of modules) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
  for (const file of ['src/styles/main.css', 'icons/rally-180.png', 'manifest.webmanifest']) if (!fs.statSync(path.join(root, file)).size) throw Error('Missing source asset: ' + file);
  return lock;
}

function buildPages(root = path.resolve(__dirname, '..')) {
  root = path.resolve(root);
  // Remove the fixed checkout-local output first: a failed run cannot leave a stale PASS candidate.
  const out = path.resolve(root, '_site');
  if (path.dirname(out) !== root || path.basename(out) !== '_site') throw Error('Invalid output directory');
  fs.rmSync(out, { recursive: true, force: true });
  const lock = verifySource(root);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid source commit');
  const metadata = { format: 'source-esm', commit, builtAt: new Date().toISOString(), gamekit: { repository: lock.repository, sourceCommit: lock.sourceCommit, distCommit: lock.distCommit } };
  try {
    fs.mkdirSync(out);
    for (const asset of sourcePaths) fs.cpSync(path.join(root, asset), path.join(out, asset), { recursive: true });
    fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(metadata, null, 2) + '\n');
    fs.writeFileSync(path.join(out, '.nojekyll'), '');
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
  return metadata;
}
module.exports = { verifySource, buildPages, sourcePaths };
if (require.main === module) console.log(JSON.stringify(buildPages(), null, 2));
