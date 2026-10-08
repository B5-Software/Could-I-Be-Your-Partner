/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Export names may be keywords (Schemastery exports `const`). Bind through
// generated aliases so the ES module never declares a keyword as a variable.
function sdkFiles(worker, name, api) {
  const names = Object.keys(api).filter(
    (key) => /^[A-Za-z_$][\w$]*$/.test(key) && !['default', '__esModule'].includes(key),
  );
  const reference = `require(${JSON.stringify(worker)}).vmSdk[${JSON.stringify(name)}]`;
  return {
    commonjs:
      'module.exports=' +
      reference +
      ';\n' +
      names.map((key) => 'exports.' + key + '=module.exports.' + key + ';').join('\n'),
    esm:
      "import api from './index.cjs';\nexport default api.default ?? api;\n" +
      names
        .map(
          (key, index) =>
            `const value${index}=api[${JSON.stringify(key)}];export {value${index} as ${key}};`,
        )
        .join('\n'),
  };
}
module.exports = { sdkFiles };
