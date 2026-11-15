/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const validEvmChainId = (id) => Number.isSafeInteger(id) && id > 0;
const chainLabel = (id) => (id === 8453 ? 'Base' : id === 84532 ? 'Base Sepolia' : 'eip155:' + id);
module.exports = { validEvmChainId, chainLabel };
