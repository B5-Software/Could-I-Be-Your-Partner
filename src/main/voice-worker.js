/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 语音推理 Worker 线程：独占 sherpa-onnx 原生对象（KWS 唤醒词 / Whisper STT / Kokoro+Piper TTS / Silero VAD）。
 * 所有模型推理在此线程同步执行，避免阻塞主进程事件循环。
 *
 * 协议（parentPort 消息）：
 *   入: { type:'init', models }                        模型路径清单（懒加载，不立即建模）
 *       { type:'wake.start', kws, keywordsFile }       启动唤醒词监听
 *       { type:'wake.audio', samples:ArrayBuffer }     int16 PCM 16kHz mono
 *       { type:'wake.stop' }
 *       { type:'stt.start', sessionId, whisper, vad }  启动听写会话
 *       { type:'stt.audio', sessionId, samples }
 *       { type:'stt.stop', sessionId }                 flush 并给出最终结果
 *       { type:'stt.cancel', sessionId }               丢弃会话（不出结果）
 *       { type:'tts.speak', reqId, text, lang, sid, speed, tts }  合成（按到达顺序排队）
 *       { type:'tts.cancelAll' }                       清空队列并打断当前合成
 *   出: { type:'wake.hit', keyword }
 *       { type:'stt.partial', sessionId, text, start, end }
 *       { type:'stt.final', sessionId, text }
 *       { type:'tts.audio', reqId, samples:ArrayBuffer(int16), sampleRate, progress }
 *       { type:'tts.done', reqId, durationSec }
 *       { type:'tts.error', reqId, error }
 *       { type:'error', scope, error } / { type:'ready' }
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

let sherpa = null;
let models = null; // { kws:{...}, vad, stt:{base:{...}}, tts:{kokoro:{...}, piperDe:{...}} }

/**
 * Windows DLL 搜索顺序加固（sherpa-onnx#3059）：
 * 把随包分发的平台二进制目录（sherpa-onnx.node / sherpa-onnx-c-api.dll / onnxruntime.dll）
 * 注册进 DLL 搜索路径，确保优先加载打包内自带的 onnxruntime.dll，
 * 而不是 PATH / 系统目录里可能残留的旧版同名 DLL（会导致原生模块加载失败）。
 * 开发态: <project>/node_modules/sherpa-onnx-win-x64
 * 打包态: <resources>/app.asar.unpacked/node_modules/sherpa-onnx-win-x64
 */
function registerSherpaDllDir() {
  try {
    if (os.platform() !== 'win32') return;
    const arch = os.arch();
    const pkgDir = path.join(__dirname, '..', '..', 'node_modules', `sherpa-onnx-win-${arch}`);
    if (!fs.existsSync(path.join(pkgDir, 'sherpa-onnx.node'))) return;
    if (typeof os.add_dll_directory === 'function') {
      try { os.add_dll_directory(pkgDir); } catch { /* ignore */ }
    }
    const sep = path.delimiter;
    const parts = String(process.env.PATH || '').split(sep);
    if (!parts.includes(pkgDir)) process.env.PATH = pkgDir + sep + (process.env.PATH || '');
  } catch { /* ignore */ }
}

// ---------- 状态 ----------
let kws = null;          // KeywordSpotter
let kwsStream = null;
let wakeActive = false;

const sttSessions = new Map(); // sessionId -> { vad, recognizer, text, closed }
let whisperRecognizer = null;  // 懒加载单例（所有会话共享）

const ttsEngines = new Map();  // 'kokoro' | 'piper-de' -> OfflineTts
const ttsQueue = [];           // { reqId, text, lang, sid, speed, engine, epoch }
let ttsBusy = false;
let ttsEpoch = 0;              // 每 cancel 一次 +1；仅处理 epoch 与当前值一致的合成任务

function post(msg, transfer) {
  try {
    if (transfer && transfer.length) parentPort.postMessage(msg, transfer);
    else parentPort.postMessage(msg);
  } catch (e) {
    // 主线程可能已销毁
  }
}

function int16ToFloat32(buf) {
  const i16 = new Int16Array(buf);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768.0;
  return f32;
}

function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return i16;
}

// ---------- KWS ----------
function startWake(cfg) {
  stopWake();
  const k = models.kws;
  kws = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: k.encoder, decoder: k.decoder, joiner: k.joiner },
      tokens: k.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    keywordsFile: cfg.keywordsFile,
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: cfg.keywordsScore != null ? cfg.keywordsScore : 1.0,
    keywordsThreshold: cfg.keywordsThreshold != null ? cfg.keywordsThreshold : 0.25,
  });
  kwsStream = kws.createStream();
  wakeActive = true;
}

function feedWakeAudio(samplesBuf) {
  if (!kws || !kwsStream || !wakeActive) return;
  const f32 = int16ToFloat32(samplesBuf);
  kwsStream.acceptWaveform({ sampleRate: 16000, samples: f32 });
  while (kws.isReady(kwsStream)) {
    kws.decode(kwsStream);
    const r = kws.getResult(kwsStream);
    if (r.keyword && r.keyword.length > 0) {
      post({ type: 'wake.hit', keyword: r.keyword });
      // 命中后重置流，避免连击
      try { kws.reset(kwsStream); } catch (_) {}
    }
  }
}

function stopWake() {
  wakeActive = false;
  kwsStream = null;
  kws = null;
}

/** 重置 KWS 流（暂停唤醒后恢复前调用，避免残留音频误触发） */
function resetWake() {
  if (kws && kwsStream) {
    try { kws.reset(kwsStream); } catch (_) {}
  }
}

// ---------- STT ----------
function getWhisperRecognizer() {
  if (whisperRecognizer) return whisperRecognizer;
  const w = models.stt.whisper;
  whisperRecognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: w.encoder, decoder: w.decoder },
      tokens: w.tokens,
      numThreads: w.numThreads || 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  return whisperRecognizer;
}

function createVad(cfg = {}) {
  return new sherpa.Vad({
    sileroVad: {
      model: models.vad,
      threshold: cfg.threshold != null ? cfg.threshold : 0.5,
      minSpeechDuration: cfg.minSpeechDuration != null ? cfg.minSpeechDuration : 0.25,
      minSilenceDuration: cfg.minSilenceDuration != null ? cfg.minSilenceDuration : 0.6,
      maxSpeechDuration: cfg.maxSpeechDuration != null ? cfg.maxSpeechDuration : 10,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, cfg.bufferSeconds || 120);
}

function sttStart(msg) {
  if (sttSessions.has(msg.sessionId)) return;
  sttSessions.set(msg.sessionId, {
    id: msg.sessionId,
    vad: createVad(msg.vad),
    buffered: [],        // 尚未凑够 windowSize 的浮点样本
    bufferedLen: 0,
    text: '',            // 已累计的最终文本
    lastPartial: '',
    cancelled: false,
  });
}

/** 处理 VAD 中已就绪的语音段：whisper 识别并发出 partial 事件 */
function drainVadSegments(session) {
  const recognizer = getWhisperRecognizer();
  while (!session.vad.isEmpty()) {
    const segment = session.vad.front(false); // false → 拷贝到 V8 堆（Electron V8 sandbox 禁外部 buffer）
    session.vad.pop();
    if (!segment || !segment.samples || segment.samples.length === 0) continue;
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples: segment.samples });
    recognizer.decode(stream);
    const r = recognizer.getResult(stream);
    const segText = (r.text || '').trim();
    if (segText) {
      session.text = session.text ? session.text + segText : segText;
      session.lastPartial = session.text;
      post({
        type: 'stt.partial',
        sessionId: session.id,
        text: session.text,
        segText,
        start: segment.start / 16000,
        end: (segment.start + segment.samples.length) / 16000,
      });
    }
  }
}

function sttAudio(msg) {
  const session = sttSessions.get(msg.sessionId);
  if (!session) return;
  const f32 = int16ToFloat32(msg.samples);
  session.buffered.push(f32);
  session.bufferedLen += f32.length;

  const windowSize = 512;
  while (session.bufferedLen >= windowSize) {
    // 拼接出恰好 windowSize 的窗口
    const window = new Float32Array(windowSize);
    let offset = 0;
    while (offset < windowSize) {
      const head = session.buffered[0];
      const need = windowSize - offset;
      const take = Math.min(need, head.length);
      window.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.length) session.buffered.shift();
      else session.buffered[0] = head.subarray(take);
    }
    session.bufferedLen -= windowSize;
    session.vad.acceptWaveform(window);
    drainVadSegments(session);
  }
}

function sttStop(msg) {
  const session = sttSessions.get(msg.sessionId);
  if (!session) return;
  sttSessions.delete(msg.sessionId);
  try {
    // 喂入剩余不足一个窗口的样本 + 尾部静音，再 flush
    if (session.bufferedLen > 0) {
      const rest = new Float32Array(session.bufferedLen);
      let off = 0;
      for (const b of session.buffered) { rest.set(b, off); off += b.length; }
      session.buffered = [];
      session.vad.acceptWaveform(rest);
    }
    session.vad.acceptWaveform(new Float32Array(16000)); // 1s 静音收尾
    session.vad.flush();
    drainVadSegments(session);
  } catch (e) {
    post({ type: 'error', scope: 'stt.stop', error: e.message });
  }
  if (!session.cancelled) {
    post({ type: 'stt.final', sessionId: msg.sessionId, text: session.text || '' });
  }
}

// ---------- TTS ----------
function getTtsEngine(name) {
  if (ttsEngines.has(name)) return ttsEngines.get(name);
  let tts = null;
  if (name === 'kokoro') {
    const k = models.tts.kokoro;
    tts = new sherpa.OfflineTts({
      model: {
        kokoro: {
          model: k.model,
          voices: k.voices,
          tokens: k.tokens,
          dataDir: k.dataDir,
          lexicon: k.lexicon,
        },
        debug: 0,
        numThreads: k.numThreads || 2,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    });
  } else if (name === 'piper-de') {
    const p = models.tts.piperDe;
    tts = new sherpa.OfflineTts({
      model: {
        vits: {
          model: p.model,
          lexicon: p.lexicon || '',
          tokens: p.tokens,
          dataDir: p.dataDir,
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
        debug: 0,
        numThreads: 2,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    });
  } else {
    throw new Error('unknown tts engine: ' + name);
  }
  ttsEngines.set(name, tts);
  return tts;
}

/**
 * 将待合成文本切成不超过 maxChars 的分块。
 * 中文以标点（。！？；，、）为边界，英文以 .!?; 句子结束，避免截断单词；
 * 无标点时按硬上限切分。空/无上限时原样返回。
 */
function splitTtsText(text, maxChars) {
  if (!text) return [];
  const limit = maxChars && maxChars > 0 ? Math.max(20, Math.floor(maxChars)) : 0;
  if (!limit || text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  const hard = limit;
  const boundaryRe = /[。！？；…!?;；】〕》」』…\n\s]|\.(?=\s)|[,，]|\s(?=\S)/g;
  while (rest.length > 0) {
    if (rest.length <= hard) { parts.push(rest); break; }
    const sub = rest.slice(0, hard);
    // 在 ~40%~95% 区间内找最后一个边界符，避免全部在开头
    const candidates = [];
    boundaryRe.lastIndex = 0;
    let m;
    while ((m = boundaryRe.exec(sub)) !== null) {
      const idx = m.index;
      if (idx >= 30) candidates.push(idx);
    }
    const cutAt = candidates.length ? candidates[candidates.length - 1] : hard;
    // 避免 single char 遗留
    const cut = cutAt >= hard - 1 || cutAt <= 0 ? hard : cutAt + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  // 合并过碎的小块（例如标点密集导致的大量几字残留），但不得重新拼成超长块
  const MIN_FRAGMENT = Math.max(10, Math.floor(limit / 6));
  const merged = [];
  for (const p of parts) {
    if (merged.length && p.length <= MIN_FRAGMENT && merged[merged.length - 1].length + p.length <= limit * 1.15) {
      merged[merged.length - 1] += p;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

async function pumpTtsQueue() {
  if (ttsBusy) return;
  ttsBusy = true;
  while (ttsQueue.length > 0) {
    const job = ttsQueue.shift();
    // 自动分块：无论流式/非流式，超长文本一律拆块合成，防止长文本单次
    // generate() 一次性申请巨量内存导致 OOM（worker 已无 onProgress 流式保护）。
    // 块大小来自设置 voice.ttsChunkChars（默认 120 字/块）。
    const chunks = splitTtsText(job.text, job.chunkChars);
    if (ttsEpoch !== job.epoch) continue; // 已取消
    if (!chunks.length) {
      post({ type: 'tts.error', reqId: job.reqId, error: 'empty text' });
      continue;
    }
    let totalFrames = 0;
    let sr = 24000;
    let failed = false;
    for (const [i, textChunk] of chunks.entries()) {
      if (ttsEpoch !== job.epoch) break; // 中间被取消：丢弃未发出部分
      try {
        const tts = getTtsEngine(job.engine);
        // 使用同步 generate()（一次返回整段音频）：
        // sherpa 的异步 generateAsync+onProgress 在 macOS 上存在
        // use-after-free（TypedThreadSafeFunction 读取已释放内存），导致
        // 吐字不清 / 随机卡顿，甚至 napi_create_arraybuffer OOM 崩溃。
        // worker 线程本来就在后台，同步阻塞完全可接受。
        const audio = tts.generate({
          text: textChunk,
          enableExternalBuffer: false,
          generationConfig: new sherpa.GenerationConfig({
            sid: job.sid != null ? job.sid : 0,
            speed: job.speed != null ? job.speed : 1.0,
            silenceScale: 0.2,
          }),
        });
        if (ttsEpoch !== job.epoch) break;
        if (audio && audio.samples && audio.samples.length > 0) {
          sr = audio.sampleRate || tts.sampleRate;
          const i16 = float32ToInt16(audio.samples);
          totalFrames += i16.length;
          post({
            type: 'tts.audio',
            reqId: job.reqId,
            samples: i16.buffer,
            sampleRate: sr,
            progress: (i + 1) / chunks.length,
          }, [i16.buffer]);
        }
      } catch (e) {
        failed = true;
        post({ type: 'tts.error', reqId: job.reqId, error: `chunk ${i + 1}/${chunks.length}: ${e.message}` });
        break;
      }
    }
    if (ttsEpoch === job.epoch && !failed && totalFrames > 0) {
      post({ type: 'tts.done', reqId: job.reqId, durationSec: totalFrames / sr });
    } else if (ttsEpoch === job.epoch && !failed && totalFrames === 0) {
      post({ type: 'tts.error', reqId: job.reqId, error: 'empty audio' });
    }
  }
  ttsBusy = false;
}

// ---------- 消息分发 ----------
parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'init':
        models = msg.models;
        registerSherpaDllDir();
        if (!sherpa) sherpa = require('sherpa-onnx-node');
        post({ type: 'ready' });
        break;
      case 'wake.start': startWake(msg); break;
      case 'wake.audio': feedWakeAudio(msg.samples); break;
      case 'wake.stop': stopWake(); break;
      case 'wake.reset': resetWake(); break;
      case 'stt.start': sttStart(msg); break;
      case 'stt.audio': sttAudio(msg); break;
      case 'stt.stop': sttStop(msg); break;
      case 'stt.cancel': {
        const s = sttSessions.get(msg.sessionId);
        if (s) { s.cancelled = true; sttSessions.delete(msg.sessionId); }
        break;
      }
      case 'tts.speak':
        ttsQueue.push({ reqId: msg.reqId, text: msg.text, engine: msg.tts, sid: msg.sid, speed: msg.speed, chunkChars: msg.chunkChars, epoch: ttsEpoch });
        pumpTtsQueue();
        break;
      case 'tts.cancelAll':
        ttsEpoch++;
        ttsQueue.length = 0;
        break;
      default:
        break;
    }
  } catch (e) {
    post({ type: 'error', scope: msg.type, error: e.message });
  }
});
