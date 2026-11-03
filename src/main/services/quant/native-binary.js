/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
module.exports = require('../native-resource').createNativeRuntime(
  require('../../../../integrations/quant/runtime-lock.json'),
  'quant-engine',
);
module.exports.developmentBinary = (root) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    spec = module.exports.target();
  const prepared = path.join(root, 'native/quant-engine/target', spec.rust, 'release', spec.binary);
  return fs.existsSync(prepared)
    ? prepared
    : path.join(root, 'native/quant-engine/target/release', spec.binary);
};
