#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 工作区同步集成冒烟（本机手工执行）：起真 VM，验证 shared 模式的双向增量同步语义。
 *
 * 覆盖：
 *   1. 首轮全量推送（含子目录/长路径/中文名），排除项不同步
 *   2. VM 内改文件 → 拉回宿主
 *   3. 宿主改文件 → 推送到 VM
 *   4. 宿主删除 → VM 同步删除
 *   5. 两侧同改 → 冲突：较新方胜出 + 败方另存 *.conflict-*
 *   6. 二次同步无变化（幂等，不重复传输）
 *
 * 用法：
 *   node vm-os/tests/sync-smoke.js --assets D:\path\to\assets --cmdline "root=PARTUUID=..."
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const images = require('../../src/main/vm/vm-images');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { WorkspaceSync } = require('../../src/main/vm/vm-workspace');

function parseArgs(argv) {
  const out = { assets: null, variant: 'base', version: null, cmdline: null, keep: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--assets') out.assets = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--version') out.version = val();
    else if (a === '--cmdline') out.cmdline = val();
    else if (a === '--keep') out.keep = true;
    else throw new Error('未知参数: ' + a);
  }
  if (!out.assets) throw new Error('缺少 --assets');
  return out;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 140) : ''}`);
}

// 落盘进度（崩溃/OOM 时 stdout 会丢失，日志必须同步写文件）
const LOG_FILE = path.join(os.tmpdir(), 'cibyp-sync-smoke.log');
function plog(msg) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${msg} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  console.log('  ' + line.trim());
}

async function main() {
  const opts = parseArgs(process.argv);
  try { fs.rmSync(LOG_FILE, { force: true }); } catch { /* ignore */ }
  plog('sync-smoke 开始');
  const assetsDir = path.resolve(opts.assets);
  const st = images.localStatus(assetsDir, { variant: opts.variant });
  const sel = opts.version ? st.versions.find((v) => v.version === opts.version) : st.selected;
  if (!sel || !sel.ok) throw new Error('未找到可用镜像: ' + JSON.stringify(st.missing));

  const inst = new VmInstance({
    assetsDir,
    imagePath: sel.image,
    kernelPath: sel.kernel,
    initrdPath: sel.initrd,
    variant: opts.variant,
    version: sel.version,
    instanceName: 'sync-smoke',
    config: { smp: 4, memMB: 4096, allowTcg: true, shutdownOnExit: true, kernelCmdline: opts.cmdline || null },
  });
  inst.on('state', (s) => { if (s.state === 'ready' || s.state === 'failed') console.log(`  [state] ${s.state} ${s.detail || ''}`); });
  await inst.start();
  console.log('VM 就绪，加速=' + (inst.accel && inst.accel.backend));

  // ---- 准备宿主工作区 ----
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-ws-'));
  const vmMount = '/workspace';
  const writeHost = (rel, content) => {
    const abs = path.join(hostRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  writeHost('a.txt', 'host-a');
  writeHost('sub/b.md', '# b');
  writeHost('deep/结构/长路径-' + 'x'.repeat(60) + '.txt', 'long');
  writeHost('node_modules/ignored.js', 'should-not-sync');
  writeHost('del-me.txt', 'bye');

  const svc = { instance: inst };
  const sync = new WorkspaceSync({
    vmService: svc,
    hostRoot,
    vmMount,
    instanceDir: inst.dir,
    options: { syncGit: false, maxFileMB: 8 },
  });
  sync.on('warn', (w) => console.log('  [warn]', w));

  // ---- 1) 首轮全量 ----
  plog('准备 VM 工作区目录');
  await inst.exec(`rm -rf ${vmMount} && mkdir -p ${vmMount} && chown cibyp:cibyp ${vmMount}`);
  plog('开始首轮同步');
  const r1 = await sync.sync({ reason: 'initial' });
  plog('首轮同步结束: ' + JSON.stringify({ ok: r1.ok, pushed: r1.pushed, ms: r1.ms, error: r1.error }));
  check('首轮同步成功', r1.ok, JSON.stringify({ pushed: r1.pushed, ms: r1.ms, conflicts: r1.conflicts && r1.conflicts.length }));
  const vmHas = async (p) => (await inst.exec(`test -e ${JSON.stringify(p)} && echo yes || echo no`)).stdout.trim() === 'yes';
  const vmCat = async (p) => (await inst.exec(`cat ${JSON.stringify(p)}`)).stdout;
  check('VM 侧收到文件', await vmHas(`${vmMount}/a.txt`) && await vmHas(`${vmMount}/sub/b.md`));
  check('长路径同步正确', (await vmCat(`${vmMount}/deep/结构/长路径-${'x'.repeat(60)}.txt`)).trim() === 'long');
  check('排除项未同步（node_modules）', !(await vmHas(`${vmMount}/node_modules/ignored.js`)));

  // ---- 2) VM 改 → 拉回 ----
  await inst.exec(`echo vm-edited > ${vmMount}/sub/b.md && sleep 1.2`);
  const r2 = await sync.sync({ reason: 'vm-edit' });
  check('VM 修改被拉回宿主', fs.readFileSync(path.join(hostRoot, 'sub', 'b.md'), 'utf8').trim() === 'vm-edited',
    `pulled=${r2.pulled}`);

  // ---- 3) 宿主改 → 推送 ----
  writeHost('a.txt', 'host-edited-2');
  const r3 = await sync.sync({ reason: 'host-edit' });
  check('宿主修改被推送到 VM', (await vmCat(`${vmMount}/a.txt`)).trim() === 'host-edited-2', `pushed=${r3.pushed}`);

  // ---- 4) 宿主删除 → VM 删除 ----
  fs.rmSync(path.join(hostRoot, 'del-me.txt'));
  const r4 = await sync.sync({ reason: 'host-delete' });
  check('宿主删除同步到 VM', !(await vmHas(`${vmMount}/del-me.txt`)), `deleted=${r4.deleted}`);

  // ---- 5) 两侧同改 → 冲突 ----
  writeHost('a.txt', 'host-conflict-version');
  await inst.exec(`echo vm-conflict-version > ${vmMount}/a.txt`);
  await new Promise((r) => setTimeout(r, 1200)); // 让 VM 侧 mtime 更新
  const r5 = await sync.sync({ reason: 'conflict' });
  const conflictFiles = () => {
    const dir = path.join(hostRoot, '.cibyp-conflicts');
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d, base) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = base ? `${base}/${e.name}` : e.name;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) walk(abs, rel); else out.push(rel);
      }
    };
    walk(dir, '');
    return out;
  };
  check('冲突被识别并保留败方副本', r5.conflicts.length >= 1 && conflictFiles().length >= 1,
    `conflicts=${JSON.stringify(r5.conflicts)} backups=${JSON.stringify(conflictFiles())}`);
  check('较新一方（VM）胜出', (await vmCat(`${vmMount}/a.txt`)).trim() === 'vm-conflict-version' &&
    fs.readFileSync(path.join(hostRoot, 'a.txt'), 'utf8').trim() === 'vm-conflict-version');
  check('冲突备份目录不进同步', !(await vmHas(`${vmMount}/.cibyp-conflicts`)));

  // ---- 6) 幂等 ----
  const r6 = await sync.sync({ reason: 'idempotent' });
  check('二次同步无传输（幂等）', r6.ok && r6.pushed === 0 && r6.pulled === 0,
    JSON.stringify({ pushed: r6.pushed, pulled: r6.pulled, files: r6.hostFiles }));

  // ---- 7) 冲突备份内容可读 ----
  const backups = conflictFiles();
  if (backups.length) {
    const backup = fs.readFileSync(path.join(hostRoot, '.cibyp-conflicts', ...backups[0].split('/')), 'utf8').trim();
    check('冲突备份含宿主原内容', backup === 'host-conflict-version', backup.slice(0, 40));
  }

  if (opts.keep) {
    console.log(`保持运行：hostRoot=${hostRoot} vmMount=${vmMount} sshPort=${inst.ports.ssh}`);
  } else {
    await inst.stop({ timeoutMs: 20000 });
    try { fs.rmSync(hostRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log('  ✗', f.name, '—', f.detail);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[sync-smoke 失败]', e.message);
  process.exit(1);
});
