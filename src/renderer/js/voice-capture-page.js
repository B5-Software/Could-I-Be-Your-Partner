/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 隐藏常驻采集页：收到主进程 start/stop 指令后采集麦克风并上行（target='wake'）。
 * 音频仅在本机内存中流经 KWS 小模型，不存储、不上传。
 */

'use strict';

(function () {
  const mic = new VoiceMic();
  let running = false;
  let keepaliveTimer = null;

  // macOS/Chromium 会把隐藏窗口的 AudioContext 挂起：主动 resume 并周期保活，
  // 否则采集图不运行、KWS 永远收不到音频帧。
  async function ensureRunning() {
    if (!running || !mic || !mic.ctx) return;
    try {
      if (mic.ctx.state !== 'running') await mic.ctx.resume();
    } catch (_) { /* 权限/策略原因暂无法恢复，下一轮保活再试 */ }
  }

  async function start() {
    if (running) return;
    try {
      mic.onChunk = (buf) => window.voiceApi.sendAudio('wake', null, buf);
      mic.onLevel = null;
      await mic.start();
      running = true;
      await ensureRunning();
      if (!keepaliveTimer) keepaliveTimer = setInterval(ensureRunning, 1500);
      window.voiceApi.reportState({ source: 'capture', capturing: true });
    } catch (e) {
      window.voiceApi.reportState({ source: 'capture', capturing: false, error: String(e && e.message ? e.message : e) });
    }
  }

  async function stop() {
    if (!running) return;
    running = false;
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    try { await mic.stop(); } catch (_) {}
    window.voiceApi.reportState({ source: 'capture', capturing: false });
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') ensureRunning(); });

  window.voiceApi.onCaptureControl((d) => {
    if (!d) return;
    if (d.command === 'start') start();
    else if (d.command === 'stop') stop();
  });
})();
