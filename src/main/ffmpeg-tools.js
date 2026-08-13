/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * FFmpeg / FFprobe 工具集：
 * - 优先使用随应用分发的预编译二进制（@ffmpeg-installer / @ffprobe-installer），
 *   用户零配置、离线可用
 * - 二进制缺失时回退到系统 PATH 中的 ffmpeg/ffprobe
 * - 全部通过 execFile + 参数数组调用，绝不经过 shell
 * - 每个工具独立校验参数类型/范围，另保留一个任意命令工具（敏感操作）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const FFMPEG_PLATFORM_PKG = {
  'darwin-arm64': '@ffmpeg-installer/darwin-arm64',
  'darwin-x64': '@ffmpeg-installer/darwin-x64',
  'win32-x64': '@ffmpeg-installer/win32-x64',
  'linux-x64': '@ffmpeg-installer/linux-x64',
  'linux-arm64': '@ffmpeg-installer/linux-arm64'
};
const FFPROBE_PLATFORM_PKG = {
  'darwin-arm64': '@ffprobe-installer/darwin-arm64',
  'darwin-x64': '@ffprobe-installer/darwin-x64',
  'win32-x64': '@ffprobe-installer/win32-x64',
  'linux-x64': '@ffprobe-installer/linux-x64',
  'linux-arm64': '@ffprobe-installer/linux-arm64'
};

let _ffmpegPath = null;
let _ffmpegResolved = false;
let _ffprobePath = null;
let _ffprobeResolved = false;

function systemBinary(binName) {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(whichCmd, [binName], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', timeout: 5000 });
    const first = String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch { return null; }
}

// drawtext 需要显式字体（静态构建无 fontconfig）。按平台探测系统字体，
// 保证文字水印零配置离线可用；找不到时提示用户传 fontFile。
function detectSystemFont() {
  const candidates = {
    darwin: [
      '/System/Library/Fonts/PingFang.ttc',
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/System/Library/Fonts/STHeiti Medium.ttc',
      '/Library/Fonts/Arial.ttf'
    ],
    win32: [
      'C:/Windows/Fonts/msyh.ttc',
      'C:/Windows/Fonts/msyh.ttf',
      'C:/Windows/Fonts/simhei.ttf',
      'C:/Windows/Fonts/arial.ttf',
      'C:/Windows/Fonts/segoeui.ttf'
    ],
    linux: [
      '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
    ]
  };
  const list = candidates[process.platform] || [];
  return list.find(f => { try { return fs.existsSync(f); } catch { return false; } }) || null;
}

function resolveBinary(kind) {
  const key = `${process.platform}-${process.arch}`;
  const pkg = (kind === 'ffmpeg' ? FFMPEG_PLATFORM_PKG : FFPROBE_PLATFORM_PKG)[key];
  if (pkg) {
    try {
      // 平台包没有 main 入口，直接解析包目录拼出二进制路径
      const pkgJsonPath = require.resolve(`${pkg}/package.json`);
      const binPath = path.join(path.dirname(pkgJsonPath), process.platform === 'win32' ? `${kind}.exe` : kind);
      if (binPath && fs.existsSync(binPath)) {
        // npm 可能因 ignore-scripts 跳过 chmod，运行前补一次可执行权限
        try { fs.accessSync(binPath, fs.constants.X_OK); } catch { try { fs.chmodSync(binPath, 0o755); } catch { /* ignore */ } }
        return binPath;
      }
    } catch { /* 该平台包未安装 */ }
  }
  return systemBinary(kind === 'ffmpeg' ? 'ffmpeg' : 'ffprobe');
}

function getFfmpegPath() {
  if (!_ffmpegResolved) { _ffmpegPath = resolveBinary('ffmpeg'); _ffmpegResolved = true; }
  return _ffmpegPath;
}

function getFfprobePath() {
  if (!_ffprobeResolved) { _ffprobePath = resolveBinary('ffprobe'); _ffprobeResolved = true; }
  return _ffprobePath;
}

function runFfmpeg(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bin = getFfmpegPath();
  if (!bin) return Promise.resolve({ ok: false, error: '未找到 ffmpeg 可执行文件（随应用分发缺失且系统未安装）' });
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message || 'ffmpeg 执行失败').toString().slice(-2000), code: err.code });
      } else {
        resolve({ ok: true, output: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

// ---- 参数校验助手（严格类型化） ----
function bad(label) { return new Error(`参数错误：${label}`); }

function str(v, name, { required = true, maxLen = 4000, enum: enums } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} 必填`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${name} 必须是字符串`);
  if (v.length > maxLen) throw bad(`${name} 过长`);
  if (enums && !enums.includes(v)) throw bad(`${name} 必须是 ${enums.join('/')} 之一`);
  return v;
}

function num(v, name, { required = true, min, max, integer = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} 必填`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} 必须是数字`);
  if (integer && !Number.isInteger(n)) throw bad(`${name} 必须是整数`);
  if (min !== undefined && n < min) throw bad(`${name} 不能小于 ${min}`);
  if (max !== undefined && n > max) throw bad(`${name} 不能大于 ${max}`);
  return n;
}

function bool(v, name, def = false) {
  if (v === undefined || v === null || v === '') return !!def;
  if (typeof v !== 'boolean') throw bad(`${name} 必须是布尔值`);
  return v;
}

function arr(v, name, { required = true, maxItems = 50 } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${name} 必填`);
    return [];
  }
  if (!Array.isArray(v)) throw bad(`${name} 必须是字符串数组`);
  if (v.length > maxItems) throw bad(`${name} 数量过多（上限 ${maxItems}）`);
  v.forEach((item, i) => {
    if (typeof item !== 'string' || !item.trim()) throw bad(`${name}[${i}] 必须是非空字符串`);
  });
  return v.map(s => s.trim());
}

function mustExist(fp, label) {
  if (!fp || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    throw new Error(`${label} 文件不存在：${fp || '(空)'}`);
  }
  return fp;
}

function defaultOut(input, suffix, ext) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}-${suffix}.${ext}`);
}

function resolveOut(input, output, suffix, ext) {
  const out = output ? path.normalize(String(output)) : defaultOut(input, suffix, ext);
  const dir = path.dirname(out);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { throw new Error(`无法创建输出目录：${e.message}`); }
  if (path.basename(out) === path.basename(input)) throw new Error('输出文件不能与输入文件相同');
  return out;
}

function writeTempList(entries) {
  const file = path.join(os.tmpdir(), `ffmpeg-concat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, entries.join('\n') + '\n', 'utf-8');
  return file;
}

function cleanupTemp(file) {
  try { if (file) fs.unlinkSync(file); } catch { /* ignore */ }
}

function parseSeconds(v, name) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  if (typeof v === 'string' && /^(\d+):([0-5]\d):([0-5]\d)(\.\d+)?$/.test(v.trim())) {
    const [h, m, s] = v.trim().split(':').map(Number);
    return h * 3600 + m * 60 + s;
  }
  throw bad(`${name} 格式无效（秒数或 HH:MM:SS）`);
}

// ---- ffprobe 信息 ----
async function probeInfo(input) {
  const bin = getFfprobePath();
  if (!bin) return { ok: false, error: '未找到 ffprobe 可执行文件' };
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], {
      timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: (err.message || 'ffprobe 失败').slice(-800) });
      try {
        const raw = JSON.parse(stdout);
        const fmt = raw.format || {};
        const streams = Array.isArray(raw.streams) ? raw.streams : [];
        const pick = (s) => ({
          index: s.index,
          codec: s.codec_name,
          type: s.codec_type,
          width: s.width || null,
          height: s.height || null,
          fps: s.r_frame_rate || s.avg_frame_rate || null,
          bitRate: s.bit_rate || null,
          sampleRate: s.sample_rate || null,
          channels: s.channels || null,
          duration: s.duration || null,
          language: (s.tags && s.tags.language) || null
        });
        resolve({
          ok: true,
          info: {
            filename: fmt.filename || input,
            duration: Number(fmt.duration) || null,
            size: Number(fmt.size) || null,
            bitRate: fmt.bit_rate || null,
            format: fmt.format_name || null,
            video: streams.filter(s => s.codec_type === 'video').map(pick),
            audio: streams.filter(s => s.codec_type === 'audio').map(pick),
            subtitle: streams.filter(s => s.codec_type === 'subtitle').map(pick)
          }
        });
      } catch (e) {
        resolve({ ok: false, error: 'ffprobe 输出解析失败：' + e.message });
      }
    });
  });
}

// ---- 工具实现 ----
async function toolInfo(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  return probeInfo(input);
}

async function toolTranscode(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'transcoded', 'mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  const videoCodec = str(p.videoCodec, 'videoCodec', { required: false, enum: ['h264', 'h265', 'vp9', 'mpeg4', 'copy'] });
  if (videoCodec) args.push('-c:v', videoCodec === 'h264' ? 'libx264' : videoCodec === 'h265' ? 'libx265' : videoCodec);
  const videoBitrate = str(p.videoBitrate, 'videoBitrate', { required: false, maxLen: 24 });
  if (videoBitrate) args.push('-b:v', videoBitrate);
  const audioCodec = str(p.audioCodec, 'audioCodec', { required: false, enum: ['aac', 'mp3', 'opus', 'flac', 'copy', 'none'] });
  if (audioCodec === 'none') args.push('-an');
  else if (audioCodec) args.push('-c:a', audioCodec === 'mp3' ? 'libmp3lame' : audioCodec === 'opus' ? 'libopus' : audioCodec);
  const audioBitrate = str(p.audioBitrate, 'audioBitrate', { required: false, maxLen: 24 });
  if (audioBitrate) args.push('-b:a', audioBitrate);
  const fps = num(p.fps, 'fps', { required: false, min: 1, max: 240 });
  if (fps) args.push('-r', String(fps));
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 8192 });
  const height = num(p.height, 'height', { required: false, integer: true, min: 16, max: 8192 });
  if (width || height) {
    const scale = width && height ? `${width}:${height}` : (width ? `${width}:-2` : `-2:${height}`);
    args.push('-vf', `scale=${scale}`);
  }
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolCompress(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'compressed', 'mp4');
  const crf = num(p.crf, 'crf', { required: false, min: 0, max: 51, integer: true }) ?? 28;
  const preset = str(p.preset, 'preset', { required: false, enum: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] }) || 'medium';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-c:v', 'libx264', '-crf', String(crf), '-preset', preset];
  const width = num(p.scaleWidth, 'scaleWidth', { required: false, integer: true, min: 16, max: 8192 });
  if (width) args.push('-vf', `scale=${width}:-2`);
  const audioBitrate = str(p.audioBitrate, 'audioBitrate', { required: false, maxLen: 24 }) || '128k';
  args.push('-c:a', 'aac', '-b:a', audioBitrate);
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolTrim(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'trimmed', 'mp4');
  const start = parseSeconds(p.start, 'start');
  const duration = parseSeconds(p.duration, 'duration');
  const end = parseSeconds(p.end, 'end');
  if (duration !== undefined && end !== undefined) throw bad('duration 与 end 只能提供一个');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (start !== undefined) args.push('-ss', String(start));
  args.push('-i', input);
  if (duration !== undefined) args.push('-t', String(duration));
  if (end !== undefined && start !== undefined) args.push('-to', String(end));
  args.push('-c', 'copy');
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolCrop(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'cropped', 'mp4');
  const x = num(p.x, 'x', { required: false, integer: true, min: 0 }) ?? 0;
  const y = num(p.y, 'y', { required: false, integer: true, min: 0 }) ?? 0;
  const width = num(p.width, 'width', { integer: true, min: 1, max: 8192 });
  const height = num(p.height, 'height', { integer: true, min: 1, max: 8192 });
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `crop=${width}:${height}:${x}:${y}`, '-c:a', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolResize(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'resized', 'mp4');
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 8192 });
  const height = num(p.height, 'height', { required: false, integer: true, min: 16, max: 8192 });
  if (!width && !height) throw bad('width 与 height 至少提供一个');
  const keepAspect = bool(p.keepAspect, 'keepAspect', true);
  const scale = width && height
    ? (keepAspect ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2` : `scale=${width}:${height}`)
    : (width ? `scale=${width}:-2` : `scale=-2:${height}`);
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', scale, '-c:a', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolRotate(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'rotated', 'mp4');
  const angle = num(p.angle, 'angle', { integer: true, min: 0, max: 360 });
  if (![90, 180, 270].includes(angle)) throw bad('angle 必须是 90/180/270');
  const vf = angle === 90 ? 'transpose=1' : angle === 270 ? 'transpose=2' : 'hflip,vflip';
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-c:a', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolExtractAudio(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const format = str(p.format, 'format', { required: false, enum: ['mp3', 'aac', 'wav', 'flac', 'opus', 'm4a'] }) || 'mp3';
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'audio', format);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn'];
  const codecMap = { mp3: 'libmp3lame', aac: 'aac', wav: 'pcm_s16le', flac: 'flac', opus: 'libopus', m4a: 'aac' };
  args.push('-c:a', codecMap[format]);
  const bitrate = str(p.bitrate, 'bitrate', { required: false, maxLen: 24 });
  if (bitrate) args.push('-b:a', bitrate);
  const sampleRate = num(p.sampleRate, 'sampleRate', { required: false, integer: true, min: 8000, max: 384000 });
  if (sampleRate) args.push('-ar', String(sampleRate));
  const channels = num(p.channels, 'channels', { required: false, integer: true, min: 1, max: 8 });
  if (channels) args.push('-ac', String(channels));
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolRemoveAudio(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'muted', 'mp4');
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-an', '-c:v', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolExtractFrame(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const format = str(p.format, 'format', { required: false, enum: ['jpg', 'png'] }) || 'jpg';
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'frame', format);
  const time = parseSeconds(p.time, 'time') ?? 0;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', input, '-frames:v', '1'];
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 8192 });
  if (width) args.push('-vf', `scale=${width}:-2`);
  if (format === 'jpg') args.push('-q:v', String(num(p.quality, 'quality', { required: false, integer: true, min: 1, max: 31 }) ?? 2));
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolExtractFrames(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const outputDir = path.normalize(String(str(p.outputDir, 'outputDir', { required: false }) || path.join(path.dirname(input), 'frames')));
  fs.mkdirSync(outputDir, { recursive: true });
  const pattern = str(p.outputPattern, 'outputPattern', { required: false, maxLen: 80 }) || 'frame_%04d.jpg';
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  const count = num(p.count, 'count', { required: false, integer: true, min: 1, max: 10000 });
  const intervalSec = num(p.intervalSec, 'intervalSec', { required: false, min: 0.01, max: 3600 });
  if (count !== undefined && intervalSec !== undefined) throw bad('count 与 intervalSec 只能提供一个');
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 8192 });
  const vfParts = [];
  if (intervalSec !== undefined) vfParts.push(`fps=1/${intervalSec}`);
  if (count !== undefined) vfParts.push(`fps=1,select='lte(n\\,${count - 1})'`);
  if (width) vfParts.push(`scale=${width}:-2`);
  if (vfParts.length) args.push('-vf', vfParts.join(','));
  args.push('-q:v', '2', path.join(outputDir, pattern));
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputDir } : res;
}

async function toolToGif(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'animated', 'gif');
  const fps = num(p.fps, 'fps', { required: false, min: 1, max: 60 }) ?? 10;
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 1600 }) ?? 480;
  const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', filter, output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolConcat(p) {
  const inputs = arr(p.inputs, 'inputs', { maxItems: 30 });
  if (inputs.length < 2) throw bad('inputs 至少需要 2 个文件');
  const first = mustExist(inputs[0], 'inputs[0]');
  const output = resolveOut(first, str(p.output, 'output', { required: true, maxLen: 4000 }), 'concat', 'mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const fcInputs = [];
  inputs.forEach((fp, idx) => {
    mustExist(fp, '输入');
    args.push('-i', fp);
    fcInputs.push(`${idx}`);
  });
  const n = inputs.length;
  const filter = fcInputs.map((i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${n}:v=1:a=1[v][a]`;
  args.push('-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolMux(p) {
  const video = mustExist(str(p.video, 'video'), '视频');
  const audio = mustExist(str(p.audio, 'audio'), '音频');
  const output = resolveOut(video, str(p.output, 'output', { required: false }), 'muxed', 'mp4');
  const audioCodec = str(p.audioCodec, 'audioCodec', { required: false, enum: ['aac', 'mp3', 'copy'] }) || 'aac';
  const replaceAudio = bool(p.replaceAudio, 'replaceAudio', true);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a'];
  args.push('-c:v', 'copy', '-c:a', audioCodec === 'mp3' ? 'libmp3lame' : audioCodec);
  if (!replaceAudio) args.push('-map', '0:a?');
  args.push('-shortest', output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolVolume(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'volume', path.extname(input).slice(1) || 'mp4');
  const factor = num(p.factor, 'factor', { min: 0, max: 10 }) ?? 1;
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-af', `volume=${factor}`, '-c:v', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

async function toolSpeed(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), `speed-${p.speed || 'x'}`, 'mp4');
  const speed = num(p.speed, 'speed', { min: 0.1, max: 16 }) ?? 1;
  const preservePitch = bool(p.preservePitch, 'preservePitch', true);
  const audioFilter = preservePitch ? atempoChain(speed) : null;
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', `setpts=PTS/${speed}`, '-c:v', 'libx264'];
  if (audioFilter) args.push('-af', audioFilter, '-c:a', 'aac');
  else args.push('-af', `asetrate=44100*${speed},aresample=44100`, '-c:a', 'aac');
  args.push(output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

function overlayPos(position, W, H, w, h, margin) {
  const m = margin || 20;
  switch (position) {
    case 'topLeft': return { x: `${m}`, y: `${m}` };
    case 'topRight': return { x: `${W}-${w}-${m}`, y: `${m}` };
    case 'bottomLeft': return { x: `${m}`, y: `${H}-${h}-${m}` };
    case 'center': return { x: `(${W}-${w})/2`, y: `(${H}-${h})/2` };
    case 'bottomRight':
    default: return { x: `${W}-${w}-${m}`, y: `${H}-${h}-${m}` };
  }
}

async function toolWatermark(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const image = str(p.image, 'image', { required: false, maxLen: 4000 });
  const text = str(p.text, 'text', { required: false, maxLen: 200 });
  if (!image && !text) throw bad('image 与 text 至少提供一个');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'watermarked', 'mp4');
  const position = str(p.position, 'position', { required: false, enum: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'center'] }) || 'bottomRight';
  const opacity = num(p.opacity, 'opacity', { required: false, min: 0.05, max: 1 }) ?? 0.75;
  const margin = num(p.margin, 'margin', { required: false, integer: true, min: 0, max: 2000 }) ?? 20;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (image) {
    mustExist(image, '水印图片');
    args.push('-i', input, '-i', image);
    const pos = overlayPos(position, 'W', 'H', 'w', 'h', margin);
    args.push('-filter_complex', `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wm];[0:v][wm]overlay=${pos.x}:${pos.y}:shortest=1`, '-c:a', 'copy', output);
  } else {
    args.push('-i', input);
    const safeText = String(text)
      .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:')
      .replace(/%/g, '\\%').replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const fontSize = num(p.fontSize, 'fontSize', { required: false, integer: true, min: 8, max: 300 }) ?? 28;
    const color = str(p.color, 'color', { required: false, maxLen: 20 }) || 'white';
    const fontfile = str(p.fontFile, 'fontFile', { required: false, maxLen: 4000 });
    const pos = overlayPos(position, 'w', 'h', 'tw', 'th', margin);
    let drawtext = `drawtext=text='${safeText}':fontsize=${fontSize}:fontcolor=${color}@${opacity}:x=${pos.x}:y=${pos.y}`;
    const effectiveFont = fontfile || detectSystemFont();
    if (!effectiveFont) {
      throw new Error('文字水印需要字体文件：未找到系统字体，请通过 fontFile 参数指定');
    }
    if (fontfile) {
      mustExist(fontfile, '字体文件');
    }
    drawtext += `:fontfile='${String(effectiveFont).replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:')}'`;
    args.push('-vf', drawtext, '-c:a', 'copy', output);
  }
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

function escapeFilterPath(fp) {
  return String(fp).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

async function toolAddSubtitle(p) {
  const input = mustExist(str(p.input, 'input'), '输入');
  const subtitle = mustExist(str(p.subtitle, 'subtitle'), '字幕文件');
  const ext = path.extname(subtitle).toLowerCase();
  if (!['.srt', '.ass', '.ssa', '.vtt', '.sub'].includes(ext)) throw bad('字幕仅支持 srt/ass/ssa/vtt/sub');
  const output = resolveOut(input, str(p.output, 'output', { required: false }), 'subtitled', 'mp4');
  const style = str(p.forceStyle, 'forceStyle', { required: false, maxLen: 200 });
  let vf = `subtitles='${escapeFilterPath(subtitle)}'`;
  if (style) vf += `:force_style='${String(style).replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
  const res = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vf', vf, '-c:a', 'copy', output]);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolSlideshow(p) {
  const images = arr(p.images, 'images', { maxItems: 100 });
  if (!images.length) throw bad('images 至少需要 1 张图片');
  const output = resolveOut(mustExist(images[0], 'images[0]'), str(p.output, 'output', { required: true, maxLen: 4000 }), 'slideshow', 'mp4');
  const durationPerImage = num(p.durationPerImage, 'durationPerImage', { min: 0.1, max: 60 }) ?? 3;
  const fps = num(p.fps, 'fps', { required: false, min: 1, max: 60 }) ?? 25;
  const width = num(p.width, 'width', { required: false, integer: true, min: 16, max: 8192 });
  const height = num(p.height, 'height', { required: false, integer: true, min: 16, max: 8192 });
  const audio = str(p.audio, 'audio', { required: false, maxLen: 4000 });
  const loopAudio = bool(p.loopAudio, 'loopAudio', true);
  const entries = [];
  for (const img of images) {
    mustExist(img, '图片');
    entries.push(`file '${String(img).replace(/'/g, "'\\''")}'`, `duration ${durationPerImage}`);
  }
  entries.push(`file '${String(images[images.length - 1]).replace(/'/g, "'\\''")}'`);
  const listFile = writeTempList(entries);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (audio) {
    mustExist(audio, '音频');
    if (loopAudio) args.push('-stream_loop', '-1', '-i', audio);
    else args.push('-i', audio);
  }
  const vfParts = [];
  if (width || height) {
    const scale = width && height ? `${width}:${height}` : (width ? `${width}:-2` : `-2:${height}`);
    vfParts.push(`scale=${scale}`);
  }
  if (vfParts.length) args.push('-vf', vfParts.join(','));
  args.push('-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) { args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-shortest'); }
  args.push(output);
  try {
    const res = await runFfmpeg(args);
    return res.ok ? { ...res, outputPath: output } : res;
  } finally {
    cleanupTemp(listFile);
  }
}

async function toolAudioMerge(p) {
  const inputs = arr(p.inputs, 'inputs', { maxItems: 30 });
  if (inputs.length < 2) throw bad('inputs 至少需要 2 个音频文件');
  const first = mustExist(inputs[0], 'inputs[0]');
  const format = str(p.format, 'format', { required: false, enum: ['mp3', 'wav', 'm4a', 'flac'] }) || 'mp3';
  const output = resolveOut(first, str(p.output, 'output', { required: false }), 'merged', format);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const parts = [];
  inputs.forEach((fp, i) => { mustExist(fp, '输入'); args.push('-i', fp); parts.push(`[${i}:a]`); });
  args.push('-filter_complex', parts.join('') + `concat=n=${inputs.length}:v=0:a=1[a]`, '-map', '[a]');
  const codecMap = { mp3: 'libmp3lame', wav: 'pcm_s16le', m4a: 'aac', flac: 'flac' };
  args.push('-c:a', codecMap[format], output);
  const res = await runFfmpeg(args);
  return res.ok ? { ...res, outputPath: output } : res;
}

async function toolRunCommand(p) {
  const rawArgs = p.args;
  if (!Array.isArray(rawArgs)) throw bad('args 必须是字符串数组');
  const args = rawArgs.map((a, i) => {
    if (typeof a !== 'string' || !a.trim()) throw bad(`args[${i}] 必须是非空字符串`);
    return a;
  });
  if (!args.length) throw bad('args 不能为空');
  const inputs = arr(p.inputs, 'inputs', { required: false, maxItems: 50 });
  inputs.forEach((fp) => mustExist(fp, '输入'));
  const timeoutSec = num(p.timeoutSec, 'timeoutSec', { required: false, integer: true, min: 1, max: 1800 }) ?? 600;
  const res = await runFfmpeg(args, { timeoutMs: timeoutSec * 1000 });
  return res;
}

const TOOLS = {
  info: toolInfo,
  transcode: toolTranscode,
  compress: toolCompress,
  trim: toolTrim,
  crop: toolCrop,
  resize: toolResize,
  rotate: toolRotate,
  extractAudio: toolExtractAudio,
  removeAudio: toolRemoveAudio,
  extractFrame: toolExtractFrame,
  extractFrames: toolExtractFrames,
  toGif: toolToGif,
  concat: toolConcat,
  mux: toolMux,
  volume: toolVolume,
  speed: toolSpeed,
  watermark: toolWatermark,
  addSubtitle: toolAddSubtitle,
  slideshow: toolSlideshow,
  audioMerge: toolAudioMerge,
  runCommand: toolRunCommand
};

function registerFfmpegIpc({ ipcMain }) {
  ipcMain.handle('ffmpeg:invoke', async (_event, tool, params) => {
    const fn = TOOLS[tool];
    if (!fn) return { ok: false, error: `未知的 ffmpeg 工具：${tool}` };
    try {
      return await fn(params && typeof params === 'object' ? params : {});
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
  ipcMain.handle('ffmpeg:available', async () => ({
    ok: true,
    ffmpeg: !!getFfmpegPath(),
    ffprobe: !!getFfprobePath()
  }));
}

module.exports = {
  registerFfmpegIpc,
  getFfmpegPath,
  getFfprobePath,
  runFfmpeg,
  TOOLS
};
