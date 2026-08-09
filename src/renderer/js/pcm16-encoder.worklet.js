/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * AudioWorklet 处理器：麦克风输入 → 16kHz Int16 PCM 分帧（100ms/1600 样本），
 * 附带 ~200ms 窗口电平上报。与 voice-capture.js 的 VoiceMic 配套使用。
 */

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
    for (let i = 0; i < ch.length; i += 4) { this.levelAcc += ch[i] * ch[i]; this.levelCount++; }
    this.levelSamples += ch.length;
    if (this.levelSamples >= sampleRate * 0.2) {
      const rms = Math.sqrt(this.levelAcc / Math.max(1, this.levelCount));
      this.port.postMessage({ type: 'level', level: Math.min(1, rms * 4) });
      this.levelAcc = 0; this.levelCount = 0; this.levelSamples = 0;
    }
    const merged = new Float32Array(this.inBuf.length + ch.length);
    merged.set(this.inBuf, 0);
    merged.set(ch, this.inBuf.length);
    this.inBuf = merged;
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
    const consumed = Math.floor(this.outPos);
    if (consumed > 1) {
      this.inBuf = this.inBuf.slice(consumed - 1);
      this.outPos -= (consumed - 1);
    }
    return true;
  }
}

registerProcessor('pcm16-encoder', Pcm16Encoder);