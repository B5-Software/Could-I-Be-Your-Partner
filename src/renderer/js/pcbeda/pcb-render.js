// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - PCB canvas renderer (Canvas 2D, event-driven repaint, DPR aware)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');

  const LAYER_COLORS = {
    'F.Cu': '#c83434', 'B.Cu': '#3465c8',
    'In1.Cu': '#c87f34', 'In2.Cu': '#34a0c8', 'In3.Cu': '#8a4fd0', 'In4.Cu': '#4fb060',
    default: '#a05090'
  };

  const PcbRenderer = {
    canvas: null, ctx: null, width: 0, height: 0,
    view: { panX: 0, panY: 0, zoom: 10 }, // zoom: px per mm
    opts: {},
    _zoneCanvas: null,
    // 视图方向：'top'（默认从顶层看）/ 'bottom'（从底层看，X 轴镜像）
    // 工业标准：KiCad/Altium 的 "View Board from Bottom Side" (V+B)
    viewFromBottom: false,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this._zoneCanvas = document.createElement('canvas');
      this.resize();
      window.addEventListener('resize', () => this.resize());
    },

    resize() {
      if (!this.canvas) return;
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
      this.width = r.width; this.height = r.height;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    },

    // world → screen：底层视图时 X 轴镜像
    w2s(p) {
      const cx = this.width / 2, cy = this.height / 2;
      const wx = this.viewFromBottom ? -p.x : p.x;
      return { x: cx + (wx + this.view.panX) * this.view.zoom, y: cy + (p.y + this.view.panY) * this.view.zoom };
    },
    // screen → world：底层视图时 X 轴反镜像
    s2w(p) {
      const cx = this.width / 2, cy = this.height / 2;
      const wx = (p.x - cx) / this.view.zoom - this.view.panX;
      return { x: this.viewFromBottom ? -wx : wx, y: (p.y - cy) / this.view.zoom - this.view.panY };
    },
    zoomAt(factor, screenCenter) {
      const before = this.s2w(screenCenter);
      this.view.zoom = Geo.clamp(this.view.zoom * factor, 0.5, 800);
      const after = this.s2w(screenCenter);
      this.view.panX += after.x - before.x;
      this.view.panY += after.y - before.y;
      this.render();
    },

    // 设置视图方向 'top'|'bottom'|'toggle'，返回新状态
    setView(side) {
      if (side === 'toggle') this.viewFromBottom = !this.viewFromBottom;
      else if (side === 'bottom') this.viewFromBottom = true;
      else this.viewFromBottom = false;
      this.render();
      return this.viewFromBottom ? 'bottom' : 'top';
    },
    fit(bbox, padding) {
      if (!bbox || !isFinite(bbox.minX)) return;
      const pad = padding || 30;
      const w = Math.max(0.1, bbox.maxX - bbox.minX), h = Math.max(0.1, bbox.maxY - bbox.minY);
      this.view.zoom = Geo.clamp(Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h), 0.5, 800);
      const cxw = (bbox.minX + bbox.maxX) / 2, cyw = (bbox.minY + bbox.maxY) / 2;
      this.view.panX = this.width / 2 / this.view.zoom - cxw;
      this.view.panY = this.height / 2 / this.view.zoom - cyw;
      this.render();
    },

    cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    },

    layerColor(layerId) {
      return LAYER_COLORS[layerId] || LAYER_COLORS.default;
    },

    // opts: {board, fpLib, layerVisibility:{}, showRatsnest, ratsnestLines, highlightNet,
    //        selection:Set, drcMarkers:[], ghost, activeLayer, showGrid, model}
    render(opts) {
      if (opts) this.opts = opts;
      const o = this.opts || {};
      if (!this.ctx || !o.board) return;
      const ctx = this.ctx;
      ctx.fillStyle = this.cssVar('--pcb-canvas-bg', '#14171e');
      ctx.fillRect(0, 0, this.width, this.height);
      if (o.showGrid !== false) this._drawGrid();
      const board = o.board;
      const fpLib = o.fpLib;
      const vis = o.layerVisibility || {};
      const isVis = (id) => vis[id] !== false;

      // board fill
      this._drawOutlineFill(board);
      // zones
      for (const z of board.zones) {
        if (!isVis(z.layer) || !z.pts || z.pts.length < 3) continue;
        this._drawZone(board, z, o);
      }
      // traces
      for (const t of board.traces) {
        if (!isVis(t.layer)) continue;
        this._drawTrace(t, o);
      }
      // vias
      for (const v of board.vias) this._drawVia(v, o);
      // pads + components
      for (const comp of board.components) this._drawComponent(board, comp, fpLib, o);
      // outline
      this._drawOutline(board);
      // silkscreen
      if (vis['silk'] !== false) this._drawSilk(board, fpLib, o);
      // ratsnest
      if (o.showRatsnest && o.ratsnestLines) this._drawRatsnest(o.ratsnestLines);
      // drc markers
      if (o.drcMarkers) this._drawDrcMarkers(o.drcMarkers);
      // ghost preview
      if (o.ghost) this._drawGhost(o.ghost);
      // selection
      this._drawSelection(board, fpLib, o);
      // origin cross
      this._drawOrigin();
    },

    _drawGrid() {
      const ctx = this.ctx;
      const step0 = 1.27; // mm base
      let step = step0;
      while (step * this.view.zoom < 14) step *= 5;
      while (step * this.view.zoom > 70) step /= 5;
      const tl = this.s2w({ x: 0, y: 0 }), br = this.s2w({ x: this.width, y: this.height });
      const minor = this.cssVar('--pcb-grid-minor', '#222834');
      ctx.strokeStyle = minor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        const sx = this.w2s({ x, y: 0 }).x;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, this.height);
      }
      for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
        const sy = this.w2s({ x: 0, y }).y;
        ctx.moveTo(0, sy); ctx.lineTo(this.width, sy);
      }
      ctx.stroke();
      this._gridStep = step;
    },

    gridStep() { return this._gridStep || 1.27; },

    _drawOrigin() {
      const ctx = this.ctx;
      const p = this.w2s({ x: 0, y: 0 });
      ctx.strokeStyle = this.cssVar('--pcb-axis', '#4a5568');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - 8, p.y); ctx.lineTo(p.x + 8, p.y);
      ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x, p.y + 8);
      ctx.stroke();
    },

    _drawOutlineFill(board) {
      const ctx = this.ctx;
      if (!board.outline.pts || board.outline.pts.length < 3) return;
      ctx.beginPath();
      board.outline.pts.forEach((p, i) => {
        const s = this.w2s(p);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = this.cssVar('--pcb-board-bg', '#0e2a1c');
      ctx.fill();
    },

    _drawOutline(board) {
      const ctx = this.ctx;
      const pts = board.outline.pts;
      if (!pts || pts.length < 2) return;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const s = this.w2s(p);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      if (board.outline.closed !== false) ctx.closePath();
      ctx.strokeStyle = this.cssVar('--pcb-outline', '#e0c040');
      ctx.lineWidth = Math.max(1.5, 0.1 * this.view.zoom);
      ctx.stroke();
    },

    _netAlpha(obj, o) {
      if (!o.highlightNet) return 1;
      return (obj.net === o.highlightNet) ? 1 : 0.25;
    },

    _drawZone(board, z, o) {
      // offscreen: fill zone color, punch clearances, composite
      const zc = this._zoneCanvas;
      const dpr = window.devicePixelRatio || 1;
      if (zc.width !== this.canvas.width) { zc.width = this.canvas.width; zc.height = this.canvas.height; }
      const c2 = zc.getContext('2d');
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, this.width, this.height);
      const color = this.layerColor(z.layer);
      c2.globalAlpha = 0.45 * this._netAlpha(z, o);
      c2.fillStyle = color;
      c2.beginPath();
      z.pts.forEach((p, i) => {
        const s = this.w2s(p);
        if (i === 0) c2.moveTo(s.x, s.y); else c2.lineTo(s.x, s.y);
      });
      c2.closePath();
      c2.fill();
      // clearances via destination-out
      c2.globalAlpha = 1;
      c2.globalCompositeOperation = 'destination-out';
      const rules = board.designRules;
      const cl = z.clearance !== undefined ? z.clearance : rules.zoneClearance;
      const Model = global.PCBModel;
      const pads = Model.Board.allPads(board, o.fpLib);
      for (const p of pads) {
        if (!p.layers.includes(z.layer)) continue;
        if (p.net === z.net) continue;
        this._fillPadShapeOn(c2, p, cl);
      }
      for (const v of board.vias) {
        if (v.net === z.net) continue;
        c2.beginPath();
        const s = this.w2s(v);
        c2.arc(s.x, s.y, (v.diameter / 2 + cl) * this.view.zoom, 0, Math.PI * 2);
        c2.fill();
      }
      for (const t of board.traces) {
        if (t.layer !== z.layer || t.net === z.net) continue;
        c2.strokeStyle = '#000';
        c2.lineWidth = (t.width + 2 * cl) * this.view.zoom;
        c2.lineCap = 'round';
        c2.beginPath();
        t.pts.forEach((p, i) => {
          const s = this.w2s(p);
          if (i === 0) c2.moveTo(s.x, s.y); else c2.lineTo(s.x, s.y);
        });
        c2.stroke();
      }
      c2.globalCompositeOperation = 'source-over';
      // redraw zone outline thin
      this.ctx.drawImage(zc, 0, 0, this.width, this.height);
      // same-net thermal spokes hint: draw small cross markers (visual only)
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = 0.8 * this._netAlpha(z, o);
      ctx.strokeStyle = color;
      for (const p of pads) {
        if (p.net !== z.net || !p.layers.includes(z.layer)) continue;
        if (!Geo.pointInPolygon(p.x, p.y, z.pts)) continue;
        const s = this.w2s(p);
        const r = (Math.max(p.w, p.h) / 2 + cl) * this.view.zoom;
        ctx.lineWidth = Math.max(1, (z.thermalWidth || 0.25) * this.view.zoom);
        ctx.beginPath();
        ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x + r, s.y);
        ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x, s.y + r);
        ctx.stroke();
      }
      ctx.restore();
    },

    _fillPadShapeOn(c2, p, inflate) {
      const s = this.w2s(p);
      const z = this.view.zoom;
      const inf = inflate || 0;
      c2.beginPath();
      if (p.shape === 'circle') {
        c2.arc(s.x, s.y, (p.w / 2 + inf) * z, 0, Math.PI * 2);
      } else {
        const pts = this._padScreenPoly(p, inf);
        pts.forEach((q, i) => { if (i === 0) c2.moveTo(q.x, q.y); else c2.lineTo(q.x, q.y); });
        c2.closePath();
      }
      c2.fill();
    },

    _padScreenPoly(p, inflate) {
      const inf = inflate || 0;
      const hw = p.w / 2 + inf, hh = p.h / 2 + inf;
      const corners = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
      return corners.map(c => {
        const rp = Geo.rotatePoint(c.x, c.y, 0, 0, p.rot || 0);
        return this.w2s({ x: p.x + rp.x, y: p.y + rp.y });
      });
    },

    _drawTrace(t, o) {
      const ctx = this.ctx;
      if (!t.pts || t.pts.length < 2) return;
      ctx.save();
      ctx.globalAlpha = this._netAlpha(t, o);
      ctx.strokeStyle = this.layerColor(t.layer);
      ctx.lineWidth = Math.max(0.8, t.width * this.view.zoom);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      t.pts.forEach((p, i) => {
        const s = this.w2s(p);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();
      ctx.restore();
    },

    _drawVia(v, o) {
      const ctx = this.ctx;
      const s = this.w2s(v);
      ctx.save();
      ctx.globalAlpha = this._netAlpha(v, o);
      ctx.fillStyle = '#d8b64a';
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.2, v.diameter / 2 * this.view.zoom), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = this.cssVar('--pcb-canvas-bg', '#14171e');
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.6, v.drill / 2 * this.view.zoom), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    _drawComponent(board, comp, fpLib, o) {
      const fp = fpLib.generate(comp.footprint, comp.params || {});
      if (!fp) return;
      const ctx = this.ctx;
      const Model = global.PCBModel;
      const pads = Model.Board.allPads(board, fpLib).filter(p => p.ref === comp.ref);
      const vis = o.layerVisibility || {};
      for (const p of pads) {
        const layerId = p.smd ? (p.side === 'B' ? 'B.Cu' : 'F.Cu') : null;
        if (layerId && vis[layerId] === false) continue;
        ctx.save();
        ctx.globalAlpha = this._netAlpha(p, o);
        ctx.fillStyle = p.drill ? '#d8b64a' : this.layerColor(p.side === 'B' ? 'B.Cu' : 'F.Cu');
        if (p.shape === 'circle') {
          const s = this.w2s(p);
          ctx.beginPath();
          ctx.arc(s.x, s.y, Math.max(1, p.w / 2 * this.view.zoom), 0, Math.PI * 2);
          ctx.fill();
        } else {
          const pts = this._padScreenPoly(p, 0);
          ctx.beginPath();
          pts.forEach((q, i) => { if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
          ctx.closePath();
          ctx.fill();
        }
        if (p.drill) {
          const s = this.w2s(p);
          ctx.fillStyle = this.cssVar('--pcb-canvas-bg', '#14171e');
          ctx.beginPath();
          ctx.arc(s.x, s.y, Math.max(0.5, p.drill / 2 * this.view.zoom), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },

    _drawSilk(board, fpLib, o) {
      const ctx = this.ctx;
      const silkColor = this.cssVar('--pcb-silk', '#e8e8e8');
      const defW = Math.max(0.8, 0.15 * this.view.zoom);
      const strokeSegs = (segs) => {
        ctx.beginPath();
        for (const sg of segs) {
          const a = this.w2s({ x: sg.x1, y: sg.y1 }), b = this.w2s({ x: sg.x2, y: sg.y2 });
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      };
      ctx.strokeStyle = silkColor;
      ctx.lineWidth = defW;
      const Gerber = global.PCBGerber;
      for (const comp of board.components) {
        const fp = fpLib.generate(comp.footprint, comp.params || {});
        if (!fp) continue;
        const mirror = comp.side === 'B';
        const tx = (lx, ly) => {
          const mx = mirror ? -lx : lx;
          const rp = Geo.rotatePoint(mx, ly, 0, 0, comp.rot || 0);
          return { x: comp.x + rp.x, y: comp.y + rp.y };
        };
        ctx.save();
        if (comp.side === 'B') ctx.globalAlpha = 0.55;
        for (const s of fp.silk) {
          if (s.kind === 'line') {
            strokeSegs([{ x1: tx(s.pts[0].x, s.pts[0].y).x, y1: tx(s.pts[0].x, s.pts[0].y).y,
                          x2: tx(s.pts[1].x, s.pts[1].y).x, y2: tx(s.pts[1].x, s.pts[1].y).y }]);
          } else if (s.kind === 'rect') {
            const c = [tx(s.x, s.y), tx(s.x + s.w, s.y), tx(s.x + s.w, s.y + s.h), tx(s.x, s.y + s.h), tx(s.x, s.y)];
            ctx.beginPath();
            c.forEach((p, i) => { const q = this.w2s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
            ctx.stroke();
          } else if (s.kind === 'circle') {
            const cpt = tx(s.x, s.y);
            const sp = this.w2s(cpt);
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, s.r * this.view.zoom, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        // ref
        const rp = tx(fp.refPos.x, fp.refPos.y);
        if (Gerber && Gerber.textToSegments) {
          strokeSegs(Gerber.textToSegments(comp.ref, rp.x, rp.y, 1.2, comp.rot || 0, 'center'));
        }
        ctx.restore();
      }
      // user silk
      for (const sk of board.silkscreen) {
        ctx.save();
        if (sk.side === 'B') ctx.globalAlpha = 0.55;
        if (sk.kind === 'line' && sk.pts && sk.pts.length >= 2) {
          ctx.beginPath();
          sk.pts.forEach((p, i) => { const q = this.w2s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
          ctx.stroke();
        } else if (sk.kind === 'rect') {
          ctx.beginPath();
          const c = [{ x: sk.x, y: sk.y }, { x: sk.x + sk.w, y: sk.y }, { x: sk.x + sk.w, y: sk.y + sk.h }, { x: sk.x, y: sk.y + sk.h }, { x: sk.x, y: sk.y }];
          c.forEach((p, i) => { const q = this.w2s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
          ctx.stroke();
        } else if (sk.kind === 'circle') {
          const q = this.w2s(sk);
          ctx.beginPath(); ctx.arc(q.x, q.y, sk.r * this.view.zoom, 0, Math.PI * 2); ctx.stroke();
        } else if (sk.kind === 'text' && Gerber && Gerber.textToSegments) {
          strokeSegs(Gerber.textToSegments(sk.text, sk.x, sk.y, sk.size || 1.2, sk.rot || 0, 'left'));
        }
        ctx.restore();
      }
    },

    _drawRatsnest(lines) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = this.cssVar('--pcb-ratsnest', '#4fd0a0');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const l of lines) {
        const a = this.w2s({ x: l.x1, y: l.y1 }), b = this.w2s({ x: l.x2, y: l.y2 });
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.restore();
    },

    _drawDrcMarkers(markers) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = '#ff4040';
      ctx.lineWidth = 2;
      for (const m of markers) {
        const s = this.w2s(m);
        const r = (m.r || 1) * this.view.zoom;
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(6, r), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x - 5, s.y - 5); ctx.lineTo(s.x + 5, s.y + 5);
        ctx.moveTo(s.x + 5, s.y - 5); ctx.lineTo(s.x - 5, s.y + 5);
        ctx.stroke();
      }
      ctx.restore();
    },

    _drawGhost(gh) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#4fd0e0';
      ctx.lineWidth = Math.max(1, (gh.width || 0.25) * this.view.zoom);
      ctx.lineCap = 'round';
      if (gh.kind === 'trace' && gh.pts && gh.pts.length >= 2) {
        ctx.beginPath();
        gh.pts.forEach((p, i) => { const q = this.w2s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
        ctx.stroke();
      } else if (gh.kind === 'zone' && gh.pts && gh.pts.length >= 2) {
        ctx.beginPath();
        gh.pts.forEach((p, i) => { const q = this.w2s(p); if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y); });
        ctx.stroke();
      } else if (gh.kind === 'via') {
        const q = this.w2s(gh);
        ctx.fillStyle = '#4fd0e0';
        ctx.beginPath();
        ctx.arc(q.x, q.y, gh.diameter / 2 * this.view.zoom, 0, Math.PI * 2);
        ctx.fill();
      } else if (gh.kind === 'measure' && gh.pts && gh.pts.length === 2) {
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        const a = this.w2s(gh.pts[0]), b = this.w2s(gh.pts[1]);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const d = Geo.dist(gh.pts[0].x, gh.pts[0].y, gh.pts[1].x, gh.pts[1].y);
        ctx.fillStyle = '#4fd0e0';
        ctx.font = '12px sans-serif';
        ctx.fillText(d.toFixed(2) + ' mm', (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 8);
      } else if (gh.kind === 'box') {
        ctx.setLineDash([4, 3]);
        const a = this.w2s(gh.pts[0]), b = this.w2s(gh.pts[1]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.setLineDash([]);
      }
      ctx.restore();
    },

    _drawSelection(board, fpLib, o) {
      const sel = o.selection;
      if (!sel || !sel.size) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      const boxFor = (bb) => {
        const a = this.w2s({ x: bb.minX, y: bb.minY }), b = this.w2s({ x: bb.maxX, y: bb.maxY });
        ctx.strokeRect(a.x - 4, a.y - 4, (b.x - a.x) + 8, (b.y - a.y) + 8);
      };
      const Model = global.PCBModel;
      for (const id of sel) {
        const comp = board.components.find(c => c.id === id);
        if (comp) {
          const pads = Model.Board.allPads(board, fpLib).filter(p => p.ref === comp.ref);
          if (pads.length) boxFor(Geo.ptsBBox(pads));
          continue;
        }
        const tr = board.traces.find(t => t.id === id);
        if (tr) { boxFor(Geo.ptsBBox(tr.pts)); continue; }
        const via = board.vias.find(v => v.id === id);
        if (via) { boxFor({ minX: via.x - via.diameter / 2, minY: via.y - via.diameter / 2, maxX: via.x + via.diameter / 2, maxY: via.y + via.diameter / 2 }); continue; }
        const zn = board.zones.find(z => z.id === id);
        if (zn && zn.pts.length) { boxFor(Geo.ptsBBox(zn.pts)); continue; }
        const sk = board.silkscreen.find(s => s.id === id);
        if (sk) {
          const bb = sk.kind === 'line' ? Geo.ptsBBox(sk.pts) :
            (sk.kind === 'rect' ? { minX: sk.x, minY: sk.y, maxX: sk.x + sk.w, maxY: sk.y + sk.h } :
             { minX: sk.x - 1, minY: sk.y - 1, maxX: sk.x + 2, maxY: sk.y + 1 });
          boxFor(bb);
        }
      }
      ctx.restore();
    },

    // hit test: returns {type:'pad'|'trace'|'via'|'zone'|'comp'|'silk', obj, pad?} or null
    pick(board, fpLib, wx, wy, tolMm) {
      const tol = tolMm !== undefined ? tolMm : 8 / this.view.zoom;
      const Model = global.PCBModel;
      // pads first (topmost)
      const pads = Model.Board.allPads(board, fpLib);
      for (let i = pads.length - 1; i >= 0; i--) {
        const p = pads[i];
        if (Math.abs(wx - p.x) <= p.w / 2 + tol && Math.abs(wy - p.y) <= p.h / 2 + tol) {
          const comp = board.components.find(c => c.ref === p.ref);
          return { type: 'pad', pad: p, obj: comp };
        }
      }
      // vias
      for (let i = board.vias.length - 1; i >= 0; i--) {
        const v = board.vias[i];
        if (Geo.dist(wx, wy, v.x, v.y) <= v.diameter / 2 + tol) return { type: 'via', obj: v };
      }
      // traces
      for (let i = board.traces.length - 1; i >= 0; i--) {
        const t = board.traces[i];
        for (let j = 0; j < t.pts.length - 1; j++) {
          if (Geo.pointToSegmentDist(wx, wy, t.pts[j].x, t.pts[j].y, t.pts[j + 1].x, t.pts[j + 1].y) <= t.width / 2 + tol) {
            return { type: 'trace', obj: t };
          }
        }
      }
      // silkscreen
      for (let i = board.silkscreen.length - 1; i >= 0; i--) {
        const sk = board.silkscreen[i];
        if (sk.kind === 'line') {
          for (let j = 0; j < sk.pts.length - 1; j++) {
            if (Geo.pointToSegmentDist(wx, wy, sk.pts[j].x, sk.pts[j].y, sk.pts[j + 1].x, sk.pts[j + 1].y) <= tol + 0.1) return { type: 'silk', obj: sk };
          }
        } else if ((sk.kind === 'text' || sk.kind === 'circle' || sk.kind === 'rect') &&
                   Math.abs(wx - sk.x) < 3 && Math.abs(wy - sk.y) < 3) {
          return { type: 'silk', obj: sk };
        }
      }
      // zones (lowest)
      for (let i = board.zones.length - 1; i >= 0; i--) {
        const z = board.zones[i];
        if (z.pts.length >= 3 && Geo.pointInPolygon(wx, wy, z.pts)) return { type: 'zone', obj: z };
      }
      return null;
    },

    // export PNG data URL of board area
    exportPNG(board, fpLib, pixelW, opts) {
      const off = document.createElement('canvas');
      const w = pixelW || 1920;
      const bb = global.PCBModel.Board.boardBBox(board, fpLib);
      const bw = bb.maxX - bb.minX + 6, bh = bb.maxY - bb.minY + 6;
      const h = Math.round(w * bh / bw);
      off.width = w; off.height = h;
      const ctx2 = off.getContext('2d');
      // temporarily rebind
      const saved = { canvas: this.canvas, ctx: this.ctx, width: this.width, height: this.height, view: { ...this.view } };
      this.canvas = off; this.ctx = ctx2; this.width = w; this.height = h;
      this.view.zoom = w / bw;
      this.view.panX = w / 2 / this.view.zoom - (bb.minX + bb.maxX) / 2;
      this.view.panY = h / 2 / this.view.zoom - (bb.minY + bb.maxY) / 2;
      const zc = this._zoneCanvas;
      zc.width = off.width; zc.height = off.height;
      this.render(Object.assign({}, this.opts, opts || {}, { board, fpLib }));
      const url = off.toDataURL('image/png');
      this.canvas = saved.canvas; this.ctx = saved.ctx; this.width = saved.width; this.height = saved.height;
      this.view = saved.view;
      this._zoneCanvas.width = this.canvas.width; this._zoneCanvas.height = this.canvas.height;
      this.render();
      return url;
    },

    // export SVG string of the PCB
    exportSVG(board, fpLib) {
      const Model = global.PCBModel;
      const bb = Model.Board.boardBBox(board, fpLib);
      const bw = bb.maxX - bb.minX + 4, bh = bb.maxY - bb.minY + 4;
      const ox = bb.minX - 2, oy = bb.minY - 2;
      const S = [];
      S.push('<?xml version="1.0" encoding="UTF-8"?>');
      S.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + bw.toFixed(3) + 'mm" height="' + bh.toFixed(3) + 'mm" viewBox="' + [ox, oy, bw, bh].map(v => v.toFixed(3)).join(' ') + '">');
      S.push('<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + bh + '" fill="#14171e"/>');
      // board outline fill
      const ptsStr = board.outline.pts.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join(' ');
      S.push('<polygon points="' + ptsStr + '" fill="#0e2a1c" stroke="#e0c040" stroke-width="0.1"/>');
      // zones
      for (const z of board.zones) {
        if (z.pts.length < 3) continue;
        S.push('<polygon points="' + z.pts.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join(' ') + '" fill="' + this.layerColor(z.layer) + '" fill-opacity="0.45"/>');
      }
      // traces
      for (const t of board.traces) {
        S.push('<polyline points="' + t.pts.map(p => p.x.toFixed(3) + ',' + p.y.toFixed(3)).join(' ') + '" fill="none" stroke="' + this.layerColor(t.layer) + '" stroke-width="' + t.width + '" stroke-linecap="round" stroke-linejoin="round"/>');
      }
      // vias
      for (const v of board.vias) {
        S.push('<circle cx="' + v.x.toFixed(3) + '" cy="' + v.y.toFixed(3) + '" r="' + (v.diameter / 2).toFixed(3) + '" fill="#d8b64a"/>');
        S.push('<circle cx="' + v.x.toFixed(3) + '" cy="' + v.y.toFixed(3) + '" r="' + (v.drill / 2).toFixed(3) + '" fill="#14171e"/>');
      }
      // pads
      for (const p of Model.Board.allPads(board, fpLib)) {
        const color = p.drill ? '#d8b64a' : this.layerColor(p.side === 'B' ? 'B.Cu' : 'F.Cu');
        if (p.shape === 'circle') {
          S.push('<circle cx="' + p.x.toFixed(3) + '" cy="' + p.y.toFixed(3) + '" r="' + (p.w / 2).toFixed(3) + '" fill="' + color + '"/>');
        } else {
          S.push('<rect x="' + (p.x - p.w / 2).toFixed(3) + '" y="' + (p.y - p.h / 2).toFixed(3) + '" width="' + p.w.toFixed(3) + '" height="' + p.h.toFixed(3) + '" fill="' + color + '" transform="rotate(' + (p.rot || 0) + ' ' + p.x.toFixed(3) + ' ' + p.y.toFixed(3) + ')"/>');
        }
        if (p.drill) {
          S.push('<circle cx="' + p.x.toFixed(3) + '" cy="' + p.y.toFixed(3) + '" r="' + (p.drill / 2).toFixed(3) + '" fill="#14171e"/>');
        }
      }
      S.push('</svg>');
      return S.join('\n');
    }
  };

  global.PCBRender = PcbRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
