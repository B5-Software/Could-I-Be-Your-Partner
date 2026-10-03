/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createAppPaths } = require('./electron-shim');

function defaultPreferencesFile() {
  let directory;
  try {
    directory = require('electron').app.getPath('userData');
  } catch {
    directory = createAppPaths().userData;
  }
  return path.join(directory, 'data', 'tui-preferences.json');
}

// Frontend preferences are deliberately separate from GUI/Agent settings.
function createPreferencesStore(file = defaultPreferencesFile()) {
  let queue = Promise.resolve();
  async function load() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return {
        thinkingExpanded:
          typeof data?.thinkingExpanded === 'boolean' ? data.thinkingExpanded : true,
      };
    } catch {
      return { thinkingExpanded: true };
    }
  }
  return {
    load,
    save(preferences) {
      const operation = queue
        .catch(() => {})
        .then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          const temporary = file + '.' + process.pid + '.tmp';
          try {
            await fs.writeFile(
              temporary,
              JSON.stringify({ thinkingExpanded: Boolean(preferences.thinkingExpanded) }, null, 2) +
                '\n',
              'utf8',
            );
            await fs.rename(temporary, file);
          } finally {
            await fs.rm(temporary, { force: true });
          }
        });
      queue = operation;
      return operation;
    },
  };
}

module.exports = { createPreferencesStore };
