#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 本文件属于 Could I Be Your Partner.
 *
 * 工具路由集成冒烟：起真 VM，验证"运行位置=虚拟机时所有文件类工具都作用于虚拟机"。
 *
 * 覆盖：
 *   A. 纯文件操作（vm-fs）：写/读/列目录/信息/搜索/改名/复制/删除/上传/转码/base64
 *   B. 宿主库工具暂存（vm-tools）：输出落到 VM、返回值回映为 VM 路径、输入从 VM 拉取
 *
 * 用法：
 *   node vm-os/tests/tools-smoke.js --assets D:\path --variant base --version <v> [--cmdline "..."]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const images = require('../../src/main/vm/vm-images');
const { VmInstance } = require('../../src/main/vm/vm-instance');
const { VmFs } = require('../../src/main/vm/vm-fs');
const { installVmToolRouting } = require('../../src/main/vm/vm-tools');

function parseArgs(argv) {
  const out = { assets: null, variant: 'base', version: null, cmdline: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--assets') out.assets = val();
    else if (a === '--variant') out.variant = val();
    else if (a === '--version') out.version = val();
    else if (a === '--cmdline') out.cmdline = val();
    else throw new Error('未知参数: ' + a);
  }
  if (!out.assets) throw new Error('缺少 --assets');
  return out;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 220) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 150) : ''}`);
}

async function main() {
  const opts = parseArgs(process.argv);
  const assetsDir = path.resolve(opts.assets);
  const st = images.localStatus(assetsDir, { variant: opts.variant });
  const sel = opts.version ? st.versions.find((v) => v.version === opts.version) : st.selected;
  if (!sel || !sel.ok) throw new Error('未找到可用镜像');

  const inst = new VmInstance({
    assetsDir, imagePath: sel.image, kernelPath: sel.kernel, initrdPath: sel.initrd,
    variant: opts.variant, version: sel.version, instanceName: 'tools-smoke',
    config: { smp: 4, memMB: 4096, allowTcg: true, shutdownOnExit: true, kernelCmdline: opts.cmdline || null },
  });
  await inst.start();
  console.log('VM 就绪，加速=' + (inst.accel && inst.accel.backend));

  // 宿主工作区（模拟真实 workspacePath）
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cibyp-tools-'));
  fs.mkdirSync(path.join(hostRoot, 'sub'), { recursive: true });
  const hostFile = (rel) => path.join(hostRoot, ...rel.split('/'));

  // 用真实 vmService 的最小替身（路径映射 + 实例）
  const vmService = {
    instance: inst,
    runtime: { vm: { workspaceMount: '/workspace' }, workspaceMode: 'shared' },
    toVmPath: (p) => {
      const rel = path.relative(path.resolve(hostRoot), path.resolve(String(p))).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return '/workspace';
      return '/workspace/' + rel;
    },
    toHostPath: (p) => String(p).startsWith('/workspace') ? path.join(hostRoot, ...String(p).slice('/workspace'.length).replace(/^\/+/, '').split('/')) : null,
  };
  const vmFs = new VmFs({ vmService });
  const vmPath = (rel) => '/workspace/' + rel;

  // ============ A. 纯文件操作 ============
  let r = await vmFs.writeFile(hostFile('sub/a.txt'), 'hello-vm\n第二行');
  check('writeFile → VM', r.ok && (await inst.exec(`cat ${JSON.stringify(vmPath('sub/a.txt'))}`)).stdout.includes('第二行'), JSON.stringify(r));

  r = await vmFs.readFile(hostFile('sub/a.txt'));
  check('readFile ← VM', r.ok && r.content.includes('hello-vm') && r.encoding, `encoding=${r.encoding} eol=${r.eol}`);

  r = await vmFs.createFile(hostFile('deep/new/b.txt'), 'new-file');
  check('createFile（自动建目录）', r.ok && (await inst.exec(`test -f ${JSON.stringify(vmPath('deep/new/b.txt'))} && echo yes`)).stdout.includes('yes'));

  r = await vmFs.listDirectory(hostRoot);
  check('listDirectory', r.ok && r.entries.some((e) => e.name === 'sub') && r.entries.some((e) => e.name === 'deep'), JSON.stringify(r.entries && r.entries.map((e) => e.name)));

  r = await vmFs.getFileInfo(hostFile('sub/a.txt'));
  check('getFileInfo', r.ok && r.exists && r.size > 0, JSON.stringify(r));

  r = await vmFs.copyFile(hostFile('sub/a.txt'), hostFile('sub/a-copy.txt'));
  r = r.ok && await vmFs.moveFile(hostFile('sub/a-copy.txt'), hostFile('sub/a-moved.txt'));
  check('copyFile + moveFile', !!r.ok && (await inst.exec(`test -f ${JSON.stringify(vmPath('sub/a-moved.txt'))} && echo yes`)).stdout.includes('yes'));

  r = await vmFs.searchInFiles([hostFile('sub')], 'hello', { regex: false });
  check('searchInFiles（VM 内 grep）', r.ok && r.totalMatches >= 1 && r.results[0].matches[0].line === 1, JSON.stringify(r.results && r.results[0] && r.results[0].matches[0]));

  r = await vmFs.localSearch(hostRoot, '*.txt');
  check('localSearch（文件名 glob）', r.ok && r.count >= 3, `count=${r.count} 例：${(r.results || [])[0]}`);

  r = await vmFs.convertFileEncoding(hostFile('sub/a.txt'), { eol: 'crlf', encoding: 'utf-8' });
  const crlf = (await vmFs.readBuffer(hostFile('sub/a.txt'))).toString('utf8').includes('\r\n');
  check('convertFileEncoding（VM 内转码）', r.ok && crlf, JSON.stringify(r));

  r = await vmFs.saveUploadedFile('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  check('saveUploadedFile → VM /workspace/_images', r.ok && r.path.startsWith('/workspace/') && (await inst.exec(`test -f ${JSON.stringify(r.path)} && echo yes`)).stdout.includes('yes'), r.path);

  r = await vmFs.readFileBase64(hostFile('sub/a.txt'));
  check('readFileBase64', r.ok && r.data.startsWith('data:text/plain;base64,') === false && r.data.startsWith('data:application/octet-stream;base64,'), r.mime);

  r = await vmFs.deleteFile(hostFile('sub/a-moved.txt'));
  check('deleteFile', r.ok && !(await vmFs.exists(hostFile('sub/a-moved.txt'))));

  // ============ B. 宿主库工具暂存（用假处理器模拟 word:create 等服务） ============
  const handlers = new Map();
  const fakeHandlers = {
    // 模拟 docx/pptx/xlsx 生成：把文件写进 workspacePath，返回宿主路径
    'word:create': (_e, spec, workspacePath) => {
      const out = path.join(workspacePath, `${spec.name || 'doc'}.docx`);
      fs.mkdirSync(workspacePath, { recursive: true });
      fs.writeFileSync(out, 'FAKE-DOCX:' + (spec.title || ''));
      return { ok: true, path: out, bytes: fs.statSync(out).size };
    },
    // 模拟需要读取输入文件的工具：返回读到的内容长度
    'word:extractText': (_e, filePath) => {
      const text = fs.readFileSync(filePath, 'utf8');
      return { ok: true, text, source: filePath };
    },
  };
  for (const [k, v] of Object.entries(fakeHandlers)) handlers.set(k, v);
  const fakeIpc = { handle: () => {} };
  const { installed } = installVmToolRouting({
    ipcMain: fakeIpc,
    handlers,
    getVmService: () => vmService,
    isLocationVm: () => true,
    originalHandle: (channel, fn) => handlers.set(channel, fn), // 覆盖到同一 map，便于测试直接调用
  });
  check('路由安装（fs:* + 工具通道）', installed.includes('word:create') && installed.includes('word:extractText'), `${installed.length} 个通道: ${installed.join(',')}`);

  // 直接调用被覆盖后的 word:create（相当于 VM 模式下渲染进程的调用）
  const created = await handlers.get('word:create')(null, { name: 'report', title: '季度报告' }, hostRoot);
  check('word:create 产物落在 VM 且返回 VM 路径',
    created.ok && created.path.startsWith('/workspace/') && (await inst.exec(`test -f ${JSON.stringify(created.path)} && echo yes`)).stdout.includes('yes'),
    JSON.stringify(created));

  const content = (await vmFs.readBuffer(created.path)).toString('utf8');
  check('word:create 内容正确', content === 'FAKE-DOCX:季度报告', content.slice(0, 40));

  // 需要读入的工具：VM 文件 → 宿主临时 → 处理
  await vmFs.writeFile(hostFile('sub/extract.docx'), 'FAKE-DOCX-IN');
  const extracted = await handlers.get('word:extractText')(null, hostFile('sub/extract.docx'));
  check('word:extractText 能从 VM 读入', extracted.ok && extracted.text === 'FAKE-DOCX-IN', JSON.stringify(extracted).slice(0, 120));

  await inst.stop({ timeoutMs: 20000 });
  try { fs.rmSync(hostRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log('  ✗', f.name, '—', f.detail);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[tools-smoke 失败]', e.message); process.exit(1); });
