const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseProductVersion, validateProductVersion } = require('./product-version.cjs');

function verifyReleaseVersion({ root = path.resolve(__dirname, '..'), commitSha, version } = {}) {
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) throw Error('A full source commit SHA is required');
  const source = execFileSync('git', ['show', `${commitSha}:src/core/product-version.js`], { cwd: root, encoding: 'utf8' });
  const productVersion = parseProductVersion(source);
  const approvedVersion = validateProductVersion(typeof version === 'string' ? version.replace(/^v/, '') : version);
  if (approvedVersion !== productVersion) throw Error('Stable version must match the selected source commit product version');
  return { commit: commitSha, productVersion };
}
module.exports = { verifyReleaseVersion };
if (require.main === module) console.log(JSON.stringify(verifyReleaseVersion({ commitSha: process.env.TARGET_SHA, version: process.env.RELEASE_VERSION })));
