const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SettingsAssistant, FIELDS } = require('../../src/main/services/settings-assistant');
const merge = require('../../src/main/settings/merge');
test('settings assistant never returns secrets and patches only exact validated safe leaves atomically', () => {
  let settings = {
    theme: { mode: 'dark' },
    llm: { apiKey: 'secret-key', pool: [{ apiKey: 'other-key' }] },
    user: { name: 'Private name' },
    privacyProtection: { enabled: true },
  };
  const assistant = new SettingsAssistant({
    getSettings: () => settings,
    update: (patch) => {
      settings = merge.mergeSettings
        ? merge.mergeSettings(settings, patch)
        : { ...settings, ...patch };
    },
  });
  const catalog = JSON.stringify(assistant.catalog());
  for (const secret of ['secret-key', 'other-key', 'Private name'])
    assert.ok(!catalog.includes(secret));
  for (const changes of [
    [{ path: '__proto__.test', value: true }],
    [{ path: 'llm.apiKey', value: 'new' }],
    [{ path: 'privacyProtection.enabled', value: false }],
    [{ path: 'theme.mode', value: 'invalid' }],
    [{ path: 'budget.dailyLimitUSD', value: Infinity }],
    [
      { path: 'theme.mode', value: 'light' },
      { path: 'llm.apiKey', value: 'new' },
    ],
  ])
    assert.throws(() => assistant.patch(changes));
  assert.equal(settings.theme.mode, 'dark');
  assert.equal(assistant.patch([{ path: 'theme.mode', value: 'light' }]).changes[0].value, 'light');
  assert.equal(settings.llm.apiKey, 'secret-key');
  assert.equal(assistant.navigate('llm.apiKey').manual, true);
  assert.throws(() => assistant.navigate('__proto__.test'));
});
test('settings assistant navigation targets exist in the correct category', () => {
  const html = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../src/renderer/pages/index.html'),
    'utf8',
  );
  for (const [name, category, id] of FIELDS) {
    if (!id) continue;
    const position = html.indexOf('id="' + id + '"');
    assert.ok(position >= 0, 'Missing field: ' + name);
    const before = html.slice(0, position);
    const tab = [...before.matchAll(/class="settings-panel[^"]*" data-tab="([^"]*)/g)].at(-1)?.[1];
    assert.equal(tab, category, name);
  }
});
