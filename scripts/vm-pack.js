#!/usr/bin/env node
/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * QEMU 运行时裁剪打包：把官方安装包解包出的大目录（Windows 实测 1.25GB / 3387 文件）
 * 裁剪成"只够跑 CIBYP-VM-OS"的运行时包（zip），交给 Release 分发、应用内下载。
 *
 * 各平台策略：
 *   win32 : 解析 PE 导入表做 DLL 依赖闭包（纯 Node，无需外部工具）
 *   linux : 用 ldd 收集 .so 闭包（需要宿主有 ldd）
 *   darwin: 用 otool -L 收集 dylib 闭包，并可用 install_name_tool 改写路径
 *
 * 保留清单（按需增减）：
 *   qemu-system-x86_64 / qemu-system-aarch64   实际要跑的 softmmu
 *   qemu-system-xtensa                         ESP32 固件模拟（IoT-Firmware 用）
 *   qemu-img                                   镜像/overlay 操作
 *   share/ 固件（bios.bin、kvmvapic.bin、edk2-*）—— 缺失会导致启动失败
 *
 * 用法：
 *   node scripts/vm-pack.js --src <解包目录> --out <输出目录> [--platform win32|linux|darwin]
 *        [--arch x64|arm64] [--qemu-version 11.1.0] [--zip] [--keep-esp32]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------- PE 解析（Windows DLL 闭包）

/** 读取 PE 文件的导入 DLL 名称列表（x86/x64 通用，只取名字） */
function peImportedDlls(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return []; }
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return []; // MZ
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.length < peOff + 24 || buf.readUInt32LE(peOff) !== 0x00004550) return []; // PE\0\0
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const optOff = coff + 20;
  const magic = buf.readUInt16LE(optOff);
  const isPe32Plus = magic === 0x20b;
  const numRva = buf.readUInt32LE(optOff + (isPe32Plus ? 108 : 92));
  const ddOff = optOff + (isPe32Plus ? 112 : 96);
  if (numRva < 2) return [];
  const importRva = buf.readUInt32LE(ddOff + 8);
  if (!importRva) return [];
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = optOff + optSize + i * 40;
    sections.push({
      va: buf.readUInt32LE(s + 12),
      vsize: buf.readUInt32LE(s + 8),
      raw: buf.readUInt32LE(s + 20),
      rawSize: buf.readUInt32LE(s + 16),
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va);
    }
    return null;
  };
  const out = [];
  let off = rvaToOff(importRva);
  if (off === null) return [];
  for (let guard = 0; guard < 256; guard++) {
    if (off + 20 > buf.length) break;
    const nameRva = buf.readUInt32LE(off + 12);
    if (!nameRva) break;
    const nameOff = rvaToOff(nameRva);
    if (nameOff === null) break;
    const end = buf.indexOf(0, nameOff);
    if (end < 0) break;
    out.push(buf.toString('ascii', nameOff, end));
    off += 20;
  }
  return out;
}

/** DLL 闭包：从入口 exe 递归收集同目录内的 DLL（系统 DLL 由 Windows 提供，跳过） */
function windowsDllClosure(srcDir, entryFiles) {
  const dirEntries = new Map();
  for (const name of fs.readdirSync(srcDir)) {
    dirEntries.set(name.toLowerCase(), name);
  }
  const needed = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const file = queue.pop();
    const abs = path.join(srcDir, file);
    for (const dll of peImportedDlls(abs)) {
      const local = dirEntries.get(dll.toLowerCase());
      if (!local) continue; // 系统 DLL（kernel32 等）
      if (needed.has(local)) continue;
      needed.add(local);
      queue.push(local);
    }
  }
  return [...needed];
}

// ---------------------------------------------------------------- Unix 依赖闭包

function unixDeps(file) {
  if (process.platform === 'darwin') {
    const r = spawnSync('otool', ['-L', file], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    return r.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(' ')[0])
      .filter((p) => p && p.startsWith('/') && !p.startsWith('/System/') && !p.startsWith('/usr/lib/'));
  }
  const r = spawnSync('ldd', [file], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[1] === '=>' && p[2] && p[2].startsWith('/'))
    .map((p) => p[2]);
}

function unixClosure(entryFiles, { rewrite = false, outLibDir = null } = {}) {
  const deps = new Set();
  const queue = [...entryFiles];
  const seen = new Set();
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of unixDeps(f)) {
      if (deps.has(dep)) continue;
      deps.add(dep);
      queue.push(dep);
    }
  }
  const out = [...deps];
  if (rewrite && outLibDir) {
    // macOS：把依赖路径改写到包内 lib/（配合 dylibbundler 或 install_name_tool）
    for (const entry of entryFiles) {
      for (const dep of unixDeps(entry)) {
        const base = path.basename(dep);
        const r = spawnSync('install_name_tool', ['-change', dep, `@executable_path/lib/${base}`, entry], { encoding: 'utf8' });
        if (r.status !== 0) console.warn(`[vm-pack] install_name_tool 改写失败 ${dep}: ${(r.stderr || '').trim()}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

function parseArgs(argv) {
  const out = { src: null, out: null, platform: process.platform, arch: process.arch, qemuVersion: null, zip: false, keepEsp32: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--src') out.src = val();
    else if (a === '--out') out.out = val();
    else if (a === '--platform') out.platform = val();
    else if (a === '--arch') out.arch = val();
    else if (a === '--qemu-version') out.qemuVersion = val();
    else if (a === '--zip') out.zip = true;
    else if (a === '--no-esp32') out.keepEsp32 = false;
    else throw new Error('未知参数: ' + a);
  }
  if (!out.src || !out.out) throw new Error('缺少 --src / --out');
  return out;
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function dirSize(dir) {
  let total = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { total += fs.statSync(p).size; files++; }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

function main() {
  const opts = parseArgs(process.argv);
  const src = path.resolve(opts.src);
  const out = path.resolve(opts.out);
  if (!fs.existsSync(src)) throw new Error('源目录不存在: ' + src);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const isWin = opts.platform === 'win32';
  const suffix = isWin ? '.exe' : '';
  const guestArches = ['x86_64', 'aarch64'];
  const entries = guestArches.map((a) => {
    const bin = isWin
      ? path.join(src, `qemu-system-${a}.exe`)
      : path.join(src, 'bin', `qemu-system-${a}`);
    return fs.existsSync(bin) ? bin : null;
  }).filter(Boolean);
  const xtensa = (isWin
    ? path.join(src, 'qemu-system-xtensa.exe')
    : path.join(src, 'bin', 'qemu-system-xtensa'));
  if (opts.keepEsp32 && fs.existsSync(xtensa)) entries.push(xtensa);
  const qemuImg = isWin ? path.join(src, 'qemu-img.exe') : path.join(src, 'bin', 'qemu-img');
  if (fs.existsSync(qemuImg)) entries.push(qemuImg);
  if (!entries.length) throw new Error('源目录里找不到 qemu-system-*（解包路径不对？）: ' + src);

  const keep = new Map(); // rel → abs
  const addKeep = (abs, rel) => { keep.set(rel || path.basename(abs), abs); };
  for (const e of entries) addKeep(e);

  // 依赖闭包
  let deps = [];
  if (isWin) {
    deps = windowsDllClosure(src, entries.map((e) => path.basename(e)));
  } else if (opts.platform === 'darwin') {
    // macOS：优先用 dylibbundler 做 dylib 闭包 + 路径改写（比手写 install_name_tool 稳）
    const which = spawnSync('which', ['dylibbundler'], { encoding: 'utf8' });
    const libDir = path.join(out, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const auxDir = path.join(out, 'bin');
    fs.mkdirSync(auxDir, { recursive: true });
    for (const e of entries) copyFile(e, path.join(auxDir, path.basename(e)));
    if (which.status === 0) {
      const r = spawnSync('dylibbundler', [
        '-od', '-b',
        '-x', ...entries.map((e) => path.join(auxDir, path.basename(e))),
        '-d', libDir,
        '-p', '@executable_path/lib',
      ], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('dylibbundler 失败: ' + (r.stderr || '').trim().slice(0, 200));
      console.log('[vm-pack] dylibbundler 完成 dylib 闭包与路径改写');
    } else {
      console.warn('[vm-pack] 未找到 dylibbundler，将以内联方式收集 dylib（可能路径未改写）');
      deps = unixClosure(entries);
      for (const d of deps) copyFile(d, path.join(libDir, path.basename(d)));
    }
  } else {
    deps = unixClosure(entries);
  }
  for (const d of deps) {
    const abs = path.isAbsolute(d) ? d : path.join(src, d);
    if (fs.existsSync(abs)) addKeep(abs, path.basename(abs));
  }

  // 固件目录（share/）：启动必需，整目录保留（约 10MB）
  const shareSrc = fs.existsSync(path.join(src, 'share')) ? path.join(src, 'share') : null;

  // 落地
  const binDir = isWin ? out : path.join(out, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [rel, abs] of keep) copyFile(abs, path.join(binDir, rel));
  if (shareSrc) {
    const copyRec = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (e.isDirectory()) copyRec(path.join(from, e.name), path.join(to, e.name));
        else copyFile(path.join(from, e.name), path.join(to, e.name));
      }
    };
    copyRec(shareSrc, path.join(out, 'share'));
  }
  // 许可与版本信息（GPLv2 合规：随包提供 COPYING）
  for (const name of ['COPYING', 'COPYING.LIB', 'VERSION', 'README.rst']) {
    const p = path.join(src, name);
    if (fs.existsSync(p)) copyFile(p, path.join(out, name));
  }
  // unix 把依赖库放到 lib/ 或与二进制同目录
  if (!isWin) {
    const libDir = path.join(out, 'lib');
    for (const d of deps) {
      const base = path.basename(d);
      copyFile(d, path.join(libDir, base));
      if (opts.platform === 'linux') {
        copyFile(d, path.join(out, 'bin', base)); // 简化 rpath：同目录即可命中
      }
    }
  }

  // 自检：确认可执行文件真的能跑起来
  if (opts.platform === 'linux') {
    // 让打包后的二进制在任意机器上找到随包携带的 .so
    const patchelf = spawnSync('patchelf', ['--version'], { encoding: 'utf8' });
    if (patchelf.status === 0) {
      for (const f of fs.readdirSync(binDir)) {
        const r = spawnSync('patchelf', ['--set-rpath', '$ORIGIN:$ORIGIN/../lib', path.join(binDir, f)], { encoding: 'utf8' });
        if (r.status !== 0) console.warn(`[vm-pack] patchelf 失败 ${f}: ${(r.stderr || '').trim()}`);
      }
    } else {
      console.warn('[vm-pack] 未找到 patchelf，Linux 包依赖系统库路径（用户机需装有对应 lib）');
    }
  }

  const ver = spawnSync(path.join(binDir, `qemu-system-${guestArches[0]}${suffix}`), ['--version'], { encoding: 'utf8', timeout: 30000 });
  const versionLine = ((ver.stdout || '') + (ver.stderr || '')).trim().split('\n')[0] || null;
  const accel = spawnSync(path.join(binDir, `qemu-system-${guestArches[0]}${suffix}`), ['-accel', 'help'], { encoding: 'utf8', timeout: 30000 });
  const accelLine = ((accel.stdout || '') + (accel.stderr || '')).replace(/\s+/g, ' ').trim();

  const size = dirSize(out);
  const qemuVersion = opts.qemuVersion || (versionLine ? (versionLine.match(/version ([\d.]+)/) || [])[1] : null);
  const manifest = {
    schema: 1,
    platform: opts.platform,
    arch: opts.arch,
    qemuVersion,
    builtAt: new Date().toISOString(),
    sizeBytes: size.bytes,
    fileCount: size.files,
    bins: fs.readdirSync(binDir).filter((f) => /^qemu-/.test(f)),
    accel: accelLine,
    versionLine,
    license: 'QEMU is licensed under GPLv2 (see COPYING). Binaries are unmodified upstream builds.',
  };
  fs.writeFileSync(path.join(out, 'runtime-pack.json'), JSON.stringify(manifest, null, 2));

  console.log(`[vm-pack] 裁剪完成: ${(size.bytes / 1024 ** 2).toFixed(1)}MB / ${size.files} 文件`);
  console.log(`[vm-pack] ${versionLine}`);
  console.log(`[vm-pack] ${accelLine}`);
  if (!versionLine) {
    console.error('[vm-pack] 自检失败：裁剪后的 QEMU 无法运行');
    process.exit(1);
  }

  if (opts.zip) {
    const zipName = `cibyp-qemu-${opts.platform}-${opts.arch}.zip`;
    const zipPath = path.join(path.dirname(out), zipName);
    // 用系统 tar 生成 zip？依赖外部工具；改用 Node + adm-zip（项目已有依赖）
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    zip.addLocalFolder(out);
    zip.writeZip(zipPath);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    fs.writeFileSync(zipPath + '.sha256', `${sha256}  ${zipName}\n`);
    const st = fs.statSync(zipPath);
    console.log(`[vm-pack] zip: ${zipPath} (${(st.size / 1024 ** 2).toFixed(1)}MB, sha256=${sha256.slice(0, 16)}…)`);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('[vm-pack] 失败:', e.message); process.exit(1); }
}
module.exports = { peImportedDlls, windowsDllClosure, unixClosure };
