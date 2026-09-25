  window.initGeoGebra = function(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const appName = String(opts.appName || 'classic').toLowerCase();
    if (!GGB_APPS.includes(appName)) {
      return Promise.resolve({ ok: false, error: `未知 GeoGebra 应用类型: ${appName}（可选: ${GGB_APPS.join('/')}）`, ready: false });
    }
    const key = ggbConfigKey(opts);

    // 已初始化且配置一致 → 直接显示面板
    if (ggbInitialized && ggbApplet && ggbCurrentConfig && ggbCurrentConfig.key === key) {
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');
      return Promise.resolve({ ok: true, message: 'GeoGebra已显示', ready: true, appName });
    }
    // 正在进行中的初始化：配置一致则复用其结果；否则等完成后按新配置重建
    if (ggbInitPromise) {
      return ggbInitPromise.then((r) => {
        if (r && r.ok && ggbCurrentConfig && ggbCurrentConfig.key === key) {
          ggbPanel.classList.remove('hidden');
          document.body.classList.add('geogebra-open');
          return { ...r, ready: true, appName };
        }
        return window.initGeoGebra(opts);
      });
    }
    // 配置切换：销毁旧 applet（GGB HTML5 无官方 remove()，清空容器并复位全局单例）
    if (ggbInitialized || ggbApplet) {
      try {
        if (ggbResizeObserver && typeof ggbResizeObserver.disconnect === 'function') ggbResizeObserver.disconnect();
      } catch (_) {}
      ggbResizeObserver = null;
      // 官方 applet 对象有 remove()（deployggb 的 removeExistingApplet 即依赖它），
      // 先优雅卸载旧实例（停止其渲染循环/事件），再清空容器，避免新旧实例并存引发卡死。
      try {
        if (ggbApplet && typeof ggbApplet.remove === 'function') ggbApplet.remove();
      } catch (_) {}
      ggbInitialized = false;
      ggbApplet = null;
      try { window.ggbApplet = null; } catch (_) {}
      ggbLastError = null;
      ggbCurrentConfig = null;
      const oldHost = document.getElementById('ggb-element');
      if (oldHost) oldHost.innerHTML = '';
    }

    ggbInitPromise = new Promise((resolve) => {
      const timeoutMs = 30000; // 30s 超时（本地加载 web3d 全模块 + deferredjs 分片）
      const timer = setTimeout(() => {
        if (!ggbInitialized) {
          ggbInitPromise = null;
          resolve({ ok: false, error: 'GeoGebra 加载超时（30s），请确认离线包 assets/geogebra-app 已完整下载', ready: false });
        }
      }, timeoutMs);

      // 关键：先显示面板并等待布局完成，读取 host 实际像素尺寸，
      // 再用具体像素值传给 GGB params（而非 '100%'）。
      // GGB inject 时会把 '100%' 解析为 host clientWidth/Height，若此时为 0（flex 布局未完成）就固化为 0×0，
      // 后续 setSize 也救不回来（GGB 内部 canvas 已按 0×0 创建）。
      ggbPanel.classList.remove('hidden');
      document.body.classList.add('geogebra-open');

      // 用 requestAnimationFrame ×2 确保布局完成（一帧可能不够，flex 有时需要两帧）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const ggbHost = document.getElementById('ggb-element');
          const hostWidth = Math.max(100, ggbHost ? ggbHost.clientWidth : 480);
          const hostHeight = Math.max(100, ggbHost ? ggbHost.clientHeight : 600);

          // classic 在窄侧边栏（宽<高）会触发 GGT portrait 竖排（图形/代数上下各半），
          // 用 perspective 'AG' 在 init 时指定左右并排：铺满无白边、保留代数视图与输入栏、
          // 屏幕键盘保持挂载式随点击弹出。调用方显式传 perspective 可覆盖。
          const appPerspective = opts.perspective || (appName === 'classic' ? 'AG' : '');
          const params = {
            appName: appName,
            width: hostWidth,   // 用具体像素值，不用 '100%'
            height: hostHeight,
            showToolBar: true,
            showAlgebraInput: true,
            showMenuBar: false,
            showAppsPicker: false,
            showKeyboard: false,
            enableRightClick: false,
            enableShiftDragZoom: true,
            showResetIcon: true,
            appletOnLoad: function() {
              clearTimeout(timer);
              ggbApplet = window.ggbApplet;
              ggbInitialized = true;
              ggbCurrentConfig = { key, appName, perspective: opts.perspective || null, enableCAS: !!opts.enableCAS, enable3D: !!opts.enable3D };
              // 成功后必须清空 ggbInitPromise：否则再次 init（尤其切换 appName）会沿已 settle 的
              // promise 无限微任务递归，渲染器主线程被饿死（表现为"卡死"）。
              ggbInitPromise = null;
              // 加载后应用视角/CAS/3D 配置（仅在显式给出布尔值时才调用，避免误关 classic 默认能力）
              try {
                if (typeof opts.enableCAS === 'boolean' && typeof ggbApplet.enableCAS === 'function') ggbApplet.enableCAS(opts.enableCAS);
              } catch (_) {}
              try {
                if (typeof opts.enable3D === 'boolean' && typeof ggbApplet.enable3D === 'function') ggbApplet.enable3D(opts.enable3D);
              } catch (_) {}
              try {
                if (opts.perspective && typeof ggbApplet.setPerspective === 'function') ggbApplet.setPerspective(String(opts.perspective));
              } catch (_) {}
              // 注册错误监听器：GGB 命令失败时会回调
              try {
                if (ggbApplet && typeof ggbApplet.setErrorListener === 'function') {
                  ggbApplet.setErrorListener(function(msg) {
                    ggbLastError = { message: String(msg || 'GeoGebra 命令错误'), ts: Date.now() };
                  });
                }
                if (ggbApplet && typeof ggbApplet.setClientListener === 'function') {
                  ggbApplet.setClientListener(function(_applet, type, args) {
                    if (type === 'error' || (Array.isArray(args) && args && args[0] === 'ERROR')) {
                      ggbLastError = { message: String((args && args[1]) || 'GeoGebra 错误'), ts: Date.now() };
                    }
                  });
                }
              } catch (e) { /* 监听器注册失败忽略 */ }
              console.log('GeoGebra loaded');
              // 注册 ResizeObserver：GGB 不会自动跟随 host 尺寸变化，需手动 setSize
              try {
                const roHost = document.getElementById('ggb-element');
                if (roHost && typeof ResizeObserver === 'function') {
                  ggbResizeObserver = new ResizeObserver(() => {
                    if (ggbApplet && typeof ggbApplet.setSize === 'function') {
                      const w = Math.max(50, roHost.clientWidth);
                      const h = Math.max(50, roHost.clientHeight);
                      try { ggbApplet.setSize(w, h); } catch (_) { /* 忽略尺寸更新异常 */ }
                    }
                  });
                  ggbResizeObserver.observe(roHost);
                }
              } catch (_) { /* ResizeObserver 不可用 */ }
              // 梯度延迟 setSize：覆盖 GGB 内部布局完成的各个时间点
              const forceResize = () => {
                const fh = document.getElementById('ggb-element');
                if (!fh || !ggbApplet || typeof ggbApplet.setSize !== 'function') return;
                const w = Math.max(50, fh.clientWidth);
                const h = Math.max(50, fh.clientHeight);
                try { ggbApplet.setSize(w, h); } catch (_) {}
                try { if (typeof ggbApplet.setWidth === 'function') ggbApplet.setWidth(w); } catch (_) {}
                try { if (typeof ggbApplet.setHeight === 'function') ggbApplet.setHeight(h); } catch (_) {}
              };
              [0, 100, 300, 600, 1000].forEach(delay => {
                setTimeout(forceResize, delay);
              });
              resolve({ ok: true, message: 'GeoGebra已启动', ready: true, appName });
            }
          };
          if (appPerspective) params.perspective = appPerspective;

          // 面板已 remove('hidden')，host 已有真实尺寸，params 已用具体像素值。
          // 直接 inject（GGB 不会用 0×0 固化 canvas）。
          try {
            const ggbApp = new GGBApplet(params, true);
            ggbApp.setHTML5Codebase(GGB_OFFLINE_CODEBASE, true);
            ggbApp.inject('ggb-element');
          } catch (e) {
            clearTimeout(timer);
            ggbInitPromise = null;
            resolve({ ok: false, error: 'GeoGebra 注入失败: ' + (e && e.message || String(e)), ready: false });
          }
        });
      });
    });
    return ggbInitPromise;
  };
