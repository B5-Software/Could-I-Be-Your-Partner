/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * CIBYP-VM-OS 资源目录：变体清单、manifest 拉取、本地安装状态与路径解析。
 *
 * 资源布局（全部位于用户可选的 assetsDir 下，不进安装包）：
 *   <assetsDir>/qemu/<platform-arch>/            QEMU 运行时（qemu-system-* / qemu-img / share）
 *   <assetsDir>/images/<variant>/<version>/      qcow2 + vmlinuz + initrd + manifest.json
 *   <assetsDir>/instances/<name>/                overlay.qcow2 / cloud-init / 日志 / instance.json
 *
 * manifest 由 vm-os CI 生成并挂在 rolling release（tag: vm-os-latest），
 * 字段：variants.<variant>.arches.<arch>.{url,sha256,size}、kernel.<arch>.{kernel,initrd,cmdline}
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = 'B5-Software/Could-I-Be-Your-Partner';
const MANIFEST_URL = `https://github.com/${REPO}/releases/download/vm-os-latest/runtime-manifest.json`;
// GitHub 直连在部分地区不可用时的镜像前缀（可用 settings.runtime.vm.mirror 切换）
const MIRROR_PREFIXES = {
  official: '',
  cn: 'https://gh-proxy.com/',
  cn2: 'https://ghfast.top/',
};

/** 镜像变体目录（与 vm-os/tests/boot-smoke.js 的体积门禁一致） */
const VARIANTS = [
  {
    id: 'base',
    label: '基础环境',
    desc: 'Agent 默认执行环境：shell / Python / Node / 编译基础，体积最小',
    limitMB: 350,
    diskGB: 8,
    default: true,
  },
  {
    id: 'desktop',
    label: '图形环境',
    desc: 'base + Xorg / x11vnc / Chromium / 中文字体，用于图形化与浏览器沙盒',
    limitMB: 750,
    diskGB: 12,
  },
  {
    id: 'full',
    label: '完整开发环境',
    desc: 'base + clang/调试器 + PostgreSQL/MariaDB/Redis + Docker + ffmpeg + Playwright 依赖',
    limitMB: 1300,
    diskGB: 16,
  },
];

function variantById(id) {
  return VARIANTS.find((v) => v.id === id) || VARIANTS[0];
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** guest 架构（宿主架构一对一） */
function guestArch(arch = process.arch) {
  return arch === 'arm64' ? 'arm64' : 'amd64';
}

/** 资源路径集合 */
function assetPaths(assetsDir, { platform = process.platform, arch = process.arch, variant = 'base', version = null } = {}) {
  const key = platformKey(platform, arch);
  const v = variantById(variant);
  return {
    root: assetsDir,
    qemuDir: path.join(assetsDir, 'qemu', key),
    imagesRoot: path.join(assetsDir, 'images', v.id),
    versionRoot: version ? path.join(assetsDir, 'images', v.id, version) : null,
    instancesRoot: path.join(assetsDir, 'instances'),
    manifestFile: path.join(assetsDir, 'manifest.json'),
    guestArch: guestArch(arch),
    variant: v.id,
    platformKey: key,
  };
}

/** 本地已安装情况（按版本目录扫描） */
function localStatus(assetsDir, { variant = 'base', arch = process.arch } = {}) {
  const v = variantById(variant);
  const ga = guestArch(arch);
  const dir = path.join(assetsDir, 'images', v.id);
  const out = { variant: v.id, dir, versions: [], selected: null, installed: false, missing: [] };
  if (!fs.existsSync(dir)) {
    out.missing = ['image', 'kernel', 'initrd'];
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const verDir = path.join(dir, entry.name);
    const image = path.join(verDir, `cibyp-vmos-${entry.name}-${v.id}-${ga}.qcow2`);
    const kernel = path.join(verDir, `vmlinuz-${ga}`);
    const initrd = path.join(verDir, `initrd-${ga}.img`);
    const missing = [];
    if (!fs.existsSync(image)) missing.push('image');
    if (!fs.existsSync(kernel)) missing.push('kernel');
    if (!fs.existsSync(initrd)) missing.push('initrd');
    const bytes = [image, kernel, initrd]
      .filter((p) => fs.existsSync(p))
      .reduce((n, p) => n + fs.statSync(p).size, 0);
    out.versions.push({ version: entry.name, image, kernel, initrd, missing, bytes, ok: missing.length === 0 });
  }
  out.versions.sort((a, b) => String(b.version).localeCompare(String(a.version)));
  out.selected = out.versions.find((x) => x.ok) || null;
  out.installed = !!out.selected;
  out.missing = out.selected ? [] : (out.versions[0] ? out.versions[0].missing : ['image', 'kernel', 'initrd']);
  return out;
}

/** 应用镜像 URL 镜像前缀 */
function applyMirror(url, mirror = 'official') {
  const prefix = MIRROR_PREFIXES[mirror];
  if (!prefix) return url;
  return prefix + url;
}

/** 拉取 runtime-manifest.json（Node 18+ 全局 fetch；失败抛错，由调用方决定回退） */
async function fetchManifest({ url = MANIFEST_URL, mirror = 'official', timeoutMs = 20000 } = {}) {
  const target = applyMirror(url, mirror);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(target, { signal: ctrl.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`manifest HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.schema !== 1 || !json.variants) throw new Error('manifest 结构不合法');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 从 manifest 解析某变体 × 架构的资源集合 */
function pickArtifacts(manifest, { variant = 'base', arch = process.arch, mirror = 'official' } = {}) {
  const ga = guestArch(arch);
  const v = variantById(variant);
  const entry = manifest && manifest.variants && manifest.variants[v.id];
  const image = entry && entry.arches && entry.arches[ga];
  const kernel = manifest && manifest.kernel && manifest.kernel[ga];
  if (!image || !kernel || !kernel.kernel || !kernel.initrd) {
    throw new Error(`manifest 中缺少 ${v.id}/${ga} 的资源`);
  }
  const withMirror = (o) => (o ? { ...o, downloadUrl: applyMirror(o.url, mirror) } : null);
  return {
    variant: v.id,
    arch: ga,
    version: manifest.version,
    builtAt: manifest.builtAt,
    image: withMirror(image),
    kernel: withMirror(kernel.kernel),
    initrd: withMirror(kernel.initrd),
    cmdline: kernel.cmdline,
    licenseNote: manifest.licenseNote,
  };
}

module.exports = {
  REPO,
  MANIFEST_URL,
  MIRROR_PREFIXES,
  VARIANTS,
  variantById,
  platformKey,
  guestArch,
  assetPaths,
  localStatus,
  applyMirror,
  fetchManifest,
  pickArtifacts,
};
