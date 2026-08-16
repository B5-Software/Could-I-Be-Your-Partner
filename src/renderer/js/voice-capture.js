/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 语音前端 I/O 共享模块（普通脚本，无模块依赖）：
 *   VoiceMic        麦克风采集 → 16kHz Int16 PCM 分帧（AudioWorklet）
 *   VoicePlayer     流式 PCM 播放器（Int16 chunk 无缝续播，自动重采样）
 *   SentenceFeeder  LLM 流式文本 → 句子切分 → 流式 TTS 投喂
 * 供主窗口、语音条、隐藏采集窗使用；WebUI 使用等价的 WS 版本。
 */

'use strict';

(function (global) {
  // ---------- AudioWorklet 处理器（独立文件，规避 blob: 因 CSP/Electron 版本无法加载） ----------
  // worklet 路径：与 voice-capture.js 同目录（页面经 ../js/ 引用，此处相对页面 URL 计算）

  let _workletUrl = null;
  function getWorkletUrl() {
    if (!_workletUrl) {
      const base = location.href;
      const pageDir = base.slice(0, base.lastIndexOf('/') + 1);
      _workletUrl = pageDir + '../js/pcm16-encoder.worklet.js';
    }
    return _workletUrl;
  }

  // ---------- 麦克风采集 ----------
  class VoiceMic {
    constructor() {
      this.ctx = null;
      this.stream = null;
      this.node = null;
      this.onChunk = null;  // (ArrayBuffer int16) => void
      this.onLevel = null;  // (0..1) => void
      this.running = false;
    }

    async start() {
      if (this.running) return;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 隐藏窗口（后台唤醒采集页）在 macOS/Chromium 上可能以 suspended 状态创建：
      // 立即尝试 resume，失败不阻断（调用方有保活轮询）
      try { await this.ctx.resume(); } catch (_) { /* 由调用方保活重试 */ }
      // AudioWorklet 为优先路径；若加载失败（Electron/CSP 环境差异）回退 ScriptProcessor
      let workletOk = false;
      try {
        await this.ctx.audioWorklet.addModule(getWorkletUrl());
        this.node = new AudioWorkletNode(this.ctx, 'pcm16-encoder', {
          processorOptions: { targetRate: 16000 },
        });
        this.node.port.onmessage = (e) => {
          const d = e.data;
          if (d.type === 'pcm' && this.onChunk) this.onChunk(d.samples);
          else if (d.type === 'level' && this.onLevel) this.onLevel(d.level);
        };
        workletOk = true;
      } catch (e) {
        if (global.console) console.warn('[VoiceMic] AudioWorklet 不可用，回退 ScriptProcessor:', e && e.message);
      }
      const source = this.ctx.createMediaStreamSource(this.stream);
      // 静音增益挂到 destination，保证处理器被持续拉流且不产生回授
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(this.ctx.destination);
      if (workletOk) {
        source.connect(this.node);
        this.node.connect(gain);
      } else {
        this._bindScriptProcessorFallback(source, gain);
      }
      this._gain = gain;
      this.running = true;
    }

    /** 显式恢复 AudioContext（隐藏窗口挂起时调用） */
    async resume() {
      if (this.ctx && this.ctx.state !== 'running') {
        try { await this.ctx.resume(); } catch (_) { /* ignore */ }
      }
    }

    // ScriptProcessor 降级：做与 worklet 等价的重采样 + Int16 分帧 + 电平
    _bindScriptProcessorFallback(sourceNode, destNode) {
      const ctx = this.ctx;
      const targetRate = 16000;
      const ratio = ctx.sampleRate / targetRate;
      let inBuf = new Float32Array(0);
      let outPos = 0;
      const CHUNK = 1600;
      let levelAcc = 0;
      let levelCount = 0;
      let levelSamples = 0;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const push = () => {
        while ((inBuf.length - 1 - outPos) / ratio >= CHUNK) {
          const out = new Int16Array(CHUNK);
          for (let i = 0; i < CHUNK; i++) {
            const srcPos = outPos + i * ratio;
            const idx = Math.floor(srcPos);
            const frac = srcPos - idx;
            const a = inBuf[idx] || 0;
            const b = inBuf[idx + 1] || 0;
            let s = a + (b - a) * frac;
            s = Math.max(-1, Math.min(1, s));
            out[i] = s < 0 ? s * 32768 : s * 32767;
          }
          if (this.onChunk) {
            try { this.onChunk(out.buffer); } catch (_) {}
          }
          outPos += CHUNK * ratio;
        }
        const consumed = Math.floor(outPos);
        if (consumed > 1) {
          inBuf = inBuf.slice(consumed - 1);
          outPos -= (consumed - 1);
        }
      };
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        const merged = new Float32Array(inBuf.length + ch.length);
        merged.set(inBuf, 0);
        merged.set(ch, inBuf.length);
        inBuf = merged;
        for (let i = 0; i < ch.length; i += 4) { levelAcc += ch[i] * ch[i]; levelCount++; }
        levelSamples += ch.length;
        if (levelSamples >= ctx.sampleRate * 0.2) {
          const rms = Math.sqrt(levelAcc / Math.max(1, levelCount));
          if (this.onLevel) {
            try { this.onLevel(Math.min(1, rms * 4)); } catch (_) {}
          }
          levelAcc = 0; levelCount = 0; levelSamples = 0;
        }
        push();
      };
      // ScriptProcessor 必须挂在 source 之后才能收到输入音频
      sourceNode.connect(proc);
      proc.connect(destNode);
      this._proc = proc;
    }

    async stop() {
      this.running = false;
      try { if (this.node) this.node.disconnect(); } catch (_) {}
      try { if (this._proc) this._proc.disconnect(); } catch (_) {}
      try { if (this._gain) this._gain.disconnect(); } catch (_) {}
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (this.ctx) await this.ctx.close(); } catch (_) {}
      this.node = null;
      this._proc = null;
      this._gain = null;
      this.stream = null;
      this.ctx = null;
    }
  }

  // ---------- 流式 PCM 播放器 ----------
  // 接收 int16 chunk（带采样率），按序无缝调度播放；支持立即打断。
  class VoicePlayer {
    constructor() {
      this.ctx = null;
      this.gainNode = null;
      this.streams = new Map(); // reqId -> { sources:Set, done, onDrain, tailEnd }
      this.nextTime = 0; // 全局播放队尾（Queue）：跨 reqId 统一续排，保证不重叠
      this.onAllDrained = null; // 所有流都播完/被停后触发（用于刷新"停止"按钮）
      this.volume = 1.0;
    }

    _ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = this.volume;
        this.gainNode.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    setVolume(v) {
      this.volume = v;
      if (this.gainNode) this.gainNode.gain.value = v;
    }

    /** 喂入一个音频 chunk（int16 ArrayBuffer）。所有请求共用播放队列，避免重叠。 */
    push(reqId, samplesBuf, sampleRate) {
      if (!reqId || !samplesBuf) return;
      const i16 = new Int16Array(samplesBuf);
      if (i16.length === 0) return;
      const ctx = this._ensureCtx();
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768.0;
      const audioBuf = ctx.createBuffer(1, f32.length, sampleRate || 24000);
      audioBuf.getChannelData(0).set(f32);

      let st = this.streams.get(reqId);
      if (!st) {
        st = { sources: new Set(), done: false, onEnd: null, tailEnd: 0 };
        this.streams.set(reqId, st);
      }
      const now = ctx.currentTime;
      // 全局队尾排期：所有请求（无论 reqId）都排在上一个尾部之后 → 播放不重叠。
      const startAt = Math.max(now + 0.03, this.nextTime);
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(this.gainNode);
      st.sources.add(src);
      src.onended = () => {
        st.sources.delete(src);
        this._maybeDrained(reqId);
      };
      src.start(startAt);
      st.tailEnd = startAt + audioBuf.duration;
      this.nextTime = st.tailEnd;
    }

    /** 标记该流不再有新 chunk；全部播完后触发 onEnd */
    finish(reqId, onEnd) {
      const st = this.streams.get(reqId);
      if (!st) { if (onEnd) onEnd(); this._checkGlobalIdle(); return; }
      st.done = true;
      st.onEnd = onEnd || null;
      this._maybeDrained(reqId);
    }

    _maybeDrained(reqId) {
      const st = this.streams.get(reqId);
      if (st && st.done && st.sources.size === 0) {
        // 该请求全部播完，把队尾回退到剩余请求的最晚尾部
        this.streams.delete(reqId);
        this._recomputeTail();
        if (st.onEnd) { try { st.onEnd(); } catch (_) {} }
        this._checkGlobalIdle();
      }
    }

    _recomputeTail() {
      let tail = 0;
      for (const [, s] of this.streams) if (s.tailEnd > tail) tail = s.tailEnd;
      this.nextTime = tail;
    }

    _checkGlobalIdle() {
      if (this.streams.size === 0 && typeof this.onAllDrained === 'function') {
        try { this.onAllDrained(); } catch (_) {}
      }
    }

    /** 立即停止（可指定单个流；不传则全部清空队列） */
    stop(reqId) {
      const stopOne = (id, st) => {
        for (const s of st.sources) { try { s.stop(); } catch (_) {} }
        st.sources.clear();
        this.streams.delete(id);
        if (st.onEnd) { try { st.onEnd(); } catch (_) {} }
      };
      if (reqId) {
        const st = this.streams.get(reqId);
        if (st) { stopOne(reqId, st); this._recomputeTail(); }
      } else {
        for (const [id, st] of [...this.streams.entries()]) stopOne(id, st);
        this.nextTime = 0; // 队列清空，下一条消息立即播放
      }
      this._checkGlobalIdle();
    }

    get playing() { return this.streams.size > 0; }
  }

  // ---------- 句子切分 + 流式 TTS 投喂 ----------
  const SENTENCE_END = /[。！？；!?;…\n]|\.(?=\s|$)/;
  const MAX_SENTENCE_CHARS = 120;

  class SentenceFeeder {
    /**
     * @param {object} opts {
     *   speak: (sentence:string, lang:'zh'|'en'|'de') => void,
     *   langOverride?: 'auto'|'zh'|'en'|'de',
     *   enabled?: () => boolean,
     * }
     */
    constructor(opts) {
      this.opts = opts || {};
      this.buf = '';
      this.inCodeBlock = false;
      this.closed = false;
    }

    reset() {
      this.buf = '';
      this.inCodeBlock = false;
      this.closed = false;
    }

    /** 剥离 markdown 语法，保留可读文本（作用于已切分的完整句子） */
    static stripMarkdown(text) {
      return text
        .replace(/`[^`]*`/g, ' ')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\|/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\s{2,}/g, ' ');
    }

    /** 简单语言检测：CJK→zh；德语特征→de；其余→en */
    static detectLang(text) {
      if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
      if (/[äöüßÄÖÜ]/.test(text)) return 'de';
      const lower = ' ' + text.toLowerCase() + ' ';
      const deHits = (lower.match(/\s(der|die|das|und|ist|ich|nicht|ein|eine|mit|für|auf|zu|den|dem|sie|wir|haben|werden|kann|auch|noch|nach|wie|aber|oder|wenn|dann|sehr)\s/g) || []).length;
      const enHits = (lower.match(/\s(the|and|is|are|a|an|to|of|in|that|it|for|on|with|as|at|this|have|not|but|be|by|or|from|we|you|they)\s/g) || []).length;
      if (deHits >= 2 && deHits > enHits) return 'de';
      return 'en';
    }

    /** 喂入增量文本（LLM token 流） */
    push(delta) {
      if (this.closed || !delta) return;
      this.buf += delta;
      this._drain(false);
    }

    /** 流结束，强制吐出剩余文本 */
    flush() {
      this.closed = true;
      this._drain(true);
      this.reset();
    }

    cancel() { this.reset(); }

    _drain(flushAll) {
      const enabled = this.opts.enabled ? this.opts.enabled() : true;
      if (!enabled) { this.buf = ''; this.inCodeBlock = false; return; }
      let guard = 0;
      while (this.buf.length > 0 && guard++ < 200) {
        if (this.inCodeBlock) {
          const i = this.buf.indexOf('```');
          if (i === -1) { this.buf = ''; return; } // 整块代码丢弃
          this.buf = this.buf.slice(i + 3);
          this.inCodeBlock = false;
          continue;
        }
        const fence = this.buf.indexOf('```');
        const region = fence === -1 ? this.buf : this.buf.slice(0, fence);
        const consumed = this._emitFrom(region, flushAll && fence === -1);
        if (consumed === 0) break;
        this.buf = this.buf.slice(consumed);
        if (consumed === region.length && fence !== -1) {
          this.buf = this.buf.slice(3); // 跳过栅栏进入代码块
          this.inCodeBlock = true;
        }
      }
    }

    /** 从 text 中切出完整句子交给 speak；返回消费的原始字符数 */
    _emitFrom(text, flushAll) {
      let pos = 0;
      let guard = 0;
      while (pos < text.length && guard++ < 50) {
        const rest = text.slice(pos);
        const m = rest.match(SENTENCE_END);
        let cut = -1;
        if (m && m.index != null) {
          // 非 flush 时，若 '.' 恰好落在区域末尾（可能是缩写/省略号未完），等待更多输入
          if (!flushAll && m[0] === '.' && (m.index + 1 === rest.length)) break;
          cut = m.index + m[0].length;
        } else if (rest.length >= MAX_SENTENCE_CHARS) {
          cut = MAX_SENTENCE_CHARS;
        } else if (flushAll && rest.trim().length > 0) {
          cut = rest.length;
        }
        if (cut === -1) break;
        const rawSentence = rest.slice(0, cut);
        pos += cut;
        const sentence = SentenceFeeder.stripMarkdown(rawSentence).trim();
        if (sentence.length >= 2 && /[\u4e00-\u9fffA-Za-z]/.test(sentence)) {
          const lang = (this.opts.langOverride && this.opts.langOverride !== 'auto')
            ? this.opts.langOverride
            : SentenceFeeder.detectLang(sentence);
          try { this.opts.speak && this.opts.speak(sentence, lang); } catch (_) {}
        }
      }
      return pos;
    }
  }

  global.VoiceMic = VoiceMic;
  global.VoicePlayer = VoicePlayer;
  global.SentenceFeeder = SentenceFeeder;
})(typeof window !== 'undefined' ? window : globalThis);
