/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
module.exports = require('../native-resource').createNativeRuntime(
  require('../../../../integrations/wallet/runtime-lock.json'),
  'wallet-signer',
);
