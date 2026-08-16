/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 语音引擎（主线程门面）：模型路径解析、Worker 生命周期、唤醒词路由、TTS 语言/音色调度。
 * 推理全部在 voice-worker.js（worker_threads）中执行。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { buildKeywordsFile } = require('./voice-kws-encoder');

// Kokoro 多语言 v1_0 音色 → sid 映射（官方 53 音色表）
const KOKORO_VOICES = {
  af_alloy: 0, af_aoede: 1, af_bella: 2, af_heart: 3, af_jessica: 4,
  af_kore: 5, af_nicole: 6, af_nova: 7, af_river: 8, af_sarah: 9,
  af_sky: 10, am_adam: 11, am_echo: 12, am_eric: 13, am_fenrir: 14,
  am_liam: 15, am_michael: 16, am_onyx: 17, am_puck: 18, am_santa: 19,
  bf_alice: 20, bf_emma: 21, bf_isabella: 22, bf_lily: 23, bm_daniel: 24,
  bm_fable: 25, bm_george: 26, bm_lewis: 27, ef_dora: 28, em_alex: 29,
  ff_siwis: 30, hf_alpha: 31, hf_beta: 32, hm_omega: 33, hm_psi: 34,
  if_sara: 35, im_nicola: 36, jf_alpha: 37, jf_gongitsune: 38,
  jf_nezumi: 39, jf_tebukuro: 40, jm_kumo: 41, pf_dora: 42, pm_alex: 43,
  pm_santa: 44, zf_xiaobei: 45, zf_xiaoni: 46, zf_xiaoxiao: 47,
  zf_xiaoyi: 48, zm_yunjian: 49, zm_yunxi: 50, zm_yunxia: 51, zm_yunyang: 52,
};

// 各语言推荐默认音色
const DEFAULT_VOICES = { zh: 'zf_xiaoxiao', en: 'af_heart', de: 'thorsten' };

/**
 * 解析内置模型根目录（无需复制到 userData：sherpa 原生层直接读真实文件）。
 * 打包后模型位于 app.asar.unpacked/assets/voice-models（asarUnpack），
 * 开发时位于 <project>/assets/voice-models。
 */
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

class VoiceEngine extends EventEmitter {
  /**
   * @param {object} opts { app, getSettings: () => settings }
   */
  constructor(opts) {
    super();
    this.app = opts.app;
    this.getSettings = opts.getSettings;
    this.worker = null;
    this.workerReady = false;
    this._pendingInit = null;
    this._pendingInitReject = null;
    this.modelRoot = null;
    this.userModelRoot = null; // userData/voice-models（可选大模型下载目录）
    this.wakeActive = false;
    this.wakeWordMap = new Map(); // encoded phrase (@原文) -> { phrase, action }
    this.sttSessions = new Set();
    this._sttSuspendWake = false; // 因 STT 会话活跃而暂停唤醒中
  }

  log(...args) { console.log('[voice]', ...args); }

  /** 汇总模型清单；缺失项写入 missing[] */
  resolveModels() {
    this.modelRoot = resolveBundledModelRoot(this.app);
    this.userModelRoot = path.join(this.app.getPath('userData'), 'voice-models');
    const missing = [];
    const root = this.modelRoot;
    const P = (rel) => {
      // 优先 userData（用户可能下载了更新/可选模型），回退内置 assets
      const inUser = this.userModelRoot ? path.join(this.userModelRoot, rel) : null;
      if (inUser && fs.existsSync(inUser)) return inUser;
      const inAssets = root ? path.join(root, rel) : null;
      if (inAssets && fs.existsSync(inAssets)) return inAssets;
      return null;
    };
    const req = (key, rel) => {
      const p = P(rel);
      if (!p) missing.push(key);
      return p;
    };

    const kwsDir = 'kws/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20';

    // 识别模型：按设置 voice.sttModel 选择 whisper-base / whisper-tiny（渲染进程已做白名单校验，这里兜底）
    const pickSttWhisper = () => {
      let size = 'base';
      try {
        const s = (this.getSettings && this.getSettings()) || {};
        const v = (s.voice && s.voice.sttModel) || 'base';
        if (v === 'tiny') size = 'tiny';
      } catch (_) {}
      const rel = (f) => `stt/whisper-${size}/${f}`;
      return {
        encoder: req('stt', rel(`${size}-encoder.int8.onnx`)),
        decoder: req('stt', rel(`${size}-decoder.int8.onnx`)),
        tokens: req('stt', rel(`${size}-tokens.txt`)),
        numThreads: 2,
      };
    };

    const models = {
      kws: {
        encoder: req('kws', `${kwsDir}/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx`),
        decoder: req('kws', `${kwsDir}/decoder-epoch-13-avg-2-chunk-8-left-64.onnx`),
        joiner: req('kws', `${kwsDir}/joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx`),
        tokens: req('kws', `${kwsDir}/tokens.txt`),
        enPhone: P(`${kwsDir}/en.phone`),
      },
      vad: req('vad', 'vad/silero_vad.onnx'),
      stt: {
        whisper: pickSttWhisper(),
      },
      tts: {
        kokoro: {
          model: req('tts-kokoro', 'tts/kokoro-int8-multi-lang-v1_0/model.int8.onnx'),
          voices: req('tts-kokoro', 'tts/kokoro-int8-multi-lang-v1_0/voices.bin'),
          tokens: req('tts-kokoro', 'tts/kokoro-int8-multi-lang-v1_0/tokens.txt'),
          dataDir: req('tts-kokoro', 'tts/kokoro-int8-multi-lang-v1_0/espeak-ng-data'),
          lexicon: [
            P('tts/kokoro-int8-multi-lang-v1_0/lexicon-us-en.txt'),
            P('tts/kokoro-int8-multi-lang-v1_0/lexicon-zh.txt'),
          ].filter(Boolean).join(','),
          ruleFsts: [
            P('tts/kokoro-int8-multi-lang-v1_0/date-zh.fst'),
            P('tts/kokoro-int8-multi-lang-v1_0/number-zh.fst'),
            P('tts/kokoro-int8-multi-lang-v1_0/phone-zh.fst'),
          ].filter(Boolean).join(','),
          numThreads: 2,
        },
        piperDe: {
          model: req('tts-piper-de', 'tts/vits-piper-de_DE-thorsten-medium/de_DE-thorsten-medium.onnx'),
          tokens: req('tts-piper-de', 'tts/vits-piper-de_DE-thorsten-medium/tokens.txt'),
          // Piper 与 Kokoro 共享 espeak-ng-data 目录（phonemization 引擎同一套文件）
          dataDir: P('tts/kokoro-int8-multi-lang-v1_0/espeak-ng-data'),
          lexicon: '',
        },
      },
    };
    this._models = models;
    this._missing = missing;
    return { models, missing };
  }

  /** 引擎状态（供设置页展示） */
  status() {
    const missing = this._missing || [];
    return {
      modelRoot: this.modelRoot,
      workerRunning: !!this.worker,
      workerReady: this.workerReady,
      wakeActive: this.wakeActive,
      sttActiveSessions: [...this.sttSessions],
      missing,
      ready: missing.length === 0,
    };
  }

  /** 确保 worker 已启动并完成 init */
  async ensureWorker() {
    if (this.worker && this.workerReady) return;
    if (this._pendingInit) return this._pendingInit;
    this._pendingInit = new Promise((resolve, reject) => {
      this._pendingInitReject = reject;
      const { missing } = this._models ? { missing: this._missing } : this.resolveModels();
      // 缺失核心模型仍允许启动（各功能在使用时报错），但记录日志
      if (missing && missing.length) this.log('模型缺失:', missing.join(', '));

      const workerPath = path.join(__dirname, 'voice-worker.js');
      try {
        this.worker = new Worker(workerPath);
      } catch (e) {
        this._pendingInit = null;
        this._pendingInitReject = null;
        return reject(e);
      }
      this.worker.on('message', (msg) => this._onWorkerMessage(msg));
      this.worker.on('error', (e) => {
        this.log('worker 错误:', e.message);
        this.emit('error', { scope: 'worker', error: e.message });
        if (this._pendingInitReject) {
          const rej = this._pendingInitReject;
          this._pendingInitReject = null;
          this._pendingInit = null;
          rej(new Error(e.message));
        }
      });
      this.worker.on('exit', (code) => {
        this.log('worker 退出 code=' + code);
        if (this._pendingInitReject) {
          const rej = this._pendingInitReject;
          this._pendingInitReject = null;
          this._pendingInit = null;
          rej(new Error(`语音 worker 提前退出（code=${code}）`));
        }
        this.worker = null;
        this.workerReady = false;
        this.wakeActive = false;
        this.sttSessions.clear();
        this._sttSuspendWake = false;
      });
      const onReady = (msg) => {
        if (msg.type === 'ready') {
          this.worker.off('message', onReadyBarrier);
          this.workerReady = true;
          this._pendingInitReject = null;
          this._pendingInit = null;
          resolve();
        }
      };
      const onReadyBarrier = (msg) => onReady(msg);
      this.worker.on('message', onReadyBarrier);
      this.worker.postMessage({ type: 'init', models: this._models });
    });
    return this._pendingInit;
  }

  _onWorkerMessage(msg) {
    switch (msg.type) {
      case 'error': {
        if (msg.scope === 'init' && this._pendingInitReject) {
          const rej = this._pendingInitReject;
          this._pendingInitReject = null;
          this._pendingInit = null;
          rej(new Error(msg.error || '语音引擎初始化失败'));
          // 初始化失败的 worker 不再可用：终止并清理，避免重试时叠加多个 worker
          if (this.worker && !this.workerReady) {
            try { this.worker.terminate(); } catch { /* ignore */ }
            this.worker = null;
          }
        }
        break;
      }
      case 'wake.hit': {
        const entry = this.wakeWordMap.get(msg.keyword) || null;
        this.emit('wake', {
          keyword: msg.keyword,
          phrase: entry ? entry.phrase : '',
          action: entry ? entry.action : 'voicebar',
        });
        break;
      }
      case 'stt.partial':
        this.emit('stt.partial', msg);
        break;
      case 'stt.final':
        this.sttSessions.delete(msg.sessionId);
        // 会话结束 → 若全部结束则恢复唤醒
        this._maybeResumeWakeAfterStt();
        this.emit('stt.final', msg);
        break;
      case 'tts.audio':
        this.emit('tts.audio', msg);
        break;
      case 'tts.done':
        this.emit('tts.done', msg);
        break;
      case 'tts.error':
        this.emit('tts.error', msg);
        break;
      case 'error':
        this.emit('engine.error', msg);
        break;
      default:
        break;
    }
  }

  // ---------- 唤醒 ----------
  /**
   * 启动/重启唤醒监听。
   * @param {Array<{phrase:string, action:string, boost?:number, threshold?:number}>} wakeWords
   */
  async startWake(wakeWords) {
    await this.ensureWorker();
    const kws = this._models.kws;
    if (!kws.encoder || !kws.decoder || !kws.joiner || !kws.tokens) {
      throw new Error('KWS 模型缺失');
    }
    // 生成 keywords 文件
    const kwDir = path.join(this.app.getPath('userData'), 'voice-models');
    fs.mkdirSync(kwDir, { recursive: true });
    const kwFile = path.join(kwDir, 'keywords.txt');
    const enabled = (wakeWords || []).filter((w) => w && w.phrase && w.enabled !== false);
    const { content, errors } = buildKeywordsFile(enabled, kws.enPhone || '');
    if (errors.length) this.log('唤醒词编码失败:', JSON.stringify(errors));
    if (!content.trim()) throw new Error('无有效唤醒词');
    fs.writeFileSync(kwFile, content, 'utf8');

    this.wakeWordMap.clear();
    for (const w of enabled) {
      // worker 返回的 keyword 为 @后的原文（空格→下划线）
      const key = w.phrase.trim().replace(/\s+/g, ' ').replace(/[:#@]/g, '').replace(/\s/g, '_');
      this.wakeWordMap.set(key, { phrase: w.phrase, action: w.action || 'voicebar' });
    }
    const s = (this.getSettings && this.getSettings()) || {};
    const kw = (s.voice && s.voice.kws) || {};
    this.worker.postMessage({
      type: 'wake.start',
      keywordsFile: kwFile,
      keywordsScore: kw.score != null ? kw.score : 1.0,
      keywordsThreshold: kw.threshold != null ? kw.threshold : 0.25,
    });
    this.wakeActive = true;
    this.log('唤醒监听已启动，词表:', enabled.map((w) => w.phrase).join(' / '));
    // 若此刻已有活跃听写会话（打开唤醒时正在听写）→ 保持互斥立即暂停
    if (this.sttSessions.size > 0 && !this._sttSuspendWake) {
      this._sttSuspendWake = true;
      this.suspendWake();
      this.log('已有听写会话，唤醒监听保持暂停');
    }
  }

  async stopWake() {
    this.wakeActive = false;
    this._sttSuspendWake = false;
    if (this.worker) this.worker.postMessage({ type: 'wake.stop' });
  }

  feedWakeAudio(int16Buf) {
    if (this.worker && this.wakeActive) {
      this.worker.postMessage({ type: 'wake.audio', samples: int16Buf });
    }
  }

  /** 暂停唤醒监听（前台听写/语音条听写期间防止误触发），不清除已建模的 KWS */
  suspendWake() {
    this.wakeActive = false;
    if (this.worker) {
      try { this.worker.postMessage({ type: 'wake.reset' }); } catch (_) {}
    }
  }

  /** 恢复唤醒监听（若 KWS 已建模则直接续用） */
  resumeWake() {
    this.wakeActive = true;
  }

  /** STT 会话结束后若全部结束 → 恢复被互斥机制暂停的唤醒 */
  _maybeResumeWakeAfterStt() {
    if (this._sttSuspendWake && this.sttSessions.size === 0) {
      this._sttSuspendWake = false;
      this.resumeWake();
      this.log('听写会话全部结束，恢复唤醒监听');
    }
  }

  // ---------- STT ----------
  async startStt(sessionId, opts = {}) {
    await this.ensureWorker();
    if (!this._models.stt.whisper.encoder) throw new Error('STT 模型缺失');
    this.sttSessions.add(sessionId);
    // 听写会话活跃 → 暂停后台唤醒（任何入口：主窗口听写 / 语音条 / WebUI）
    if (this.wakeActive && !this._sttSuspendWake) {
      this._sttSuspendWake = true;
      this.suspendWake();
      this.log('听写开始，暂停唤醒监听');
    }
    this.worker.postMessage({ type: 'stt.start', sessionId, vad: opts.vad });
  }

  feedStt(sessionId, int16Buf) {
    if (this.worker && this.sttSessions.has(sessionId)) {
      this.worker.postMessage({ type: 'stt.audio', sessionId, samples: int16Buf });
    }
  }

  stopStt(sessionId) {
    if (this.worker) this.worker.postMessage({ type: 'stt.stop', sessionId });
  }

  cancelStt(sessionId) {
    this.sttSessions.delete(sessionId);
    if (this.worker) this.worker.postMessage({ type: 'stt.cancel', sessionId });
    // 会话取消 → 若全部结束则恢复唤醒
    this._maybeResumeWakeAfterStt();
  }

  // ---------- TTS ----------
  /**
   * 合成一句文本。
   * @param {string} reqId 请求 ID（同一播报任务共享，便于整体取消）
   * @param {string} text 句子文本
   * @param {object} opts { lang:'zh'|'en'|'de', voice?:string, speed?:number }
   */
  async speak(reqId, text, opts = {}) {
    await this.ensureWorker();
    const lang = opts.lang || 'zh';
    const s = (this.getSettings && this.getSettings()) || {};
    const voiceCfg = (s.voice && s.voice.tts) || {};
    const ttsVoices = (s.voice && s.voice.ttsVoices) || {};
    let engine, sid;
    if (lang === 'de') {
      engine = 'piper-de';
      sid = 0;
    } else {
      engine = 'kokoro';
      const voiceName = opts.voice || ttsVoices[lang] || voiceCfg.voices?.[lang] || DEFAULT_VOICES[lang] || DEFAULT_VOICES.zh;
      sid = KOKORO_VOICES[voiceName] != null ? KOKORO_VOICES[voiceName] : KOKORO_VOICES[DEFAULT_VOICES[lang] || 'zf_xiaoxiao'];
    }
    const speed = opts.speed != null ? opts.speed : (voiceCfg.speed != null ? voiceCfg.speed : 1.0);
    // 自动分块：长文本在 worker 侧按 voice.ttsChunkChars 拆分合成（默认 120 字/块），
    // 防止单次 generate() 一次性申请巨量音频内存导致 OOM。voice.ttsAutoChunk 关闭则不切分。
    let chunkChars = 0;
    if (!s.voice || s.voice.ttsAutoChunk !== false) {
      chunkChars = s.voice && s.voice.ttsChunkChars != null ? s.voice.ttsChunkChars : 120;
    }
    this.worker.postMessage({ type: 'tts.speak', reqId, text, tts: engine, sid, speed, chunkChars });
  }

  cancelAllTts() {
    if (this.worker) this.worker.postMessage({ type: 'tts.cancelAll' });
  }

  /** 关闭引擎（应用退出时调用） */
  async dispose() {
    try { if (this.worker) await this.worker.terminate(); } catch (_) {}
    this.worker = null;
    this.workerReady = false;
  }

  /**
   * 重载模型并重启 worker（模型设置变更后调用）。
   * worker 内 whisper 识别器为懒加载单例，模型路径在 init 时锁定，必须重建 worker。
   * @returns {boolean} 重载前唤醒是否处于激活状态（需上层按需重建 KWS）
   */
  async reloadModels() {
    const wasWake = this.wakeActive;
    await this.dispose();
    this.sttSessions.clear();
    this._sttSuspendWake = false;
    this.resolveModels();
    this.wakeActive = false;
    this.log('语音模型已重载（sttModel 变更）');
    return wasWake;
  }
}

module.exports = { VoiceEngine, KOKORO_VOICES, DEFAULT_VOICES };
