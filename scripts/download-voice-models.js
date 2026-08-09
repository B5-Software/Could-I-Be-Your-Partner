/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 构建期模型下载脚本：从 HuggingFace / GitHub Releases 下载 sherpa-onnx 语音模型
 * 到 assets/voice-models/，打包时随 app.asar.unpacked 一起分发。
 *
 * 模型清单：
 *   - KWS 唤醒词: zipformer zh-en 3M (2025-12-20, GitHub Release tar.bz2)
 *   - VAD: silero_vad.onnx (GitHub Release)
 *   - STT: whisper-base int8 (HuggingFace csukuangfj/sherpa-onnx-whisper-base)
 *   - TTS kokoro: int8 multi-lang v1_0 (HuggingFace csukuangfj/kokoro-int8-multi-lang-v1_0)
 *   - TTS piper de: thorsten medium fp32 (HuggingFace csukuangfj/vits-piper-de_DE-thorsten-medium)
 *   - espeak-ng-data: 由 kokoro 包的 espeak-ng-data 目录提供，piper 共享
 *
 * 数据源优先级: HF 镜像 (hf-mirror.com) > HuggingFace 直连 > GitHub Release
 * 下载引擎复用项目内置 aria2c（多连接加速）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const OUT = path.resolve(__dirname, '..', 'assets', 'voice-models');
const HF_MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

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
  return `${HF_MIRROR}/${repo}/resolve/main/${filename}`;
}

function downloadFile(url, dest) {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) {
    console.log(`[voice-models] 已存在: ${dest}`);
    return;
  }
  console.log(`[voice-models] 下载: ${url} → ${dest}`);
  const aria2 = aria2Available();
  if (aria2) {
    spawnSync(aria2, ['-x', '8', '-s', '8', '-d', path.dirname(dest), '-o', path.basename(dest), url], {
      stdio: 'inherit', shell: false,
    });
  } else {
    // 回退到系统 curl
    execSync(`curl -fSL --retry 3 -o "${dest}" "${url}"`, { stdio: 'inherit' });
  }
}

function downloadHfFiles(repo, files, destDir) {
  ensureDir(destDir);
  for (const f of files) {
    downloadFile(hfUrl(repo, f), path.join(destDir, f));
  }
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
          const dest = path.join(OUT, m.dest, d);
          ensureDir(dest);
          // 通过 HF API 列出目录文件并逐一下载
          try {
            const apiUrl = `${HF_MIRROR}/api/models/${m.repo}`;
            const result = execSync(`curl -sL "${apiUrl}"`, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
            const siblings = JSON.parse(result).siblings || [];
            for (const s of siblings) {
              if (s.rfilename.startsWith(d + '/')) {
                downloadFile(hfUrl(m.repo, s.rfilename), path.join(OUT, m.dest, s.rfilename));
              }
            }
          } catch (e) {
            console.warn(`[voice-models] 无法列出 ${d} 目录文件: ${e.message}`);
          }
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
  for (const m of MODELS) {
    try {
      downloadModel(m);
    } catch (e) {
      console.error(`[voice-models] ${m.name} 下载失败:`, e.message, '(将跳过，构建仍可继续)');
    }
  }
  // piper-de espeak-ng-data 符号链接（软链接指向 kokoro 目录，构建时实际文件在同一 volume）
  // 在 Windows 上复制目录作为后备
  const piperDir = path.join(OUT, 'tts/vits-piper-de_DE-thorsten-medium');
  const kokoroDataDir = path.join(OUT, 'tts/kokoro-int8-multi-lang-v1_0/espeak-ng-data');
  const piperDataDir = path.join(piperDir, 'espeak-ng-data');
  if (fs.existsSync(kokoroDataDir) && !fs.existsSync(piperDataDir)) {
    try {
      fs.symlinkSync(kokoroDataDir, piperDataDir, process.platform === 'win32' ? 'junction' : 'dir');
      console.log('[voice-models] piper-de → kokoro espeak-ng-data 符号链接已创建');
    } catch (e) {
      console.warn('[voice-models] espeak-ng-data 符号链接失败:', e.message, '(piper 将在运行时回退到 kokoro 数据目录)');
    }
  }
  console.log('[voice-models] 模型下载完成');
}

main();
