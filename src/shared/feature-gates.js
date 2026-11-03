/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Experimental features require an explicit owner setting, including older profiles.
const quantEnabled = (settings) => settings?.features?.quant === true;
module.exports = { quantEnabled };
