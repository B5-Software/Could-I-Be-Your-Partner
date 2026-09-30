/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

/** Keep Office parser's version-specific API in one place for both import paths. */
async function extractOfficeText(filePath) {
  const { parseOffice } = require('officeparser');
  const ast = await parseOffice(filePath, {
    ignoreNotes: false,
    extractAttachments: false,
    ocr: false,
  });
  const { value } = await ast.to('text', {
    includeImages: false,
    textConfig: { newlineDelimiter: '\n', renderNotes: true },
  });
  if (typeof value !== 'string') throw new TypeError('Office parser returned non-text content');
  return value;
}

module.exports = { extractOfficeText };
