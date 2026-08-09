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

  async function start() {
    if (running) return;
    try {
      mic.onChunk = (buf) => window.voiceApi.sendAudio('wake', null, buf);
      mic.onLevel = null;
      await mic.start();
      running = true;
      window.voiceApi.reportState({ source: 'capture', capturing: true });
    } catch (e) {
      window.voiceApi.reportState({ source: 'capture', capturing: false, error: String(e && e.message ? e.message : e) });
    }
  }

  async function stop() {
    if (!running) return;
    running = false;
    try { await mic.stop(); } catch (_) {}
    window.voiceApi.reportState({ source: 'capture', capturing: false });
  }

  window.voiceApi.onCaptureControl((d) => {
    if (!d) return;
    if (d.command === 'start') start();
    else if (d.command === 'stop') stop();
  });
})();
