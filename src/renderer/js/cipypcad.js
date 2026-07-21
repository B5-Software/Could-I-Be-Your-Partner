/**
 * CIPYP-CAD - 2D Drafting CAD Engine + Command Interpreter
 *
 * Features:
 *  - Geometry: line, polyline, rectangle, circle, arc, ellipse, text, dimension, hatch
 *  - Layers: visibility/lock/color, current layer
 *  - Selection: add/remove/replace by id or filter
 *  - Transforms: move, rotate, scale, mirror
 *  - View: pan, zoom, fit, grid, axes
 *  - Command DSL (AutoCAD-like): LLM-driven
 *  - DXF R12 ASCII export (LINE/CIRCLE/ARC/TEXT/POLYLINE/LWPOLYLINE)
 *  - Project save/load (JSON .cipyproj)
 *  - PNG/SVG export
 *
 * IPC Bridge (via cipypcad-preload):
 *   cadExecuteCommand(cmd)         -> { ok, result?, error? }
 *   cadExecuteCommands(cmdList)    -> { ok, results: [] }
 *   cadGetState()                  -> { ok, state }
 *   cadGetObjectList()             -> { ok, objects: [] }
 *   cadSaveProject(path)           -> { ok, path }
 *   cadLoadProject(path)           -> { ok }
 *   cadExportDxf(path)             -> { ok, path }
 *   cadExportImage(path, fmt)      -> { ok, path }   // fmt: png/svg
 *   cadClose()                     -> void
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. GEOMETRY PRIMITIVES
  // =========================================================================

  // Each object: { id, type, layer, props: {...}, selected }
  let _idCounter = 1;
  function nextId() { return `obj_${_idCounter++}`; }

  // Point parser: "12.5,30" -> {x, y}
  function parsePt(s) {
    if (typeof s === 'object' && s !== null) return { x: +s.x || 0, y: +s.y || 0 };
    if (typeof s !== 'string') throw new Error('invalid point: ' + s);
    const parts = s.split(/[, ]+/).filter(Boolean);
    if (parts.length < 2) throw new Error('invalid point: ' + s);
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  }

  function parseNum(s) {
    const n = parseFloat(s);
    if (isNaN(n)) throw new Error('invalid number: ' + s);
    return n;
  }

  function parseColor(s) {
    if (!s) return null;
    if (s.startsWith('#')) return s;
    const named = { red: '#ff0000', green: '#00aa00', blue: '#0044ff', yellow: '#ffd700', cyan: '#00cccc', magenta: '#cc00cc', white: '#ffffff', black: '#000000', gray: '#808080' };
    return named[s.toLowerCase()] || s;
  }

  // Distance helpers
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function angleBetween(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }

  // Rotate a point around origin by angle (radians)
  function rotatePt(p, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
  }
  // Rotate around arbitrary center
  function rotateAround(p, center, ang) {
    const d = { x: p.x - center.x, y: p.y - center.y };
    const r = rotatePt(d, ang);
    return { x: r.x + center.x, y: r.y + center.y };
  }

  // 线段求交（返回交点或 null）
  function segIntersect(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }

  // 无限直线求交（不考虑线段范围）
  function lineIntersect(p1, p2, p3, p4) {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }

  // 沿直线从 from 到 to，距离 d 的点
  function pointOnLineAtDist(from, to, d) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: from.x + dx / len * d, y: from.y + dy / len * d };
  }

  // Catmull-Rom 样条采样（统一张力，端点循环或夹紧）
  function catmullRom(points, closed, samplesPerSeg) {
    const pts = points.slice();
    const n = pts.length;
    if (n < 2) return pts;
    const result = [];
    const seg = samplesPerSeg || 16;
    const get = (i) => {
      if (closed) return pts[((i % n) + n) % n];
      if (i < 0) return pts[0];
      if (i >= n) return pts[n - 1];
      return pts[i];
    };
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      for (let t = 0; t < seg; t++) {
        const s = t / seg;
        const s2 = s * s, s3 = s2 * s;
        const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * s + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * s2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * s3);
        const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * s + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * s2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * s3);
        result.push({ x, y });
      }
    }
    if (closed) result.push({ x: pts[0].x, y: pts[0].y });
    else result.push({ x: pts[n - 1].x, y: pts[n - 1].y });
    return result;
  }

  // =========================================================================
  // 2. DOCUMENT MODEL
  // =========================================================================

  const Document = {
    objects: new Map(),    // id -> obj
    layers: [],            // [{ name, color, visible, locked }]
    currentLayer: null,
    view: { panX: 0, panY: 0, zoom: 1 },
    modified: false,
    filePath: null,       // 当前工程的保存路径（用于 Agent 自动保存与标题显示）
    // 撤销/重做历史栈
    _history: [],
    _redoStack: [],
    _maxHistory: 100,
    _suspendHistory: false,  // 临时挂起（undo/redo 自身执行时不再压栈）
    _blocks: new Map(),     // 命名块定义：name -> { name, base, objects }
    _snapEnabled: false,
    _snapModes: null,       // Set<string>

    init() {
      this.objects.clear();
      this.layers = [{ name: 'Layer0', color: '#4f8cff', visible: true, locked: false }];
      this.currentLayer = 'Layer0';
      this.view = { panX: 0, panY: 0, zoom: 1 };
      this.modified = false;
      this.filePath = null;
      this._history = [];
      this._redoStack = [];
      this._blocks = new Map();
      this._snapEnabled = false;
      this._snapModes = new Set(['endpoint', 'midpoint', 'center']);
    },

    // 深拷贝当前文档状态作为快照（用于 undo/redo）
    snapshot() {
      return {
        objects: Array.from(this.objects.values()).map(o => ({
          id: o.id, type: o.type, layer: o.layer,
          props: JSON.parse(JSON.stringify(o.props)),
          selected: !!o.selected
        })),
        layers: JSON.parse(JSON.stringify(this.layers)),
        currentLayer: this.currentLayer,
        view: Object.assign({}, this.view),
        blocks: Array.from(this._blocks.entries()).map(([name, b]) => ({
          name, base: Object.assign({}, b.base),
          objects: b.objects.map(o => ({ type: o.type, layer: o.layer, props: JSON.parse(JSON.stringify(o.props)) }))
        }))
      };
    },

    restoreSnapshot(snap) {
      this.objects.clear();
      let maxN = 0;
      for (const o of snap.objects) {
        this.objects.set(o.id, {
          id: o.id, type: o.type, layer: o.layer,
          props: JSON.parse(JSON.stringify(o.props)),
          selected: !!o.selected
        });
        const m = /(\d+)$/.exec(o.id);
        if (m) { const n = parseInt(m[1]); if (n > maxN) maxN = n; }
      }
      _idCounter = maxN + 1;
      this.layers = JSON.parse(JSON.stringify(snap.layers));
      this.currentLayer = snap.currentLayer;
      this.view = Object.assign({}, snap.view);
      this._blocks = new Map();
      if (snap.blocks) {
        for (const b of snap.blocks) {
          this._blocks.set(b.name, {
            name: b.name,
            base: Object.assign({}, b.base),
            objects: b.objects.map(o => ({ type: o.type, layer: o.layer, props: JSON.parse(JSON.stringify(o.props)) }))
          });
        }
      }
    },

    pushHistory() {
      if (this._suspendHistory) return;
      this._history.push(this.snapshot());
      if (this._history.length > this._maxHistory) this._history.shift();
      this._redoStack.length = 0;
    },

    undo() {
      if (this._history.length === 0) return false;
      this._suspendHistory = true;
      try {
        this._redoStack.push(this.snapshot());
        const snap = this._history.pop();
        this.restoreSnapshot(snap);
        this.modified = true;
      } finally {
        this._suspendHistory = false;
      }
      return true;
    },

    redo() {
      if (this._redoStack.length === 0) return false;
      this._suspendHistory = true;
      try {
        this._history.push(this.snapshot());
        const snap = this._redoStack.pop();
        this.restoreSnapshot(snap);
        this.modified = true;
      } finally {
        this._suspendHistory = false;
      }
      return true;
    },

    canUndo() { return this._history.length > 0; },
    canRedo() { return this._redoStack.length > 0; },

    addObject(type, props, layer) {
      const id = nextId();
      const obj = {
        id,
        type,
        layer: layer || this.currentLayer,
        props: Object.assign({}, props),
        selected: false
      };
      this.objects.set(id, obj);
      this.modified = true;
      return obj;
    },

    getObject(id) { return this.objects.get(id); },

    deleteObject(id) {
      const ok = this.objects.delete(id);
      if (ok) this.modified = true;
      return ok;
    },

    clear() {
      this.objects.clear();
      this.modified = true;
    },

    getLayer(name) { return this.layers.find(l => l.name === name); },

    addLayer(name, color) {
      if (this.layers.find(l => l.name === name)) return false;
      this.layers.push({ name, color: color || '#4f8cff', visible: true, locked: false });
      this.modified = true;
      return true;
    },

    deleteLayer(name) {
      if (name === 'Layer0') return false; // cannot delete default
      const idx = this.layers.findIndex(l => l.name === name);
      if (idx < 0) return false;
      // move objects on this layer to Layer0
      for (const obj of this.objects.values()) {
        if (obj.layer === name) obj.layer = 'Layer0';
      }
      this.layers.splice(idx, 1);
      if (this.currentLayer === name) this.currentLayer = 'Layer0';
      this.modified = true;
      return true;
    },

    setCurrentLayer(name) {
      if (!this.layers.find(l => l.name === name)) return false;
      this.currentLayer = name;
      return true;
    },

    setLayerVisible(name, visible) {
      const l = this.getLayer(name);
      if (!l) return false;
      l.visible = !!visible;
      this.modified = true;
      return true;
    },

    setLayerColor(name, color) {
      const l = this.getLayer(name);
      if (!l) return false;
      l.color = color;
      this.modified = true;
      return true;
    },

    getSelectedIds() {
      const ids = [];
      for (const obj of this.objects.values()) if (obj.selected) ids.push(obj.id);
      return ids;
    },

    selectAll() {
      for (const obj of this.objects.values()) {
        const l = this.getLayer(obj.layer);
        if (l && l.visible) obj.selected = true;
      }
    },

    clearSelection() {
      for (const obj of this.objects.values()) obj.selected = false;
    },

    selectById(id, additive) {
      const obj = this.objects.get(id);
      if (!obj) return false;
      if (!additive) this.clearSelection();
      obj.selected = true;
      return true;
    },

    // Serialize to plain object (for save / state queries)
    toJSON() {
      return {
        version: 2,
        objects: Array.from(this.objects.values()).map(o => ({
          id: o.id, type: o.type, layer: o.layer, props: o.props
        })),
        layers: this.layers.map(l => ({ name: l.name, color: l.color, visible: l.visible, locked: l.locked })),
        currentLayer: this.currentLayer,
        view: Object.assign({}, this.view),
        blocks: Array.from(this._blocks.entries()).map(([name, b]) => ({
          name, base: b.base,
          objects: b.objects.map(o => ({ type: o.type, layer: o.layer, props: o.props }))
        }))
      };
    },

    loadJSON(data) {
      // 兼容 version 1（无 blocks）和 version 2（含 blocks）
      if (!data || (data.version !== 1 && data.version !== 2)) throw new Error('invalid project file');
      this.objects.clear();
      this.layers = (data.layers || []).map(l => ({
        name: l.name, color: l.color || '#4f8cff', visible: l.visible !== false, locked: !!l.locked
      }));
      if (this.layers.length === 0) this.layers.push({ name: 'Layer0', color: '#4f8cff', visible: true, locked: false });
      this.currentLayer = data.currentLayer || 'Layer0';
      this.view = data.view || { panX: 0, panY: 0, zoom: 1 };
      let maxN = 0;
      for (const o of data.objects || []) {
        const obj = { id: o.id, type: o.type, layer: o.layer || this.currentLayer, props: o.props || {}, selected: false };
        this.objects.set(obj.id, obj);
        const m = /(\d+)$/.exec(o.id);
        if (m) { const n = parseInt(m[1]); if (n > maxN) maxN = n; }
      }
      _idCounter = maxN + 1;
      this._blocks = new Map();
      if (data.blocks) {
        for (const b of data.blocks) {
          this._blocks.set(b.name, {
            name: b.name,
            base: b.base || { x: 0, y: 0 },
            objects: (b.objects || []).map(o => ({ type: o.type, layer: o.layer, props: o.props }))
          });
        }
      }
      this.modified = false;
      this._history = [];
      this._redoStack = [];
    },

    // 克隆对象（深拷贝 props，新 id）
    cloneObject(obj) {
      const id = nextId();
      const clone = {
        id,
        type: obj.type,
        layer: obj.layer,
        props: JSON.parse(JSON.stringify(obj.props)),
        selected: false
      };
      this.objects.set(id, clone);
      this.modified = true;
      return clone;
    },

    // 按偏移克隆对象
    cloneOffset(obj, dx, dy) {
      const clone = this.cloneObject(obj);
      const p = clone.props;
      const sh = (pt) => { if (pt && typeof pt.x === 'number') { pt.x += dx; pt.y += dy; } };
      switch (clone.type) {
        case 'line': sh(p.start); sh(p.end); break;
        case 'polyline': case 'hatch': (p.points || []).forEach(sh); break;
        case 'rect': sh(p.corner1); sh(p.corner2); break;
        case 'circle': case 'arc': case 'ellipse': sh(p.center); break;
        case 'text': sh(p.position); break;
        case 'dim': sh(p.start); sh(p.end); if (p.projEnd) sh(p.projEnd); break;
        case 'dimradius': sh(p.center); sh(p.edgePoint); sh(p.leaderEnd); break;
        case 'dimdiameter': sh(p.center); sh(p.point1); sh(p.point2); if (p.leaderEnd) sh(p.leaderEnd); break;
        case 'dimangle': sh(p.vertex); sh(p.p1); sh(p.p2); break;
        case 'dimleader': sh(p.start); sh(p.end); break;
        case 'spline': case 'point': break;  // spline/point 的克隆无需偏移特殊处理（points 数组已深拷贝）
      }
      return clone;
    }
  };

  // =========================================================================
  // 3. RENDERER
  // =========================================================================

  const Renderer = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,
    GRID_MINOR: 10,
    GRID_MAJOR: 50,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
      this.width = r.width;
      this.height = r.height;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    },

    // World -> Screen
    w2s(p) {
      const cx = this.width / 2;
      const cy = this.height / 2;
      return {
        x: cx + (p.x + Document.view.panX) * Document.view.zoom,
        y: cy - (p.y + Document.view.panY) * Document.view.zoom  // flip Y
      };
    },
    // Screen -> World
    s2w(p) {
      const cx = this.width / 2;
      const cy = this.height / 2;
      return {
        x: (p.x - cx) / Document.view.zoom - Document.view.panX,
        y: -(p.y - cy) / Document.view.zoom - Document.view.panY
      };
    },

    render() {
      const ctx = this.ctx;
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--cad-canvas-bg').trim() || '#fff';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, this.width, this.height);
      this._drawGrid();
      this._drawAxes();
      this._drawObjects();
      this._drawSelection();
    },

    _drawGrid() {
      const ctx = this.ctx;
      const z = Document.view.zoom;
      // Choose grid spacing so that grid pixels spacing ~ 40-80
      let minor = this.GRID_MINOR;
      while (minor * z < 20) minor *= 5;
      while (minor * z > 80) minor /= 5;
      const major = minor * 5;

      // World bounds visible
      const tl = this.s2w({ x: 0, y: 0 });
      const br = this.s2w({ x: this.width, y: this.height });
      const minX = Math.floor(tl.x / minor) * minor;
      const maxX = Math.ceil(br.x / minor) * minor;
      const minY = Math.floor(br.y / minor) * minor;
      const maxY = Math.ceil(tl.y / minor) * minor;

      // Minor grid
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cad-grid-minor').trim() || '#eee';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = minX; x <= maxX; x += minor) {
        const p = this.w2s({ x, y: 0 });
        ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height);
      }
      for (let y = minY; y <= maxY; y += minor) {
        const p = this.w2s({ x: 0, y });
        ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y);
      }
      ctx.stroke();

      // Major grid
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cad-grid-major').trim() || '#ccc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const minXm = Math.floor(tl.x / major) * major;
      const maxXm = Math.ceil(br.x / major) * major;
      const minYm = Math.floor(br.y / major) * major;
      const maxYm = Math.ceil(tl.y / major) * major;
      for (let x = minXm; x <= maxXm; x += major) {
        const p = this.w2s({ x, y: 0 });
        ctx.moveTo(p.x, 0); ctx.lineTo(p.x, this.height);
      }
      for (let y = minYm; y <= maxYm; y += major) {
        const p = this.w2s({ x: 0, y });
        ctx.moveTo(0, p.y); ctx.lineTo(this.width, p.y);
      }
      ctx.stroke();
    },

    _drawAxes() {
      const ctx = this.ctx;
      const o = this.w2s({ x: 0, y: 0 });
      // X axis
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cad-axis-x').trim() || '#f55';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, o.y); ctx.lineTo(this.width, o.y);
      ctx.stroke();
      // Y axis
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--cad-axis-y').trim() || '#5c5';
      ctx.beginPath();
      ctx.moveTo(o.x, 0); ctx.lineTo(o.x, this.height);
      ctx.stroke();
    },

    _layerColor(obj) {
      const l = Document.getLayer(obj.layer);
      if (l && l.color) return l.color;
      return '#000';
    },

    _isLayerVisible(obj) {
      const l = Document.getLayer(obj.layer);
      return !l || l.visible;
    },

    _drawObjects() {
      const ctx = this.ctx;
      for (const obj of Document.objects.values()) {
        if (!this._isLayerVisible(obj)) continue;
        const color = this._layerColor(obj);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;
        this._drawOne(obj);
      }
    },

    _drawOne(obj) {
      const ctx = this.ctx;
      const p = obj.props;
      switch (obj.type) {
        case 'line': {
          const a = this.w2s(p.start), b = this.w2s(p.end);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          break;
        }
        case 'polyline': {
          if (!p.points || p.points.length < 2) break;
          ctx.beginPath();
          const first = this.w2s(p.points[0]);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < p.points.length; i++) {
            const pt = this.w2s(p.points[i]);
            ctx.lineTo(pt.x, pt.y);
          }
          if (p.closed) ctx.closePath();
          ctx.stroke();
          break;
        }
        case 'rect': {
          const a = this.w2s(p.corner1), b = this.w2s(p.corner2);
          ctx.beginPath();
          ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
          ctx.stroke();
          break;
        }
        case 'circle': {
          const c = this.w2s(p.center);
          const r = Math.max(0.5, p.radius * Document.view.zoom);
          ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
          break;
        }
        case 'arc': {
          const c = this.w2s(p.center);
          const r = Math.max(0.5, p.radius * Document.view.zoom);
          // In world coords, Y is up; on screen Y is down → flip angle direction
          const sa = -p.startAngle;
          const ea = -p.endAngle;
          ctx.beginPath();
          // Canvas arc draws clockwise in screen coords; world angles are CCW.
          ctx.arc(c.x, c.y, r, sa, ea, false);
          ctx.stroke();
          break;
        }
        case 'ellipse': {
          const c = this.w2s(p.center);
          const rx = Math.max(0.5, p.radiusX * Document.view.zoom);
          const ry = Math.max(0.5, p.radiusY * Document.view.zoom);
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(-(p.rotation || 0));
          ctx.beginPath();
          ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'text': {
          const a = this.w2s(p.position);
          ctx.save();
          ctx.translate(a.x, a.y);
          ctx.rotate(-(p.rotation || 0));
          ctx.font = `${Math.max(8, (p.height || 12) * Document.view.zoom)}px "Microsoft YaHei", sans-serif`;
          ctx.fillStyle = this._layerColor(obj);
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.text || '', 0, 0);
          ctx.restore();
          break;
        }
        case 'dim': {
          // Linear dimension. style: 'aligned'(默认,沿两点连线) | 'horizontal' | 'vertical'
          // horizontal: dim line 为水平线，b 投影到 a.y；vertical: dim line 为垂直线，b 投影到 a.x
          const style = p.style || 'aligned';
          let a, b;
          if (style === 'horizontal' && p.projEnd) {
            // 水平标注：dim line = 从 (a.x, a.y) 到 (b.x, a.y)
            const aStart = this.w2s(p.start);
            const bEnd = this.w2s(p.end);
            const projEndSc = this.w2s(p.projEnd);
            a = aStart;
            b = projEndSc;
            // 绘制投影线（虚线，从 bEnd 到 projEndSc）
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = this._layerColor(obj);
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(bEnd.x, bEnd.y); ctx.lineTo(projEndSc.x, projEndSc.y);
            ctx.stroke();
            ctx.restore();
          } else if (style === 'vertical' && p.projEnd) {
            const aStart = this.w2s(p.start);
            const bEnd = this.w2s(p.end);
            const projEndSc = this.w2s(p.projEnd);
            a = aStart;
            b = projEndSc;
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = this._layerColor(obj);
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(bEnd.x, bEnd.y); ctx.lineTo(projEndSc.x, projEndSc.y);
            ctx.stroke();
            ctx.restore();
          } else {
            a = this.w2s(p.start);
            b = this.w2s(p.end);
          }
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1) break;
          const nx = -dy / len, ny = dx / len;
          const offPx = (p.offset || 20);
          const a2 = { x: a.x + nx * offPx, y: a.y + ny * offPx };
          const b2 = { x: b.x + nx * offPx, y: b.y + ny * offPx };
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(a2.x, a2.y);
          ctx.moveTo(b.x, b.y); ctx.lineTo(b2.x, b2.y);
          ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y);
          ctx.stroke();
          ctx.fillStyle = this._layerColor(obj);
          this._arrow(a2, b2);
          this._arrow(b2, a2);
          let realLen;
          if (style === 'horizontal') realLen = Math.abs(p.end.x - p.start.x);
          else if (style === 'vertical') realLen = Math.abs(p.end.y - p.start.y);
          else realLen = dist(p.start, p.end);
          const txt = (p.prefix || '') + realLen.toFixed(2);
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, mid.x + nx * offPx, mid.y + ny * offPx - 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          break;
        }
        case 'dimradius': {
          // 半径标注：从圆边缘到引线末端 + 箭头 + 文本 'Rxx'
          const edge = this.w2s(p.edgePoint);
          const leader = this.w2s(p.leaderEnd);
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(edge.x, edge.y); ctx.lineTo(leader.x, leader.y);
          ctx.stroke();
          ctx.fillStyle = this._layerColor(obj);
          this._arrow(leader, edge);  // 箭头指向圆心方向
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.text || ('R' + (p.radius || 0).toFixed(2)), leader.x + 2, leader.y - 2);
          break;
        }
        case 'dimdiameter': {
          // 直径标注：从 p1 到 p2 (穿过圆心) + 引线 + 箭头 + 文本 'Øxx'
          const p1 = this.w2s(p.point1), p2 = this.w2s(p.point2);
          const leader = this.w2s(p.leaderEnd);
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
          ctx.moveTo(p1.x, p1.y); ctx.lineTo(leader.x, leader.y);
          ctx.stroke();
          ctx.fillStyle = this._layerColor(obj);
          this._arrow(p1, p2);  // 箭头从 p1 指向 p2
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.text || ('Ø' + (p.diameter || 0).toFixed(2)), leader.x + 2, leader.y - 2);
          break;
        }
        case 'dimangle': {
          // 角度标注：从 vertex 到 p1/p2 (缩短到 offset 长度) + 弧 + 文本 'xx°'
          const v = this.w2s(p.vertex);
          const p1End = this.w2s(p.p1);
          const p2End = this.w2s(p.p2);
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          // 在 vertex 周围画两条边（截到 offset 距离）
          const offset = p.offset || 20;
          // 简化：直接画 vertex -> p1, vertex -> p2
          ctx.beginPath();
          ctx.moveTo(v.x, v.y); ctx.lineTo(p1End.x, p1End.y);
          ctx.moveTo(v.x, v.y); ctx.lineTo(p2End.x, p2End.y);
          ctx.stroke();
          // 画弧（在屏幕空间，半径 offset）
          const startAng = p.startAngle || 0;
          const endAng = p.endAngle || 0;
          // 屏幕坐标 y 翻转，所以角度方向需取反
          ctx.beginPath();
          ctx.arc(v.x, v.y, offset, -startAng, -endAng, false);
          ctx.stroke();
          // 文本
          ctx.fillStyle = this._layerColor(obj);
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          // 文本位置：在弧的中点外
          const midAng = (startAng + endAng) / 2;
          const tx = v.x + (offset + 10) * Math.cos(midAng);
          const ty = v.y - (offset + 10) * Math.sin(midAng);  // y 翻转
          ctx.fillText(p.text || '', tx, ty);
          break;
        }
        case 'dimleader': {
          // 引线标注：start -> end + 箭头在 start + 文本在 end 附近
          const s = this.w2s(p.start);
          const e = this.w2s(p.end);
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y); ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.fillStyle = this._layerColor(obj);
          this._arrow(e, s);  // 箭头在 s 指向 s
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(p.text || '', e.x + 2, e.y - 2);
          break;
        }
        case 'hatch': {
          // 填充：根据 pattern 绘制多组平行线
          if (!p.points || p.points.length < 3) break;
          ctx.save();
          ctx.beginPath();
          const first = this.w2s(p.points[0]);
          ctx.moveTo(first.x, first.y);
          for (let i = 1; i < p.points.length; i++) {
            const pt = this.w2s(p.points[i]);
            ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.clip();
          ctx.strokeStyle = this._layerColor(obj);
          ctx.fillStyle = this._layerColor(obj);
          ctx.lineWidth = 0.8;
          // 使用图案库渲染（pattern 字段优先；如果未指定则用 angle/spacing 兼容旧数据）
          const patternName = p.pattern;
          if (patternName) {
            HatchPatterns.draw(ctx, p.points, patternName, (pt) => this.w2s(pt), Document.view.zoom);
          } else {
            // 旧数据：单方向 + spacing
            const ang = (p.angle != null ? p.angle : Math.PI / 4);
            const spacing = (p.spacing != null ? p.spacing : 5);
            const cosA = Math.cos(ang), sinA = Math.sin(ang);
            const spacingPx = spacing * Document.view.zoom;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const w of p.points) {
              const s = this.w2s(w);
              if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
              if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
            }
            const corners = [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
            const projections = corners.map(c => c.x * cosA + c.y * sinA);
            const pMin = Math.min(...projections), pMax = Math.max(...projections);
            ctx.beginPath();
            for (let pp = Math.floor(pMin / spacingPx) * spacingPx; pp <= pMax; pp += spacingPx) {
              const x1 = -sinA * 5000 + cosA * pp;
              const y1 = cosA * 5000 + sinA * pp;
              const x2 = sinA * 5000 + cosA * pp;
              const y2 = -cosA * 5000 + sinA * pp;
              ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
            }
            ctx.stroke();
          }
          ctx.restore();
          break;
        }
        case 'point': {
          // 绘制为小十字+圆点
          const a = this.w2s(p.position);
          const r = 3;
          ctx.beginPath(); ctx.arc(a.x, a.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath();
          ctx.moveTo(a.x - r * 2, a.y); ctx.lineTo(a.x + r * 2, a.y);
          ctx.moveTo(a.x, a.y - r * 2); ctx.lineTo(a.x, a.y + r * 2);
          ctx.stroke();
          break;
        }
      }
    },

    _arrow(from, to) {
      const ctx = this.ctx;
      const ang = Math.atan2(to.y - from.y, to.x - from.x);
      const size = 8;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - size * Math.cos(ang - Math.PI / 6), to.y - size * Math.sin(ang - Math.PI / 6));
      ctx.lineTo(to.x - size * Math.cos(ang + Math.PI / 6), to.y - size * Math.sin(ang + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    },

    _drawSelection() {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = '#ff9900';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      for (const obj of Document.objects.values()) {
        if (!obj.selected) continue;
        const bb = this._boundingBox(obj);
        if (!bb) continue;
        const a = this.w2s(bb.min), b = this.w2s(bb.max);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      }
      ctx.restore();
    },

    _boundingBox(obj) {
      const p = obj.props;
      let pts = [];
      switch (obj.type) {
        case 'line': pts = [p.start, p.end]; break;
        case 'polyline': pts = p.points ? p.points.slice() : []; break;
        case 'rect': pts = [p.corner1, p.corner2]; break;
        case 'circle': pts = [{ x: p.center.x - p.radius, y: p.center.y - p.radius }, { x: p.center.x + p.radius, y: p.center.y + p.radius }]; break;
        case 'arc': pts = [{ x: p.center.x - p.radius, y: p.center.y - p.radius }, { x: p.center.x + p.radius, y: p.center.y + p.radius }]; break;
        case 'ellipse': pts = [{ x: p.center.x - p.radiusX, y: p.center.y - p.radiusY }, { x: p.center.x + p.radiusX, y: p.center.y + p.radiusY }]; break;
        case 'text': pts = [{ x: p.position.x, y: p.position.y }, { x: p.position.x + (p.text || '').length * (p.height || 12) * 0.6, y: p.position.y + (p.height || 12) }]; break;
        case 'dim': pts = [p.start, p.end]; if (p.projEnd) pts.push(p.projEnd); break;
        case 'dimradius': pts = [p.center, p.edgePoint, p.leaderEnd].filter(Boolean); break;
        case 'dimdiameter': pts = [p.point1, p.point2, p.leaderEnd].filter(Boolean); break;
        case 'dimangle': pts = [p.vertex, p.p1, p.p2].filter(Boolean); break;
        case 'dimleader': pts = [p.start, p.end].filter(Boolean); break;
        case 'hatch': pts = p.points ? p.points.slice() : []; break;
        case 'point': pts = [{ x: p.position.x - 1, y: p.position.y - 1 }, { x: p.position.x + 1, y: p.position.y + 1 }]; break;
        case 'spline': pts = p.points ? p.points.slice() : []; break;
      }
      if (pts.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of pts) {
        if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
      }
      return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
    },

    // Fit all objects in view
    fit() {
      if (Document.objects.size === 0) {
        Document.view = { panX: 0, panY: 0, zoom: 1 };
        this.render();
        return;
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const obj of Document.objects.values()) {
        const bb = this._boundingBox(obj);
        if (!bb) continue;
        if (bb.min.x < minX) minX = bb.min.x;
        if (bb.min.y < minY) minY = bb.min.y;
        if (bb.max.x > maxX) maxX = bb.max.x;
        if (bb.max.y > maxY) maxY = bb.max.y;
      }
      if (!isFinite(minX)) return;
      const w = maxX - minX, h = maxY - minY;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const pad = 40;
      const zx = (this.width - pad * 2) / Math.max(1, w);
      const zy = (this.height - pad * 2) / Math.max(1, h);
      Document.view.zoom = Math.min(zx, zy, 100);
      Document.view.panX = -cx;
      Document.view.panY = -cy;
      this.render();
    },

    pan(dxScreen, dyScreen) {
      Document.view.panX += dxScreen / Document.view.zoom;
      Document.view.panY -= dyScreen / Document.view.zoom;
      this.render();
    },

    zoomAt(factor, screenCenter) {
      const before = this.s2w(screenCenter);
      Document.view.zoom = Math.max(0.001, Math.min(10000, Document.view.zoom * factor));
      const after = this.s2w(screenCenter);
      Document.view.panX += after.x - before.x;
      Document.view.panY += after.y - before.y;
      this.render();
    },

    // Render to offscreen at given size & export as data URL (PNG)
    exportPNG(width, height) {
      const off = document.createElement('canvas');
      off.width = width;
      off.height = height;
      const octx = off.getContext('2d');
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, width, height);
      // Temporarily swap context
      const savedCanvas = this.canvas, savedCtx = this.ctx, savedW = this.width, savedH = this.height;
      const savedView = Object.assign({}, Document.view);
      this.canvas = off; this.ctx = octx; this.width = width; this.height = height;
      // Fit content to image
      this.fit();
      // Grid is too noisy in export; just axes + objects
      // Re-render with light bg
      octx.fillStyle = '#ffffff';
      octx.fillRect(0, 0, width, height);
      this._drawObjects();
      // Restore
      this.canvas = savedCanvas; this.ctx = savedCtx; this.width = savedW; this.height = savedH;
      Document.view = savedView;
      this.render();
      return off.toDataURL('image/png');
    },

    // Export as SVG string
    exportSVG() {
      let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      // Compute bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const obj of Document.objects.values()) {
        const bb = this._boundingBox(obj);
        if (!bb) continue;
        if (bb.min.x < minX) minX = bb.min.x;
        if (bb.min.y < minY) minY = bb.min.y;
        if (bb.max.x > maxX) maxX = bb.max.x;
        if (bb.max.y > maxY) maxY = bb.max.y;
      }
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
      const pad = 10;
      const w = maxX - minX + pad * 2;
      const h = maxY - minY + pad * 2;
      // SVG y is flipped: top-left origin, y grows down
      svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - pad} ${-(maxY + pad)} ${w} ${h}" width="${w}" height="${h}">\n`;
      svg += `<rect x="${minX - pad}" y="${-(maxY + pad)}" width="${w}" height="${h}" fill="white"/>\n`;
      for (const obj of Document.objects.values()) {
        if (!this._isLayerVisible(obj)) continue;
        const color = this._layerColor(obj);
        const p = obj.props;
        switch (obj.type) {
          case 'line':
            svg += `<line x1="${p.start.x}" y1="${-p.start.y}" x2="${p.end.x}" y2="${-p.end.y}" stroke="${color}" stroke-width="1.5"/>\n`;
            break;
          case 'polyline': {
            if (!p.points || p.points.length < 2) break;
            const pts = p.points.map(pt => `${pt.x},${-pt.y}`).join(' ');
            svg += `<polyline points="${pts}" fill="${p.closed ? 'none' : 'none'}" stroke="${color}" stroke-width="1.5"${p.closed ? ' closed' : ''}/>\n`;
            break;
          }
          case 'rect':
            svg += `<rect x="${Math.min(p.corner1.x, p.corner2.x)}" y="${-Math.max(p.corner1.y, p.corner2.y)}" width="${Math.abs(p.corner2.x - p.corner1.x)}" height="${Math.abs(p.corner2.y - p.corner1.y)}" fill="none" stroke="${color}" stroke-width="1.5"/>\n`;
            break;
          case 'circle':
            svg += `<circle cx="${p.center.x}" cy="${-p.center.y}" r="${p.radius}" fill="none" stroke="${color}" stroke-width="1.5"/>\n`;
            break;
          case 'arc':
            svg += `<path d="M ${p.center.x + p.radius * Math.cos(p.startAngle)} ${-(p.center.y + p.radius * Math.sin(p.startAngle))} A ${p.radius} ${p.radius} 0 0 1 ${p.center.x + p.radius * Math.cos(p.endAngle)} ${-(p.center.y + p.radius * Math.sin(p.endAngle))}" fill="none" stroke="${color}" stroke-width="1.5"/>\n`;
            break;
          case 'ellipse':
            svg += `<ellipse cx="${p.center.x}" cy="${-p.center.y}" rx="${p.radiusX}" ry="${p.radiusY}" fill="none" stroke="${color}" stroke-width="1.5" transform="rotate(${-(p.rotation || 0) * 180 / Math.PI} ${p.center.x} ${-p.center.y})"/>\n`;
            break;
          case 'text':
            svg += `<text x="${p.position.x}" y="${-p.position.y}" font-family="Microsoft YaHei, sans-serif" font-size="${p.height || 12}" fill="${color}" transform="rotate(${-(p.rotation || 0) * 180 / Math.PI} ${p.position.x} ${-p.position.y})">${escapeXml(p.text || '')}</text>\n`;
            break;
          case 'hatch':
            if (p.points && p.points.length >= 3) {
              const pts = p.points.map(pt => `${pt.x},${-pt.y}`).join(' ');
              svg += `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="0.5"/>\n`;
            }
            break;
          case 'point':
            svg += `<circle cx="${p.position.x}" cy="${-p.position.y}" r="2" fill="${color}"/>\n`;
            svg += `<line x1="${p.position.x - 5}" y1="${-p.position.y}" x2="${p.position.x + 5}" y2="${-p.position.y}" stroke="${color}" stroke-width="1"/>\n`;
            svg += `<line x1="${p.position.x}" y1="${-(p.position.y - 5)}" x2="${p.position.x}" y2="${-(p.position.y + 5)}" stroke="${color}" stroke-width="1"/>\n`;
            break;
          case 'spline':
            if (p.points && p.points.length >= 2) {
              const pts = p.points.map(pt => `${pt.x},${-pt.y}`).join(' ');
              svg += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/>\n`;
            }
            break;
          case 'dim':
          case 'dimradius':
          case 'dimdiameter':
          case 'dimangle':
          case 'dimleader': {
            // 标注类导出为简单 LINE + TEXT 组合（基于 _boundingBox 反推近似）
            const bb = this._boundingBox(obj);
            if (bb) {
              svg += `<rect x="${bb.min.x}" y="${-bb.max.y}" width="${bb.max.x - bb.min.x}" height="${bb.max.y - bb.min.y}" fill="none" stroke="${color}" stroke-width="0.5" stroke-dasharray="2,2"/>\n`;
            }
            // 引线 + 文本
            if (obj.type === 'dim') {
              svg += `<line x1="${p.start.x}" y1="${-p.start.y}" x2="${p.end.x}" y2="${-p.end.y}" stroke="${color}" stroke-width="1"/>\n`;
              const mid = { x: (p.start.x + p.end.x) / 2, y: (p.start.y + p.end.y) / 2 };
              const realLen = dist(p.start, p.end);
              svg += `<text x="${mid.x}" y="${-mid.y}" font-family="Consolas, monospace" font-size="11" fill="${color}">${(p.prefix || '') + realLen.toFixed(2)}</text>\n`;
            } else if (obj.type === 'dimradius' || obj.type === 'dimdiameter' || obj.type === 'dimleader') {
              const s = p.edgePoint || p.point1 || p.start;
              const e = p.leaderEnd || p.end;
              if (s && e) {
                svg += `<line x1="${s.x}" y1="${-s.y}" x2="${e.x}" y2="${-e.y}" stroke="${color}" stroke-width="1"/>\n`;
              }
              if (e && p.text) {
                svg += `<text x="${e.x + 2}" y="${-e.y - 2}" font-family="Consolas, monospace" font-size="11" fill="${color}">${escapeXml(p.text)}</text>\n`;
              }
            } else if (obj.type === 'dimangle') {
              svg += `<line x1="${p.vertex.x}" y1="${-p.vertex.y}" x2="${p.p1.x}" y2="${-p.p1.y}" stroke="${color}" stroke-width="1"/>\n`;
              svg += `<line x1="${p.vertex.x}" y1="${-p.vertex.y}" x2="${p.p2.x}" y2="${-p.p2.y}" stroke="${color}" stroke-width="1"/>\n`;
              const midAng = ((p.startAngle || 0) + (p.endAngle || 0)) / 2;
              const off = p.offset || 20;
              const tx = p.vertex.x + (off + 10) * Math.cos(midAng);
              const ty = p.vertex.y + (off + 10) * Math.sin(midAng);
              if (p.text) {
                svg += `<text x="${tx}" y="${-ty}" font-family="Consolas, monospace" font-size="11" fill="${color}">${escapeXml(p.text)}</text>\n`;
              }
            }
            break;
          }
        }
      }
      svg += `</svg>`;
      return svg;
    }
  };

  function escapeXml(s) {
    return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  // =========================================================================
  // 4. DXF EXPORTER (R12 ASCII minimal)
  // =========================================================================

  const DXFColors = { '#ff0000': 1, '#00aa00': 3, '#0044ff': 5, '#ffd700': 2, '#00cccc': 4, '#cc00cc': 6, '#000000': 7, '#808080': 8, '#ffffff': 7 };

  function colorToDxf(hex) {
    if (!hex) return 7;
    if (DXFColors[hex.toLowerCase()]) return DXFColors[hex.toLowerCase()];
    // Hash-based fallback
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 1 + ((r + g + b) % 8);
  }

  function fnum(n) {
    // DXF requires max 16 significant digits, no scientific notation
    if (Math.abs(n) < 1e-12) return '0.0';
    return Number(n.toFixed(6)).toString();
  }

  function dxfPair(code, value) {
    return `${code}\n${value}\n`;
  }

  const DXFExporter = {
    export() {
      let out = '';
      // HEADER section (R2000 = AC1015)
      out += '0\nSECTION\n2\nHEADER\n';
      out += dxfPair(9, '$ACADVER');
      out += dxfPair(1, 'AC1015'); // R2000
      out += dxfPair(9, '$INSBASE');
      out += dxfPair(10, '0.0');
      out += dxfPair(20, '0.0');
      out += dxfPair(30, '0.0');
      out += dxfPair(9, '$EXTMIN');
      out += dxfPair(10, '0.0'); out += dxfPair(20, '0.0'); out += dxfPair(30, '0.0');
      out += dxfPair(9, '$EXTMAX');
      out += dxfPair(10, '0.0'); out += dxfPair(20, '0.0'); out += dxfPair(30, '0.0');
      out += dxfPair(9, '$LIMMIN');
      out += dxfPair(10, '0.0'); out += dxfPair(20, '0.0');
      out += dxfPair(9, '$LIMMAX');
      out += dxfPair(10, '100.0'); out += dxfPair(20, '100.0');
      out += dxfPair(9, '$MEASUREMENT');
      out += dxfPair(70, '1'); // 1 = metric
      out += '0\nENDSEC\n';

      // TABLES section (layers)
      out += '0\nSECTION\n2\nTABLES\n';
      out += '0\nTABLE\n2\nLAYER\n';
      out += dxfPair(70, Document.layers.length.toString());
      for (const l of Document.layers) {
        out += '0\nLAYER\n';
        out += dxfPair(2, l.name);
        out += dxfPair(70, '0'); // flags
        out += dxfPair(62, colorToDxf(l.color).toString());
        out += dxfPair(6, 'CONTINUOUS');
      }
      out += '0\nENDTAB\n';
      out += '0\nENDSEC\n';

      // BLOCKS section（导出命名块定义，便于在 AutoCAD 中复用）
      if (Document._blocks && Document._blocks.size > 0) {
        out += '0\nSECTION\n2\nBLOCKS\n';
        for (const block of Document._blocks.values()) {
          out += '0\nBLOCK\n';
          out += dxfPair(8, '0');
          out += dxfPair(2, block.name);
          out += dxfPair(70, '0'); // flags
          out += dxfPair(10, fnum(block.base.x));
          out += dxfPair(20, fnum(block.base.y));
          out += dxfPair(30, '0.0');
          out += dxfPair(3, block.name);
          out += dxfPair(1, '');
          // 块内的实体（相对于 base 的坐标）
          for (const bo of block.objects) {
            const bp = bo.props;
            switch (bo.type) {
              case 'line':
                out += '0\nLINE\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(10, fnum(bp.start.x));
                out += dxfPair(20, fnum(bp.start.y));
                out += dxfPair(30, '0.0');
                out += dxfPair(11, fnum(bp.end.x));
                out += dxfPair(21, fnum(bp.end.y));
                out += dxfPair(31, '0.0');
                break;
              case 'circle':
                out += '0\nCIRCLE\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(10, fnum(bp.center.x));
                out += dxfPair(20, fnum(bp.center.y));
                out += dxfPair(30, '0.0');
                out += dxfPair(40, fnum(bp.radius));
                break;
              case 'arc':
                out += '0\nARC\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(10, fnum(bp.center.x));
                out += dxfPair(20, fnum(bp.center.y));
                out += dxfPair(30, '0.0');
                out += dxfPair(40, fnum(bp.radius));
                out += dxfPair(50, fnum(bp.startAngle * 180 / Math.PI));
                out += dxfPair(51, fnum(bp.endAngle * 180 / Math.PI));
                break;
              case 'text':
                out += '0\nTEXT\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(10, fnum(bp.position.x));
                out += dxfPair(20, fnum(bp.position.y));
                out += dxfPair(30, '0.0');
                out += dxfPair(40, fnum(bp.height || 12));
                out += dxfPair(1, String(bp.text || ''));
                break;
              case 'polyline':
                out += '0\nPOLYLINE\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(66, '1');
                out += dxfPair(70, bp.closed ? '1' : '0');
                for (const pt of bp.points || []) {
                  out += '0\nVERTEX\n';
                  out += dxfPair(8, bo.layer || '0');
                  out += dxfPair(10, fnum(pt.x));
                  out += dxfPair(20, fnum(pt.y));
                  out += dxfPair(30, '0.0');
                }
                out += '0\nSEQEND\n';
                break;
              case 'point':
                out += '0\nPOINT\n';
                out += dxfPair(8, bo.layer || '0');
                out += dxfPair(10, fnum(bp.position.x));
                out += dxfPair(20, fnum(bp.position.y));
                out += dxfPair(30, '0.0');
                break;
            }
          }
          out += '0\nENDBLK\n';
          out += dxfPair(8, '0');
        }
        out += '0\nENDSEC\n';
      }

      // ENTITIES section
      out += '0\nSECTION\n2\nENTITIES\n';
      for (const obj of Document.objects.values()) {
        const l = Document.getLayer(obj.layer);
        const color = l ? colorToDxf(l.color) : 7;
        const lname = obj.layer;
        const p = obj.props;
        switch (obj.type) {
          case 'line':
            out += '0\nLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.start.x));
            out += dxfPair(20, fnum(p.start.y));
            out += dxfPair(30, '0.0');
            out += dxfPair(11, fnum(p.end.x));
            out += dxfPair(21, fnum(p.end.y));
            out += dxfPair(31, '0.0');
            break;
          case 'polyline':
            // Use old-style POLYLINE for compatibility
            out += '0\nPOLYLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(66, '1'); // vertices follow
            out += dxfPair(70, p.closed ? '1' : '0');
            for (const pt of p.points || []) {
              out += '0\nVERTEX\n';
              out += dxfPair(8, lname);
              out += dxfPair(10, fnum(pt.x));
              out += dxfPair(20, fnum(pt.y));
              out += dxfPair(30, '0.0');
            }
            out += '0\nSEQEND\n';
            break;
          case 'rect': {
            // 4 lines
            const a = p.corner1, b = p.corner2;
            const corners = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
            out += '0\nPOLYLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(66, '1');
            out += dxfPair(70, '1'); // closed
            for (const c of corners) {
              out += '0\nVERTEX\n';
              out += dxfPair(8, lname);
              out += dxfPair(10, fnum(c.x));
              out += dxfPair(20, fnum(c.y));
              out += dxfPair(30, '0.0');
            }
            out += '0\nSEQEND\n';
            break;
          }
          case 'circle':
            out += '0\nCIRCLE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.center.x));
            out += dxfPair(20, fnum(p.center.y));
            out += dxfPair(30, '0.0');
            out += dxfPair(40, fnum(p.radius));
            break;
          case 'arc': {
            // DXF arc: startAngle, endAngle in degrees, CCW
            out += '0\nARC\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.center.x));
            out += dxfPair(20, fnum(p.center.y));
            out += dxfPair(30, '0.0');
            out += dxfPair(40, fnum(p.radius));
            out += dxfPair(50, fnum(p.startAngle * 180 / Math.PI));
            out += dxfPair(51, fnum(p.endAngle * 180 / Math.PI));
            break;
          }
          case 'ellipse':
            // Approximate with 4 arcs (full ellipse)
            // DXF true ELLIPSE entity needs major/minor ratio (not in R12)
            // Fallback: 4 quarter arcs
            for (let q = 0; q < 4; q++) {
              const sa = q * Math.PI / 2;
              const ea = (q + 1) * Math.PI / 2;
              // Compute arc start/end points
              const r = (p.radiusX + p.radiusY) / 2;
              out += '0\nARC\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(p.center.x));
              out += dxfPair(20, fnum(p.center.y));
              out += dxfPair(30, '0.0');
              out += dxfPair(40, fnum(r));
              out += dxfPair(50, fnum(sa * 180 / Math.PI));
              out += dxfPair(51, fnum(ea * 180 / Math.PI));
            }
            break;
          case 'text':
            out += '0\nTEXT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.position.x));
            out += dxfPair(20, fnum(p.position.y));
            out += dxfPair(30, '0.0');
            out += dxfPair(40, fnum(p.height || 12));
            out += dxfPair(1, String(p.text || ''));
            out += dxfPair(50, fnum(((p.rotation || 0) * 180 / Math.PI)));
            break;
          case 'dim':
            // 导出为 LINE(标注线) + 可能的投影虚线 + TEXT
            {
              const a = p.start, b = p.end;
              const style = p.style || 'aligned';
              let dimB = b;
              let realLen;
              if (style === 'horizontal' && p.projEnd) {
                dimB = p.projEnd;
                realLen = Math.abs(b.x - a.x);
                // 投影虚线（导出为虚线直线 - 简化用 LINE）
                out += '0\nLINE\n';
                out += dxfPair(8, lname);
                out += dxfPair(62, color.toString());
                out += dxfPair(10, fnum(b.x)); out += dxfPair(20, fnum(b.y)); out += dxfPair(30, '0.0');
                out += dxfPair(11, fnum(p.projEnd.x)); out += dxfPair(21, fnum(p.projEnd.y)); out += dxfPair(31, '0.0');
              } else if (style === 'vertical' && p.projEnd) {
                dimB = p.projEnd;
                realLen = Math.abs(b.y - a.y);
                out += '0\nLINE\n';
                out += dxfPair(8, lname);
                out += dxfPair(62, color.toString());
                out += dxfPair(10, fnum(b.x)); out += dxfPair(20, fnum(b.y)); out += dxfPair(30, '0.0');
                out += dxfPair(11, fnum(p.projEnd.x)); out += dxfPair(21, fnum(p.projEnd.y)); out += dxfPair(31, '0.0');
              } else {
                realLen = dist(a, b);
              }
              const mid = { x: (a.x + dimB.x) / 2, y: (a.y + dimB.y) / 2 };
              out += '0\nLINE\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(a.x)); out += dxfPair(20, fnum(a.y)); out += dxfPair(30, '0.0');
              out += dxfPair(11, fnum(dimB.x)); out += dxfPair(21, fnum(dimB.y)); out += dxfPair(31, '0.0');
              out += '0\nTEXT\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(mid.x)); out += dxfPair(20, fnum(mid.y)); out += dxfPair(30, '0.0');
              out += dxfPair(40, '10');
              out += dxfPair(1, (p.prefix || '') + realLen.toFixed(2));
              out += dxfPair(50, '0');
            }
            break;
          case 'dimradius': {
            // 导出为 LINE(引线) + TEXT
            const e = p.edgePoint, l = p.leaderEnd;
            out += '0\nLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(e.x)); out += dxfPair(20, fnum(e.y)); out += dxfPair(30, '0.0');
            out += dxfPair(11, fnum(l.x)); out += dxfPair(21, fnum(l.y)); out += dxfPair(31, '0.0');
            out += '0\nTEXT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(l.x)); out += dxfPair(20, fnum(l.y)); out += dxfPair(30, '0.0');
            out += dxfPair(40, '10');
            out += dxfPair(1, String(p.text || ''));
            out += dxfPair(50, '0');
            break;
          }
          case 'dimdiameter': {
            // 导出为 LINE(直径) + LINE(引线) + TEXT
            const p1 = p.point1, p2 = p.point2, l = p.leaderEnd || p.point1;
            out += '0\nLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p1.x)); out += dxfPair(20, fnum(p1.y)); out += dxfPair(30, '0.0');
            out += dxfPair(11, fnum(p2.x)); out += dxfPair(21, fnum(p2.y)); out += dxfPair(31, '0.0');
            out += '0\nLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p1.x)); out += dxfPair(20, fnum(p1.y)); out += dxfPair(30, '0.0');
            out += dxfPair(11, fnum(l.x)); out += dxfPair(21, fnum(l.y)); out += dxfPair(31, '0.0');
            out += '0\nTEXT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(l.x)); out += dxfPair(20, fnum(l.y)); out += dxfPair(30, '0.0');
            out += dxfPair(40, '10');
            out += dxfPair(1, String(p.text || ''));
            out += dxfPair(50, '0');
            break;
          }
          case 'dimangle': {
            // 导出为 LINE×2(两条边) + TEXT(角度值)
            const v = p.vertex;
            for (const pt of [p.p1, p.p2]) {
              out += '0\nLINE\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(v.x)); out += dxfPair(20, fnum(v.y)); out += dxfPair(30, '0.0');
              out += dxfPair(11, fnum(pt.x)); out += dxfPair(21, fnum(pt.y)); out += dxfPair(31, '0.0');
            }
            // 角度中点（在 offset 距离上）
            const midAng = ((p.startAngle || 0) + (p.endAngle || 0)) / 2;
            const off = p.offset || 20;
            const tx = v.x + (off + 10) * Math.cos(midAng);
            const ty = v.y + (off + 10) * Math.sin(midAng);
            out += '0\nTEXT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(tx)); out += dxfPair(20, fnum(ty)); out += dxfPair(30, '0.0');
            out += dxfPair(40, '10');
            out += dxfPair(1, String(p.text || ''));
            out += dxfPair(50, '0');
            break;
          }
          case 'dimleader': {
            // 导出为 LINE(引线) + TEXT
            out += '0\nLINE\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.start.x)); out += dxfPair(20, fnum(p.start.y)); out += dxfPair(30, '0.0');
            out += dxfPair(11, fnum(p.end.x)); out += dxfPair(21, fnum(p.end.y)); out += dxfPair(31, '0.0');
            out += '0\nTEXT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.end.x)); out += dxfPair(20, fnum(p.end.y)); out += dxfPair(30, '0.0');
            out += dxfPair(40, '10');
            out += dxfPair(1, String(p.text || ''));
            out += dxfPair(50, '0');
            break;
          }
          case 'hatch':
            // Export as a closed polyline + many short hatch lines (approx)
            if (p.points && p.points.length >= 3) {
              out += '0\nPOLYLINE\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(66, '1');
              out += dxfPair(70, '1');
              for (const pt of p.points) {
                out += '0\nVERTEX\n';
                out += dxfPair(8, lname);
                out += dxfPair(10, fnum(pt.x));
                out += dxfPair(20, fnum(pt.y));
                out += dxfPair(30, '0.0');
              }
              out += '0\nSEQEND\n';
            }
            break;
          case 'point':
            out += '0\nPOINT\n';
            out += dxfPair(8, lname);
            out += dxfPair(62, color.toString());
            out += dxfPair(10, fnum(p.position.x));
            out += dxfPair(20, fnum(p.position.y));
            out += dxfPair(30, '0.0');
            break;
          case 'spline':
            // spline 实际存为 polyline（带 controlPoints）
            if (p.points && p.points.length >= 2) {
              out += '0\nPOLYLINE\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(66, '1');
              out += dxfPair(70, p.closed ? '1' : '0');
              for (const pt of p.points) {
                out += '0\nVERTEX\n';
                out += dxfPair(8, lname);
                out += dxfPair(10, fnum(pt.x));
                out += dxfPair(20, fnum(pt.y));
                out += dxfPair(30, '0.0');
              }
              out += '0\nSEQEND\n';
            }
            break;
        }
      }
      out += '0\nENDSEC\n';
      out += '0\nEOF\n';
      return out;
    }
  };

  // =========================================================================
  // 4b. DXF IMPORTER (R12/R2000 ASCII, basic entities)
  //   解析 DXF 文本，输出 { objects: [{type, props, layer}], layers: [{name,color}] }
  //   支持: LINE / CIRCLE / ARC / ELLIPSE / POINT / TEXT /
  //         POLYLINE+VERTEX+SEQEND / LWPOLYLINE / HATCH(边界→polyline) /
  //         DIMENSION(降级为 dim/leader 近似) / INSERT(块引用→展开为对象)
  //   支持 BLOCKS section（命名块定义）
  // =========================================================================

  // ACI 颜色 → hex（覆盖常用颜色，未列出的回退到灰阶）
  const ACI_TO_HEX = {
    1: '#ff0000', 2: '#ffff00', 3: '#00aa00', 4: '#00cccc', 5: '#0044ff',
    6: '#cc00cc', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0',
    10: '#ff0000', 11: '#ffaaaa', 12: '#bd0000', 13: '#bd7e7e',
    14: '#bd0000', 15: '#bd7e7e', 16: '#bd0000', 17: '#bd7e7e',
    20: '#ff0000', 30: '#ff7f00', 40: '#ffff00', 50: '#00ff00',
    60: '#00ffff', 70: '#0000ff', 80: '#ff00ff', 90: '#808080',
    140: '#ff0000', 141: '#ff8080', 142: '#ffa080', 143: '#ffc080',
    144: '#ffe080', 145: '#ffff80', 146: '#e0ff80', 147: '#c0ff80',
    148: '#a0ff80', 149: '#80ff80', 150: '#80ffa0', 151: '#80ffc0',
    152: '#80ffe0', 153: '#80ffff', 154: '#80e0ff', 155: '#80c0ff',
    156: '#80a0ff', 157: '#8080ff', 158: '#a080ff', 159: '#c080ff',
    160: '#ff80ff', 161: '#ff80c0', 162: '#ff80a0', 163: '#ff8080',
    200: '#404040', 201: '#804040', 202: '#a04040', 203: '#c04040',
    204: '#e04040', 205: '#ff4040', 220: '#404080', 221: '#4040a0'
  };
  function dxfToColor(aci) {
    if (aci == null) return '#4f8cff';
    if (ACI_TO_HEX[aci]) return ACI_TO_HEX[aci];
    // 通用回退: 用 hue 循环
    const h = (aci * 37) % 360;
    return hslToHex(h, 65, 50);
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return '#' + toHex(f(0)) + toHex(f(8)) + toHex(f(4));
  }

  const DXFImporter = {
    import(text) {
      const result = { objects: [], layers: [], blocks: new Map() };
      // 切分为 code/value 对（按行成对）
      const lines = String(text).split(/\r?\n/);
      const pairs = [];
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = parseInt(lines[i].trim(), 10);
        if (isNaN(code)) { i -= 1; continue; }  // 跳过空行/注释
        const value = lines[i + 1];
        pairs.push({ code, value: value !== undefined ? value.trim() : '' });
      }

      // 状态机遍历 sections
      let i = 0;
      const sectionTypeStack = [];
      while (i < pairs.length) {
        const p = pairs[i];
        if (p.code === 0 && p.value === 'SECTION') {
          const next = pairs[i + 1];
          if (next && next.code === 2) {
            const secName = next.value;
            i += 2;
            const secEnd = this._findSectionEnd(pairs, i);
            if (secName === 'TABLES') this._parseTables(pairs, i, secEnd, result);
            else if (secName === 'BLOCKS') this._parseBlocks(pairs, i, secEnd, result);
            else if (secName === 'ENTITIES') this._parseEntities(pairs, i, secEnd, result);
            i = secEnd;
            continue;
          }
        }
        i++;
      }
      return result;
    },

    _findSectionEnd(pairs, start) {
      for (let j = start; j < pairs.length; j++) {
        if (pairs[j].code === 0 && pairs[j].value === 'ENDSEC') return j + 1;
      }
      return pairs.length;
    },

    // ---- TABLES: 仅解析 LAYER 表 ----
    _parseTables(pairs, start, end, result) {
      let i = start;
      while (i < end) {
        const p = pairs[i];
        if (p.code === 0 && p.value === 'TABLE') {
          const next = pairs[i + 1];
          if (next && next.code === 2 && next.value === 'LAYER') {
            i += 2;
            i = this._parseLayerTable(pairs, i, end, result);
            continue;
          }
        }
        i++;
      }
    },

    _parseLayerTable(pairs, start, end, result) {
      let i = start;
      while (i < end) {
        const p = pairs[i];
        if (p.code === 0 && (p.value === 'ENDTAB' || p.value === 'ENDSEC')) return i + 1;
        if (p.code === 0 && p.value === 'LAYER') {
          i++;
          const layer = { name: 'Layer0', color: '#4f8cff' };
          while (i < end) {
            const pp = pairs[i];
            if (pp.code === 0) break;  // 下一个实体
            if (pp.code === 2) layer.name = pp.value;
            else if (pp.code === 62) layer.color = dxfToColor(parseInt(pp.value, 10));
            i++;
          }
          result.layers.push(layer);
          continue;
        }
        i++;
      }
      return i;
    },

    // ---- BLOCKS: 解析命名块定义 ----
    _parseBlocks(pairs, start, end, result) {
      let i = start;
      while (i < end) {
        const p = pairs[i];
        if (p.code === 0 && p.value === 'BLOCK') {
          i++;
          const block = { name: '', base: { x: 0, y: 0 }, objects: [] };
          while (i < end) {
            const pp = pairs[i];
            if (pp.code === 0 && pp.value === 'ENDBLK') { i++; break; }
            if (pp.code === 2) block.name = pp.value;
            else if (pp.code === 10) block.base.x = parseFloat(pp.value) || 0;
            else if (pp.code === 20) block.base.y = parseFloat(pp.value) || 0;
            else if (pp.code === 0) {
              // 一个实体的开始：把它和后续成对解析
              const ent = this._parseOneEntity(pairs, i, end);
              if (ent) {
                block.objects.push(ent.obj);
                i = ent.next;
                continue;
              }
            }
            i++;
          }
          if (block.name) result.blocks.set(block.name, block);
          continue;
        }
        i++;
      }
    },

    // ---- ENTITIES: 解析所有实体 ----
    _parseEntities(pairs, start, end, result) {
      let i = start;
      while (i < end) {
        const p = pairs[i];
        if (p.code === 0) {
          // INSERT 块引用需要展开
          if (p.value === 'INSERT') {
            const ent = this._parseInsert(pairs, i + 1, end, result);
            if (ent) { result.objects.push(...ent.objects); i = ent.next; continue; }
            i++; continue;
          }
          // SEQEND: 单独作为标记推送（POLYLINE/VERTEX 序列的结束）
          if (p.value === 'SEQEND') {
            result.objects.push({ type: 'SEQEND', layer: '', props: {} });
            i++;
            // 跳过 SEQEND 后的字段直到下一个 code 0
            while (i < end && pairs[i].code !== 0) i++;
            continue;
          }
          const ent = this._parseOneEntity(pairs, i, end);
          if (ent) { result.objects.push(ent.obj); i = ent.next; continue; }
        }
        i++;
      }
      // 后处理：合并 POLYLINE/VERTEX/SEQEND 序列
      _postProcessDxfImport(result);
    },

    // 解析单个实体（基于 code 0 起始）。返回 { obj, next } 或 null
    _parseOneEntity(pairs, start, end) {
      const type = pairs[start].value;
      const handler = this._entityHandlers[type];
      if (!handler) return null;
      // 收集此实体的所有 code/value 对，直到下一个 code 0
      let i = start + 1;
      const fields = {};  // code -> value (单一值)
      const multiFields = {};  // code -> [values] (重复出现，例如 LWPOLYLINE 的 10/20)
      while (i < end) {
        const pp = pairs[i];
        if (pp.code === 0) break;
        if (multiFields[pp.code]) multiFields[pp.code].push(pp.value);
        else if (fields[pp.code] !== undefined) {
          multiFields[pp.code] = [fields[pp.code], pp.value];
          delete fields[pp.code];
        } else {
          fields[pp.code] = pp.value;
        }
        i++;
      }
      const ctx = { fields, multiFields, type };
      const obj = handler.call(this, ctx);
      if (!obj) return null;
      return { obj, next: i };
    },

    _entityHandlers: {
      LINE(ctx) {
        const x1 = parseFloat(ctx.fields[10]), y1 = parseFloat(ctx.fields[20]);
        const x2 = parseFloat(ctx.fields[11]), y2 = parseFloat(ctx.fields[21]);
        if ([x1, y1, x2, y2].some(v => isNaN(v))) return null;
        return {
          type: 'line', layer: ctx.fields[8] || 'Layer0',
          props: { start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
        };
      },
      CIRCLE(ctx) {
        const cx = parseFloat(ctx.fields[10]), cy = parseFloat(ctx.fields[20]);
        const r = parseFloat(ctx.fields[40]);
        if ([cx, cy, r].some(v => isNaN(v))) return null;
        return {
          type: 'circle', layer: ctx.fields[8] || 'Layer0',
          props: { center: { x: cx, y: cy }, radius: r }
        };
      },
      ARC(ctx) {
        const cx = parseFloat(ctx.fields[10]), cy = parseFloat(ctx.fields[20]);
        const r = parseFloat(ctx.fields[40]);
        const sa = parseFloat(ctx.fields[50]), ea = parseFloat(ctx.fields[51]);
        if ([cx, cy, r, sa, ea].some(v => isNaN(v))) return null;
        return {
          type: 'arc', layer: ctx.fields[8] || 'Layer0',
          props: {
            center: { x: cx, y: cy }, radius: r,
            startAngle: sa * Math.PI / 180,
            endAngle: ea * Math.PI / 180
          }
        };
      },
      ELLIPSE(ctx) {
        const cx = parseFloat(ctx.fields[10]), cy = parseFloat(ctx.fields[20]);
        const mx = parseFloat(ctx.fields[11]), my = parseFloat(ctx.fields[21]);
        const ratio = parseFloat(ctx.fields[40]);
        if ([cx, cy, mx, my, ratio].some(v => isNaN(v))) return null;
        const majorLen = Math.hypot(mx, my);
        const rot = Math.atan2(my, mx);
        return {
          type: 'ellipse', layer: ctx.fields[8] || 'Layer0',
          props: {
            center: { x: cx, y: cy },
            radiusX: majorLen,
            radiusY: majorLen * Math.abs(ratio),
            rotation: rot
          }
        };
      },
      POINT(ctx) {
        const x = parseFloat(ctx.fields[10]), y = parseFloat(ctx.fields[20]);
        if (isNaN(x) || isNaN(y)) return null;
        return {
          type: 'point', layer: ctx.fields[8] || 'Layer0',
          props: { position: { x, y } }
        };
      },
      TEXT(ctx) {
        const x = parseFloat(ctx.fields[10]), y = parseFloat(ctx.fields[20]);
        const h = parseFloat(ctx.fields[40]);
        const txt = ctx.fields[1] || '';
        const rotDeg = parseFloat(ctx.fields[50]) || 0;
        if (isNaN(x) || isNaN(y)) return null;
        return {
          type: 'text', layer: ctx.fields[8] || 'Layer0',
          props: { position: { x, y }, height: isNaN(h) ? 12 : h, text: txt, rotation: rotDeg * Math.PI / 180 }
        };
      },
      MTEXT(ctx) {
        // 简化：与 TEXT 同处理，但 1 可能多次出现需要拼接
        const x = parseFloat(ctx.fields[10]), y = parseFloat(ctx.fields[20]);
        const h = parseFloat(ctx.fields[40]);
        let txt = ctx.fields[1] || '';
        if (ctx.multiFields[1]) txt = ctx.multiFields[1].join('');
        // 去除格式控制符 \P 换行等
        txt = txt.replace(/\\P/g, '\n').replace(/\\[A-Za-z];/g, '').replace(/[{}]/g, '');
        const rotDeg = parseFloat(ctx.fields[50]) || 0;
        if (isNaN(x) || isNaN(y)) return null;
        return {
          type: 'text', layer: ctx.fields[8] || 'Layer0',
          props: { position: { x, y }, height: isNaN(h) ? 12 : h, text: txt, rotation: rotDeg * Math.PI / 180 }
        };
      },
      LWPOLYLINE(ctx) {
        const xs = (ctx.multiFields[10] || []).map(parseFloat);
        const ys = (ctx.multiFields[20] || []).map(parseFloat);
        if (xs.length < 2 || xs.length !== ys.length) return null;
        const flags = parseInt(ctx.fields[70] || '0', 10);
        const closed = (flags & 1) === 1;
        const points = [];
        for (let i = 0; i < xs.length; i++) {
          if (!isNaN(xs[i]) && !isNaN(ys[i])) points.push({ x: xs[i], y: ys[i] });
        }
        if (points.length < 2) return null;
        return {
          type: 'polyline', layer: ctx.fields[8] || 'Layer0',
          props: { points, closed }
        };
      },
      POLYLINE(ctx) {
        // POLYLINE/VERTEX/SEQEND 结构：本对象本身只有 flags，顶点在后续 VERTEX 中
        // 由 _parseEntities 在收集完顶点后处理；这里只返回占位
        const flags = parseInt(ctx.fields[70] || '0', 10);
        return {
          type: '__polyline_header__', layer: ctx.fields[8] || 'Layer0',
          props: { closed: (flags & 1) === 1, _vertices: [] }
        };
      },
      VERTEX(ctx) {
        const x = parseFloat(ctx.fields[10]), y = parseFloat(ctx.fields[20]);
        if (isNaN(x) || isNaN(y)) return null;
        return {
          type: '__vertex__', layer: ctx.fields[8] || 'Layer0',
          props: { x, y }
        };
      },
      HATCH(ctx) {
        // 简化: HATCH 边界路径作为闭合 polyline 导入
        // 仅支持 boundary path type=2 (polyline) 的简化处理
        // 完整 HATCH 解析复杂，这里只取 pattern name 和第一个边界路径点列表
        const patternName = ctx.fields[2] || 'ANSI31';
        // 不在此处理边界点，留给后续增强
        return {
          type: '__hatch_placeholder__', layer: ctx.fields[8] || 'Layer0',
          props: { patternName, _points: [] }
        };
      },
      DIMENSION(ctx) {
        // 简化: 把 DIMENSION 降级为 TEXT (显示其文本)
        const x = parseFloat(ctx.fields[11]), y = parseFloat(ctx.fields[21]);
        const txt = ctx.fields[1] || '';
        if (isNaN(x) || isNaN(y)) return null;
        return {
          type: 'text', layer: ctx.fields[8] || 'Layer0',
          props: { position: { x, y }, height: 10, text: txt || '<dim>', rotation: 0 }
        };
      }
    },

    // 解析 INSERT 块引用并展开为对象列表
    _parseInsert(pairs, start, end, result) {
      const fields = {};
      let i = start;
      while (i < end) {
        const pp = pairs[i];
        if (pp.code === 0) break;
        fields[pp.code] = pp.value;
        i++;
      }
      const blockName = fields[2];
      const block = result.blocks.get(blockName);
      if (!block) return { objects: [], next: i };
      const ix = parseFloat(fields[10]) || 0;
      const iy = parseFloat(fields[20]) || 0;
      const scale = parseFloat(fields[41]) || 1;
      const sy = parseFloat(fields[42]) || scale;
      const rotDeg = parseFloat(fields[50]) || 0;
      const ang = rotDeg * Math.PI / 180;
      // 把块内每个对象克隆+变换
      const objects = [];
      for (const bo of block.objects) {
        const clone = JSON.parse(JSON.stringify(bo));
        // 平移每个点到 block.base 相对 + 应用缩放+旋转 + 平移到 (ix, iy)
        const transform = (pt) => {
          if (!pt || typeof pt.x !== 'number') return;
          // 相对 base
          let dx = pt.x - block.base.x;
          let dy = pt.y - block.base.y;
          // 缩放
          dx *= scale; dy *= sy;
          // 旋转
          const rx = dx * Math.cos(ang) - dy * Math.sin(ang);
          const ry = dx * Math.sin(ang) + dy * Math.cos(ang);
          pt.x = ix + rx; pt.y = iy + ry;
        };
        const p = clone.props;
        switch (clone.type) {
          case 'line': transform(p.start); transform(p.end); break;
          case 'polyline': case 'hatch': (p.points || []).forEach(transform); break;
          case 'rect': transform(p.corner1); transform(p.corner2); break;
          case 'circle': case 'arc': transform(p.center); if (p.radius) p.radius *= scale; break;
          case 'ellipse': transform(p.center); p.radiusX *= scale; p.radiusY *= sy; p.rotation = (p.rotation || 0) + ang; break;
          case 'text': transform(p.position); if (p.height) p.height *= scale; p.rotation = (p.rotation || 0) + ang; break;
          case 'point': transform(p.position); break;
          case 'dim': transform(p.start); transform(p.end); break;
        }
        objects.push(clone);
      }
      return { objects, next: i };
    }
  };

  // DXF 导入后处理：合并 POLYLINE/VERTEX/SEQEND 序列为单个 polyline 对象
  function _postProcessDxfImport(result) {
    const out = [];
    let pendingPoly = null;
    for (const obj of result.objects) {
      if (obj.type === '__polyline_header__') {
        pendingPoly = obj;
        continue;
      }
      if (obj.type === '__vertex__' && pendingPoly) {
        pendingPoly.props._vertices.push({ x: obj.props.x, y: obj.props.y });
        continue;
      }
      if (obj.type === 'SEQEND' || (obj.type === '__seqend__')) {
        if (pendingPoly) {
          if (pendingPoly.props._vertices.length >= 2) {
            out.push({
              type: 'polyline',
              layer: pendingPoly.layer,
              props: { points: pendingPoly.props._vertices, closed: pendingPoly.props.closed }
            });
          }
          pendingPoly = null;
        }
        continue;
      }
      // 跳过占位类型
      if (obj.type && obj.type.startsWith('__')) continue;
      out.push(obj);
    }
    // 如果还有未关闭的 pendingPoly
    if (pendingPoly && pendingPoly.props._vertices.length >= 2) {
      out.push({
        type: 'polyline', layer: pendingPoly.layer,
        props: { points: pendingPoly.props._vertices, closed: pendingPoly.props.closed }
      });
    }
    result.objects = out;
  }

  // =========================================================================
  // 4c. HATCH PATTERNS (填充图案库)
  //   每个图案由若干"线组"组成，每组 {angle, offsetX, offsetY, spacing}
  //   angle: 线方向（弧度）；offsetX/Y: 起点偏移；spacing: 平行线间距
  //   渲染时对 hatch.bbox 做多组平行线裁剪绘制
  // =========================================================================
  const HatchPatterns = {
    _patterns: {
      // ANSI31: 45° 实线
      ansi31: { description: 'ANSI31 - 45° 实线', lines: [{ angle: Math.PI / 4, spacing: 4 }] },
      // ANSI32: 45°/135° 双向
      ansi32: { description: 'ANSI32 - 45°/135° 双向线', lines: [
        { angle: Math.PI / 4, spacing: 4 },
        { angle: 3 * Math.PI / 4, spacing: 4 }
      ] },
      // ANSI33: 45° + 间隔 8
      ansi33: { description: 'ANSI33 - 45° 实线 (大间距)', lines: [{ angle: Math.PI / 4, spacing: 8 }] },
      // ANSI34: 30°/60°
      ansi34: { description: 'ANSI34 - 30°/60° 网格', lines: [
        { angle: Math.PI / 6, spacing: 4 },
        { angle: Math.PI / 3, spacing: 4 }
      ] },
      // ANSI35: 0°/90° 交叉
      ansi35: { description: 'ANSI35 - 水平+垂直交叉', lines: [
        { angle: 0, spacing: 4 },
        { angle: Math.PI / 2, spacing: 4 }
      ] },
      // ANSI36: 0°/45°/90°
      ansi36: { description: 'ANSI36 - 三向交叉', lines: [
        { angle: 0, spacing: 6 },
        { angle: Math.PI / 4, spacing: 6 },
        { angle: Math.PI / 2, spacing: 6 }
      ] },
      // ANSI37: 0° 实线
      ansi37: { description: 'ANSI37 - 水平实线', lines: [{ angle: 0, spacing: 4 }] },
      // ANSI38: 45° 双倍间距
      ansi38: { description: 'ANSI38 - 45° 稀疏', lines: [{ angle: Math.PI / 4, spacing: 12 }] },
      // 自定义常用图案
      cross: { description: '十字交叉 (0°/90° 密集)', lines: [
        { angle: 0, spacing: 3 },
        { angle: Math.PI / 2, spacing: 3 }
      ] },
      dot: { description: '点阵 (45°/135°/0°/90°)', lines: [
        { angle: Math.PI / 4, spacing: 5 },
        { angle: 3 * Math.PI / 4, spacing: 5 },
        { angle: 0, spacing: 5 },
        { angle: Math.PI / 2, spacing: 5 }
      ] },
      grid: { description: '网格 (0°/90° 大间距)', lines: [
        { angle: 0, spacing: 8 },
        { angle: Math.PI / 2, spacing: 8 }
      ] },
      solid: { description: '实心填充 (无图案)', lines: [] },
      horizontal: { description: '水平线', lines: [{ angle: 0, spacing: 4 }] },
      vertical: { description: '垂直线', lines: [{ angle: Math.PI / 2, spacing: 4 }] }
    },

    list() {
      return Object.entries(this._patterns).map(([name, p]) => ({ name, description: p.description }));
    },

    get(name) {
      if (!name) return this._patterns.ansi31;
      return this._patterns[name.toLowerCase()] || null;
    },

    // 应用图案到 ctx（已 clip 区域内）
    // pts: 闭合多边形顶点（世界坐标）
    // patternName: 图案名
    // spacingScale: 间距缩放（zoom 适配）
    draw(ctx, pts, patternName, w2s, zoom) {
      const pat = this.get(patternName) || this._patterns.ansi31;
      if (pat.lines.length === 0) {
        // solid: 实心填充
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        const first = w2s(pts[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < pts.length; i++) {
          const sp = w2s(pts[i]);
          ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.fill();
        return;
      }
      // 计算 bbox 在屏幕空间
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of pts) {
        const s = w2s(w);
        if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
      }
      const w = maxX - minX, h = maxY - minY;
      const diag = Math.hypot(w, h) + 10;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      for (const line of pat.lines) {
        const spacingPx = (line.spacing || 4) * zoom;
        if (spacingPx < 1) continue;
        // 法线方向 (cos, sin) 的角度
        const nx = Math.cos(line.angle), ny = Math.sin(line.angle);
        // 投影 bbox 顶点到法线方向
        const corners = [
          { x: minX, y: minY }, { x: maxX, y: minY },
          { x: maxX, y: maxY }, { x: minX, y: maxY }
        ];
        const projections = corners.map(c => c.x * nx + c.y * ny);
        const pMin = Math.min(...projections), pMax = Math.max(...projections);
        // 切线方向（线方向）
        const tx = -ny, ty = nx;
        ctx.beginPath();
        for (let pp = Math.floor(pMin / spacingPx) * spacingPx; pp <= pMax; pp += spacingPx) {
          // 线上的点 = (cx, cy) + t * (tx, ty) 满足 x*nx + y*ny = pp
          // 求 (cx*nx + cy*ny - pp) 在切线方向的偏移
          const base = cx * nx + cy * ny - pp;
          // 起点 = (cx - base*tx, cy - base*ty)
          const x1 = cx - base * tx - diag * tx;
          const y1 = cy - base * ty - diag * ty;
          const x2 = cx - base * tx + diag * tx;
          const y2 = cy - base * ty + diag * ty;
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        }
        ctx.stroke();
      }
    }
  };

  // =========================================================================
  // 5. COMMAND PARSER & EXECUTOR
  // =========================================================================

  // Command grammar (case-insensitive command name, args separated by spaces):
  //   line x1,y1 x2,y2
  //   polyline x1,y1 x2,y2 [x3,y3 ...] [--closed]
  //   rect x1,y1 x2,y2
  //   circle cx,cy radius
  //   arc cx,cy radius startDeg endDeg
  //   ellipse cx,cy rx ry [rotationDeg]
  //   text x,y "content" [height]
  //   dim x1,y1 x2,y2 [offset]
  //   hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n] [--closed]
  //   layer new NAME [color]
  //   layer delete NAME
  //   layer current NAME
  //   layer color NAME COLOR
  //   layer on NAME
  //   layer off NAME
  //   select all
  //   select id <id>
  //   select layer <name>
  //   select clear
  //   move sel dx,dy
  //   rotate sel angleDeg [cx,cy]
  //   scale sel factor [cx,cy]
  //   mirror sel x1,y1 x2,y2    (mirror across line through 2 pts)
  //   delete sel
  //   delete id <id>
  //   clear
  //   zoom factor
  //   pan dx,dy
  //   fit
  //   grid on|off
  //   help [command]

  const CommandParser = {
    parse(line) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return null;
      // Tokenize: respect quoted strings
      const tokens = [];
      let i = 0, cur = '', inQuote = false;
      while (i < line.length) {
        const ch = line[i];
        if (ch === '"') { inQuote = !inQuote; cur += ch; i++; continue; }
        if (ch === ' ' && !inQuote) { if (cur) { tokens.push(cur); cur = ''; } i++; continue; }
        cur += ch; i++;
      }
      if (cur) tokens.push(cur);
      if (tokens.length === 0) return null;
      return tokens;
    },

    // Parse "x,y" -> {x,y}
    parsePt(s) { return parsePt(s); },
    parseNum(s) { return parseNum(s); },
    parseColor(s) { return parseColor(s); },

    // Parse double-quoted string token (strip surrounding quotes)
    parseStr(s) {
      if (s == null) return '';
      s = String(s);
      if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
      return s;
    }
  };

  const Executor = {
    execute(line) {
      const tokens = CommandParser.parse(line);
      if (!tokens) return { ok: true, result: { skipped: true } };
      const cmd = tokens[0].toLowerCase();
      const args = tokens.slice(1);
      switch (cmd) {
        case 'line': return this._line(args);
        case 'polyline': case 'pl': return this._polyline(args);
        case 'rect': case 'rectangle': return this._rect(args);
        case 'circle': return this._circle(args);
        case 'arc': return this._arc(args);
        case 'ellipse': return this._ellipse(args);
        case 'text': return this._text(args);
        case 'dim': case 'dimension': return this._dim(args);
        case 'dimalign': case 'dimaligned': return this._dimalign(args);
        case 'dimlinear': return this._dimlinear(args);
        case 'dimradius': return this._dimradius(args);
        case 'dimdiameter': return this._dimdiameter(args);
        case 'dimangle': return this._dimangle(args);
        case 'dimleader': case 'leader': return this._dimleader(args);
        case 'hatch': return this._hatch(args);
        case 'layer': return this._layer(args);
        case 'select': case 'sel': return this._select(args);
        case 'move': return this._move(args);
        case 'rotate': return this._rotate(args);
        case 'scale': return this._scale(args);
        case 'mirror': return this._mirror(args);
        case 'copy': case 'clone': return this._copy(args);
        case 'offset': return this._offset(args);
        case 'array': return this._array(args);
        case 'fillet': return this._fillet(args);
        case 'chamfer': return this._chamfer(args);
        case 'trim': return this._trim(args);
        case 'extend': return this._extend(args);
        case 'break': return this._break(args);
        case 'join': return this._join(args);
        case 'explode': return this._explode(args);
        case 'pedit': return this._pedit(args);
        case 'spline': return this._spline(args);
        case 'point': return this._point(args);
        case 'block': return this._block(args);
        case 'insert': return this._insert(args);
        case 'delete': return this._delete(args);
        case 'clear': return this._clear();
        case 'undo': return this._undo();
        case 'redo': return this._redo();
        case 'zoom': return this._zoom(args);
        case 'pan': return this._pan(args);
        case 'fit': Renderer.fit(); return { ok: true, result: 'view fitted' };
        case 'grid': return this._grid(args);
        case 'snap': return this._snap(args);
        case 'osnap': return this._snap(args);
        case 'dist': case 'distance': return this._dist(args);
        case 'len': case 'length': return this._length(args);
        case 'area': return this._area(args);
        case 'perim': case 'perimeter': return this._perim(args);
        case 'list': case 'ls': return this._list(args);
        case 'info': return this._info(args);
        case 'bbox': return this._bbox(args);
        case 'find': return this._find(args);
        case 'count': return this._count(args);
        case 'id': return this._idAt(args);
        case 'save': return { ok: true, result: { hint: '请使用界面按钮 Ctrl+S 或 文件→保存' } };
        case 'dxfin': case 'dxfimport': case 'import': return this._dxfin(args);
        case 'dxfout': case 'dxfexport': return { ok: true, result: { hint: '请使用 文件→导出 DXF 界面按钮' } };
        case 'hatchpattern': case 'pattern': return this._hatchpattern(args);
        case 'help': case '?': return this._help(args[0]);
        default:
          return { ok: false, error: `未知命令: ${cmd}。输入 help 查看可用命令` };
      }
    },

    _line(args) {
      if (args.length < 2) return { ok: false, error: '用法: line x1,y1 x2,y2' };
      try {
        const a = parsePt(args[0]), b = parsePt(args[1]);
        Document.pushHistory();
        const o = Document.addObject('line', { start: a, end: b });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'line' } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _polyline(args) {
      if (args.length < 2) return { ok: false, error: '用法: polyline x1,y1 x2,y2 [x3,y3 ...] [--closed]' };
      try {
        let closed = false;
        const filtered = args.filter(a => {
          if (a.toLowerCase() === '--closed') { closed = true; return false; }
          return true;
        });
        const pts = filtered.map(parsePt);
        if (pts.length < 2) return { ok: false, error: '至少需要 2 个点' };
        Document.pushHistory();
        const o = Document.addObject('polyline', { points: pts, closed });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'polyline', points: pts.length, closed } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _rect(args) {
      if (args.length < 2) return { ok: false, error: '用法: rect x1,y1 x2,y2' };
      try {
        const a = parsePt(args[0]), b = parsePt(args[1]);
        Document.pushHistory();
        const o = Document.addObject('rect', { corner1: a, corner2: b });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'rect' } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _circle(args) {
      if (args.length < 2) return { ok: false, error: '用法: circle cx,cy radius' };
      try {
        const c = parsePt(args[0]);
        const r = parseNum(args[1]);
        if (r <= 0) return { ok: false, error: '半径必须为正数' };
        Document.pushHistory();
        const o = Document.addObject('circle', { center: c, radius: r });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'circle', radius: r } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _arc(args) {
      if (args.length < 4) return { ok: false, error: '用法: arc cx,cy radius startDeg endDeg' };
      try {
        const c = parsePt(args[0]);
        const r = parseNum(args[1]);
        const sa = parseNum(args[2]) * Math.PI / 180;
        const ea = parseNum(args[3]) * Math.PI / 180;
        if (r <= 0) return { ok: false, error: '半径必须为正数' };
        Document.pushHistory();
        const o = Document.addObject('arc', { center: c, radius: r, startAngle: sa, endAngle: ea });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'arc', startAngle: sa, endAngle: ea } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _ellipse(args) {
      if (args.length < 3) return { ok: false, error: '用法: ellipse cx,cy rx ry [rotationDeg]' };
      try {
        const c = parsePt(args[0]);
        const rx = parseNum(args[1]);
        const ry = parseNum(args[2]);
        let rot = 0;
        if (args[3]) rot = parseNum(args[3]) * Math.PI / 180;
        if (rx <= 0 || ry <= 0) return { ok: false, error: '半径必须为正数' };
        Document.pushHistory();
        const o = Document.addObject('ellipse', { center: c, radiusX: rx, radiusY: ry, rotation: rot });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'ellipse' } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _text(args) {
      if (args.length < 2) return { ok: false, error: '用法: text x,y "content" [height]' };
      try {
        const pos = parsePt(args[0]);
        const text = CommandParser.parseStr(args[1]);
        let height = 12;
        if (args[2]) height = parseNum(args[2]);
        let rotation = 0;
        if (args[3]) rotation = parseNum(args[3]) * Math.PI / 180;
        Document.pushHistory();
        const o = Document.addObject('text', { position: pos, text, height, rotation });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'text', text } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _dim(args) {
      if (args.length < 2) return { ok: false, error: '用法: dim x1,y1 x2,y2 [offset]' };
      try {
        const a = parsePt(args[0]), b = parsePt(args[1]);
        let offset = 20;
        if (args[2]) offset = parseNum(args[2]);
        Document.pushHistory();
        const o = Document.addObject('dim', { start: a, end: b, offset, prefix: '', style: 'aligned' });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'dim', length: dist(a, b) } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // 对齐标注（沿两点连线方向）
    _dimalign(args) { return this._dim(args); },

    // 线性标注（水平/垂直）
    // dimlinear h x1,y1 x2,y2 [offset]  - 水平
    // dimlinear v x1,y1 x2,y2 [offset]  - 垂直
    _dimlinear(args) {
      if (args.length < 3) return { ok: false, error: '用法: dimlinear h|v x1,y1 x2,y2 [offset]' };
      try {
        const dir = args[0].toLowerCase();
        if (dir !== 'h' && dir !== 'v' && dir !== 'horizontal' && dir !== 'vertical') {
          return { ok: false, error: '方向必须是 h(水平) 或 v(垂直)' };
        }
        const a = parsePt(args[1]), b = parsePt(args[2]);
        let offset = 20;
        if (args[3]) offset = parseNum(args[3]);
        Document.pushHistory();
        // 强制标注水平/垂直距离
        const projEnd = (dir === 'h' || dir === 'horizontal')
          ? { x: b.x, y: a.y }   // 水平：投影到水平线
          : { x: a.x, y: b.y }; // 垂直：投影到垂直线
        const o = Document.addObject('dim', {
          start: a, end: b, projEnd,
          offset, prefix: '',
          style: (dir === 'h' || dir === 'horizontal') ? 'horizontal' : 'vertical'
        });
        Renderer.render();
        const realLen = (o.props.style === 'horizontal') ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
        return { ok: true, result: { id: o.id, type: 'dim', style: o.props.style, length: realLen } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // 半径标注
    _dimradius(args) {
      if (args.length < 2) return { ok: false, error: '用法: dimradius id <id> [angleDeg]' };
      try {
        if (args[0].toLowerCase() !== 'id' || !args[1]) return { ok: false, error: '用法: dimradius id <id> [angleDeg]' };
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        if (o.type !== 'circle' && o.type !== 'arc') return { ok: false, error: '半径标注仅支持 circle/arc' };
        let angDeg = 45;
        if (args[2]) angDeg = parseNum(args[2]);
        const ang = angDeg * Math.PI / 180;
        const c = o.props.center, r = o.props.radius;
        const edgePt = { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) };
        const leaderEnd = { x: c.x + (r + 20) * Math.cos(ang), y: c.y + (r + 20) * Math.sin(ang) };
        Document.pushHistory();
        const dim = Document.addObject('dimradius', {
          center: c, edgePoint: edgePt, leaderEnd,
          radius: r, text: 'R' + r.toFixed(2), angle: ang
        });
        Renderer.render();
        return { ok: true, result: { id: dim.id, type: 'dimradius', radius: r } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // 直径标注
    _dimdiameter(args) {
      if (args.length < 2) return { ok: false, error: '用法: dimdiameter id <id> [angleDeg]' };
      try {
        if (args[0].toLowerCase() !== 'id' || !args[1]) return { ok: false, error: '用法: dimdiameter id <id> [angleDeg]' };
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        if (o.type !== 'circle' && o.type !== 'arc') return { ok: false, error: '直径标注仅支持 circle/arc' };
        let angDeg = 45;
        if (args[2]) angDeg = parseNum(args[2]);
        const ang = angDeg * Math.PI / 180;
        const c = o.props.center, r = o.props.radius;
        const p1 = { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) };
        const p2 = { x: c.x - r * Math.cos(ang), y: c.y - r * Math.sin(ang) };
        const leaderEnd = { x: p1.x + 20 * Math.cos(ang), y: p1.y + 20 * Math.sin(ang) };
        Document.pushHistory();
        const dim = Document.addObject('dimdiameter', {
          center: c, point1: p1, point2: p2, leaderEnd,
          diameter: r * 2, text: 'Ø' + (r * 2).toFixed(2), angle: ang
        });
        Renderer.render();
        return { ok: true, result: { id: dim.id, type: 'dimdiameter', diameter: r * 2 } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // 角度标注
    // dimangle vertexX,vertexY x1,y1 x2,y2 [offset]
    _dimangle(args) {
      if (args.length < 3) return { ok: false, error: '用法: dimangle vx,vy x1,y1 x2,y2 [offset]  (顶点 + 两条边的端点)' };
      try {
        const v = parsePt(args[0]);
        const p1 = parsePt(args[1]);
        const p2 = parsePt(args[2]);
        let offset = 20;
        if (args[3]) offset = parseNum(args[3]);
        // 计算角度
        const a1 = Math.atan2(p1.y - v.y, p1.x - v.x);
        const a2 = Math.atan2(p2.y - v.y, p2.x - v.x);
        let ang = a2 - a1;
        if (ang < 0) ang += 2 * Math.PI;
        const angDeg = ang * 180 / Math.PI;
        Document.pushHistory();
        const o = Document.addObject('dimangle', {
          vertex: v, p1, p2, offset,
          startAngle: a1, endAngle: a2, angle: ang,
          text: angDeg.toFixed(2) + '°'
        });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'dimangle', angleDeg: angDeg } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // 引线标注
    // dimleader x,y x2,y2 "text"
    _dimleader(args) {
      if (args.length < 3) return { ok: false, error: '用法: dimleader x,y x2,y2 "text"' };
      try {
        const start = parsePt(args[0]);
        const end = parsePt(args[1]);
        const text = CommandParser.parseStr(args[2]);
        Document.pushHistory();
        const o = Document.addObject('dimleader', { start, end, text });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'dimleader', text } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _hatch(args) {
      if (args.length < 3) return { ok: false, error: '用法: hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n] [--pattern NAME] [--closed]' };
      try {
        let angle = Math.PI / 4;
        let spacing = 5;
        let closed = true;
        let pattern = 'ansi31';
        const pts = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.toLowerCase() === '--angle') { angle = parseNum(args[++i]) * Math.PI / 180; continue; }
          if (a.toLowerCase() === '--spacing') { spacing = parseNum(args[++i]); continue; }
          if (a.toLowerCase() === '--closed') { closed = true; continue; }
          if (a.toLowerCase() === '--open') { closed = false; continue; }
          if (a.toLowerCase() === '--pattern') { pattern = (args[++i] || 'ansi31').toLowerCase(); continue; }
          pts.push(parsePt(a));
        }
        if (pts.length < 3) return { ok: false, error: '填充至少需要 3 个点' };
        if (!HatchPatterns.get(pattern)) return { ok: false, error: '未知图案: ' + pattern + '。使用 hatchpattern list 查看可用图案' };
        Document.pushHistory();
        const o = Document.addObject('hatch', { points: pts, angle, spacing, closed, pattern });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'hatch', points: pts.length, pattern } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _layer(args) {
      if (args.length === 0) return { ok: false, error: '用法: layer new|delete|current|color|on|off NAME [...]' };
      const sub = args[0].toLowerCase();
      switch (sub) {
        case 'new': {
          if (args.length < 2) return { ok: false, error: '用法: layer new NAME [color]' };
          const name = args[1];
          const color = args[2] ? parseColor(args[2]) : '#4f8cff';
          Document.pushHistory();
          if (!Document.addLayer(name, color)) { Document._history.pop(); return { ok: false, error: '图层已存在: ' + name }; }
          UI.refreshLayers();
          return { ok: true, result: { layer: name, color } };
        }
        case 'delete': case 'del': {
          if (args.length < 2) return { ok: false, error: '用法: layer delete NAME' };
          Document.pushHistory();
          if (!Document.deleteLayer(args[1])) { Document._history.pop(); return { ok: false, error: '无法删除图层 (Layer0 不可删除或图层不存在)' }; }
          UI.refreshLayers();
          return { ok: true, result: { deleted: args[1] } };
        }
        case 'current': case 'set': {
          if (args.length < 2) return { ok: false, error: '用法: layer current NAME' };
          if (!Document.setCurrentLayer(args[1])) return { ok: false, error: '图层不存在: ' + args[1] };
          // 选择当前图层不改数据，不计入撤销
          UI.refreshLayers();
          return { ok: true, result: { current: args[1] } };
        }
        case 'color': {
          if (args.length < 3) return { ok: false, error: '用法: layer color NAME COLOR' };
          Document.pushHistory();
          if (!Document.setLayerColor(args[1], parseColor(args[2]))) { Document._history.pop(); return { ok: false, error: '图层不存在: ' + args[1] }; }
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], color: args[2] } };
        }
        case 'on': {
          if (args.length < 2) return { ok: false, error: '用法: layer on NAME' };
          Document.pushHistory();
          if (!Document.setLayerVisible(args[1], true)) { Document._history.pop(); return { ok: false, error: '图层不存在: ' + args[1] }; }
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], visible: true } };
        }
        case 'off': {
          if (args.length < 2) return { ok: false, error: '用法: layer off NAME' };
          Document.pushHistory();
          if (!Document.setLayerVisible(args[1], false)) { Document._history.pop(); return { ok: false, error: '图层不存在: ' + args[1] }; }
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], visible: false } };
        }
        case 'lock': {
          if (args.length < 3) return { ok: false, error: '用法: layer lock NAME on|off' };
          const l = Document.getLayer(args[1]);
          if (!l) return { ok: false, error: '图层不存在: ' + args[1] };
          Document.pushHistory();
          l.locked = (args[2].toLowerCase() === 'on');
          Document.modified = true;
          UI.refreshLayers();
          return { ok: true, result: { layer: args[1], locked: l.locked } };
        }
        case 'list': {
          return { ok: true, result: { layers: Document.layers } };
        }
        default:
          return { ok: false, error: '未知子命令: ' + sub };
      }
    },

    _select(args) {
      if (args.length === 0) return { ok: false, error: '用法: select all | id <id> | layer <name> | clear' };
      const sub = args[0].toLowerCase();
      switch (sub) {
        case 'all':
          Document.selectAll();
          UI.refreshObjects();
          Renderer.render();
          return { ok: true, result: { selected: Document.getSelectedIds().length } };
        case 'clear':
          Document.clearSelection();
          UI.refreshObjects();
          Renderer.render();
          return { ok: true, result: { cleared: true } };
        case 'id': {
          if (args.length < 2) return { ok: false, error: '用法: select id <id>' };
          if (!Document.selectById(args[1], args[2] && args[2].toLowerCase() === '--add')) return { ok: false, error: '对象不存在: ' + args[1] };
          UI.refreshObjects();
          Renderer.render();
          return { ok: true, result: { selected: args[1] } };
        }
        case 'layer': {
          if (args.length < 2) return { ok: false, error: '用法: select layer <name>' };
          Document.clearSelection();
          for (const obj of Document.objects.values()) {
            if (obj.layer === args[1]) obj.selected = true;
          }
          UI.refreshObjects();
          Renderer.render();
          return { ok: true, result: { selectedByLayer: args[1] } };
        }
        default:
          return { ok: false, error: '未知子命令: ' + sub };
      }
    },

    _move(args) {
      if (args.length < 2) return { ok: false, error: '用法: move sel dx,dy  (或: move id <id> dx,dy)' };
      const sel = args[0].toLowerCase();
      let dx, dy;
      try { const p = parsePt(args[1]); dx = p.x; dy = p.y; } catch (e) { return { ok: false, error: e.message }; }
      let targets = [];
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        targets = [o];
        // shift args
        try { const p = parsePt(args[2]); dx = p.x; dy = p.y; } catch (e) { return { ok: false, error: e.message }; }
      } else if (sel === 'all') {
        targets = Array.from(Document.objects.values());
      } else {
        return { ok: false, error: '未知选择: ' + sel };
      }
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      Document.pushHistory();
      for (const obj of targets) this._translateObj(obj, dx, dy);
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { moved: targets.length } };
    },

    _translateObj(obj, dx, dy) {
      const p = obj.props;
      const sh = (pt) => { pt.x += dx; pt.y += dy; };
      switch (obj.type) {
        case 'line': sh(p.start); sh(p.end); break;
        case 'polyline': case 'hatch': (p.points || []).forEach(sh); break;
        case 'rect': sh(p.corner1); sh(p.corner2); break;
        case 'circle': case 'arc': case 'ellipse': case 'text': sh(p.center || p.position); if (p.position) sh(p.position); break;
        case 'dim': sh(p.start); sh(p.end); if (p.projEnd) sh(p.projEnd); break;
        case 'dimradius': sh(p.center); sh(p.edgePoint); sh(p.leaderEnd); break;
        case 'dimdiameter': sh(p.center); sh(p.point1); sh(p.point2); if (p.leaderEnd) sh(p.leaderEnd); break;
        case 'dimangle': sh(p.vertex); sh(p.p1); sh(p.p2); break;
        case 'dimleader': sh(p.start); sh(p.end); break;
      }
    },

    _rotate(args) {
      if (args.length < 2) return { ok: false, error: '用法: rotate sel angleDeg [cx,cy]' };
      const sel = args[0].toLowerCase();
      let angDeg, center = { x: 0, y: 0 };
      try { angDeg = parseNum(args[1]); } catch (e) { return { ok: false, error: e.message }; }
      if (args[2]) { try { center = parsePt(args[2]); } catch (e) { return { ok: false, error: e.message }; } }
      let targets;
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'all') targets = Array.from(Document.objects.values());
      else return { ok: false, error: '未知选择: ' + sel };
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      Document.pushHistory();
      const ang = angDeg * Math.PI / 180;
      for (const obj of targets) this._rotateObj(obj, ang, center);
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { rotated: targets.length, angleDeg: angDeg } };
    },

    _rotateObj(obj, ang, center) {
      const p = obj.props;
      const ro = (pt) => { const r = rotateAround(pt, center, ang); pt.x = r.x; pt.y = r.y; };
      switch (obj.type) {
        case 'line': ro(p.start); ro(p.end); break;
        case 'polyline': case 'hatch': (p.points || []).forEach(ro); break;
        case 'rect': {
          ro(p.corner1); ro(p.corner2);
          // rect becomes general quadrilateral; we keep as rect if axis-aligned after rotation, else convert to polyline
          // For simplicity, convert to polyline
          const a = p.corner1, b = p.corner2;
          const corners = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
          obj.type = 'polyline';
          obj.props = { points: corners, closed: true };
          break;
        }
        case 'circle':
          // Circle stays circle (rotation symmetric)
          p.center = rotateAround(p.center, center, ang);
          break;
        case 'arc':
          p.center = rotateAround(p.center, center, ang);
          p.startAngle += ang;
          p.endAngle += ang;
          break;
        case 'ellipse':
          p.center = rotateAround(p.center, center, ang);
          p.rotation = (p.rotation || 0) + ang;
          break;
        case 'text':
          p.position = rotateAround(p.position, center, ang);
          p.rotation = (p.rotation || 0) + ang;
          break;
        case 'dim': ro(p.start); ro(p.end); if (p.projEnd) ro(p.projEnd); break;
        case 'dimradius': ro(p.center); ro(p.edgePoint); ro(p.leaderEnd); if (p.angle != null) p.angle += ang; break;
        case 'dimdiameter': ro(p.center); ro(p.point1); ro(p.point2); if (p.leaderEnd) ro(p.leaderEnd); if (p.angle != null) p.angle += ang; break;
        case 'dimangle': ro(p.vertex); ro(p.p1); ro(p.p2); p.startAngle = (p.startAngle || 0) + ang; p.endAngle = (p.endAngle || 0) + ang; break;
        case 'dimleader': ro(p.start); ro(p.end); break;
      }
    },

    _scale(args) {
      if (args.length < 2) return { ok: false, error: '用法: scale sel factor [cx,cy]' };
      const sel = args[0].toLowerCase();
      let factor, center = { x: 0, y: 0 };
      try { factor = parseNum(args[1]); } catch (e) { return { ok: false, error: e.message }; }
      if (args[2]) { try { center = parsePt(args[2]); } catch (e) { return { ok: false, error: e.message }; } }
      if (factor <= 0) return { ok: false, error: '缩放比例必须为正数' };
      let targets;
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'all') targets = Array.from(Document.objects.values());
      else return { ok: false, error: '未知选择: ' + sel };
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      Document.pushHistory();
      for (const obj of targets) this._scaleObj(obj, factor, center);
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { scaled: targets.length, factor } };
    },

    _scaleObj(obj, f, c) {
      const p = obj.props;
      const sc = (pt) => { pt.x = c.x + (pt.x - c.x) * f; pt.y = c.y + (pt.y - c.y) * f; };
      switch (obj.type) {
        case 'line': sc(p.start); sc(p.end); break;
        case 'polyline': case 'hatch': (p.points || []).forEach(sc); break;
        case 'rect': sc(p.corner1); sc(p.corner2); break;
        case 'circle': case 'arc': sc(p.center); p.radius *= f; break;
        case 'ellipse': sc(p.center); p.radiusX *= f; p.radiusY *= f; break;
        case 'text': sc(p.position); p.height = (p.height || 12) * f; break;
        case 'dim': sc(p.start); sc(p.end); if (p.projEnd) sc(p.projEnd); break;
        case 'dimradius': sc(p.center); sc(p.edgePoint); sc(p.leaderEnd); p.radius *= f; break;
        case 'dimdiameter': sc(p.center); sc(p.point1); sc(p.point2); if (p.leaderEnd) sc(p.leaderEnd); p.diameter *= f; break;
        case 'dimangle': sc(p.vertex); sc(p.p1); sc(p.p2); p.offset = (p.offset || 20) * f; break;
        case 'dimleader': sc(p.start); sc(p.end); break;
      }
    },

    _mirror(args) {
      if (args.length < 3) return { ok: false, error: '用法: mirror sel x1,y1 x2,y2  (镜像轴为通过两点的直线)' };
      const sel = args[0].toLowerCase();
      let p1, p2;
      try { p1 = parsePt(args[1]); p2 = parsePt(args[2]); } catch (e) { return { ok: false, error: e.message }; }
      if (dist(p1, p2) < 1e-9) return { ok: false, error: '两点重合，无法定义镜像轴' };
      let targets;
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'all') targets = Array.from(Document.objects.values());
      else return { ok: false, error: '未知选择: ' + sel };
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      Document.pushHistory();
      // Mirror line: ax + by + c = 0; normal = (-(p2.y-p1.y), (p2.x-p1.x))
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const len2 = dx * dx + dy * dy;
      const mirrorPt = (pt) => {
        const t = ((pt.x - p1.x) * dx + (pt.y - p1.y) * dy) / len2;
        const projX = p1.x + t * dx, projY = p1.y + t * dy;
        return { x: 2 * projX - pt.x, y: 2 * projY - pt.y };
      };
      for (const obj of targets) {
        const p = obj.props;
        const mp = (pt) => { const r = mirrorPt(pt); pt.x = r.x; pt.y = r.y; };
        switch (obj.type) {
          case 'line': mp(p.start); mp(p.end); break;
          case 'polyline': case 'hatch': (p.points || []).forEach(mp); break;
          case 'rect': mp(p.corner1); mp(p.corner2); break;
          case 'circle': mp(p.center); break;
          case 'arc': mp(p.center); { const sa = p.startAngle, ea = p.endAngle; p.startAngle = -ea; p.endAngle = -sa; } break;
          case 'ellipse': mp(p.center); p.rotation = -(p.rotation || 0); break;
          case 'text': mp(p.position); p.rotation = -(p.rotation || 0); break;
          case 'dim': mp(p.start); mp(p.end); if (p.projEnd) mp(p.projEnd); break;
          case 'dimradius': mp(p.center); mp(p.edgePoint); mp(p.leaderEnd); break;
          case 'dimdiameter': mp(p.center); mp(p.point1); mp(p.point2); if (p.leaderEnd) mp(p.leaderEnd); break;
          case 'dimangle': mp(p.vertex); mp(p.p1); mp(p.p2); break;
          case 'dimleader': mp(p.start); mp(p.end); break;
        }
      }
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { mirrored: targets.length } };
    },

    _delete(args) {
      if (args.length === 0) return { ok: false, error: '用法: delete sel | delete id <id>' };
      const sel = args[0].toLowerCase();
      if (sel === 'sel') {
        const ids = Document.getSelectedIds();
        if (ids.length === 0) return { ok: false, error: '没有选中对象' };
        Document.pushHistory();
        ids.forEach(id => Document.deleteObject(id));
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { deleted: ids.length } };
      }
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        Document.pushHistory();
        Document.deleteObject(args[1]);
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { deleted: args[1] } };
      }
      return { ok: false, error: '未知选择: ' + sel };
    },

    _clear() {
      const n = Document.objects.size;
      if (n === 0) return { ok: true, result: { cleared: 0 } };
      Document.pushHistory();
      Document.clear();
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { cleared: n } };
    },

    _undo() {
      if (!Document.undo()) return { ok: false, error: '无可撤销操作' };
      Renderer.render();
      UI.refreshLayers();
      UI.refreshObjects();
      UI.refreshStatus();
      return { ok: true, result: { undoStack: Document._history.length, redoStack: Document._redoStack.length } };
    },

    _redo() {
      if (!Document.redo()) return { ok: false, error: '无可重做操作' };
      Renderer.render();
      UI.refreshLayers();
      UI.refreshObjects();
      UI.refreshStatus();
      return { ok: true, result: { undoStack: Document._history.length, redoStack: Document._redoStack.length } };
    },

    // 复制选中或指定对象，可加偏移
    _copy(args) {
      if (args.length < 1) return { ok: false, error: '用法: copy sel [dx,dy]  |  copy id <id> [dx,dy]' };
      const sel = args[0].toLowerCase();
      let dx = 0, dy = 0;
      let targets = [];
      if (sel === 'sel') {
        if (args[1]) { try { const p = parsePt(args[1]); dx = p.x; dy = p.y; } catch (e) { return { ok: false, error: e.message }; } }
        targets = Document.getSelectedIds().map(id => Document.getObject(id));
      } else if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        if (args[2]) { try { const p = parsePt(args[2]); dx = p.x; dy = p.y; } catch (e) { return { ok: false, error: e.message }; } }
        targets = [o];
      } else if (sel === 'all') {
        if (args[1]) { try { const p = parsePt(args[1]); dx = p.x; dy = p.y; } catch (e) { return { ok: false, error: e.message }; } }
        targets = Array.from(Document.objects.values());
      } else {
        return { ok: false, error: '未知选择: ' + sel };
      }
      if (targets.length === 0) return { ok: false, error: '没有可复制的对象' };
      Document.pushHistory();
      const clones = targets.map(o => Document.cloneOffset(o, dx, dy));
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { copied: clones.length, newIds: clones.map(c => c.id) } };
    },

    // offset: 偏移复制（平行线、等距多边形）
    _offset(args) {
      if (args.length < 2) return { ok: false, error: '用法: offset distance sel|id <id> [side]' };
      try {
        const off = parseNum(args[0]);
        const sel = args[1].toLowerCase();
        let target;
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length === 0) return { ok: false, error: '没有选中对象' };
          target = Document.getObject(ids[0]);
        } else if (sel === 'id' && args[2]) {
          target = Document.getObject(args[2]);
          if (!target) return { ok: false, error: '对象不存在: ' + args[2] };
        } else {
          return { ok: false, error: '用法: offset distance sel|id <id>' };
        }
        const p = target.props;
        let clone = null;
        Document.pushHistory();
        switch (target.type) {
          case 'line': {
            // 平行偏移：垂直方向移动 distance
            const dx = p.end.x - p.start.x, dy = p.end.y - p.start.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len * off, ny = dx / len * off;
            clone = Document.cloneOffset(target, nx, ny);
            break;
          }
          case 'circle': {
            clone = Document.cloneOffset(target, 0, 0);
            clone.props.radius = Math.max(0.01, p.radius + off);
            break;
          }
          case 'arc': {
            clone = Document.cloneOffset(target, 0, 0);
            clone.props.radius = Math.max(0.01, p.radius + off);
            break;
          }
          case 'polyline': case 'hatch': {
            // 简化：将每个点沿法线方向偏移
            if (!p.points || p.points.length < 2) { Document._history.pop(); return { ok: false, error: '折线点数不足' }; }
            clone = Document.cloneOffset(target, 0, 0);
            const pts = clone.props.points;
            const newPts = [];
            for (let i = 0; i < pts.length; i++) {
              const prev = pts[i === 0 ? pts.length - 1 : i - 1];
              const next = pts[(i + 1) % pts.length];
              const dx1 = pts[i].x - prev.x, dy1 = pts[i].y - prev.y;
              const dx2 = next.x - pts[i].x, dy2 = next.y - pts[i].y;
              const l1 = Math.hypot(dx1, dy1) || 1, l2 = Math.hypot(dx2, dy2) || 1;
              const nx = (-dy1 / l1 + -dy2 / l2) / 2;
              const ny = (dx1 / l1 + dx2 / l2) / 2;
              const nl = Math.hypot(nx, ny) || 1;
              newPts.push({ x: pts[i].x + nx / nl * off, y: pts[i].y + ny / nl * off });
            }
            clone.props.points = newPts;
            break;
          }
          case 'rect': {
            // 简化：直接向外扩 distance
            clone = Document.cloneOffset(target, 0, 0);
            const a = p.corner1, b = p.corner2;
            clone.props.corner1 = { x: Math.min(a.x, b.x) - off, y: Math.min(a.y, b.y) - off };
            clone.props.corner2 = { x: Math.max(a.x, b.x) + off, y: Math.max(a.y, b.y) + off };
            break;
          }
          case 'ellipse': {
            clone = Document.cloneOffset(target, 0, 0);
            clone.props.radiusX = Math.max(0.01, p.radiusX + off);
            clone.props.radiusY = Math.max(0.01, p.radiusY + off);
            break;
          }
          default:
            Document._history.pop();
            return { ok: false, error: '不支持 offset 的对象类型: ' + target.type };
        }
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { offset: off, newId: clone ? clone.id : null } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // array: 阵列复制（矩形阵列 / 极坐标阵列）
    // array rect sel cols rows dx,dy
    // array polar sel count cx,cy [startAngleDeg] [totalAngleDeg]
    _array(args) {
      if (args.length < 4) return { ok: false, error: '用法: array rect sel cols rows dx,dy  |  array polar sel count cx,cy [startDeg] [totalDeg]' };
      const sub = args[0].toLowerCase();
      const sel = args[1].toLowerCase();
      let targets = [];
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'id' && args[2]) {
        const o = Document.getObject(args[2]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[2] };
        targets = [o];
        // 移除已使用的 id 参数，统一后续下标
        args.splice(2, 1);
      } else if (sel === 'all') targets = Array.from(Document.objects.values());
      else return { ok: false, error: '未知选择: ' + sel };
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };

      if (sub === 'rect') {
        if (args.length < 5) return { ok: false, error: '用法: array rect sel cols rows dx,dy' };
        try {
          const cols = parseInt(args[2]), rows = parseInt(args[3]);
          const off = parsePt(args[4]);
          if (cols < 1 || rows < 1) return { ok: false, error: '列/行数必须 >= 1' };
          Document.pushHistory();
          const newIds = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (c === 0 && r === 0) continue;  // 跳过原位置
              const dx = off.x * c, dy = off.y * r;
              for (const t of targets) newIds.push(Document.cloneOffset(t, dx, dy).id);
            }
          }
          Renderer.render();
          UI.refreshObjects();
          return { ok: true, result: { cols, rows, created: newIds.length, newIds } };
        } catch (e) { return { ok: false, error: e.message }; }
      } else if (sub === 'polar') {
        if (args.length < 4) return { ok: false, error: '用法: array polar sel count cx,cy [startDeg] [totalDeg]' };
        try {
          const count = parseInt(args[2]);
          const center = parsePt(args[3]);
          let startDeg = 0, totalDeg = 360;
          if (args[4]) startDeg = parseNum(args[4]);
          if (args[5]) totalDeg = parseNum(args[5]);
          if (count < 1) return { ok: false, error: '阵列数必须 >= 1' };
          Document.pushHistory();
          const newIds = [];
          const startAng = startDeg * Math.PI / 180;
          const totalAng = totalDeg * Math.PI / 180;
          for (let i = 1; i < count; i++) {  // i=0 跳过原位置
            const ang = startAng + (i / count) * totalAng;
            for (const t of targets) {
              const c = Document.cloneObject(t);
              // 围绕 center 旋转 ang，然后平移到 center + 旋转后位置 - 原位置
              // 简化：先记录对象中心点（取 bbox 中心），围绕 center 旋转 ang 角度
              const bb = Renderer._boundingBox(t);
              const oc = bb ? { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2 } : { x: 0, y: 0 };
              const rotated = rotateAround(oc, center, ang);
              const dx = rotated.x - oc.x, dy = rotated.y - oc.y;
              // 把 clone 平移 dx,dy
              const sh = (pt) => { if (pt && typeof pt.x === 'number') { pt.x += dx; pt.y += dy; } };
              const cp = c.props;
              switch (c.type) {
                case 'line': sh(cp.start); sh(cp.end); break;
                case 'polyline': case 'hatch': (cp.points || []).forEach(sh); break;
                case 'rect': sh(cp.corner1); sh(cp.corner2); break;
                case 'circle': case 'arc': case 'ellipse': sh(cp.center); break;
                case 'text': sh(cp.position); break;
                case 'dim': sh(cp.start); sh(cp.end); break;
              }
              // 旋转对象自身（围绕其中心）
              this._rotateObj(c, ang, oc);
              newIds.push(c.id);
            }
          }
          Renderer.render();
          UI.refreshObjects();
          return { ok: true, result: { count, center, created: newIds.length, newIds } };
        } catch (e) { return { ok: false, error: e.message }; }
      } else {
        return { ok: false, error: '未知 array 子命令: ' + sub };
      }
    },

    // fillet: 圆角化两条线段的交点（或选中折线的所有顶点）
    // fillet radius sel   或   fillet radius id <id1> [id <id2>]
    _fillet(args) {
      if (args.length < 2) return { ok: false, error: '用法: fillet radius sel|id <id> [id <id2>]' };
      try {
        const r = parseNum(args[0]);
        if (r < 0) return { ok: false, error: '半径必须 >= 0' };
        const sel = args[1].toLowerCase();
        let lines = [];
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length < 2) return { ok: false, error: '需要选中 2 个 line/polyline 对象' };
          lines = ids.map(id => Document.getObject(id)).filter(o => o && (o.type === 'line' || o.type === 'polyline'));
          if (lines.length < 2) return { ok: false, error: '选中对象必须为 line/polyline' };
        } else if (sel === 'id' && args[2]) {
          const o1 = Document.getObject(args[2]);
          if (!o1) return { ok: false, error: '对象不存在: ' + args[2] };
          lines.push(o1);
          if (args[3] === 'id' && args[4]) {
            const o2 = Document.getObject(args[4]);
            if (!o2) return { ok: false, error: '对象不存在: ' + args[4] };
            lines.push(o2);
          }
        } else {
          return { ok: false, error: '用法: fillet radius sel|id <id> [id <id2>]' };
        }
        if (lines.length !== 2) return { ok: false, error: 'fillet 仅支持两条线段' };
        // 仅支持 line-line fillet
        if (lines[0].type !== 'line' || lines[1].type !== 'line') {
          return { ok: false, error: 'fillet 当前仅支持 line + line' };
        }
        const l1 = lines[0].props, l2 = lines[1].props;
        // 求交点
        const intersect = segIntersect(l1.start, l1.end, l2.start, l2.end);
        if (!intersect) return { ok: false, error: '两线段不相交' };
        // 缩短每条线到距离交点 r 处，并添加圆弧
        const d1 = dist(intersect, l1.end) < dist(intersect, l1.start) ? 'end' : 'start';
        const d2 = dist(intersect, l2.end) < dist(intersect, l2.start) ? 'end' : 'start';
        const cutPt1 = pointOnLineAtDist(intersect, d1 === 'end' ? l1.start : l1.end, r);
        const cutPt2 = pointOnLineAtDist(intersect, d2 === 'end' ? l2.start : l2.end, r);
        Document.pushHistory();
        if (d1 === 'end') l1.end = cutPt1; else l1.start = cutPt1;
        if (d2 === 'end') l2.end = cutPt2; else l2.start = cutPt2;
        // 添加圆弧（从 cutPt1 到 cutPt2，圆心 intersect，半径 r）
        const sa = Math.atan2(cutPt1.y - intersect.y, cutPt1.x - intersect.x);
        const ea = Math.atan2(cutPt2.y - intersect.y, cutPt2.x - intersect.x);
        Document.addObject('arc', { center: intersect, radius: r, startAngle: sa, endAngle: ea });
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { radius: r, modified: 2, addedArc: true } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // chamfer: 倒角两条线段的交点
    _chamfer(args) {
      if (args.length < 2) return { ok: false, error: '用法: chamfer distance1 sel [distance2]  或 chamfer d1 id <id1> id <id2> [d2]' };
      try {
        const d1 = parseNum(args[0]);
        let d2 = d1;
        const sel = args[1].toLowerCase();
        let lines = [];
        let argIdx = 2;
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length < 2) return { ok: false, error: '需要选中 2 个 line 对象' };
          lines = ids.map(id => Document.getObject(id)).filter(o => o && o.type === 'line');
          if (lines.length < 2) return { ok: false, error: '选中对象必须为 line' };
          if (args[2]) { d2 = parseNum(args[2]); argIdx = 3; }
        } else if (sel === 'id' && args[2]) {
          const o1 = Document.getObject(args[2]);
          if (!o1) return { ok: false, error: '对象不存在: ' + args[2] };
          lines.push(o1);
          if (args[3] === 'id' && args[4]) {
            const o2 = Document.getObject(args[4]);
            if (!o2) return { ok: false, error: '对象不存在: ' + args[4] };
            lines.push(o2);
            if (args[5]) d2 = parseNum(args[5]);
          }
        } else {
          return { ok: false, error: '用法: chamfer d1 sel [d2]  或 chamfer d1 id <id1> id <id2> [d2]' };
        }
        if (lines.length !== 2) return { ok: false, error: 'chamfer 仅支持两条 line' };
        const l1 = lines[0].props, l2 = lines[1].props;
        const intersect = segIntersect(l1.start, l1.end, l2.start, l2.end);
        if (!intersect) return { ok: false, error: '两线段不相交' };
        const which1 = dist(intersect, l1.end) < dist(intersect, l1.start) ? 'end' : 'start';
        const which2 = dist(intersect, l2.end) < dist(intersect, l2.start) ? 'end' : 'start';
        const cutPt1 = pointOnLineAtDist(intersect, which1 === 'end' ? l1.start : l1.end, d1);
        const cutPt2 = pointOnLineAtDist(intersect, which2 === 'end' ? l2.start : l2.end, d2);
        Document.pushHistory();
        if (which1 === 'end') l1.end = cutPt1; else l1.start = cutPt1;
        if (which2 === 'end') l2.end = cutPt2; else l2.start = cutPt2;
        // 添加倒角直线
        Document.addObject('line', { start: cutPt1, end: cutPt2 });
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { d1, d2, modified: 2, addedLine: true } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // trim: 用其他对象裁剪选中对象
    // trim sel [id <cuttingId>]
    _trim(args) {
      if (args.length < 1) return { ok: false, error: '用法: trim sel [id <cuttingId>]' };
      try {
        const sel = args[0].toLowerCase();
        let targets = [], cutters = [];
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length < 2) return { ok: false, error: '至少需选中 2 个对象（1 个被裁剪 + 1 个裁剪边界）' };
          // 假设最后一个选中对象是裁剪边界，前面的是被裁剪对象
          targets = ids.slice(0, -1).map(id => Document.getObject(id));
          cutters = [Document.getObject(ids[ids.length - 1])];
        } else if (sel === 'id' && args[1] && args[2] === 'id' && args[3]) {
          const o = Document.getObject(args[1]);
          if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
          const c = Document.getObject(args[3]);
          if (!c) return { ok: false, error: '对象不存在: ' + args[3] };
          targets = [o]; cutters = [c];
        } else {
          return { ok: false, error: '用法: trim sel | trim id <id> id <cuttingId>' };
        }
        Document.pushHistory();
        let trimmed = 0;
        for (const t of targets) {
          if (t.type !== 'line') continue;
          // 找到所有交点
          const cuts = [];
          for (const c of cutters) {
            if (c.type === 'line') {
              const ip = segIntersect(t.props.start, t.props.end, c.props.start, c.props.end);
              if (ip) cuts.push(ip);
            }
          }
          if (cuts.length === 0) continue;
          // 找距离 start 最近的交点，截断到该交点
          cuts.sort((a, b) => dist(a, t.props.start) - dist(b, t.props.start));
          t.props.end = cuts[0];
          trimmed++;
        }
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { trimmed } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // extend: 延伸线段到边界对象
    _extend(args) {
      if (args.length < 1) return { ok: false, error: '用法: extend sel [id <boundaryId>]' };
      try {
        const sel = args[0].toLowerCase();
        let targets = [], bounds = [];
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length < 2) return { ok: false, error: '至少需选中 2 个对象' };
          targets = ids.slice(0, -1).map(id => Document.getObject(id));
          bounds = [Document.getObject(ids[ids.length - 1])];
        } else if (sel === 'id' && args[1] && args[2] === 'id' && args[3]) {
          const o = Document.getObject(args[1]);
          if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
          const b = Document.getObject(args[3]);
          if (!b) return { ok: false, error: '对象不存在: ' + args[3] };
          targets = [o]; bounds = [b];
        } else {
          return { ok: false, error: '用法: extend sel | extend id <id> id <boundaryId>' };
        }
        Document.pushHistory();
        let extended = 0;
        for (const t of targets) {
          if (t.type !== 'line') continue;
          // 沿线段方向延伸，找到与边界对象的交点
          for (const b of bounds) {
            if (b.type !== 'line') continue;
            // 把 t 当作无限长直线，与 b 求交点
            const ip = lineIntersect(t.props.start, t.props.end, b.props.start, b.props.end);
            if (!ip) continue;
            // 选择离当前端点更远的一端延伸
            const dStart = dist(ip, t.props.start), dEnd = dist(ip, t.props.end);
            if (dStart > dEnd) t.props.end = ip; else t.props.start = ip;
            extended++;
          }
        }
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { extended } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // break: 在指定点打断对象
    _break(args) {
      if (args.length < 2) return { ok: false, error: '用法: break id <id> x,y  |  break id <id> x1,y1 x2,y2' };
      try {
        if (args[0].toLowerCase() !== 'id' || !args[1]) return { ok: false, error: '用法: break id <id> x,y' };
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        const p1 = parsePt(args[2]);
        const p2 = args[3] ? parsePt(args[3]) : p1;
        Document.pushHistory();
        if (o.type === 'line') {
          // 把 line 拆成两段
          const start = o.props.start, end = o.props.end;
          o.props.end = p1;
          Document.addObject('line', { start: p2, end });
          Renderer.render();
          UI.refreshObjects();
          return { ok: true, result: { broken: true, newSegment: true } };
        } else if (o.type === 'polyline') {
          // 在 p1, p2 之间删除一段
          const pts = o.props.points;
          let i1 = -1, i2 = -1;
          for (let i = 0; i < pts.length; i++) {
            if (dist(pts[i], p1) < 0.01) i1 = i;
            if (dist(pts[i], p2) < 0.01) i2 = i;
          }
          if (i1 < 0 || i2 < 0) { Document._history.pop(); return { ok: false, error: '点不在折线顶点上' }; }
          const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
          const before = pts.slice(0, lo + 1);
          const after = pts.slice(hi);
          o.props.points = before;
          if (after.length >= 2) Document.addObject('polyline', { points: after, closed: false });
          if (o.props.points.length < 2) Document.deleteObject(o.id);
          Renderer.render();
          UI.refreshObjects();
          return { ok: true, result: { broken: true } };
        } else {
          Document._history.pop();
          return { ok: false, error: 'break 仅支持 line / polyline' };
        }
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // join: 合并两条共端点的线段为一条 polyline
    _join(args) {
      if (args.length < 1) return { ok: false, error: '用法: join sel  |  join id <id1> id <id2>' };
      try {
        const sel = args[0].toLowerCase();
        let objs = [];
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length < 2) return { ok: false, error: '需要选中 2 个或更多 line/polyline' };
          objs = ids.map(id => Document.getObject(id)).filter(o => o && (o.type === 'line' || o.type === 'polyline'));
        } else if (sel === 'id' && args[1] && args[2] === 'id' && args[3]) {
          objs.push(Document.getObject(args[1]));
          objs.push(Document.getObject(args[3]));
          if (objs[0] && objs[1] && args[4] === 'id' && args[5]) objs.push(Document.getObject(args[5]));
        } else {
          return { ok: false, error: '用法: join sel  |  join id <id1> id <id2>' };
        }
        if (objs.some(o => !o)) return { ok: false, error: '对象不存在' };
        // 提取所有点序列
        const allPts = [];
        for (const o of objs) {
          if (o.type === 'line') { allPts.push([o.props.start, o.props.end]); }
          else if (o.type === 'polyline') { allPts.push(o.props.points.slice()); }
        }
        // 简化：把所有点合并为一条 polyline
        const merged = [];
        for (const seg of allPts) merged.push(...seg);
        Document.pushHistory();
        objs.forEach(o => Document.deleteObject(o.id));
        const o = Document.addObject('polyline', { points: merged, closed: false });
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { joined: objs.length, newId: o.id } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // explode: 把 polyline / rect / hatch 拆分成多个 line
    _explode(args) {
      if (args.length < 1) return { ok: false, error: '用法: explode sel  |  explode id <id>' };
      const sel = args[0].toLowerCase();
      let targets = [];
      if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
      else if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        targets = [o];
      } else return { ok: false, error: '用法: explode sel | explode id <id>' };
      const explodeOne = (o) => {
        const lines = [];
        const p = o.props;
        switch (o.type) {
          case 'line': lines.push([p.start, p.end]); break;
          case 'rect': {
            const a = p.corner1, b = p.corner2;
            const corners = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
            for (let i = 0; i < 4; i++) lines.push([corners[i], corners[(i + 1) % 4]]);
            break;
          }
          case 'polyline': {
            const pts = p.points || [];
            for (let i = 0; i < pts.length - 1; i++) lines.push([pts[i], pts[i + 1]]);
            if (p.closed && pts.length > 2) lines.push([pts[pts.length - 1], pts[0]]);
            break;
          }
          case 'hatch': {
            const pts = p.points || [];
            for (let i = 0; i < pts.length - 1; i++) lines.push([pts[i], pts[i + 1]]);
            if (pts.length > 2) lines.push([pts[pts.length - 1], pts[0]]);
            break;
          }
          default: return 0;
        }
        for (const [a, b] of lines) Document.addObject('line', { start: a, end: b });
        Document.deleteObject(o.id);
        return lines.length;
      };
      Document.pushHistory();
      let total = 0;
      for (const o of targets) total += explodeOne(o);
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { exploded: targets.length, linesCreated: total } };
    },

    // pedit: 折线编辑（简化：只支持 join 子命令）
    _pedit(args) {
      if (args.length < 1) return { ok: false, error: '用法: pedit join sel|id <id> [id <id2> ...]' };
      const sub = args[0].toLowerCase();
      if (sub === 'join') {
        return this._join(args.slice(1));
      } else if (sub === 'close' || sub === 'open') {
        const close = (sub === 'close');
        const sel = (args[1] || '').toLowerCase();
        let targets = [];
        if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
        else if (sel === 'id' && args[2]) {
          const o = Document.getObject(args[2]);
          if (!o) return { ok: false, error: '对象不存在: ' + args[2] };
          targets = [o];
        } else return { ok: false, error: '用法: pedit close|open sel|id <id>' };
        Document.pushHistory();
        let n = 0;
        for (const o of targets) {
          if (o.type === 'polyline') { o.props.closed = close; n++; }
        }
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { modified: n, closed: close } };
      } else if (sub === 'reverse') {
        const sel = (args[1] || '').toLowerCase();
        let target;
        if (sel === 'sel') {
          const ids = Document.getSelectedIds();
          if (ids.length === 0) return { ok: false, error: '没有选中对象' };
          target = Document.getObject(ids[0]);
        } else if (sel === 'id' && args[2]) {
          target = Document.getObject(args[2]);
          if (!target) return { ok: false, error: '对象不存在: ' + args[2] };
        } else return { ok: false, error: '用法: pedit reverse sel|id <id>' };
        if (target.type !== 'polyline') return { ok: false, error: 'reverse 仅支持 polyline' };
        Document.pushHistory();
        target.props.points.reverse();
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { reversed: target.id } };
      }
      return { ok: false, error: '未知 pedit 子命令: ' + sub };
    },

    // spline: 通过控制点的样条曲线（Catmull-Rom 近似，导出为 polyline）
    _spline(args) {
      if (args.length < 3) return { ok: false, error: '用法: spline x1,y1 x2,y2 x3,y3 ... [--closed] [--order N]' };
      try {
        let closed = false, order = 16;
        const pts = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.toLowerCase() === '--closed') { closed = true; continue; }
          if (a.toLowerCase() === '--order') { order = parseInt(args[++i]) || 16; continue; }
          pts.push(parsePt(a));
        }
        if (pts.length < 3) return { ok: false, error: '至少需要 3 个控制点' };
        // Catmull-Rom 样条采样
        const samples = catmullRom(pts, closed, order);
        Document.pushHistory();
        const o = Document.addObject('polyline', { points: samples, closed, spline: true, controlPoints: pts });
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { id: o.id, type: 'spline', samples: samples.length, closed } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // point: 单点对象（用小圆圈表示）
    _point(args) {
      if (args.length < 1) return { ok: false, error: '用法: point x,y' };
      try {
        const p = parsePt(args[0]);
        Document.pushHistory();
        const o = Document.addObject('point', { position: p });
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { id: o.id, type: 'point', position: p } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // block: 块定义（创建命名块）
    // block define NAME sel  |  block define NAME id <id1> [id <id2>...]
    _block(args) {
      if (args.length < 2) return { ok: false, error: '用法: block define NAME sel|id <id>...  |  block list  |  block delete NAME' };
      const sub = args[0].toLowerCase();
      if (sub === 'list') {
        return { ok: true, result: { blocks: Array.from(Document._blocks.entries()).map(([name, b]) => ({ name, base: b.base, objectCount: b.objects.length })) } };
      }
      if (sub === 'delete') {
        if (!args[1]) return { ok: false, error: '用法: block delete NAME' };
        if (!Document._blocks.has(args[1])) return { ok: false, error: '块不存在: ' + args[1] };
        Document.pushHistory();
        Document._blocks.delete(args[1]);
        return { ok: true, result: { deleted: args[1] } };
      }
      if (sub === 'define') {
        const name = args[1];
        const sel = (args[2] || '').toLowerCase();
        let targets = [];
        if (sel === 'sel') targets = Document.getSelectedIds().map(id => Document.getObject(id));
        else {
          // 收集后续的 id <id> 对
          for (let i = 2; i < args.length; i++) {
            if (args[i].toLowerCase() === 'id' && args[i + 1]) {
              const o = Document.getObject(args[++i]);
              if (o) targets.push(o);
            }
          }
        }
        if (targets.length === 0) return { ok: false, error: '没有可定义为块的对象' };
        // 取所有对象的中心作为基点
        let cx = 0, cy = 0, n = 0;
        for (const o of targets) {
          const bb = Renderer._boundingBox(o);
          if (bb) { cx += (bb.min.x + bb.max.x) / 2; cy += (bb.min.y + bb.max.y) / 2; n++; }
        }
        if (n > 0) { cx /= n; cy /= n; }
        const blockObjs = targets.map(o => ({
          type: o.type, layer: o.layer,
          props: JSON.parse(JSON.stringify(o.props)),
          // 相对基点的偏移
          dx: 0, dy: 0
        }));
        Document.pushHistory();
        Document._blocks.set(name, { name, base: { x: cx, y: cy }, objects: blockObjs });
        // 删除原图（已被吸入块定义）
        targets.forEach(o => Document.deleteObject(o.id));
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { block: name, base: { x: cx, y: cy }, objectCount: blockObjs.length } };
      }
      return { ok: false, error: '未知 block 子命令: ' + sub };
    },

    // insert: 插入块引用
    _insert(args) {
      if (args.length < 2) return { ok: false, error: '用法: insert NAME x,y [scale] [rotationDeg]' };
      try {
        const name = args[0];
        const pos = parsePt(args[1]);
        let scaleFactor = 1, rotDeg = 0;
        if (args[2]) scaleFactor = parseNum(args[2]);
        if (args[3]) rotDeg = parseNum(args[3]);
        const block = Document._blocks.get(name);
        if (!block) return { ok: false, error: '块不存在: ' + name };
        const rot = rotDeg * Math.PI / 180;
        Document.pushHistory();
        const newIds = [];
        for (const bo of block.objects) {
          const o = Document.addObject(bo.type, JSON.parse(JSON.stringify(bo.props)));
          // 应用平移：把对象移到 pos（相对基点）
          // 简化：把对象整体平移 (pos - base)，然后旋转 rotDeg，缩放 scaleFactor
          const sh = (pt) => {
            if (!pt || typeof pt.x !== 'number') return;
            // 相对 block.base 缩放和旋转
            const dx = pt.x - block.base.x, dy = pt.y - block.base.y;
            const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
            const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
            pt.x = pos.x + rx * scaleFactor;
            pt.y = pos.y + ry * scaleFactor;
          };
          const p = o.props;
          switch (o.type) {
            case 'line': sh(p.start); sh(p.end); break;
            case 'polyline': case 'hatch': (p.points || []).forEach(sh); break;
            case 'rect': sh(p.corner1); sh(p.corner2); break;
            case 'circle': case 'arc': case 'ellipse': sh(p.center); p.radius *= scaleFactor; if (o.type === 'ellipse') { p.radiusX *= scaleFactor; p.radiusY *= scaleFactor; } break;
            case 'text': sh(p.position); p.height *= scaleFactor; p.rotation = (p.rotation || 0) + rot; break;
            case 'dim': sh(p.start); sh(p.end); break;
            case 'point': sh(p.position); break;
          }
          newIds.push(o.id);
        }
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { block: name, position: pos, scale: scaleFactor, rotation: rotDeg, inserted: newIds.length, newIds } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // dist: 计算两点距离
    _dist(args) {
      if (args.length < 2) return { ok: false, error: '用法: dist x1,y1 x2,y2  |  dist id <id1> id <id2>' };
      try {
        if (args[0].toLowerCase() === 'id' && args[1] && args[2] === 'id' && args[3]) {
          const o1 = Document.getObject(args[1]);
          const o2 = Document.getObject(args[3]);
          if (!o1) return { ok: false, error: '对象不存在: ' + args[1] };
          if (!o2) return { ok: false, error: '对象不存在: ' + args[3] };
          const c1 = this._centerOf(o1), c2 = this._centerOf(o2);
          const d = dist(c1, c2);
          return { ok: true, result: { distance: d, from: c1, to: c2, unit: 'world' } };
        }
        const a = parsePt(args[0]), b = parsePt(args[1]);
        const d = dist(a, b);
        return { ok: true, result: { distance: d, from: a, to: b, unit: 'world' } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    // length: 计算对象长度（line / polyline / arc / circle 周长）
    _length(args) {
      if (args.length < 2) return { ok: false, error: '用法: length id <id>  |  length sel' };
      const sel = args[0].toLowerCase();
      let targets = [];
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        targets = [o];
      } else if (sel === 'sel') {
        targets = Document.getSelectedIds().map(id => Document.getObject(id));
      } else {
        return { ok: false, error: '用法: length id <id>  |  length sel' };
      }
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      const results = targets.map(o => ({ id: o.id, type: o.type, length: this._objLength(o) }));
      const total = results.reduce((s, r) => s + r.length, 0);
      return { ok: true, result: { items: results, total } };
    },

    _objLength(o) {
      const p = o.props;
      switch (o.type) {
        case 'line': return dist(p.start, p.end);
        case 'polyline': case 'hatch': {
          let s = 0;
          const pts = p.points || [];
          for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]);
          if (p.closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
          return s;
        }
        case 'rect': {
          const w = Math.abs(p.corner2.x - p.corner1.x);
          const h = Math.abs(p.corner2.y - p.corner1.y);
          return 2 * (w + h);
        }
        case 'circle': return 2 * Math.PI * p.radius;
        case 'arc': {
          let da = p.endAngle - p.startAngle;
          if (da < 0) da += 2 * Math.PI;
          return p.radius * da;
        }
        case 'ellipse': {
          // Ramanujan 近似
          const a = p.radiusX, b = p.radiusY;
          const h = Math.pow((a - b) / (a + b), 2);
          return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
        }
        case 'spline': {
          // spline 实际存为 polyline，调用 polyline 计算
          let s = 0;
          const pts = p.points || [];
          for (let i = 0; i < pts.length - 1; i++) s += dist(pts[i], pts[i + 1]);
          if (p.closed && pts.length > 2) s += dist(pts[pts.length - 1], pts[0]);
          return s;
        }
        default: return 0;
      }
    },

    _centerOf(o) {
      const bb = Renderer._boundingBox(o);
      if (!bb) return { x: 0, y: 0 };
      return { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2 };
    },

    // area: 计算对象面积
    _area(args) {
      if (args.length < 1) return { ok: false, error: '用法: area id <id>  |  area sel  |  area x1,y1 x2,y2 x3,y3 ...' };
      const sel = args[0].toLowerCase();
      let targets = [];
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        targets = [o];
      } else if (sel === 'sel') {
        targets = Document.getSelectedIds().map(id => Document.getObject(id));
      } else {
        // 当作点序列求多边形面积
        try {
          const pts = args.map(parsePt);
          if (pts.length < 3) return { ok: false, error: '面积至少需要 3 个点' };
          let s = 0;
          for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
          }
          return { ok: true, result: { area: Math.abs(s) / 2, points: pts.length, type: 'polygon' } };
        } catch (e) { return { ok: false, error: e.message }; }
      }
      if (targets.length === 0) return { ok: false, error: '没有选中对象' };
      const results = targets.map(o => ({ id: o.id, type: o.type, area: this._objArea(o) }));
      const total = results.reduce((s, r) => s + r.area, 0);
      return { ok: true, result: { items: results, total } };
    },

    _objArea(o) {
      const p = o.props;
      switch (o.type) {
        case 'circle': return Math.PI * p.radius * p.radius;
        case 'ellipse': return Math.PI * p.radiusX * p.radiusY;
        case 'rect': return Math.abs((p.corner2.x - p.corner1.x) * (p.corner2.y - p.corner1.y));
        case 'polyline': case 'hatch': case 'spline': {
          if (!p.closed) return 0;
          const pts = p.points || [];
          if (pts.length < 3) return 0;
          let s = 0;
          for (let i = 0; i < pts.length; i++) {
            const j = (i + 1) % pts.length;
            s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
          }
          return Math.abs(s) / 2;
        }
        case 'arc': {
          // 扇形面积
          let da = p.endAngle - p.startAngle;
          if (da < 0) da += 2 * Math.PI;
          return 0.5 * p.radius * p.radius * da;
        }
        default: return 0;
      }
    },

    // perim: 对象周长（与 length 相同，但矩形返回 2*(w+h)）
    _perim(args) { return this._length(args); },

    // list: 列出对象
    _list(args) {
      if (args.length === 0) {
        const objs = Array.from(Document.objects.values()).map(o => ({
          id: o.id, type: o.type, layer: o.layer, selected: o.selected,
          length: this._objLength(o), area: this._objArea(o)
        }));
        return { ok: true, result: { count: objs.length, objects: objs } };
      }
      const sel = args[0].toLowerCase();
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        const bb = Renderer._boundingBox(o);
        return { ok: true, result: {
          id: o.id, type: o.type, layer: o.layer, selected: o.selected,
          props: o.props,
          length: this._objLength(o),
          area: this._objArea(o),
          bbox: bb
        } };
      }
      if (sel === 'sel') {
        const objs = Document.getSelectedIds().map(id => Document.getObject(id)).map(o => ({
          id: o.id, type: o.type, layer: o.layer, length: this._objLength(o), area: this._objArea(o)
        }));
        return { ok: true, result: { count: objs.length, objects: objs } };
      }
      return { ok: false, error: '用法: list  |  list id <id>  |  list sel' };
    },

    // info: 总览
    _info(args) {
      const byType = {}, byLayer = {};
      for (const o of Document.objects.values()) {
        byType[o.type] = (byType[o.type] || 0) + 1;
        byLayer[o.layer] = (byLayer[o.layer] || 0) + 1;
      }
      return { ok: true, result: {
        totalObjects: Document.objects.size,
        byType, byLayer,
        layers: Document.layers.length,
        blocks: Document._blocks.size,
        currentLayer: Document.currentLayer,
        modified: Document.modified,
        view: Document.view,
        filePath: Document.filePath,
        undoStack: Document._history.length,
        redoStack: Document._redoStack.length
      } };
    },

    // bbox: 边界框
    _bbox(args) {
      if (args.length === 0) {
        // 全图 bbox
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const o of Document.objects.values()) {
          const bb = Renderer._boundingBox(o);
          if (!bb) continue;
          if (bb.min.x < minX) minX = bb.min.x;
          if (bb.min.y < minY) minY = bb.min.y;
          if (bb.max.x > maxX) maxX = bb.max.x;
          if (bb.max.y > maxY) maxY = bb.max.y;
        }
        if (!isFinite(minX)) return { ok: true, result: { bbox: null, hint: '空文档' } };
        const w = maxX - minX, h = maxY - minY;
        return { ok: true, result: { bbox: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }, width: w, height: h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 } };
      }
      const sel = args[0].toLowerCase();
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        const bb = Renderer._boundingBox(o);
        if (!bb) return { ok: false, error: '对象无边界框' };
        const w = bb.max.x - bb.min.x, h = bb.max.y - bb.min.y;
        return { ok: true, result: { id: o.id, type: o.type, bbox: bb, width: w, height: h, cx: (bb.min.x + bb.max.x) / 2, cy: (bb.min.y + bb.max.y) / 2 } };
      }
      if (sel === 'sel') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let count = 0;
        for (const id of Document.getSelectedIds()) {
          const o = Document.getObject(id);
          const bb = Renderer._boundingBox(o);
          if (!bb) continue;
          if (bb.min.x < minX) minX = bb.min.x;
          if (bb.min.y < minY) minY = bb.min.y;
          if (bb.max.x > maxX) maxX = bb.max.x;
          if (bb.max.y > maxY) maxY = bb.max.y;
          count++;
        }
        if (count === 0) return { ok: false, error: '没有选中对象' };
        const w = maxX - minX, h = maxY - minY;
        return { ok: true, result: { count, bbox: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }, width: w, height: h } };
      }
      return { ok: false, error: '用法: bbox  |  bbox id <id>  |  bbox sel' };
    },

    // find: 查找对象
    _find(args) {
      if (args.length < 2) return { ok: false, error: '用法: find type <type>  |  find layer <name>  |  find id <id>' };
      const sel = args[0].toLowerCase();
      if (sel === 'type') {
        const t = args[1].toLowerCase();
        const objs = Array.from(Document.objects.values()).filter(o => o.type === t || o.type === 'spline' && t === 'polyline')
          .map(o => ({ id: o.id, type: o.type, layer: o.layer }));
        return { ok: true, result: { count: objs.length, objects: objs } };
      }
      if (sel === 'layer') {
        const objs = Array.from(Document.objects.values()).filter(o => o.layer === args[1])
          .map(o => ({ id: o.id, type: o.type, layer: o.layer }));
        return { ok: true, result: { count: objs.length, objects: objs } };
      }
      if (sel === 'id' && args[1]) {
        const o = Document.getObject(args[1]);
        if (!o) return { ok: false, error: '对象不存在: ' + args[1] };
        return { ok: true, result: { found: true, object: { id: o.id, type: o.type, layer: o.layer, props: o.props } } };
      }
      if (sel === 'near' && args[1]) {
        // find near x,y [maxDist]
        try {
          const p = parsePt(args[1]);
          let maxD = args[2] ? parseNum(args[2]) : 10;
          let best = null, bestD = maxD;
          for (const o of Document.objects.values()) {
            const bb = Renderer._boundingBox(o);
            if (!bb) continue;
            const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2;
            const d = dist({ x: cx, y: cy }, p);
            if (d < bestD) { best = o; bestD = d; }
          }
          if (!best) return { ok: true, result: { found: false } };
          return { ok: true, result: { found: true, distance: bestD, object: { id: best.id, type: best.type, layer: best.layer } } };
        } catch (e) { return { ok: false, error: e.message }; }
      }
      return { ok: false, error: '未知 find 子命令: ' + sel };
    },

    // count: 统计
    _count(args) {
      const byType = {}, byLayer = {};
      for (const o of Document.objects.values()) {
        byType[o.type] = (byType[o.type] || 0) + 1;
        byLayer[o.layer] = (byLayer[o.layer] || 0) + 1;
      }
      if (args.length > 0) {
        const sel = args[0].toLowerCase();
        if (sel === 'type' && args[1]) return { ok: true, result: { type: args[1], count: byType[args[1]] || 0 } };
        if (sel === 'layer' && args[1]) return { ok: true, result: { layer: args[1], count: byLayer[args[1]] || 0 } };
      }
      return { ok: true, result: { total: Document.objects.size, byType, byLayer } };
    },

    // id: 查询指定坐标下的对象
    _idAt(args) {
      if (args.length < 1) return { ok: false, error: '用法: id x,y [maxDist]' };
      try {
        const p = parsePt(args[0]);
        const maxD = args[1] ? parseNum(args[1]) : 10;
        const found = [];
        for (const o of Document.objects.values()) {
          const bb = Renderer._boundingBox(o);
          if (!bb) continue;
          if (p.x >= bb.min.x - maxD && p.x <= bb.max.x + maxD && p.y >= bb.min.y - maxD && p.y <= bb.max.y + maxD) {
            found.push({ id: o.id, type: o.type, layer: o.layer });
          }
        }
        return { ok: true, result: { point: p, count: found.length, objects: found } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _snap(args) {
      if (args.length === 0) return { ok: false, error: '用法: snap on|off|status  |  snap endpoint|midpoint|center|intersection|nearest' };
      const sub = args[0].toLowerCase();
      if (sub === 'on') { Document._snapEnabled = true; return { ok: true, result: { snap: true } }; }
      if (sub === 'off') { Document._snapEnabled = false; return { ok: true, result: { snap: false } }; }
      if (sub === 'status') return { ok: true, result: { snap: !!Document._snapEnabled } };
      // 暂时仅记录模式（实际 snapping 在鼠标交互时实现）
      if (!Document._snapModes) Document._snapModes = new Set();
      if (['endpoint', 'midpoint', 'center', 'intersection', 'nearest', 'quadrant'].includes(sub)) {
        if (Document._snapModes.has(sub)) Document._snapModes.delete(sub);
        else Document._snapModes.add(sub);
        return { ok: true, result: { mode: sub, enabled: Document._snapModes.has(sub), active: Array.from(Document._snapModes) } };
      }
      return { ok: false, error: '未知 snap 子命令: ' + sub };
    },

    _zoom(args) {
      if (args.length < 1) return { ok: false, error: '用法: zoom factor  |  zoom extents  |  zoom window x1,y1 x2,y2  |  zoom in  |  zoom out' };
      const sub = args[0].toLowerCase();
      if (sub === 'extents' || sub === 'e' || sub === 'all') {
        Renderer.fit();
        return { ok: true, result: { zoom: Document.view.zoom, action: 'extents' } };
      }
      if (sub === 'in') {
        Renderer.zoomAt(1.5, { x: Renderer.width / 2, y: Renderer.height / 2 });
        return { ok: true, result: { zoom: Document.view.zoom, action: 'in' } };
      }
      if (sub === 'out') {
        Renderer.zoomAt(1 / 1.5, { x: Renderer.width / 2, y: Renderer.height / 2 });
        return { ok: true, result: { zoom: Document.view.zoom, action: 'out' } };
      }
      if (sub === 'window' || sub === 'w') {
        if (args.length < 3) return { ok: false, error: '用法: zoom window x1,y1 x2,y2' };
        try {
          const a = parsePt(args[1]), b = parsePt(args[2]);
          const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
          const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
          const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
          const w = Math.max(0.01, maxX - minX), h = Math.max(0.01, maxY - minY);
          const zx = Renderer.width / w, zy = Renderer.height / h;
          Document.view.zoom = Math.min(zx, zy, 10000);
          Document.view.panX = -cx;
          Document.view.panY = -cy;
          Renderer.render();
          return { ok: true, result: { zoom: Document.view.zoom, action: 'window', view: Document.view } };
        } catch (e) { return { ok: false, error: e.message }; }
      }
      try {
        const f = parseNum(args[0]);
        Renderer.zoomAt(f, { x: Renderer.width / 2, y: Renderer.height / 2 });
        return { ok: true, result: { zoom: Document.view.zoom, factor: f } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _pan(args) {
      if (args.length < 1) return { ok: false, error: '用法: pan dx,dy' };
      try {
        const p = parsePt(args[0]);
        Renderer.pan(p.x * Document.view.zoom, -p.y * Document.view.zoom);
        return { ok: true, result: { pan: p } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _grid(args) {
      if (args.length === 0) return { ok: false, error: '用法: grid on|off' };
      const v = args[0].toLowerCase() === 'on';
      // Store on document.meta
      Document._showGrid = v;
      Renderer.render();
      return { ok: true, result: { grid: v } };
    },

    // DXF 导入：从文件读取 DXF 文本并解析为对象
    // 用法: dxfin                (打开文件对话框)
    //       dxfin <filepath>     (从指定路径导入)
    _dxfin(args) {
      if (args.length === 0) {
        return { ok: false, error: '请在界面点击 文件→导入 DXF 按钮，或通过 IPC 调用 cadAPI.importDxfDialog()' };
      }
      // 命令行仅支持已读取的 DXF 文本（通过 IPC 已读取并传入）
      // args[0] 形如 "path"; 但本上下文无法访问 fs，所以仅作为提示
      return { ok: false, error: '命令行不支持直接读取文件，请使用 文件→导入 DXF 按钮' };
    },

    // 填充图案库管理
    // 用法: hatchpattern list                 (列出所有图案)
    //       hatchpattern current              (查看当前选中对象的图案)
    //       hatchpattern set <name>           (为选中对象设置图案)
    //       hatchpattern set <name> id <id>   (为指定对象设置图案)
    _hatchpattern(args) {
      if (args.length === 0) return { ok: false, error: '用法: hatchpattern list|current|set <name> [id <id>]' };
      const sub = args[0].toLowerCase();
      const patterns = HatchPatterns.list();
      if (sub === 'list') {
        return { ok: true, result: patterns.map(p => `${p.name}: ${p.description}`) };
      }
      if (sub === 'current') {
        const sel = Document.getSelectedIds().map(id => Document.getObject(id)).filter(o => o && o.type === 'hatch');
        if (sel.length === 0) return { ok: false, error: '请先选中一个 hatch 对象' };
        return { ok: true, result: sel.map(o => ({ id: o.id, pattern: o.props.pattern || 'ansi31' })) };
      }
      if (sub === 'set') {
        if (!args[1]) return { ok: false, error: '用法: hatchpattern set <name> [id <id>]' };
        const name = args[1].toLowerCase();
        if (!HatchPatterns.get(name)) return { ok: false, error: '未知图案: ' + name + '。使用 hatchpattern list 查看可用图案' };
        let targets;
        if (args[2] && args[2].toLowerCase() === 'id' && args[3]) {
          const o = Document.getObject(args[3]);
          if (!o) return { ok: false, error: '对象不存在' };
          if (o.type !== 'hatch') return { ok: false, error: '对象不是 hatch 类型' };
          targets = [o];
        } else {
          targets = Document.getSelectedIds().map(id => Document.getObject(id)).filter(o => o && o.type === 'hatch');
          if (targets.length === 0) return { ok: false, error: '请先选中一个 hatch 对象' };
        }
        Document.pushHistory();
        for (const o of targets) o.props.pattern = name;
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { updated: targets.length, pattern: name } };
      }
      return { ok: false, error: '未知子命令: ' + sub };
    },

    _help(cmd) {
      const help = {
        // === 绘图 ===
        line: 'line x1,y1 x2,y2',
        polyline: 'polyline x1,y1 x2,y2 [x3,y3 ...] [--closed]',
        rect: 'rect x1,y1 x2,y2',
        circle: 'circle cx,cy radius',
        arc: 'arc cx,cy radius startDeg endDeg',
        ellipse: 'ellipse cx,cy rx ry [rotationDeg]',
        spline: 'spline x1,y1 x2,y2 x3,y3 ... [--closed] [--order N]',
        text: 'text x,y "content" [height] [rotationDeg]',
        dim: 'dim x1,y1 x2,y2 [offset]  (对齐标注)',
        dimalign: 'dimalign x1,y1 x2,y2 [offset]  (对齐标注, 同 dim)',
        dimlinear: 'dimlinear h|v x1,y1 x2,y2 [offset]  (h=水平 v=垂直)',
        dimradius: 'dimradius id <id> [angleDeg]  (半径标注, 仅 circle/arc)',
        dimdiameter: 'dimdiameter id <id> [angleDeg]  (直径标注, 仅 circle/arc)',
        dimangle: 'dimangle vx,vy x1,y1 x2,y2 [offset]  (角度标注, 顶点+两边端点)',
        dimleader: 'dimleader x,y x2,y2 "text"  (引线标注)',
        hatch: 'hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n] [--pattern NAME] [--closed]',
        point: 'point x,y',
        // === 文件 ===
        dxfin: 'dxfin (DXF 导入: 通过界面 文件→导入 DXF)',
        dxfout: 'dxfout (DXF 导出: 通过界面 文件→导出 DXF)',
        hatchpattern: 'hatchpattern list|current|set <name> [id <id>]',
        // === 编辑 ===
        move: 'move sel|all|id <id> dx,dy',
        rotate: 'rotate sel|all angleDeg [cx,cy]',
        scale: 'scale sel|all factor [cx,cy]',
        mirror: 'mirror sel|all x1,y1 x2,y2',
        copy: 'copy sel [dx,dy]  |  copy id <id> [dx,dy]  |  copy all [dx,dy]',
        offset: 'offset distance sel|id <id>',
        array: 'array rect sel cols rows dx,dy  |  array polar sel count cx,cy [startDeg] [totalDeg]',
        fillet: 'fillet radius sel|id <id> [id <id2>]',
        chamfer: 'chamfer d1 sel [d2]  |  chamfer d1 id <id1> id <id2> [d2]',
        trim: 'trim sel  |  trim id <id> id <cuttingId>',
        extend: 'extend sel  |  extend id <id> id <boundaryId>',
        break: 'break id <id> x,y [x2,y2]',
        join: 'join sel  |  join id <id1> id <id2> [id <id3>...]',
        explode: 'explode sel  |  explode id <id>  (把 polyline/rect/hatch 拆为 line)',
        pedit: 'pedit join|close|open|reverse sel|id <id>',
        // === 块 ===
        block: 'block define NAME sel|id <id>...  |  block list  |  block delete NAME',
        insert: 'insert NAME x,y [scale] [rotationDeg]',
        // === 选择 ===
        select: 'select all|clear|id <id> [--add]|layer <name>',
        // === 删除 ===
        delete: 'delete sel|id <id>',
        clear: 'clear (清空所有对象)',
        // === 撤销 ===
        undo: 'undo (撤销上一步)',
        redo: 'redo (重做)',
        // === 图层 ===
        layer: 'layer new|delete|current|color|on|off|lock|list NAME [...]',
        // === 视图 ===
        zoom: 'zoom factor  |  zoom extents  |  zoom window',
        pan: 'pan dx,dy',
        fit: 'fit (自适应视图)',
        grid: 'grid on|off',
        snap: 'snap on|off|status|endpoint|midpoint|center|intersection|nearest',
        // === 查询 ===
        dist: 'dist x1,y1 x2,y2  |  dist id <id1> id <id2>',
        length: 'length id <id>  |  length sel',
        area: 'area id <id>  |  area sel  |  area x1,y1 x2,y2 x3,y3 ...',
        perim: 'perim id <id>  |  perim sel',
        list: 'list  |  list id <id>  |  list sel',
        info: 'info (文档总览)',
        bbox: 'bbox  |  bbox id <id>  |  bbox sel',
        find: 'find type <type>  |  find layer <name>  |  find id <id>  |  find near x,y [maxDist]',
        count: 'count  |  count type <type>  |  count layer <name>',
        id: 'id x,y [maxDist] (查询指定坐标下的对象)'
      };
      if (cmd && help[cmd.toLowerCase()]) return { ok: true, result: help[cmd.toLowerCase()] };
      return { ok: true, result: help };
    }
  };

  // =========================================================================
  // 6. UI CONTROLLER
  // =========================================================================

  const UI = {
    init() {
      // Tabs
      document.querySelectorAll('.cad-tab').forEach(t => {
        t.addEventListener('click', () => {
          document.querySelectorAll('.cad-tab').forEach(x => x.classList.remove('active'));
          t.classList.add('active');
          const tab = t.getAttribute('data-tab');
          document.getElementById('panel-layers').classList.toggle('hidden', tab !== 'layers');
          document.getElementById('panel-objects').classList.toggle('hidden', tab !== 'objects');
        });
      });

      // Layer toolbar buttons
      document.getElementById('btn-layer-new').addEventListener('click', () => {
        const name = prompt('图层名称:');
        if (!name) return;
        if (Document.addLayer(name, '#4f8cff')) {
          Document.setCurrentLayer(name);
          this.refreshLayers();
          this.setStatus(`新建图层: ${name}`, 'success');
        } else {
          this.setStatus('图层已存在', 'error');
        }
      });

      document.getElementById('btn-layer-delete').addEventListener('click', () => {
        if (Document.layers.length <= 1) { this.setStatus('至少保留一个图层', 'error'); return; }
        if (Document.deleteLayer(Document.currentLayer)) {
          this.refreshLayers();
          this.setStatus(`删除图层: ${Document.currentLayer}`, 'success');
        }
      });

      document.getElementById('btn-layer-current').addEventListener('click', () => {
        // No-op: clicking a row already sets current. Kept for symmetry.
        this.refreshLayers();
      });

      // Object toolbar
      document.getElementById('btn-obj-select-all').addEventListener('click', () => {
        Document.selectAll();
        this.refreshObjects();
        Renderer.render();
      });
      document.getElementById('btn-obj-clear-sel').addEventListener('click', () => {
        Document.clearSelection();
        this.refreshObjects();
        Renderer.render();
      });

      // Tool buttons → fill command input
      document.querySelectorAll('.cad-tool-btn[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => {
          const cmd = btn.getAttribute('data-cmd');
          const input = document.getElementById('cmd-input');
          const templates = {
            line: 'line 0,0 100,0',
            polyline: 'polyline 0,0 100,0 100,50 --closed',
            rect: 'rect 0,0 100,50',
            circle: 'circle 50,50 25',
            arc: 'arc 50,50 25 0 90',
            ellipse: 'ellipse 50,50 30 20',
            text: 'text 10,10 "CIPYP" 12',
            dim: 'dim 0,0 100,0 20',
            hatch: 'hatch 0,0 100,0 100,50 0,50 --angle 45 --spacing 5',
            move: 'move sel 10,0',
            rotate: 'rotate sel 30',
            scale: 'scale sel 1.5',
            mirror: 'mirror sel 0,0 100,0',
            delete: 'delete sel',
            clear: 'clear'
          };
          input.value = templates[cmd] || cmd;
          input.focus();
        });
      });

      // Command input
      const cmdInput = document.getElementById('cmd-input');
      cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const line = cmdInput.value;
          if (!line.trim()) return;
          this.logCmd(line);
          const res = Executor.execute(line);
          if (res.ok) {
            this.logOut(`✓ ${typeof res.result === 'object' ? JSON.stringify(res.result) : res.result}`);
            this.setStatus('就绪', 'success');
          } else {
            this.logErr(`✗ ${res.error}`);
            this.setStatus(res.error, 'error');
          }
          cmdInput.value = '';
          this.refreshLayers();
          this.refreshObjects();
          this.refreshStatus();
        }
      });

      // ---- 工程标题更新（保存/加载后更新 #doc-name） ----
      function updateDocTitle(filePath) {
        const el = document.getElementById('doc-name');
        if (!el) return;
        if (!filePath) { el.textContent = '未命名工程'; return; }
        // 取文件名（兼容 Windows 反斜杠与 POSIX 正斜杠）
        const parts = String(filePath).split(/[\\/]/);
        el.textContent = parts[parts.length - 1] || '未命名工程';
      }

      // Title bar buttons
      document.getElementById('btn-fit').addEventListener('click', () => { Renderer.fit(); });
      document.getElementById('btn-save').addEventListener('click', async () => {
        const r = await window.cadAPI.saveProjectDialog();
        if (!r || !r.ok || !r.path) return;
        const res = await window.cadAPI.saveProject(r.path);
        if (res.ok) {
          Document.modified = false;
          Document.filePath = r.path;
          updateDocTitle(r.path);
          this.setStatus('已保存: ' + r.path, 'success');
        } else this.setStatus('保存失败: ' + res.error, 'error');
      });
      document.getElementById('btn-export-png').addEventListener('click', async () => {
        const r = await window.cadAPI.saveImageDialog('export.png', 'PNG');
        if (!r || !r.ok || !r.path) return;
        const res = await window.cadAPI.exportImage(r.path, 'png');
        if (res.ok) this.setStatus('已导出 PNG: ' + r.path, 'success');
        else this.setStatus('导出失败: ' + res.error, 'error');
      });
      document.getElementById('btn-export-dxf').addEventListener('click', async () => {
        const r = await window.cadAPI.saveImageDialog('export.dxf', 'DXF');
        if (!r || !r.ok || !r.path) return;
        const res = await window.cadAPI.exportDxf(r.path);
        if (res.ok) this.setStatus('已导出 DXF: ' + r.path, 'success');
        else this.setStatus('导出失败: ' + res.error, 'error');
      });
      // DXF 导入按钮
      const btnImportDxf = document.getElementById('btn-import-dxf');
      if (btnImportDxf) {
        btnImportDxf.addEventListener('click', async () => {
          const r = await window.cadAPI.importDxfDialog();
          if (!r || !r.ok) {
            if (r && r.canceled) return;  // 用户取消
            this.setStatus('导入失败: ' + (r ? r.error : '未知错误'), 'error');
            return;
          }
          this.setStatus(`已导入 DXF: ${r.imported} 个对象, ${r.layers.length} 个新图层`, 'success');
          this.logOut(`✓ DXF 导入完成: ${r.imported} 个对象, 新建图层: ${r.layers.join(', ') || '(无)'}`);
        });
      }
      document.getElementById('btn-clear-console').addEventListener('click', () => {
        document.getElementById('console-log').innerHTML = '';
      });

      // ---- 自定义窗口控制器按钮 ----
      // 平台检测：macOS 隐藏自定义窗口控制器（用红绿灯），并加 padding 防遮挡
      const isMac = navigator.userAgent.indexOf('Mac') >= 0;
      if (isMac) {
        document.getElementById('cad-titlebar').classList.add('platform-darwin');
      }
      // 更新最大化按钮图标
      function updateMaximizeIcon() {
        const btn = document.getElementById('btn-win-maximize');
        if (!btn) return;
        window.cadAPI.isMaximized().then(r => {
          const icon = btn.querySelector('i');
          if (icon) {
            icon.className = (r && r.maximized) ? 'fa-regular fa-window-restore' : 'fa-regular fa-square';
          }
        });
      }
      document.getElementById('btn-win-minimize').addEventListener('click', () => {
        window.cadAPI.minimize();
      });
      document.getElementById('btn-win-maximize').addEventListener('click', () => {
        window.cadAPI.maximizeToggle().then(() => updateMaximizeIcon());
      });
      // 监听主进程最大化状态变化
      if (window.cadAPI.onMaximizeChange) {
        window.cadAPI.onMaximizeChange(() => updateMaximizeIcon());
      }
      // 初始化最大化按钮图标
      setTimeout(updateMaximizeIcon, 200);

      // ---- 关闭逻辑：触发主进程 close 事件，由渲染进程显示保存提示 ----
      function requestClose() {
        // 调用 closeWindow（主进程会触发 close-requested 回到渲染进程）
        window.cadAPI.closeWindow();
      }
      document.getElementById('btn-close').addEventListener('click', requestClose);

      // ---- 保存提示模态框 ----
      const savePrompt = document.getElementById('cad-save-prompt');
      const promptMsg = document.getElementById('cad-save-prompt-msg');
      let closeAction = null; // 'save' | 'dontsave' | 'cancel'

      function showSavePrompt(hasUnsaved) {
        if (promptMsg) {
          promptMsg.textContent = hasUnsaved
            ? '当前工程有未保存的修改，是否保存？'
            : '是否保存当前工程？';
        }
        savePrompt.classList.remove('hidden');
      }
      function hideSavePrompt() {
        savePrompt.classList.add('hidden');
        closeAction = null;
      }
      // 三个按钮
      document.getElementById('cad-prompt-save').addEventListener('click', async () => {
        // 保存后关闭
        const r = await window.cadAPI.saveProjectDialog();
        if (!r || !r.ok || !r.path) {
          // 用户取消了保存对话框，停留在 CAD 窗口
          hideSavePrompt();
          return;
        }
        const res = await window.cadAPI.saveProject(r.path);
        if (res.ok) {
          Document.modified = false;
          Document.filePath = r.path;
          updateDocTitle(r.path);
          hideSavePrompt();
          window.cadAPI.confirmClose('close');
        } else {
          // 保存失败，停留在 CAD 窗口
          this.setStatus('保存失败: ' + (res.error || '未知错误'), 'error');
          hideSavePrompt();
        }
      });
      document.getElementById('cad-prompt-dontsave').addEventListener('click', () => {
        hideSavePrompt();
        window.cadAPI.confirmClose('close');
      });
      document.getElementById('cad-prompt-cancel').addEventListener('click', () => {
        hideSavePrompt();
        // 取消关闭，不做任何事
      });
      // 接收主进程的 close-requested 事件（用户点了窗口 X 按钮 或 Agent 调用 closeCipypCad）
      if (window.cadAPI.onCloseRequested) {
        window.cadAPI.onCloseRequested(() => {
          // 若工程无任何改动（包括从未保存），直接关闭
          if (!Document.modified) {
            window.cadAPI.confirmClose('close');
          } else {
            showSavePrompt(true);
          }
        });
      }

      // Console header collapse
      document.querySelector('.cad-console-header').addEventListener('click', (e) => {
        if (e.target.closest('.cad-icon-btn')) return;
        document.getElementById('cad-console').classList.toggle('collapsed');
      });

      // Canvas mouse events
      const canvas = document.getElementById('cad-canvas');
      let isPanning = false, lastX = 0, lastY = 0;
      let isBoxSelecting = false, boxStart = null;

      canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
          // Middle button or shift+left → pan
          isPanning = true; lastX = e.clientX; lastY = e.clientY;
          canvas.style.cursor = 'grabbing';
        } else if (e.button === 0) {
          isBoxSelecting = true;
          boxStart = { x: e.offsetX, y: e.offsetY };
        }
      });
      canvas.addEventListener('mousemove', (e) => {
        const wpt = Renderer.s2w({ x: e.offsetX, y: e.offsetY });
        document.getElementById('status-coord').textContent = `${wpt.x.toFixed(2)}, ${wpt.y.toFixed(2)}`;
        if (isPanning) {
          Renderer.pan(e.clientX - lastX, e.clientY - lastY);
          lastX = e.clientX; lastY = e.clientY;
        }
      });
      canvas.addEventListener('mouseup', (e) => {
        if (isPanning) {
          isPanning = false;
          canvas.style.cursor = 'crosshair';
        }
        if (isBoxSelecting && boxStart) {
          // Click (not drag) → try to pick object at point
          if (Math.abs(e.offsetX - boxStart.x) < 3 && Math.abs(e.offsetY - boxStart.y) < 3) {
            const picked = this._pickAt({ x: e.offsetX, y: e.offsetY });
            if (picked) {
              if (!e.ctrlKey) Document.clearSelection();
              picked.selected = !picked.selected;
              Renderer.render();
              this.refreshObjects();
            } else if (!e.ctrlKey) {
              Document.clearSelection();
              Renderer.render();
              this.refreshObjects();
            }
          } else {
            // Box select
            const r = Renderer.s2w(boxStart);
            const r2 = Renderer.s2w({ x: e.offsetX, y: e.offsetY });
            const minX = Math.min(r.x, r2.x), maxX = Math.max(r.x, r2.x);
            const minY = Math.min(r.y, r2.y), maxY = Math.max(r.y, r2.y);
            if (!e.ctrlKey) Document.clearSelection();
            for (const obj of Document.objects.values()) {
              const bb = Renderer._boundingBox(obj);
              if (!bb) continue;
              if (bb.min.x >= minX && bb.max.x <= maxX && bb.min.y >= minY && bb.max.y <= maxY) {
                obj.selected = true;
              }
            }
            Renderer.render();
            this.refreshObjects();
          }
        }
        isBoxSelecting = false; boxStart = null;
      });
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        Renderer.zoomAt(f, { x: e.offsetX, y: e.offsetY });
        this.refreshStatus();
      }, { passive: false });

      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === 'Delete') {
          const ids = Document.getSelectedIds();
          if (ids.length > 0) {
            ids.forEach(id => Document.deleteObject(id));
            Renderer.render();
            this.refreshObjects();
          }
        } else if (e.key === 'Escape') {
          Document.clearSelection();
          Renderer.render();
          this.refreshObjects();
        } else if (e.key === 'f' || e.key === 'F') {
          Renderer.fit();
        }
      });

      // Theme listener
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => Renderer.render());

      // IPC listeners (from main process, forwarded by Agent)
      window.cadAPI.onCommand((cmd) => {
        try {
          const res = Executor.execute(cmd);
          this.logCmd(`[IPC] ${cmd}`);
          if (res.ok) this.logOut(`✓ ${typeof res.result === 'object' ? JSON.stringify(res.result) : res.result}`);
          else this.logErr(`✗ ${res.error}`);
          this.refreshLayers();
          this.refreshObjects();
          this.refreshStatus();
        } catch (e) {
          this.logErr(`✗ ${e.message}`);
        }
      });

      this.refreshLayers();
      this.refreshObjects();
      this.refreshStatus();
    },

    _pickAt(screenPt) {
      // Pick topmost object within 5px of screenPt
      let best = null, bestDist = 6;
      for (const obj of Array.from(Document.objects.values()).reverse()) {
        if (!Renderer._isLayerVisible(obj)) continue;
        const bb = Renderer._boundingBox(obj);
        if (!bb) continue;
        const a = Renderer.w2s(bb.min), b = Renderer.w2s(bb.max);
        // Box containment check (rough)
        if (screenPt.x >= a.x - 5 && screenPt.x <= b.x + 5 && screenPt.y >= a.y - 5 && screenPt.y <= b.y + 5) {
          return obj;
        }
      }
      return null;
    },

    refreshLayers() {
      const list = document.getElementById('layer-list');
      list.innerHTML = '';
      Document.layers.forEach(l => {
        const row = document.createElement('div');
        row.className = 'cad-layer-row' + (l.name === Document.currentLayer ? ' current' : '');
        row.innerHTML = `
          <div class="cad-layer-color" style="background:${l.color}"></div>
          <span class="cad-layer-name">${escapeHtml(l.name)}</span>
          <span class="cad-layer-toggle ${l.visible ? '' : 'off'}" title="${l.visible ? '可见' : '隐藏'}"><i class="fa-solid ${l.visible ? 'fa-eye' : 'fa-eye-slash'}"></i></span>
          <span class="cad-layer-toggle ${l.locked ? '' : 'off'}" title="${l.locked ? '锁定' : '未锁'}"><i class="fa-solid ${l.locked ? 'fa-lock' : 'fa-lock-open'}"></i></span>`;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.cad-layer-toggle')) {
            // Toggle visibility
            Document.setLayerVisible(l.name, !l.visible);
            this.refreshLayers();
            Renderer.render();
            return;
          }
          Document.setCurrentLayer(l.name);
          this.refreshLayers();
          this.refreshStatus();
        });
        list.appendChild(row);
      });
    },

    refreshObjects() {
      const list = document.getElementById('object-list');
      list.innerHTML = '';
      const objs = Array.from(Document.objects.values()).reverse();
      document.getElementById('obj-count').textContent = `${Document.objects.size} 个对象`;
      const typeIcons = {
        line: 'fa-minus', polyline: 'fa-bezier-curve', rect: 'fa-square',
        circle: 'fa-circle', arc: 'fa-circle-half-stroke', ellipse: 'fa-egg',
        text: 'fa-font', dim: 'fa-ruler', hatch: 'fa-fill-drip'
      };
      for (const obj of objs) {
        const row = document.createElement('div');
        row.className = 'cad-obj-row' + (obj.selected ? ' selected' : '');
        row.innerHTML = `
          <span class="cad-obj-icon"><i class="fa-solid ${typeIcons[obj.type] || 'fa-vector-square'}"></i></span>
          <span class="cad-obj-id">${obj.id}</span>
          <span class="cad-obj-type">${escapeHtml(obj.type)} @ ${escapeHtml(obj.layer)}</span>`;
        row.addEventListener('click', (e) => {
          if (!e.ctrlKey) Document.clearSelection();
          obj.selected = !obj.selected;
          Renderer.render();
          this.refreshObjects();
        });
        list.appendChild(row);
      }
    },

    refreshStatus() {
      document.getElementById('status-zoom').textContent = `${(Document.view.zoom * 100).toFixed(0)}%`;
      document.getElementById('status-layer').textContent = Document.currentLayer;
      document.getElementById('status-sel').textContent = Document.getSelectedIds().length;
    },

    setStatus(msg, type) {
      const el = document.getElementById('status-msg');
      el.textContent = msg;
      el.classList.remove('error', 'success');
      if (type) el.classList.add(type);
    },

    logCmd(text) { this._log(text, 'cmd'); },
    logOut(text) { this._log(text, 'out'); },
    logErr(text) { this._log(text, 'err'); },
    _log(text, cls) {
      const log = document.getElementById('console-log');
      const div = document.createElement('div');
      div.className = `cad-log-line ${cls}`;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }
  };

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // =========================================================================
  // 7. IPC BRIDGE (expose to main process via executeJavaScript)
  // =========================================================================

  // Single command execution (synchronous return)
  window.cadExecuteCommand = function (cmd) {
    try {
      const res = Executor.execute(cmd);
      UI.refreshLayers();
      UI.refreshObjects();
      UI.refreshStatus();
      return res;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // Batch commands
  window.cadExecuteCommands = function (cmds) {
    const results = [];
    if (!Array.isArray(cmds)) return { ok: false, error: 'commands must be array' };
    for (const cmd of cmds) {
      try {
        const res = Executor.execute(cmd);
        results.push(res);
        if (!res.ok) {
          // Stop on first error? Continue per LLM preference. We continue.
        }
      } catch (e) {
        results.push({ ok: false, error: e.message });
      }
    }
    UI.refreshLayers();
    UI.refreshObjects();
    UI.refreshStatus();
    return { ok: true, results };
  };

  window.cadGetState = function () {
    return {
      ok: true,
      state: {
        objectCount: Document.objects.size,
        layerCount: Document.layers.length,
        currentLayer: Document.currentLayer,
        layers: Document.layers.map(l => ({ name: l.name, color: l.color, visible: l.visible, locked: l.locked })),
        selectedCount: Document.getSelectedIds().length,
        view: Document.view,
        modified: Document.modified,
        filePath: Document.filePath
      }
    };
  };

  window.cadGetObjectList = function () {
    const objs = [];
    for (const obj of Document.objects.values()) {
      objs.push({
        id: obj.id,
        type: obj.type,
        layer: obj.layer,
        selected: obj.selected,
        props: obj.props
      });
    }
    return { ok: true, objects: objs };
  };

  window.cadGetProjectJSON = function () {
    return { ok: true, data: Document.toJSON() };
  };

  window.cadLoadProjectJSON = function (data, filePath) {
    try {
      Document.loadJSON(data);
      Document.filePath = filePath || null;
      if (filePath) updateDocTitle(filePath);
      Renderer.fit();
      UI.refreshLayers();
      UI.refreshObjects();
      UI.refreshStatus();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  window.cadGetDxfString = function () {
    try { return { ok: true, dxf: DXFExporter.export() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  window.cadGetPNGDataUrl = function (width, height) {
    try {
      const w = width || 1920, h = height || 1080;
      const url = Renderer.exportPNG(w, h);
      return { ok: true, dataUrl: url };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  window.cadGetSVGString = function () {
    try { return { ok: true, svg: Renderer.exportSVG() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  // DXF 导入：从 DXF 文本解析并加入文档
  window.cadImportDxfString = function (dxfText, filePath) {
    try {
      const result = DXFImporter.import(dxfText);
      if (!result.objects.length && !result.layers.length) {
        return { ok: false, error: 'DXF 文件中未找到任何实体或图层' };
      }
      // 先创建文档中尚不存在的图层
      const newLayers = [];
      for (const layer of result.layers) {
        if (!Document.getLayer(layer.name)) {
          Document.addLayer(layer.name, layer.color);
          newLayers.push(layer.name);
        }
      }
      // 如果文档没有任何 layer，确保至少有 Layer0
      if (Document.layers.length === 0) Document.addLayer('Layer0', '#4f8cff');
      Document.pushHistory();
      // 添加所有对象
      const added = [];
      for (const obj of result.objects) {
        // 确保对象的 layer 存在（不存在则归到 Layer0）
        let layer = obj.layer;
        if (!Document.getLayer(layer)) layer = Document.layers[0].name;
        const o = Document.addObject(obj.type, obj.props, layer);
        added.push(o.id);
      }
      if (filePath) {
        Document.filePath = filePath;
        updateDocTitle(filePath);
      }
      Renderer.fit();
      UI.refreshLayers();
      UI.refreshObjects();
      UI.refreshStatus();
      return { ok: true, imported: result.objects.length, layers: newLayers };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // 获取填充图案列表（供 UI 选择器使用）
  window.cadGetHatchPatterns = function () {
    return { ok: true, patterns: HatchPatterns.list() };
  };

  // =========================================================================
  // 8. INIT
  // =========================================================================

  function getQuery(name) {
    const u = new URLSearchParams(location.search);
    return u.get(name);
  }

  async function start() {
    Document.init();
    Renderer.init(document.getElementById('cad-canvas'));
    UI.init();
    Renderer.fit();
    UI.logOut('CIPYP-CAD 已就绪。输入 help 查看命令列表。');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
