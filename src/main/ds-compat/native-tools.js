/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Resolve outside the shim's package scope: its identical package name makes
// an internal bare import a circular self-reference rather than the native SDK.
// A static import also keeps the native runtime inside the deployed VM bundle.
module.exports = require('@deepseek-ai/dsh-tools');
