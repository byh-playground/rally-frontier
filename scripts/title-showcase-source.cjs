const fs = require('node:fs');
const path = require('node:path');
const { readProductVersion } = require('./product-version.cjs');

function verifyTitleShowcase(root = path.resolve(__dirname, '..')) {
    const showcase = JSON.parse(
        fs.readFileSync(path.join(root, 'assets/title-showcase.json'), 'utf8'),
    );
    if (
        showcase.productVersion !== readProductVersion(root) ||
        showcase.seed !== 12349 ||
        showcase.checkpoints?.length !== 3
    )
        throw Error(
            'Title showcase version mismatch; regenerate with npm run generate:title-showcase',
        );
}
if (require.main === module) verifyTitleShowcase();
module.exports = { verifyTitleShowcase };
