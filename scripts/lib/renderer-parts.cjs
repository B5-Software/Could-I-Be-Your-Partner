/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  GenMapping,
  addSegment,
  setSourceContent,
  toEncodedMap,
} = require('@jridgewell/gen-mapping');

function collectParts(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectParts(path.join(directory, entry.name), relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}
function compareParts(a, b) {
  const aa = a.split('/');
  const bb = b.split('/');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1;
    if (bb[i] === undefined) return 1;
    const an = Number(/^\d+/.exec(aa[i])?.[0] ?? Infinity);
    const bn = Number(/^\d+/.exec(bb[i])?.[0] ?? Infinity);
    if (an !== bn) return an - bn;
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}
function validateManifest(directory, files) {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== 'string'))
    throw new Error('Empty or invalid renderer manifest');
  if (new Set(files).size !== files.length) throw new Error('Duplicate renderer part in manifest');
  const available = new Set(collectParts(directory));
  for (const file of files) {
    if (!available.delete(file)) throw new Error(`Missing or invalid renderer part: ${file}`);
  }
  if (available.size) throw new Error(`Unlisted renderer parts: ${[...available].join(', ')}`);
}
function assembleLegacy(directory, files, header) {
  validateManifest(directory, files);
  const mapping = new GenMapping();
  let contents = header + '\n';
  let generatedLine = contents.split('\n').length - 1;
  for (const file of files) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    const sourceName = `app-parts/${file}`;
    setSourceContent(mapping, sourceName, source);
    for (let line = 0; line < source.split('\n').length; line++)
      addSegment(mapping, generatedLine + line, 0, sourceName, line, 0);
    contents += source + '\n';
    generatedLine += source.split('\n').length;
  }
  contents += '\n})();\nappReady.catch(reportBootstrapFailure);\nexport default appReady;\n';
  const encoded = Buffer.from(JSON.stringify(toEncodedMap(mapping))).toString('base64');
  return `${contents}//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
}

module.exports = {
  collectParts,
  compareParts,
  validateManifest,
  assembleLegacy,
};
