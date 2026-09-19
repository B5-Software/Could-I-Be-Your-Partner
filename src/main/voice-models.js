/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 语音模型目录清单 / 路径解析 / 安装检测 / 启动审计。
 * 与用户设置的关系：
 *   - settings.resources.voiceModelDir : 自定义模型下载目录（默认 userData/voice-models）
 *   - settings.resources.mirror        : 'cn'(hf-mirror.com) | 'official'(huggingface.co)
 *   - settings.voice.*                 : sttEnabled / ttsEnabled / wakeEnabled / sttModel
 *
 * 运行时不再随安装包分发模型：全部由用户在「设置 → 资源下载」手动下载到模型目录。
 * 语音引擎查找顺序：用户模型目录 → 内置 assets/voice-models（兼容旧安装 / 便携版）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GITHUB = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';
const KWS_DIR = 'kws/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';

/** HF 镜像地址 */
function mirrorOrigin(mirror) {
  return mirror === 'official' ? 'https://huggingface.co' : 'https://hf-mirror.com';
}

function hfFile(repo, file) {
  return { type: 'hf', repo, file };
}

/**
 * 模型清单：
 *   id/label/kind/size 供 UI 展示；files 为相对模型根目录的文件清单；
 *   dirs 为需要递归下载的目录（HF Tree API）；tarFallback 为主源不可用时的 GitHub 压缩包回退。
 */
const CATALOG = [
  {
    id: 'vad', label: 'VAD 语音活动检测（silero）', kind: 'vad', size: '0.6 MB', required: true,
    files: [{ type: 'url', url: `${GITHUB}/asr-models/silero_vad.onnx`, dest: 'vad/silero_vad.onnx' }],
  },
  {
    id: 'kws', label: '唤醒词 KWS（zipformer zh-en 3M）', kind: 'kws', size: '41 MB', required: true,
    // KWS 未发布在 HuggingFace（HF resolve 返回 401），使用 GitHub Release 压缩包，
    // 下载后用系统 tar 解压（Windows 10+ / macOS / Linux 自带 bsdtar）
    files: [
      { dest: `${KWS_DIR}/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx` },
      { dest: `${KWS_DIR}/decoder-epoch-13-avg-2-chunk-8-left-64.onnx` },
      { dest: `${KWS_DIR}/joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx` },
      { dest: `${KWS_DIR}/tokens.txt` },
      { dest: `${KWS_DIR}/en.phone` },
    ],
    tar: {
      url: `${GITHUB}/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2`,
      destDir: KWS_DIR,
      keep: ['encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
        'decoder-epoch-13-avg-2-chunk-8-left-64.onnx',
        'joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx', 'tokens.txt', 'en.phone'],
    },
  },
  {
    id: 'stt-base', label: '语音识别 Whisper base（推荐，更准）', kind: 'stt', size: '161 MB', required: true,
    files: [
      hfFile('csukuangfj/sherpa-onnx-whisper-base', 'base-encoder.int8.onnx'),
      hfFile('csukuangfj/sherpa-onnx-whisper-base', 'base-decoder.int8.onnx'),
      hfFile('csukuangfj/sherpa-onnx-whisper-base', 'base-tokens.txt'),
    ],
  },
  {
    id: 'stt-tiny', label: '语音识别 Whisper tiny（更快，省内存）', kind: 'stt', size: '104 MB', required: false,
    files: [
      hfFile('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-encoder.int8.onnx'),
      hfFile('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-decoder.int8.onnx'),
      hfFile('csukuangfj/sherpa-onnx-whisper-tiny', 'tiny-tokens.txt'),
    ],
  },
  {
    id: 'tts-kokoro', label: '语音合成 Kokoro 多语言 v1.0（中/英）', kind: 'tts', size: '235 MB', required: true,
    files: [
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'model.int8.onnx'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'voices.bin'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'tokens.txt'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'lexicon-us-en.txt'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'lexicon-zh.txt'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'date-zh.fst'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'number-zh.fst'),
      hfFile('csukuangfj/kokoro-int8-multi-lang-v1_0', 'phone-zh.fst'),
    ],
    dirs: ['espeak-ng-data', 'dict'],
  },
  {
    id: 'tts-piper-de', label: '语音合成 Piper 德语（thorsten medium）', kind: 'tts', size: '64 MB', required: false,
    files: [
      hfFile('csukuangfj/vits-piper-de_DE-thorsten-medium', 'de_DE-thorsten-medium.onnx'),
      hfFile('csukuangfj/vits-piper-de_DE-thorsten-medium', 'tokens.txt'),
    ],
  },
];

/** 模型根目录（用户配置优先，默认 userData/voice-models） */
function resolveVoiceModelDir(app, settings) {
  const custom = settings && settings.resources && settings.resources.voiceModelDir;
  if (custom && String(custom).trim()) return String(custom).trim();
  return path.join(app.getPath('userData'), 'voice-models');
}

/** 内置模型根目录（旧安装包 / 便携版兼容；打包后位于 app.asar.unpacked） */
function resolveBundledModelRoot(app) {
  const candidates = [];
  try {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'voice-models'));
      candidates.push(path.join(process.resourcesPath, 'assets', 'voice-models'));
    }
  } catch (_) {}
  try { candidates.push(path.join(app.getAppPath(), 'assets', 'voice-models')); } catch (_) {}
  candidates.push(path.join(__dirname, '..', '..', 'assets', 'voice-models'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

/** 查找顺序：[用户模型目录, 内置目录] */
function searchRoots(app, settings) {
  const roots = [];
  try { roots.push(resolveVoiceModelDir(app, settings)); } catch (_) {}
  const bundled = resolveBundledModelRoot(app);
  if (bundled) roots.push(bundled);
  return roots;
}

function fileInRoots(roots, rel) {
  for (const root of roots) {
    const p = path.join(root, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    } catch (_) {}
  }
  return null;
}

function dirInRoots(roots, rel) {
  for (const root of roots) {
    const p = path.join(root, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const entries = fs.readdirSync(p);
        if (entries.length > 0) return p;
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 单个模型的安装状态。
 * @param {string[]} roots 查找根目录（含用户目录）
 * @param {string} rootDir 用于计算“该模型在本目录中是否完整”（下载目录）
 */
function modelStatus(roots, model, downloadRoot) {
  const missing = [];
  for (const f of model.files) {
    const rel = f.dest || path.join(modelDirOf(model), pathBasename(f.file || f.url));
    if (!fileInRoots(roots, rel)) missing.push(rel);
  }
  for (const dir of model.dirs || []) {
    const rel = path.join(modelDirOf(model), dir);
    if (!dirInRoots(roots, rel)) missing.push(rel + '/');
  }
  let bytes = 0;
  if (downloadRoot) {
    for (const f of model.files) {
      const rel = f.dest || path.join(modelDirOf(model), pathBasename(f.file || f.url));
      try { bytes += fs.statSync(path.join(downloadRoot, rel)).size; } catch (_) {}
    }
  }
  return { missingFiles: missing, installed: missing.length === 0, bytes };
}

function pathBasename(p) {
  try { return path.basename(new URL(p).pathname); } catch (_) { return path.basename(String(p || '')); }
}

/** 模型的相对落盘目录（由第一个文件推导，如 stt/whisper-base） */
function modelDirOf(model) {
  const dests = model.files.map(f => f.dest).filter(Boolean);
  if (dests.length) return path.dirname(dests[0]).split(path.sep).join('/');
  return '';
}

/** 计算每个文件在模型根目录下的相对路径 */
function fileRelPath(model, file) {
  if (file.dest) return file.dest;
  return path.join(modelDirOf(model), pathBasename(file.file || file.url));
}

/**
 * 构建某个文件的下载 URL（mirror: 'cn' | 'official'）。
 */
function resolveFileUrl(file, mirror) {
  if (file.type === 'hf') {
    const base = mirrorOrigin(mirror);
    const encoded = String(file.file).split('/').map(encodeURIComponent).join('/');
    return `${base}/${file.repo}/resolve/main/${encoded}`;
  }
  return file.url;
}

/**
 * 能力 → 所需模型 id。
 * @param {object} settings
 * @returns {{stt:string[], tts:string[], wake:string[]}}
 */
function requiredModelIds(settings) {
  const v = (settings && settings.voice) || {};
  const sttId = v.sttModel === 'tiny' ? 'stt-tiny' : 'stt-base';
  return {
    stt: [sttId],
    tts: ['tts-kokoro'],
    wake: ['kws', 'vad'],
  };
}

/**
 * 启动审计：模型未安装时自动关闭对应语音开关。
 * @returns {{changed:boolean, disabled:string[], missing:object}}
 */
function auditVoiceSettings(settings, roots) {
  const v = (settings && settings.voice) || {};
  const need = requiredModelIds(settings);
  const disabled = [];
  const missing = {};
  const isInstalled = (id) => {
    const model = CATALOG.find(m => m.id === id);
    if (!model) return true;
    return modelStatus(roots, model, null).installed;
  };
  if (v.sttEnabled && !need.stt.every(isInstalled)) { v.sttEnabled = false; disabled.push('sttEnabled'); }
  if (v.ttsEnabled && !need.tts.every(isInstalled)) { v.ttsEnabled = false; disabled.push('ttsEnabled'); }
  if (v.wakeEnabled && !need.wake.every(isInstalled)) { v.wakeEnabled = false; disabled.push('wakeEnabled'); }
  for (const id of [...need.stt, ...need.tts, ...need.wake]) {
    if (!isInstalled(id)) missing[id] = true;
  }
  return { changed: disabled.length > 0, disabled, missing };
}

module.exports = {
  CATALOG,
  KWS_DIR,
  mirrorOrigin,
  resolveFileUrl,
  resolveVoiceModelDir,
  resolveBundledModelRoot,
  searchRoots,
  fileInRoots,
  modelStatus,
  modelDirOf,
  fileRelPath,
  requiredModelIds,
  auditVoiceSettings,
};
