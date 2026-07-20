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

  // =========================================================================
  // 2. DOCUMENT MODEL
  // =========================================================================

  const Document = {
    objects: new Map(),    // id -> obj
    layers: [],            // [{ name, color, visible, locked }]
    currentLayer: null,
    view: { panX: 0, panY: 0, zoom: 1 },
    modified: false,

    init() {
      this.objects.clear();
      this.layers = [{ name: 'Layer0', color: '#4f8cff', visible: true, locked: false }];
      this.currentLayer = 'Layer0';
      this.view = { panX: 0, panY: 0, zoom: 1 };
      this.modified = false;
    },

    addObject(type, props) {
      const id = nextId();
      const obj = {
        id,
        type,
        layer: this.currentLayer,
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
        version: 1,
        objects: Array.from(this.objects.values()).map(o => ({
          id: o.id, type: o.type, layer: o.layer, props: o.props
        })),
        layers: this.layers.map(l => ({ name: l.name, color: l.color, visible: l.visible, locked: l.locked })),
        currentLayer: this.currentLayer,
        view: Object.assign({}, this.view)
      };
    },

    loadJSON(data) {
      if (!data || data.version !== 1) throw new Error('invalid project file');
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
      this.modified = false;
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
          // Linear dimension: from p.start to p.end, offset perpendicular by p.offset
          const a = this.w2s(p.start), b = this.w2s(p.end);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1) break;
          const nx = -dy / len, ny = dx / len;
          const offPx = (p.offset || 20);  // offset in screen pixels (default 20)
          const a2 = { x: a.x + nx * offPx, y: a.y + ny * offPx };
          const b2 = { x: b.x + nx * offPx, y: b.y + ny * offPx };
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 1;
          ctx.beginPath();
          // Extension lines
          ctx.moveTo(a.x, a.y); ctx.lineTo(a2.x, a2.y);
          ctx.moveTo(b.x, b.y); ctx.lineTo(b2.x, b2.y);
          // Dim line
          ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y);
          ctx.stroke();
          // Arrowheads (simple)
          ctx.fillStyle = this._layerColor(obj);
          this._arrow(a2, b2);
          this._arrow(b2, a2);
          // Text
          const realLen = dist(p.start, p.end);
          const txt = (p.prefix || '') + realLen.toFixed(2);
          ctx.font = `11px "Consolas", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, mid.x + nx * offPx, mid.y + ny * offPx - 2);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          break;
        }
        case 'hatch': {
          // Simple hatch: fill closed polyline region with parallel lines
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
          // Hatch lines at p.angle, spacing p.spacing (in world units)
          const ang = (p.angle != null ? p.angle : Math.PI / 4);
          const spacing = (p.spacing != null ? p.spacing : 5);
          // Get bounding box in world
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const w of p.points) {
            if (w.x < minX) minX = w.x; if (w.x > maxX) maxX = w.x;
            if (w.y < minY) minY = w.y; if (w.y > maxY) maxY = w.y;
          }
          // Convert to screen
          const sTL = this.w2s({ x: minX, y: maxY });
          const sBR = this.w2s({ x: maxX, y: minY });
          ctx.strokeStyle = this._layerColor(obj);
          ctx.lineWidth = 0.8;
          const cosA = Math.cos(ang), sinA = Math.sin(ang);
          // Compute hatch line spacing in screen px
          const spacingPx = spacing * Document.view.zoom;
          // Project bounding box onto hatch direction normal
          const corners = [sTL, { x: sBR.x, y: sTL.y }, sBR, { x: sTL.x, y: sBR.y }];
          let projections = corners.map(c => c.x * cosA + c.y * sinA);
          let pMin = Math.min(...projections), pMax = Math.max(...projections);
          ctx.beginPath();
          for (let pp = Math.floor(pMin / spacingPx) * spacingPx; pp <= pMax; pp += spacingPx) {
            // Line: x*cos + y*sin = pp  → perpendicular direction (cos, sin), direction (-sin, cos)
            const x1 = -sinA * 5000 + cosA * pp;
            const y1 = cosA * 5000 + sinA * pp;
            const x2 = sinA * 5000 + cosA * pp;
            const y2 = -cosA * 5000 + sinA * pp;
            ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          }
          ctx.stroke();
          ctx.restore();
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
        case 'dim': pts = [p.start, p.end]; break;
        case 'hatch': pts = p.points ? p.points.slice() : []; break;
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
      // HEADER section
      out += '0\nSECTION\n2\nHEADER\n';
      out += dxfPair(9, '$ACADVER');
      out += dxfPair(1, 'AC1009'); // R12
      out += dxfPair(9, '$INSBASE');
      out += dxfPair(10, '0.0');
      out += dxfPair(20, '0.0');
      out += dxfPair(30, '0.0');
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
            // Export as 2 lines + text
            {
              const a = p.start, b = p.end;
              const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              const len = dist(a, b);
              out += '0\nLINE\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(a.x)); out += dxfPair(20, fnum(a.y)); out += dxfPair(30, '0.0');
              out += dxfPair(11, fnum(b.x)); out += dxfPair(21, fnum(b.y)); out += dxfPair(31, '0.0');
              out += '0\nTEXT\n';
              out += dxfPair(8, lname);
              out += dxfPair(62, color.toString());
              out += dxfPair(10, fnum(mid.x)); out += dxfPair(20, fnum(mid.y)); out += dxfPair(30, '0.0');
              out += dxfPair(40, '10');
              out += dxfPair(1, (p.prefix || '') + len.toFixed(2));
              out += dxfPair(50, '0');
            }
            break;
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
        }
      }
      out += '0\nENDSEC\n';
      out += '0\nEOF\n';
      return out;
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
        case 'hatch': return this._hatch(args);
        case 'layer': return this._layer(args);
        case 'select': case 'sel': return this._select(args);
        case 'move': return this._move(args);
        case 'rotate': return this._rotate(args);
        case 'scale': return this._scale(args);
        case 'mirror': return this._mirror(args);
        case 'delete': return this._delete(args);
        case 'clear': return this._clear();
        case 'zoom': return this._zoom(args);
        case 'pan': return this._pan(args);
        case 'fit': Renderer.fit(); return { ok: true, result: 'view fitted' };
        case 'grid': return this._grid(args);
        case 'help': return this._help(args[0]);
        default:
          return { ok: false, error: `未知命令: ${cmd}。输入 help 查看可用命令` };
      }
    },

    _line(args) {
      if (args.length < 2) return { ok: false, error: '用法: line x1,y1 x2,y2' };
      try {
        const a = parsePt(args[0]), b = parsePt(args[1]);
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
        const o = Document.addObject('polyline', { points: pts, closed });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'polyline', points: pts.length, closed } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _rect(args) {
      if (args.length < 2) return { ok: false, error: '用法: rect x1,y1 x2,y2' };
      try {
        const a = parsePt(args[0]), b = parsePt(args[1]);
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
        const o = Document.addObject('dim', { start: a, end: b, offset, prefix: '' });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'dim', length: dist(a, b) } };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    _hatch(args) {
      if (args.length < 3) return { ok: false, error: '用法: hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n] [--closed]' };
      try {
        let angle = Math.PI / 4;
        let spacing = 5;
        let closed = true;
        const pts = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a.toLowerCase() === '--angle') { angle = parseNum(args[++i]) * Math.PI / 180; continue; }
          if (a.toLowerCase() === '--spacing') { spacing = parseNum(args[++i]); continue; }
          if (a.toLowerCase() === '--closed') { closed = true; continue; }
          if (a.toLowerCase() === '--open') { closed = false; continue; }
          pts.push(parsePt(a));
        }
        if (pts.length < 3) return { ok: false, error: '填充至少需要 3 个点' };
        const o = Document.addObject('hatch', { points: pts, angle, spacing, closed });
        Renderer.render();
        return { ok: true, result: { id: o.id, type: 'hatch', points: pts.length } };
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
          if (!Document.addLayer(name, color)) return { ok: false, error: '图层已存在: ' + name };
          UI.refreshLayers();
          return { ok: true, result: { layer: name, color } };
        }
        case 'delete': case 'del': {
          if (args.length < 2) return { ok: false, error: '用法: layer delete NAME' };
          if (!Document.deleteLayer(args[1])) return { ok: false, error: '无法删除图层 (Layer0 不可删除或图层不存在)' };
          UI.refreshLayers();
          return { ok: true, result: { deleted: args[1] } };
        }
        case 'current': case 'set': {
          if (args.length < 2) return { ok: false, error: '用法: layer current NAME' };
          if (!Document.setCurrentLayer(args[1])) return { ok: false, error: '图层不存在: ' + args[1] };
          UI.refreshLayers();
          return { ok: true, result: { current: args[1] } };
        }
        case 'color': {
          if (args.length < 3) return { ok: false, error: '用法: layer color NAME COLOR' };
          if (!Document.setLayerColor(args[1], parseColor(args[2]))) return { ok: false, error: '图层不存在: ' + args[1] };
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], color: args[2] } };
        }
        case 'on': {
          if (args.length < 2) return { ok: false, error: '用法: layer on NAME' };
          if (!Document.setLayerVisible(args[1], true)) return { ok: false, error: '图层不存在: ' + args[1] };
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], visible: true } };
        }
        case 'off': {
          if (args.length < 2) return { ok: false, error: '用法: layer off NAME' };
          if (!Document.setLayerVisible(args[1], false)) return { ok: false, error: '图层不存在: ' + args[1] };
          UI.refreshLayers();
          Renderer.render();
          return { ok: true, result: { layer: args[1], visible: false } };
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
        case 'dim': sh(p.start); sh(p.end); break;
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
        case 'dim': ro(p.start); ro(p.end); break;
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
        case 'dim': sc(p.start); sc(p.end); break;
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
          case 'dim': mp(p.start); mp(p.end); break;
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
        ids.forEach(id => Document.deleteObject(id));
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { deleted: ids.length } };
      }
      if (sel === 'id' && args[1]) {
        if (!Document.deleteObject(args[1])) return { ok: false, error: '对象不存在: ' + args[1] };
        Renderer.render();
        UI.refreshObjects();
        return { ok: true, result: { deleted: args[1] } };
      }
      return { ok: false, error: '未知选择: ' + sel };
    },

    _clear() {
      const n = Document.objects.size;
      Document.clear();
      Renderer.render();
      UI.refreshObjects();
      return { ok: true, result: { cleared: n } };
    },

    _zoom(args) {
      if (args.length < 1) return { ok: false, error: '用法: zoom factor' };
      try {
        const f = parseNum(args[0]);
        Renderer.zoomAt(f, { x: Renderer.width / 2, y: Renderer.height / 2 });
        return { ok: true, result: { zoom: Document.view.zoom } };
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

    _help(cmd) {
      const help = {
        line: 'line x1,y1 x2,y2',
        polyline: 'polyline x1,y1 x2,y2 [x3,y3 ...] [--closed]',
        rect: 'rect x1,y1 x2,y2',
        circle: 'circle cx,cy radius',
        arc: 'arc cx,cy radius startDeg endDeg',
        ellipse: 'ellipse cx,cy rx ry [rotationDeg]',
        text: 'text x,y "content" [height] [rotationDeg]',
        dim: 'dim x1,y1 x2,y2 [offset]',
        hatch: 'hatch x1,y1 x2,y2 x3,y3 ... [--angle deg] [--spacing n]',
        layer: 'layer new|delete|current|color|on|off|list NAME [...]',
        select: 'select all|clear|id <id> [--add]|layer <name>',
        move: 'move sel|all|id <id> dx,dy',
        rotate: 'rotate sel|all angleDeg [cx,cy]',
        scale: 'scale sel|all factor [cx,cy]',
        mirror: 'mirror sel|all x1,y1 x2,y2',
        delete: 'delete sel|id <id>',
        clear: 'clear (清空所有对象)',
        zoom: 'zoom factor',
        pan: 'pan dx,dy',
        fit: 'fit (自适应视图)'
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
        modified: Document.modified
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

  window.cadLoadProjectJSON = function (data) {
    try {
      Document.loadJSON(data);
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
