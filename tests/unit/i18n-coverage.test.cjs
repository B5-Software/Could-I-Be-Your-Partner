const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseDocument } = require('htmlparser2');
const dictionaries = {};
const context = vm.createContext({
  i18nRegister: (language, dictionary) => {
    dictionaries[language] = dictionary;
  },
});
for (const language of ['en', 'de'])
  vm.runInContext(fs.readFileSync(`src/renderer/js/i18n/${language}.js`, 'utf8'), context);

test('every renderer page has translations for static Chinese labels and explicit localization keys', () => {
  const missing = [];
  for (const file of fs
    .readdirSync('src/renderer/pages')
    .filter((file) => file.endsWith('.html'))) {
    function walk(node) {
      if (['script', 'style', 'pre', 'code'].includes(node.name)) return;
      const texts = [
        node.type === 'text' ? node.data.trim() : '',
        ...['title', 'placeholder', 'aria-label'].map((key) => node.attribs?.[key] || ''),
      ];
      for (const text of texts)
        if (/[\u3400-\u9fff]/.test(text))
          for (const language of ['en', 'de'])
            if (!dictionaries[language]._textMap[text]) missing.push([language, file, text]);
      for (const [attribute, key] of Object.entries(node.attribs || {}))
        if (/^data-i18n(?:-title|-placeholder|-aria-label)?$/.test(attribute))
          for (const language of ['en', 'de'])
            if (!dictionaries[language][key]) missing.push([language, file, key]);
      for (const child of node.children || []) walk(child);
    }
    walk(parseDocument(fs.readFileSync('src/renderer/pages/' + file, 'utf8')));
  }
  assert.deepEqual(missing, []);
});

test('new paginated search instructions and UI placeholders survive translation', () => {
  for (const language of ['en', 'de']) {
    const dict = dictionaries[language];
    assert.match(dict._toolSchemas.webSearch, /TinyFish/);
    assert.match(dict._toolSchemas.webSearch, /resultOffset/);
    assert.match(dict._toolSchemas.webFetch, /maxChars=0/);
    assert.ok(
      ['files', 'bytes', 'skipped'].every((key) =>
        dict['ui.vmFiles.complete'].includes('{' + key + '}'),
      ),
    );
    assert.ok(
      ['files', 'bytes', 'path'].every((key) =>
        dict['ui.vmFiles.progress'].includes('{' + key + '}'),
      ),
    );
  }
});
