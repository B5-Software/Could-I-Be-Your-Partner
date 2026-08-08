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
  // ---------- AudioWorklet 处理器（内联，经 Blob URL 加载） ----------
  const WORKLET_CODE = `
class Pcm16Encoder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.inBuf = new Float32Array(0);
    this.outPos = 0;
    this.chunkSize = 1600; // 100ms @16k
    this.levelAcc = 0;
    this.levelCount = 0;
    this.levelSamples = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // 电平统计（~200ms 上报一次）
    for (let i = 0; i < ch.length; i += 4) { this.levelAcc += ch[i] * ch[i]; this.levelCount++; }
    this.levelSamples += ch.length;
    if (this.levelSamples >= sampleRate * 0.2) {
      const rms = Math.sqrt(this.levelAcc / Math.max(1, this.levelCount));
      this.port.postMessage({ type: 'level', level: Math.min(1, rms * 4) });
      this.levelAcc = 0; this.levelCount = 0; this.levelSamples = 0;
    }
    // 拼接输入缓冲
    const merged = new Float32Array(this.inBuf.length + ch.length);
    merged.set(this.inBuf, 0);
    merged.set(ch, this.inBuf.length);
    this.inBuf = merged;
    // 线性插值重采样 → Int16 chunk
    while ((this.inBuf.length - 1 - this.outPos) / this.ratio >= this.chunkSize) {
      const out = new Int16Array(this.chunkSize);
      for (let i = 0; i < this.chunkSize; i++) {
        const srcPos = this.outPos + i * this.ratio;
        const idx = Math.floor(srcPos);
        const frac = srcPos - idx;
        const a = this.inBuf[idx] || 0;
        const b = this.inBuf[idx + 1] || 0;
        let s = a + (b - a) * frac;
        s = Math.max(-1, Math.min(1, s));
        out[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage({ type: 'pcm', samples: out.buffer }, [out.buffer]);
      this.outPos += this.chunkSize * this.ratio;
    }
    // 丢弃已消费输入（保留 1 样本保证插值连续）
    const consumed = Math.floor(this.outPos);
    if (consumed > 1) {
      this.inBuf = this.inBuf.slice(consumed - 1);
      this.outPos -= (consumed - 1);
    }
    return true;
  }
}
registerProcessor('pcm16-encoder', Pcm16Encoder);
`;

  let _workletUrl = null;
  function getWorkletUrl() {
    if (!_workletUrl) {
      _workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
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
      await this.ctx.audioWorklet.addModule(getWorkletUrl());
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'pcm16-encoder', {
        processorOptions: { targetRate: 16000 },
      });
      this.node.port.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'pcm' && this.onChunk) this.onChunk(d.samples);
        else if (d.type === 'level' && this.onLevel) this.onLevel(d.level);
      };
      // 静音增益挂到 destination，保证 worklet 被持续拉流且不产生回授
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      source.connect(this.node);
      this.node.connect(gain);
      gain.connect(this.ctx.destination);
      this._gain = gain;
      this.running = true;
    }

    async stop() {
      this.running = false;
      try { if (this.node) this.node.disconnect(); } catch (_) {}
      try { if (this._gain) this._gain.disconnect(); } catch (_) {}
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { if (this.ctx) await this.ctx.close(); } catch (_) {}
      this.node = null;
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
      this.streams = new Map(); // reqId -> { nextTime, sources:Set, done, onDrain }
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

    /** 喂入一个音频 chunk（int16 ArrayBuffer） */
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
        st = { nextTime: 0, sources: new Set(), done: false, onDrain: null };
        this.streams.set(reqId, st);
      }
      const now = ctx.currentTime;
      if (st.nextTime < now + 0.03) st.nextTime = now + 0.03; // 落后即立即播放
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(this.gainNode);
      st.sources.add(src);
      src.onended = () => {
        st.sources.delete(src);
        this._maybeDrained(reqId);
      };
      src.start(st.nextTime);
      st.nextTime += audioBuf.duration;
    }

    /** 标记该流不再有新 chunk；全部播完后触发 onDrain */
    finish(reqId, onDrain) {
      const st = this.streams.get(reqId);
      if (!st) { if (onDrain) onDrain(); return; }
      st.done = true;
      st.onDrain = onDrain || null;
      this._maybeDrained(reqId);
    }

    _maybeDrained(reqId) {
      const st = this.streams.get(reqId);
      if (st && st.done && st.sources.size === 0) {
        this.streams.delete(reqId);
        if (st.onDrain) { try { st.onDrain(); } catch (_) {} }
      }
    }

    /** 立即停止（可指定单个流；不传则全部） */
    stop(reqId) {
      const stopOne = (id, st) => {
        for (const s of st.sources) { try { s.stop(); } catch (_) {} }
        st.sources.clear();
        this.streams.delete(id);
        if (st.onDrain) { try { st.onDrain(); } catch (_) {} }
      };
      if (reqId) {
        const st = this.streams.get(reqId);
        if (st) stopOne(reqId, st);
      } else {
        for (const [id, st] of [...this.streams.entries()]) stopOne(id, st);
      }
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
