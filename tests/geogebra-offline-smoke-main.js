/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * GeoGebra 完整离线冒烟测试（Electron 主进程侧）：
 * 复用 src/main/geogebra-protocol.js 注册 ggb:// 协议，offscreen 窗口加载最小页面，
 * 真实初始化 classic 应用并执行作图/CAS/XML/Base64，全部离线，不访问网络。
 */

'use strict';

const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('path');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ggb',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const { registerGeogebraProtocol } = require('../src/main/geogebra-protocol');

let failures = 0;
function check(name, cond, extra) {
  const extraStr = extra === undefined ? '' : ' ' + JSON.stringify(extra).slice(0, 220);
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extraStr}`);
  if (!cond) failures++;
}

app.whenReady().then(async () => {
  try {
    const root = registerGeogebraProtocol();
    check('离线包解析成功（assets/geogebra-app）', !!root, root);
    if (!root) {
      app.exit(1);
      return;
    }

    // 直接验证协议层：主进程 net.fetch ggb:// 应返回 web3d.nocache.js 内容
    try {
      const probe = await net.fetch('ggb://app/GeoGebra/HTML5/5.0/web3d/web3d.nocache.js');
      const probeText = await probe.text();
      console.log('[probe] nocache.js:', probe.status, probeText.length, 'bytes');
      check('协议可直接返回 web3d.nocache.js', probe.status === 200 && probeText.length > 500, probe.status);
    } catch (e) {
      check('协议可直接返回 web3d.nocache.js', false, e.message);
    }

    const win = new BrowserWindow({
      width: 1200,
      height: 900,
      show: false,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    await win.loadFile(path.join(__dirname, 'geogebra-offline-smoke.html'));

    const result = await new Promise((resolve) => {
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        try {
          const r = await win.webContents.executeJavaScript('window.__SMOKE__ || null');
          if (r) {
            clearInterval(timer);
            resolve(r);
          } else if (Date.now() - startedAt > 120000) {
            clearInterval(timer);
            resolve({ ok: false, error: '冒烟测试超时（120s）' });
          }
        } catch (_) {
          /* 页面尚未就绪，继续轮询 */
        }
      }, 500);
    });

    check('applet 离线加载成功（appletOnLoad）', !!(result.ok && result.appletLoaded), result.error);
    check('getVersion 可用', typeof result.version === 'string' && result.version.length > 0, result.version);
    check('evalCommandGetLabels 产生对象标签', result.labels === 'f', result.labels);
    check('getAllObjectNames 返回对象', Array.isArray(result.objects) && result.objects.includes('f'), result.objects);
    check('getObjectType("f") === function', result.fType === 'function', result.fType);
    check('getValueString("f") 为函数表达式', typeof result.fValue === 'string' && result.fValue.length > 0, result.fValue);
    check('evalCommandCAS 符号展开成功', typeof result.cas === 'string' && /x\s*\^?\s*2|2\s*x/i.test(result.cas), result.cas);
    check('getXML 返回作图源码', (result.xmlLen || 0) > 100, result.xmlLen);
    check('getBase64 异步导出 .ggb', (result.b64Len || 0) > 100, result.b64Len);

    console.log('\n==== GeoGebra 离线冒烟测试:', failures === 0 ? '全部通过' : `失败 ${failures} 项`, '====');
    app.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error('冒烟测试异常:', e);
    app.exit(1);
  }
});
