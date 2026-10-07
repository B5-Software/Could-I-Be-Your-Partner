/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs');
const { generateReleaseNotes, mergeReleaseNotes } = require('./lib/release-notes.cjs');
const options = {};
const allowed = new Set([
  'version',
  'to',
  'from',
  'repo',
  'output',
  'published-tags',
  'existing-body',
]);
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (!allowed.has(key) || !process.argv[i + 1]) throw Error('Expected --option value');
  options[key] = process.argv[i + 1];
}
const notes = generateReleaseNotes({
  ...options,
  publishedTags: options['published-tags']
    ? JSON.parse(fs.readFileSync(options['published-tags'], 'utf8'))
    : undefined,
});
const markdown = options['existing-body']
  ? mergeReleaseNotes(fs.readFileSync(options['existing-body'], 'utf8'), notes.markdown)
  : notes.markdown;
if (options.output) fs.writeFileSync(options.output, markdown);
else process.stdout.write(markdown);
