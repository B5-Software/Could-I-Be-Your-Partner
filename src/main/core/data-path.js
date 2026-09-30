/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const path = require('node:path');

/** IDs in settings/history APIs are names, never filesystem paths. */
function dataPath(directory, id, suffix = '') {
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 200 ||
    /[\\/\x00-\x1f<>:"|?*]/.test(id) ||
    id === '.' ||
    id === '..' ||
    /[. ]$/.test(id)
  )
    throw new TypeError('Invalid data ID');
  const root = path.resolve(directory);
  const target = path.resolve(root, id + suffix);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new TypeError('Data ID is outside its directory');
  return target;
}

module.exports = { dataPath };
