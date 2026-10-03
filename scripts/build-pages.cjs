const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function stampHtml(html, { commit, builtAt = new Date().toISOString() }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid build commit');
  const date = new Date(builtAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid build timestamp');
  date.setUTCMilliseconds(0);
  const iso = date.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, '') + '+0000';
  const id = `${stamp}-rf-${commit.slice(0, 12)}`;
  const marker = 'const BUILD_ID="development";';
  if (html.split(marker).length !== 2) throw new Error('Expected one development BUILD_ID marker');
  return { html: html.replace(marker, `const BUILD_ID=${JSON.stringify(id)};`),
    metadata: { id, commit, builtAt: iso } };
}

function buildPages(root = path.resolve(__dirname, '..')) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const result = stampHtml(source, { commit });
  // The only deleted directory is this fixed, ignored build output inside the checkout.
  const out = path.resolve(root, '_site');
  if (path.dirname(out) !== path.resolve(root) || path.basename(out) !== '_site') throw new Error('Invalid output directory');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  for (const asset of ['campaign', 'icons', 'manifest.webmanifest']) {
    fs.cpSync(path.join(root, asset), path.join(out, asset), { recursive: true });
  }
  fs.writeFileSync(path.join(out, 'index.html'), result.html);
  fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(result.metadata, null, 2) + '\n');
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return result.metadata;
}

module.exports = { stampHtml, buildPages };
if (require.main === module) console.log(JSON.stringify(buildPages(), null, 2));
