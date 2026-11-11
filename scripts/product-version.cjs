const fs = require('node:fs');
const path = require('node:path');

// The product source is one literal export. Read it without executing game code.
function validateProductVersion(version) {
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
        throw Error('Product version must be canonical MAJOR.MINOR.PATCH');
    return version;
}
function parseProductVersion(source) {
    const declaration = /^\s*export const PRODUCT_VERSION\s*=\s*(['"])([^'"\r\n]+)\1;\s*$/.exec(
        source,
    );
    if (!declaration)
        throw Error('Product version source must contain only one literal PRODUCT_VERSION export');
    return validateProductVersion(declaration[2]);
}
function readProductVersion(root = path.resolve(__dirname, '..')) {
    return parseProductVersion(
        fs.readFileSync(path.join(root, 'src/core/product-version.js'), 'utf8'),
    );
}
module.exports = { validateProductVersion, parseProductVersion, readProductVersion };
