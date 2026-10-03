/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * TUI 设置沿用测试：
 *   - i18n 覆盖率：TUI 用到的每个文案键在 en/de 都有译文（漏译即失败）
 *   - t() 行为：中文源文回退、en/de 取词、全局词典兜底
 *   - 数据目录：与 Electron 的 userData 对齐（否则读不到 GUI 的设置）
 *   - 语言加载：i18n 模块可在无 DOM 环境切换语言
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const { t, setLanguage, setGlobalTranslator, DICT } = require(path.join(root, 'src/tui/text.js'));
const { createAppPaths } = require(path.join(root, 'src/tui/electron-shim.js'));
const { loadI18n } = require(path.join(root, 'src/agent/i18n-loader.js'));
const { COMMANDS } = require(path.join(root, 'src/tui/commands.js'));

// ---------------- i18n 覆盖率 ----------------

function collectKeys() {
  const keys = new Set();
  for (const file of ['app.js', 'views.js', 'commands.js', 'text.js']) {
    const src = fs.readFileSync(path.join(root, 'src/tui', file), 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'(ui\.tui\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
    // 派生键：t('ui.tui.cmd.' + cmd.name) 等
    for (const m of src.matchAll(/t\(\s*'(ui\.tui\.(?:cmd|args|group))\.'\s*\+/g))
      keys.add(m[1] + '.*');
  }
  return keys;
}

test('i18n 覆盖率：TUI 文案键在 en/de 都有译文', () => {
  const keys = collectKeys();
  assert.ok(keys.size > 30, '应扫描到足够多的文案键，实际 ' + keys.size);
  const missing = [];
  for (const key of keys) {
    if (key.endsWith('.*') || key.endsWith('.')) continue; // 派生键按下表单独断言
    for (const lang of ['en', 'de']) {
      if (typeof DICT[lang][key] !== 'string') missing.push(lang + ' 缺 ' + key);
    }
  }
  assert.deepEqual(missing, [], '存在漏译的文案键');
});

test('i18n 覆盖率：命令表的描述/参数/分组键齐全', () => {
  const missing = [];
  for (const cmd of COMMANDS) {
    for (const lang of ['en', 'de']) {
      if (typeof DICT[lang]['ui.tui.cmd.' + cmd.name] !== 'string') {
        missing.push(lang + ' 缺 ui.tui.cmd.' + cmd.name);
      }
      if (cmd.args && typeof DICT[lang]['ui.tui.args.' + cmd.name] !== 'string') {
        missing.push(lang + ' 缺 ui.tui.args.' + cmd.name);
      }
    }
  }
  for (const group of ['general', 'session', 'message', 'info', 'custom']) {
    for (const lang of ['en', 'de']) {
      if (typeof DICT[lang]['ui.tui.group.' + group] !== 'string') {
        missing.push(lang + ' 缺 ui.tui.group.' + group);
      }
    }
  }
  assert.deepEqual(missing, [], '命令表存在漏译');
});

// ---------------- t() 行为 ----------------

test('t()：中文源文回退，en/de 取词，缺译回落中文', () => {
  setLanguage('zh-CN');
  assert.equal(t('ui.tui.helpTitle', '命令表'), '命令表');

  setLanguage('en');
  assert.equal(t('ui.tui.helpTitle', '命令表'), 'Commands');
  assert.equal(t('ui.tui.unknownKey', '中文回退'), '中文回退', '缺译应回落中文源文');

  setLanguage('de');
  assert.equal(t('ui.tui.helpTitle', '命令表'), 'Befehle');

  // 占位符填充
  setLanguage('en');
  assert.equal(
    t('ui.tui.switchedToSession', '已切换到会话 {title}', { title: 'X' }),
    'switched to session X',
  );

  // 全局词典兜底（GUI 共用键）
  setGlobalTranslator((key, fallback) => (key === 'ui.shared.x' ? 'GLOBAL' : fallback));
  setLanguage('en');
  assert.equal(t('ui.shared.x', '本地没有'), 'GLOBAL');
  setGlobalTranslator(null);
  setLanguage('zh-CN');
});

// ---------------- 数据目录（沿用 GUI 设置的关键） ----------------

test('数据目录：CIBYP_USER_DATA 显式指定优先', () => {
  const previous = process.env.CIBYP_USER_DATA;
  process.env.CIBYP_USER_DATA = path.join(os.tmpdir(), 'cibyp-explicit-profile');
  try {
    const paths = createAppPaths();
    assert.equal(paths.userData, process.env.CIBYP_USER_DATA);
  } finally {
    if (previous === undefined) delete process.env.CIBYP_USER_DATA;
    else process.env.CIBYP_USER_DATA = previous;
  }
});

test('数据目录：与 Electron userData 同名解析，并优先已有设置的目录', () => {
  const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-appdata-'));
  const options = { platform: 'win32', home: fakeAppData, env: { APPDATA: fakeAppData } };
  try {
    // 两个候选目录：只有“打包名”那个有 settings.json
    const devName = require(path.join(root, 'package.json')).name;
    const productName = require(path.join(root, 'package.json')).build.productName;
    const devDir = path.join(fakeAppData, devName);
    const packDir = path.join(fakeAppData, productName);
    fs.mkdirSync(path.join(packDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(packDir, 'data', 'settings.json'), '{}');

    const paths = createAppPaths(options);
    assert.equal(paths.userData, packDir, '应优先选择已有 settings.json 的目录');

    // 都没有设置时回落到 name 目录（开发态同 Electron）
    fs.rmSync(path.join(packDir, 'data', 'settings.json'));
    assert.equal(createAppPaths(options).userData, devDir);
    for (const platform of ['darwin', 'linux']) {
      const paths = createAppPaths({
        platform,
        home: fakeAppData,
        env: { XDG_CONFIG_HOME: fakeAppData },
      });
      assert.equal(
        paths.appData,
        platform === 'linux'
          ? fakeAppData
          : path.join(fakeAppData, 'Library', 'Application Support'),
      );
      assert.equal(paths.userData, path.join(paths.appData, devName));
    }
  } finally {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  }
});

// ---------------- i18n 在无 DOM 环境可用 ----------------

test('i18n 加载：无 DOM 环境可切换语言且系统提示可翻译', () => {
  const i18n = loadI18n();
  assert.equal(typeof i18n.t, 'function');
  assert.equal(typeof i18n.i18nSetLanguage, 'function');
  i18n.i18nSetLanguage('en');
  assert.equal(i18n.i18nGetLanguage(), 'en');
  i18n.i18nSetLanguage('zh-CN');
  assert.equal(i18n.i18nGetLanguage(), 'zh-CN');
  // GUI 词典里的工具回显翻译应可用（英文）
  i18n.i18nSetLanguage('en');
  if (typeof i18n.i18nToolReturn === 'function') {
    const out = i18n.i18nToolReturn('no_workspace', '未设置工作区');
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  }
  i18n.i18nSetLanguage('zh-CN');
});
