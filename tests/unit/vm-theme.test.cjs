const { test } = require('node:test');
const assert = require('node:assert/strict');
const { desktopAppearance, VmAppearanceSync } = require('../../src/main/vm/vm-theme');

function decode(command) {
  return JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)[1], 'base64').toString());
}

test('VM uses the exact App colors and resolves system appearance', () => {
  assert.deepEqual(
    desktopAppearance({ mode: 'system', accentColor: '#A55EEA', backgroundColor: '#1B1433' }, true),
    {
      theme: 'dark',
      accent_color: '#a55eea',
      background_color: '#1b1433',
      appearance_source: 'app',
    },
  );
  assert.equal(desktopAppearance({ mode: 'light' }, true).theme, 'light');
  assert.equal(desktopAppearance({ mode: 'dark' }, false).theme, 'dark');
  assert.equal(desktopAppearance({ mode: 'system' }, false).theme, 'light');
  assert.equal(
    desktopAppearance({ accentColor: 'red; exit', backgroundColor: '"$(touch /tmp/bad)"' })
      .accent_color,
    '#4f8cff',
  );
});

test('offline appearance changes never start a VM and apply the latest saved values after boot', async () => {
  let instance = null;
  let theme = { mode: 'light' };
  const writes = [];
  const sync = new VmAppearanceSync({
    getInstance: () => instance,
    getTheme: () => theme,
    getSystemDark: () => false,
  });
  assert.equal((await sync.sync()).pending, true);
  theme = { mode: 'dark', accentColor: '#a55eea', backgroundColor: '#1b1433' };
  await sync.sync();
  instance = {
    state: 'ready',
    exec: async (command) => {
      writes.push(decode(command));
      return { ok: true };
    },
  };
  await sync.sync({ force: true });
  assert.deepEqual(writes, [desktopAppearance(theme)]);
});

test('rapid appearance changes serialize writes and coalesce intermediate colors', async () => {
  let theme = { accentColor: '#112233' };
  let release;
  const writes = [];
  const instance = {
    state: 'ready',
    exec: async (command) => {
      writes.push(decode(command));
      if (writes.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return { ok: true };
    },
  };
  const sync = new VmAppearanceSync({
    getInstance: () => instance,
    getTheme: () => theme,
    getSystemDark: () => false,
  });
  const first = sync.sync();
  theme = { accentColor: '#445566' };
  const second = sync.sync();
  theme = { accentColor: '#778899' };
  const third = sync.sync();
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(
    writes.map((row) => row.accent_color),
    ['#112233', '#778899'],
  );
  await sync.sync();
  assert.equal(writes.length, 2);
  await sync.sync({ force: true });
  assert.equal(writes.length, 3);
});

test('system appearance changes propagate without changing custom colors', async () => {
  let dark = false;
  const writes = [];
  const instance = {
    state: 'ready',
    exec: async (command) => {
      writes.push(decode(command));
      return { ok: true };
    },
  };
  const sync = new VmAppearanceSync({
    getInstance: () => instance,
    getTheme: () => ({ mode: 'system', accentColor: '#278877', backgroundColor: '#f0fff4' }),
    getSystemDark: () => dark,
  });
  await sync.sync();
  dark = true;
  await sync.sync();
  assert.deepEqual(
    writes.map((row) => row.theme),
    ['light', 'dark'],
  );
  assert.ok(
    writes.every((row) => row.accent_color === '#278877' && row.background_color === '#f0fff4'),
  );
});

test('failed guest writes remain retryable and do not suppress future changes', async () => {
  let failed = true;
  let calls = 0;
  const instance = {
    state: 'ready',
    exec: async () => {
      calls++;
      return { ok: !failed, stderr: 'disconnected' };
    },
  };
  const sync = new VmAppearanceSync({
    getInstance: () => instance,
    getTheme: () => ({}),
    getSystemDark: () => false,
  });
  await assert.rejects(sync.sync(), /disconnected/);
  failed = false;
  await sync.sync();
  assert.equal(calls, 2);
});
