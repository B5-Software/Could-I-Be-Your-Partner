/* SPDX-License-Identifier: GPL-3.0-or-later */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeTheme, systemDark } = require('../../src/tui/native-theme');
const { desktopAppearance } = require('../../src/main/vm/vm-theme');

test('headless nativeTheme resolves the real system preference before VM appearance is applied', async (t) => {
  assert.equal(
    await systemDark({
      platform: 'win32',
      run: async () => ({ stdout: 'AppsUseLightTheme    REG_DWORD    0x1' }),
    }),
    false,
  );
  assert.equal(
    await systemDark({
      platform: 'win32',
      run: async () => ({ stdout: 'AppsUseLightTheme    REG_DWORD    0x0' }),
    }),
    true,
  );
  assert.equal(
    await systemDark({
      platform: 'darwin',
      run: async () => {
        throw new Error('unset');
      },
    }),
    false,
  );
  assert.equal(
    await systemDark({ platform: 'linux', run: async () => ({ stdout: "'prefer-light'" }) }),
    false,
  );
  let dark = false;
  const theme = createNativeTheme({ detect: async () => dark });
  t.after(() => theme.dispose());
  await theme.ready;
  const palette = { mode: 'system', accentColor: '#000000', backgroundColor: '#ffffff' };
  assert.equal(desktopAppearance(palette, theme.shouldUseDarkColors).theme, 'light');
  const events = [];
  theme.on('updated', () => events.push(theme.shouldUseDarkColors));
  dark = true;
  await theme.refresh();
  assert.deepEqual(events, [true]);
  theme.themeSource = 'light';
  assert.equal(theme.shouldUseDarkColors, false);
  theme.themeSource = 'dark';
  assert.equal(theme.shouldUseDarkColors, true);
});
