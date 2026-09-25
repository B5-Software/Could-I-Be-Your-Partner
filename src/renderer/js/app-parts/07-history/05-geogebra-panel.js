  // ---- GeoGebra Side Panel ----
  let ggbApplet = null;
  let ggbInitialized = false;
  let ggbInitPromise = null;
  let ggbLastError = null; // { message, ts }
  let ggbCurrentConfig = null; // { key, appName, perspective, enableCAS, enable3D }
  let ggbResizeObserver = null;
  const ggbPanel = document.getElementById('geogebra-panel');
  const btnCloseGgb = document.getElementById('btn-close-geogebra');

  // 完整离线：官方 Math Apps Bundle 的 web3d 编译产物经主进程 ggb:// 协议从本地加载。
  // 官方文档推荐形如 applet.setHTML5Codebase('GeoGebra/HTML5/5.0/web3d/')，此处等价替换为
  // ggb://app/...（协议根即 GeoGebra/HTML5/5.0）。不再访问 www.geogebra.org。
  const GGB_OFFLINE_CODEBASE = 'ggb://app/GeoGebra/HTML5/5.0/web3d/';
  const GGB_APPS = ['classic', 'graphing', 'geometry', '3d', 'cas', 'scientific', 'notes', 'evaluator', 'suite', 'probability'];
  const ggbConfigKey = (o) => {
    const appName = String((o && o.appName) || 'classic').toLowerCase();
    return [appName, (o && o.perspective) || '', (o && o.enableCAS) ? 'cas' : '', (o && o.enable3D) ? '3d' : ''].join('|');
  };

  // 异步初始化：返回 Promise，在 appletOnLoad 触发后 resolve。
  // options: { appName, perspective, enableCAS, enable3D }。appName 改变时销毁旧 applet 重建。
