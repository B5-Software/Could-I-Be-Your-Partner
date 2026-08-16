/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 构建期资源下载脚本：从 HuggingFace / GitHub Releases / Google Fonts / download.geogebra.org
 * 下载 sherpa-onnx 语音模型（assets/voice-models/）、内置 UI 字体（assets/ui-fonts/）与
 * GeoGebra Math Apps Bundle 离线包（assets/geogebra-app/），打包时随 app.asar.unpacked 一起分发。
 *
 * 模型清单：
 *   - KWS 唤醒词: zipformer zh-en 3M (2025-12-20, GitHub Release tar.bz2)
 *   - VAD: silero_vad.onnx (GitHub Release)
 *   - STT: whisper-base int8 + whisper-tiny int8 (HuggingFace csukuangfj/sherpa-onnx-whisper-*)
 *   - TTS kokoro: int8 multi-lang v1_0 (HuggingFace csukuangfj/kokoro-int8-multi-lang-v1_0)
 *   - TTS piper de: thorsten medium fp32 (HuggingFace csukuangfj/vits-piper-de_DE-thorsten-medium)
 *   - espeak-ng-data: 由 kokoro 包的 espeak-ng-data 目录提供，piper 共享
 *
 * 数据源优先级: HF 镜像 (hf-mirror.com) > HuggingFace 直连 > GitHub Release
 * 下载引擎复用项目内置 aria2c（多连接加速）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const OUT = path.resolve(__dirname, '..', 'assets', 'voice-models');
const HF_MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
// aria2 单文件下载的原子性最差（断点续传校验弱），视为第一候选但需校验退出码；
// curl -fSL 对服务端错误/偶发断流更严格，作为回退。
const DOWNLOAD_RETRY = 2; // 每个文件最多额外重试次数（不含首次）
const LIST_RETRIES = 3; // 目录清单拉取最多尝试次数

// ========== 模型清单 ==========
// type 'hf': 从 HuggingFace repo 逐文件下载
// type 'tar': 从 URL 下载 .tar.bz2 并解压，仅保留指定文件
const MODELS = [
  // --- VAD ---
  {
    name: 'vad',
    type: 'file',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    dest: 'vad/silero_vad.onnx',
  },
  // --- KWS 唤醒词 ---
  {
    name: 'kws',
    type: 'tar',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2',
    dest: 'kws/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20',
    keepExtracted: ['encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
      'decoder-epoch-13-avg-2-chunk-8-left-64.onnx',
      'joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
      'tokens.txt', 'en.phone'],
  },
  // --- STT: whisper-base int8 ---
  {
    name: 'stt-base',
    type: 'hf',
    repo: 'csukuangfj/sherpa-onnx-whisper-base',
    files: ['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt'],
    dest: 'stt/whisper-base',
  },
  // --- STT: whisper-tiny int8（可选小模型，更快、更省内存，准确率略低）---
  {
    name: 'stt-tiny',
    type: 'hf',
    repo: 'csukuangfj/sherpa-onnx-whisper-tiny',
    files: ['tiny-encoder.int8.onnx', 'tiny-decoder.int8.onnx', 'tiny-tokens.txt'],
    dest: 'stt/whisper-tiny',
  },
  // --- TTS: kokoro int8 multi-lang v1_0 ---
  {
    name: 'tts-kokoro',
    type: 'hf',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_0',
    files: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
      'lexicon-us-en.txt', 'lexicon-zh.txt',
      'date-zh.fst', 'number-zh.fst', 'phone-zh.fst'],
    dest: 'tts/kokoro-int8-multi-lang-v1_0',
    // espeak-ng-data 子目录需单独递归下载（文件数 > 200）
    dirs: ['espeak-ng-data', 'dict'],
  },
  // --- TTS: piper de thorsten medium ---
  {
    name: 'tts-piper-de',
    type: 'hf',
    repo: 'csukuangfj/vits-piper-de_DE-thorsten-medium',
    files: ['de_DE-thorsten-medium.onnx', 'tokens.txt'],
    dest: 'tts/vits-piper-de_DE-thorsten-medium',
    // espeak-ng-data 指向 kokoro 下的同名目录（piper 与 kokoro 共享 espeak-ng-data）
  },
];

// ========== UI 字体清单（全部为自由字体，SIL OFL 1.1）==========
const FONT_OUT = path.resolve(__dirname, '..', 'assets', 'ui-fonts');
const FONTS = [
  {
    name: 'noto-sans-sc',
    family: 'Noto Sans SC',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    dest: 'NotoSansSC[wght].ttf',
    upstream: 'google/fonts（思源黑体官方发行）'
  },
  {
    name: 'noto-serif-sc',
    family: 'Noto Serif SC',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf',
    dest: 'NotoSerifSC[wght].ttf',
    upstream: 'google/fonts（思源宋体官方发行）'
  },
  {
    name: 'lxgw-wenkai',
    family: 'LXGW WenKai',
    url: 'https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf',
    dest: 'LXGWWenKai-Regular.ttf',
    upstream: 'github.com/lxgw/LxgwWenKai v1.522'
  },
  {
    name: 'inter',
    family: 'Inter',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf',
    dest: 'Inter[opsz,wght].ttf',
    upstream: 'google/fonts（rsms/inter）'
  },
  {
    name: 'source-sans-3',
    family: 'Source Sans 3',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/sourcesans3/SourceSans3%5Bwght%5D.ttf',
    dest: 'SourceSans3[wght].ttf',
    upstream: 'google/fonts（Adobe Source Sans 3）'
  },
  {
    name: 'noto-sans',
    family: 'Noto Sans',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf',
    dest: 'NotoSans[wdth,wght].ttf',
    upstream: 'google/fonts'
  }
];

function writeFontLicenses() {
  const lines = [
    '# UI 字体许可',
    '',
    '本目录字体随应用离线分发，均为自由字体（SIL Open Font License 1.1）。',
    '',
    '| 字体 | 上游来源 | 许可 |',
    '| --- | --- | --- |',
    ...FONTS.map(f => `| ${f.family} | ${f.upstream} | SIL OFL 1.1 |`),
    '',
    '完整许可证文本见各字体上游仓库。',
    ''
  ];
  fs.writeFileSync(path.join(FONT_OUT, 'LICENSES.md'), lines.join('\n'), 'utf8');
}

// ========== GeoGebra Math Apps Bundle（完整离线包）==========
// 官方 Self-Hosted 方案（见 https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_Embedding/）：
// 该 zip 内含 web3d/webSimple/web 三个 GWT 编译模块（classic/graphing/geometry/3d/cas/
// scientific/notes/evaluator/suite 全部 appName）、字体与 CSS，运行时经 ggb:// 协议从本地加载，
// 完全不再依赖 www.geogebra.org。许可：GeoGebra Non-Commercial License（保留包内 README.txt）。
const GGB_OUT = path.resolve(__dirname, '..', 'assets', 'geogebra-app');
const GGB_LEGACY_LOADER = path.resolve(__dirname, '..', 'assets', 'geogebra', 'deployggb.js');
const GGB_BUNDLE_URL = 'https://download.geogebra.org/package/geogebra-math-apps-bundle';
const GGB_WEB3D_NOCACHE = path.join(GGB_OUT, 'GeoGebra', 'HTML5', '5.0', 'web3d', 'web3d.nocache.js');
const GGB_BUNDLE_DEPLOY = path.join(GGB_OUT, 'GeoGebra', 'deployggb.js');

function writeGeogebraLicenseNote() {
  const lines = [
    '# GeoGebra Math Apps（离线包）许可',
    '',
    '本目录内容来自官方 GeoGebra Math Apps Bundle（https://download.geogebra.org/package/geogebra-math-apps-bundle）。',
    '',
    '- 版权：© International GeoGebra Institute',
    '- 许可：GeoGebra Non-Commercial License（非商业用途可自由复制、分发与传输）',
    '- 完整条款：见同目录 GeoGebra/README.txt 与 https://www.geogebra.org/license',
    '',
    '此离线包由 scripts/download-voice-models.js 在构建期下载并解压，仅用于随应用离线分发，不修改上游内容。',
    ''
  ];
  fs.writeFileSync(path.join(GGB_OUT, 'LICENSES.md'), lines.join('\n'), 'utf8');
}

function downloadGeogebraBundle() {
  if (fs.existsSync(GGB_WEB3D_NOCACHE) && fs.existsSync(GGB_BUNDLE_DEPLOY)) {
    console.log('[geogebra] 离线包已存在，跳过:', GGB_OUT);
    return;
  }
  const zipPath = path.join(os.tmpdir(), `geogebra-math-apps-bundle-${Date.now()}.zip`);
  try {
    downloadFile(GGB_BUNDLE_URL, zipPath, '[geogebra] 离线包');
    console.log('[geogebra] 解压:', zipPath, '→', GGB_OUT);
    ensureDir(GGB_OUT);
    // adm-zip 为项目既有依赖（package.json），纯 JS 跨平台，避免依赖系统 unzip。
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(GGB_OUT, true);
    if (!fs.existsSync(GGB_WEB3D_NOCACHE) || !fs.existsSync(GGB_BUNDLE_DEPLOY)) {
      throw new Error('离线包解压后缺少关键文件（web3d/web3d.nocache.js 或 deployggb.js）');
    }
    // 同步包内 deployggb.js 到 assets/geogebra/（index.html 现有引用路径），
    // 保证 loader 的 web3d/webSimple 排列哈希与 927 离线产物一致。
    // 注意：fetch-assets 以 --skip-geogebra 调用时该目录不会预先存在，需确保创建
    ensureDir(path.dirname(GGB_LEGACY_LOADER));
    fs.copyFileSync(GGB_BUNDLE_DEPLOY, GGB_LEGACY_LOADER);
    writeGeogebraLicenseNote();
    console.log('[geogebra] 离线包就绪');
  } finally {
    try { fs.unlinkSync(zipPath); } catch {}
  }
}

// ========== 工具函数 ==========
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function aria2Available() {
  try {
    const p = path.resolve(__dirname, '..', 'assets', 'aria2', process.platform === 'win32' ? 'win-x64' : '', 'aria2c' + (process.platform === 'win32' ? '.exe' : ''));
    return fs.existsSync(p) ? p : false;
  } catch { return false; }
}

function hfUrl(repo, filename) {
  // resolve 下载 URL：文件名含空格等需要 URL 编码
  return `${HF_MIRROR}/${repo}/resolve/main/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 下载单个文件。优先级 aria2c（内置多连接）→ 系统 curl。
 * - 已存在的文件直接跳过（可重复执行，增量续传）。
 * - aria2 返回码非 0 或无产物时回退 curl；两者均失败则 throw，让上层感知并重试。
 * - curl 使用 -fSL（服务端错误即失败）+ --retry 3 自动重试。
 */
function downloadFile(url, dest, reason) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`[voice-models] 已存在: ${dest}`);
    return true;
  }
  const lastError = downloadFileOnce(url, dest);
  if (!lastError) return true;
  if (DOWNLOAD_RETRY > 0) {
    console.warn(`[voice-models] ${reason || ''}下载失败(${lastError})，重试`);
    for (let i = 1; i <= DOWNLOAD_RETRY; i++) {
      try { fs.unlinkSync(dest); } catch {}
      const e2 = downloadFileOnce(url, dest);
      if (!e2) return true;
      if (i < DOWNLOAD_RETRY) console.warn(`[voice-models] 重试失败(${e2})，继续重试 (${i}/${DOWNLOAD_RETRY})`);
    }
  }
  const e = lastError;
  throw new Error(`下载失败: ${url} (${e})`);
}

function downloadFileOnce(url, dest) {
  const aria2 = aria2Available();
  if (aria2) {
    console.log(`[voice-models] 下载(aria2): ${url}`);
    // aria2 不读取 http_proxy/https_proxy 环境变量，需要显式传 --all-proxy
    const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
    const proxyArgs = proxy ? ['--all-proxy=' + proxy] : [];
    const r = spawnSync(aria2, ['-x', '8', '-s', '8', '-d', path.dirname(dest), '-o', path.basename(dest), ...proxyArgs, url], {
      stdio: 'inherit', shell: false,
    });
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return null;
    let reason = `aria2 退出码 ${r.status}`;
    if (r.error) reason = `aria2 启动失败: ${r.error.message}`;
    try { fs.unlinkSync(dest); } catch {}
    try { fs.unlinkSync(dest + '.aria2'); } catch {}
    console.warn(`[voice-models] aria2 失败(${reason})，回退 curl`);
    return curlDownload(url, dest) ? null : reason + '; curl 亦失败';
  }
  return curlDownload(url, dest) ? null : 'curl 下载失败';
}

function curlDownload(url, dest) {
  console.log(`[voice-models] 下载(curl): ${url} → ${dest}`);
  try {
    execSync(`curl -fSL --connect-timeout 30 --retry 2 --retry-delay 2 -o "${dest}" "${url}"`, { stdio: 'inherit' });
    return fs.existsSync(dest) && fs.statSync(dest).size > 0;
  } catch (e) {
    try { fs.unlinkSync(dest); } catch {}
    try { fs.unlinkSync(dest + '.aria2'); } catch {}
    return false;
  }
}

/**
 * 通过 HF Tree API 递归列出目录下全部文件（分页取全，避免 API 默认截断导致的静默缺文件）。
 * 相比 /api/models 的 siblings（服务端默认分页截断），/tree/main/{dir}?recursive=true 可
 * 用 Link: rel="next"+cursor 翻页直至无 next，得到完整文件清单。
 * 实现：curl -D 导出响应头（execSync 拿不到响应头），解析 Link 头翻页。
 */
function listHfDirFiles(repo, dir) {
  const files = [];
  let cursor = '';
  for (let attempt = 0; attempt < LIST_RETRIES; attempt++) {
    files.length = 0;
    cursor = '';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tree-'));
    let ok = false;
    try {
      let mayHaveMore = true;
      let guard = 0;
      const seenCursors = new Set();
      while (mayHaveMore && guard++ < 500) {
        const dirPath = dir.split('/').map(encodeURIComponent).join('/');
        // limit=128 强制分页，保证即使服务端默认单页很大也按游标逐页取全（确定性枚举）
        const apiUrl =
          `${HF_MIRROR}/api/models/${repo}/tree/main/${dirPath}?recursive=true&limit=128` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const hdrFile = path.join(tmpDir, `hd-${guard}.txt`);
        const bodyFile = path.join(tmpDir, `bd-${guard}.json`);
        execSync(`curl -sL --connect-timeout 30 --max-time 120 -D "${hdrFile}" -o "${bodyFile}" "${apiUrl}"`, {
          encoding: 'utf8', stdio: 'pipe', maxBuffer: 8 * 1024 * 1024,
        });
        const page = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
        for (const e of page) {
          if (e.type === 'file') files.push(e.path);
        }
        const link = fs.existsSync(hdrFile) ? fs.readFileSync(hdrFile, 'utf8') : '';
        const nextCursor = parseNextCursor(link);
        // 防御镜像源 cursor 死循环（hf-mirror 会在末页回卷到第 0 页的 cursor）
        if (nextCursor) {
          if (seenCursors.has(nextCursor)) {
            console.warn(`[voice-models] 分页游标重复(${dir}，第 ${guard} 页)，判定枚举完成`);
            mayHaveMore = false;
          } else {
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
        } else {
          mayHaveMore = false;
        }
        try { fs.unlinkSync(hdrFile); fs.unlinkSync(bodyFile); } catch (_) {}
      }
      ok = true;
      if (files.length === 0) throw new Error('清单为空');
      return files;
    } catch (e) {
      if (attempt >= LIST_RETRIES - 1) throw new Error(`列出 ${dir} 目录失败: ${e.message}`);
      console.warn(`[voice-models] 列出 ${dir} 失败(${e.message})，重试 ${attempt + 2}/${LIST_RETRIES}`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
      if (ok) break;
    }
  }
  return files;
}

function parseNextCursor(linkHeader) {
  // Link: <https://huggingface.co/...?cursor=XXXX>; rel="next"
  // 只要存在 Link 头即代表还有下一页，取出第一个 cursor 即可
  if (!linkHeader) return null;
  const m = linkHeader.match(/[?&]cursor=([^;&>\s]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function downloadHfFiles(repo, files, destDir) {
  ensureDir(destDir);
  for (const f of files) {
    downloadFile(hfUrl(repo, f), path.join(destDir, f), f);
  }
}

/**
 * 下载 HF 仓库中某目录的完整文件树（递归清单 + 逐文件下载 + 缺失校验）。
 * 用 Tree API 拉全量清单，保证不因服务端分页截断而静默缺文件；
 * 下载失败抛错（不吞掉），由调用方决定是否中断构建。
 */
function downloadHfDirTree(repo, dir, destDir) {
  const dest = path.join(destDir, dir);
  ensureDir(dest);
  const listed = listHfDirFiles(repo, dir);
  const failed = [];
  for (const rel of listed) {
    const target = path.join(dest, rel.replace(new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), ''));
    try {
      downloadFile(hfUrl(repo, rel), target, rel);
    } catch (e) {
      failed.push(`${rel} (${e.message})`);
    }
  }
  // 完整性校验：期望 === 实际。缺失即报错，由构建终止感知。
  const missing = [];
  for (const rel of listed) {
    const target = path.join(dest, rel.replace(new RegExp('^' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), ''));
    if (!(fs.existsSync(target) && fs.statSync(target).size > 0)) missing.push(rel);
  }
  if (missing.length) {
    throw new Error(`目录 ${dir} 缺失 ${missing.length} 个文件: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
  }
  if (failed.length) {
    throw new Error(`目录 ${dir} 有 ${failed.length} 个文件下载失败（已重试）: ${failed.slice(0, 5).join('; ')}`);
  }
  console.log(`[voice-models] ${dir}: ${listed.length} 个文件全部就绪`);
}

function downloadTar(url, destDir) {
  ensureDir(path.dirname(destDir));
  if (fs.existsSync(destDir)) {
    console.log(`[voice-models] 已解压: ${destDir}`);
    return;
  }
  const tarFile = destDir + '.tar.bz2';
  downloadFile(url, tarFile);
  console.log(`[voice-models] 解压: ${tarFile} → ${destDir}`);
  execSync(`tar -xf "${tarFile}" -C "${path.dirname(destDir)}"`, { stdio: 'inherit' });
  try { fs.unlinkSync(tarFile); } catch {}
}

function downloadModel(m) {
  switch (m.type) {
    case 'file':
      downloadFile(m.url, path.join(OUT, m.dest));
      break;
    case 'tar':
      downloadTar(m.url, path.join(OUT, m.dest));
      break;
    case 'hf':
      downloadHfFiles(m.repo, m.files, path.join(OUT, m.dest));
      if (m.dirs) {
        for (const d of m.dirs) {
          // 用 Tree API 全量清单 + 完整性校验下载目录文件（不再用 /api/models siblings，
          // 该接口会被服务端默认分页截断 → 静默缺后半批文件）。
          downloadHfDirTree(m.repo, d, path.join(OUT, m.dest));
        }
      }
      break;
    default:
      console.warn(`[voice-models] 未知类型: ${m.type}`);
      break;
  }
}

// ========== 主流程 ==========
function main() {
  console.log('[voice-models] 开始下载语音模型（目标:', OUT, ')');
  ensureDir(OUT);
  let hasError = false;
  for (const m of MODELS) {
    try {
      downloadModel(m);
    } catch (e) {
      hasError = true;
      console.error(`[voice-models] ${m.name} 下载失败:`, e.message);
    }
  }
  // UI 字体：复用同一套 aria2c → curl 下载引擎
  console.log('[ui-fonts] 开始下载 UI 字体（目标:', FONT_OUT, ')');
  ensureDir(FONT_OUT);
  for (const f of FONTS) {
    try {
      downloadFile(f.url, path.join(FONT_OUT, f.dest), `[ui-fonts] ${f.family}`);
    } catch (e) {
      hasError = true;
      console.error(`[ui-fonts] ${f.name} 下载失败:`, e.message);
    }
  }
  try { writeFontLicenses(); } catch (e) { console.warn('[ui-fonts] 写入许可证说明失败:', e.message); }
  // GeoGebra Math Apps Bundle 离线包
  console.log('[geogebra] 开始下载离线包（目标:', GGB_OUT, ')');
  try {
    downloadGeogebraBundle();
  } catch (e) {
    hasError = true;
    console.error('[geogebra] 离线包下载失败:', e.message);
  }
  // piper-de espeak-ng-data 与 kokoro 共享（vits-piper 模型不内置该目录）
  // 非 Windows 用符号链接节省体积；Windows 复制目录——junction 保存绝对路径，
  // actions/cache 还原后常成断链（7za 归档时 "The system cannot find the path specified"）。
  const piperDir = path.join(OUT, 'tts/vits-piper-de_DE-thorsten-medium');
  const kokoroDataDir = path.join(OUT, 'tts/kokoro-int8-multi-lang-v1_0/espeak-ng-data');
  const piperDataDir = path.join(piperDir, 'espeak-ng-data');
  if (fs.existsSync(kokoroDataDir)) {
    // 清理残留条目：断链时 existsSync 为 false 但路径仍占位（Windows 缓存还原常见）
    if (!fs.existsSync(piperDataDir)) {
      try { fs.rmSync(piperDataDir, { force: true, recursive: true }); } catch { /* ignore */ }
    } else if (fs.lstatSync(piperDataDir).isSymbolicLink()) {
      try { fs.unlinkSync(piperDataDir); } catch { /* ignore */ }
    }
    if (!fs.existsSync(piperDataDir)) {
      try {
        if (process.platform === 'win32') {
          fs.cpSync(kokoroDataDir, piperDataDir, { recursive: true });
          console.log('[voice-models] piper-de espeak-ng-data 已复制（Windows 用目录复制替代 junction，避免缓存还原后链接失效）');
        } else {
          fs.symlinkSync(kokoroDataDir, piperDataDir, 'dir');
          console.log('[voice-models] piper-de → kokoro espeak-ng-data 符号链接已创建');
        }
      } catch (e) {
        console.warn('[voice-models] espeak-ng-data 创建失败:', e.message, '(piper 将在运行时回退到 kokoro 数据目录)');
      }
    }
  }
  if (hasError) {
    console.error('[voice-models] 存在下载失败，以非零退出码终止构建');
    process.exitCode = 1;
  } else {
    console.log('[voice-models] 语音模型、UI 字体与 GeoGebra 离线包全部就绪');
  }
}

main();
