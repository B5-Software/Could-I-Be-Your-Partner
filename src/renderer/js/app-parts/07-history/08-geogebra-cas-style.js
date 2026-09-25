  async function ensureGgbReady() {
    if (ggbApplet) return true;
    if (ggbInitPromise) await ggbInitPromise;
    return !!(ggbApplet);
  }

  // 符号计算（CAS）：需要 classic/cas/suite 应用；按需启用 CAS
  window.evalGeoGebraCAS = async function(cmd) {
    if (!await ensureGgbReady()) {
      return { ok: false, error: 'GeoGebra未初始化（applet 尚未加载完成）' };
    }
    if (!cmd || typeof cmd !== 'string') return { ok: false, error: '命令为空' };
    if (typeof ggbApplet.evalCommandCAS !== 'function') {
      return { ok: false, error: '当前应用不支持 CAS（请使用 classic/cas/suite 应用）' };
    }
    ggbLastError = null;
    try {
      if (typeof ggbApplet.enableCAS === 'function') {
        try { ggbApplet.enableCAS(true); } catch (_) {}
        await new Promise(r => setTimeout(r, 120));
      }
      // Giac 符号引擎懒加载：首次调用先预热，并对 "?"（未就绪）做有限重试
      try { ggbApplet.evalCommandCAS('1+1'); } catch (_) {}
      let result = '?';
      for (let attempt = 0; attempt < 20; attempt++) {
        result = ggbApplet.evalCommandCAS(cmd);
        if (result !== '?' && result !== undefined && result !== null) break;
        await new Promise(r => setTimeout(r, 300));
      }
      if (ggbLastError && Date.now() - (ggbLastError.ts || 0) < 3000) {
        return { ok: false, error: ggbLastError.message, cmd };
      }
      const text = result == null ? '' : String(result);
      if (text === '?' || text === '') {
        return { ok: false, error: 'CAS 未能求值（结果为 ?，可能语法错误或引擎未就绪）', cmd, result: text };
      }
      return { ok: true, result: text, cmd };
    } catch (e) {
      return { ok: false, error: e.message, cmd };
    }
  };

  // 单个对象详情：类型、值、坐标、定义、命令、样式状态
  window.getGeoGebraObject = function(name) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!name) return { ok: false, error: '缺少对象名' };
    try {
      const type = ggbApplet.getObjectType(name);
      const obj = { name: String(name), type };
      let value = null;
      try { value = ggbApplet.getValueString(name); } catch (_) {}
      if (type === 'numeric') {
        try {
          const n = ggbApplet.getValue(name);
          if (isFinite(n)) value = n;
        } catch (_) {}
      } else if (type === 'point' || type === 'vector') {
        try {
          const x = ggbApplet.getXcoord(name);
          const y = ggbApplet.getYcoord(name);
          if (isFinite(x) && isFinite(y)) value = `(${x}, ${y})`;
        } catch (_) {}
      }
      obj.value = value;
      try { obj.definition = ggbApplet.getDefinitionString(name); } catch (_) {}
      try { if (typeof ggbApplet.getCommandString === 'function') obj.command = ggbApplet.getCommandString(name, false); } catch (_) {}
      try { obj.visible = ggbApplet.getVisible(name); } catch (_) {}
      try { if (typeof ggbApplet.getCaption === 'function') obj.caption = ggbApplet.getCaption(name); } catch (_) {}
      try { if (typeof ggbApplet.getLayer === 'function') obj.layer = ggbApplet.getLayer(name); } catch (_) {}
      return { ok: true, object: obj };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  window.getGeoGebraXML = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      return { ok: true, xml: String(ggbApplet.getXML() || '') };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // setXML 会清空当前作图后按 XML 重建（官方文档行为），适合加载整份文件
  window.setGeoGebraXML = function(xml) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!xml || typeof xml !== 'string') return { ok: false, error: 'XML 为空' };
    try {
      if (typeof ggbApplet.setXML === 'function') {
        ggbApplet.setXML(xml);
      } else if (typeof ggbApplet.evalXML === 'function') {
        ggbApplet.evalXML(xml);
      } else {
        return { ok: false, error: '当前应用不支持 XML 加载' };
      }
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // 颜色支持 '#rrggbb'/'#rgb'/数组/对象 归一化为 [r,g,b]
  function ggbParseColor(c) {
    if (Array.isArray(c)) return c.slice(0, 3).map(v => Math.max(0, Math.min(255, Number(v) || 0)));
    if (c && typeof c === 'object') {
      return [Math.max(0, Math.min(255, Number(c.r) || 0)), Math.max(0, Math.min(255, Number(c.g) || 0)), Math.max(0, Math.min(255, Number(c.b) || 0))];
    }
    const s = String(c || '').replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(s)) return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
    if (/^[0-9a-f]{3}$/i.test(s)) return s.split('').map(x => parseInt(x + x, 16));
    return null;
  }

  window.setGeoGebraStyle = function(name, style) {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    if (!name) return { ok: false, error: '缺少对象名' };
    const s = style && typeof style === 'object' ? style : {};
    const applied = [];
    const call = (fn, args, label) => {
      if (typeof ggbApplet[fn] !== 'function') return false;
      try { ggbApplet[fn](...args); applied.push(label); return true; } catch (_) { return false; }
    };
    if (s.color !== undefined) {
      const rgb = ggbParseColor(s.color);
      if (rgb) call('setColor', [name, rgb[0], rgb[1], rgb[2]], 'color');
    }
    if (s.visible !== undefined) call('setVisible', [name, !!s.visible], 'visible');
    if (s.labelVisible !== undefined || s.label !== undefined) {
      call('setLabelVisible', [name, !!(s.labelVisible !== undefined ? s.labelVisible : s.label)], 'labelVisible');
    }
    if (s.labelStyle !== undefined) call('setLabelStyle', [name, Number(s.labelStyle)], 'labelStyle');
    if (s.caption !== undefined) call('setCaption', [name, String(s.caption)], 'caption');
    if (s.fixed !== undefined) call('setFixed', [name, !!s.fixed, s.selectionAllowed !== false], 'fixed');
    if (s.layer !== undefined) call('setLayer', [name, Number(s.layer)], 'layer');
    if (s.lineStyle !== undefined) call('setLineStyle', [name, Number(s.lineStyle)], 'lineStyle');
    if (s.lineThickness !== undefined) call('setLineThickness', [name, Number(s.lineThickness)], 'lineThickness');
    if (s.pointStyle !== undefined) call('setPointStyle', [name, Number(s.pointStyle)], 'pointStyle');
    if (s.pointSize !== undefined) call('setPointSize', [name, Number(s.pointSize)], 'pointSize');
    return { ok: true, applied };
  };

  // 取最后一次命令错误（读取即清空），形成"执行→读错→修正"闭环
  window.getGeoGebraError = function() {
    const last = ggbLastError || null;
    ggbLastError = null;
    let appError = null;
    try {
      if (ggbApplet && typeof ggbApplet.getErrorString === 'function') appError = ggbApplet.getErrorString();
    } catch (_) {}
    return { ok: true, error: (last && last.message) || appError || null, ts: last ? last.ts : null };
  };

  window.getGeoGebraPNGBase64 = function() {
    if (!ggbApplet) return { ok: false, error: 'GeoGebra未初始化' };
    try {
      return { ok: true, data: ggbApplet.getPNGBase64(1, true, 72) };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // getBase64 为异步回调 API，包成 Promise
  window.getGeoGebraBase64 = function() {
    return new Promise((resolve) => {
      if (!ggbApplet || typeof ggbApplet.getBase64 !== 'function') {
        return resolve({ ok: false, error: 'GeoGebra未初始化或版本不支持 getBase64' });
      }
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      try {
        ggbApplet.getBase64((b64) => done({ ok: true, base64: String(b64 || '') }));
        setTimeout(() => done({ ok: false, error: 'getBase64 超时（10s）' }), 10000);
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    });
  };

  window.setGeoGebraBase64 = function(b64) {
    if (!ggbApplet || typeof ggbApplet.setBase64 !== 'function') {
      return { ok: false, error: 'GeoGebra未初始化或版本不支持 setBase64' };
    }
    try {
      ggbApplet.setBase64(String(b64 || ''));
      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  };

  // 命令目录：按需获取（不注入系统提示词，模型需要时经工具显式拉取）
