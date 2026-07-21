// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - schematic sheet renderer (Canvas 2D)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');

  const SchRenderer = {
    canvas: null, ctx: null, width: 0, height: 0,
    view: { panX: 0, panY: 0, zoom: 10 },
    opts: {},

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
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
    w2s(p) {
      const cx = this.width / 2, cy = this.height / 2;
      return { x: cx + (p.x + this.view.panX) * this.view.zoom, y: cy + (p.y + this.view.panY) * this.view.zoom };
    },
    s2w(p) {
      const cx = this.width / 2, cy = this.height / 2;
      return { x: (p.x - cx) / this.view.zoom - this.view.panX, y: (p.y - cy) / this.view.zoom - this.view.panY };
    },
    zoomAt(factor, screenCenter) {
      const before = this.s2w(screenCenter);
      this.view.zoom = Geo.clamp(this.view.zoom * factor, 1, 100);
      const after = this.s2w(screenCenter);
      this.view.panX += after.x - before.x;
      this.view.panY += after.y - before.y;
      this.render();
    },
    fit(bbox, padding) {
      if (!bbox || !isFinite(bbox.minX)) return;
      const pad = padding || 40;
      const w = Math.max(1, bbox.maxX - bbox.minX), h = Math.max(1, bbox.maxY - bbox.minY);
      this.view.zoom = Geo.clamp(Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h), 1, 100);
      this.view.panX = this.width / 2 / this.view.zoom - (bbox.minX + bbox.maxX) / 2;
      this.view.panY = this.height / 2 / this.view.zoom - (bbox.minY + bbox.maxY) / 2;
      this.render();
    },
    cssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    },

    // opts: {sheet, symLib, selection:Set, ghost, showGrid, highlightNet, ercMarkers}
    render(opts) {
      if (opts) this.opts = opts;
      const o = this.opts || {};
      if (!this.ctx || !o.sheet) return;
      const ctx = this.ctx;
      ctx.fillStyle = this.cssVar('--pcb-sch-bg', '#10141c');
      ctx.fillRect(0, 0, this.width, this.height);
      if (o.showGrid !== false) this._drawGrid();
      const sheet = o.sheet;
      // wires
      ctx.strokeStyle = this.cssVar('--pcb-sch-wire', '#3fc96f');
      ctx.lineWidth = Math.max(1.2, 0.12 * this.view.zoom);
      ctx.lineCap = 'round';
      for (const w of sheet.wires) {
        ctx.beginPath();
        w.pts.forEach((p, i) => {
          const s = this.w2s(p);
          if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();
      }
      // junctions
      ctx.fillStyle = this.cssVar('--pcb-sch-wire', '#3fc96f');
      for (const j of sheet.junctions) {
        const s = this.w2s(j);
        ctx.beginPath();
        ctx.arc(s.x, s.y, Math.max(2, 0.3 * this.view.zoom), 0, Math.PI * 2);
        ctx.fill();
      }
      // symbols
      for (const sym of sheet.symbols) this._drawSymbol(sym, o);
      // labels
      for (const lb of sheet.labels) this._drawLabel(lb, o);
      // power symbols
      for (const ps of sheet.powerSymbols) this._drawPower(ps, o);
      // no-connects
      ctx.strokeStyle = '#e05050';
      ctx.lineWidth = 1.2;
      for (const nc of sheet.noConnects) {
        const s = this.w2s(nc);
        const r = 0.4 * this.view.zoom;
        ctx.beginPath();
        ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r);
        ctx.stroke();
      }
      // texts
      ctx.fillStyle = this.cssVar('--pcb-sch-text', '#c8d0e0');
      for (const t of sheet.texts) {
        const s = this.w2s(t);
        ctx.font = ((t.size || 1.6) * this.view.zoom) + 'px sans-serif';
        ctx.fillText(t.text, s.x, s.y);
      }
      // ghost
      if (o.ghost) this._drawGhost(o.ghost);
      // ERC markers
      if (o.ercMarkers) {
        ctx.strokeStyle = '#ff4040';
        ctx.lineWidth = 2;
        for (const m of o.ercMarkers) {
          const s = this.w2s(m);
          ctx.beginPath();
          ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // selection
      this._drawSelection(sheet, o);
      // origin
      const op = this.w2s({ x: 0, y: 0 });
      ctx.strokeStyle = this.cssVar('--pcb-axis', '#4a5568');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(op.x - 8, op.y); ctx.lineTo(op.x + 8, op.y);
      ctx.moveTo(op.x, op.y - 8); ctx.lineTo(op.x, op.y + 8);
      ctx.stroke();
    },

    _drawGrid() {
      const ctx = this.ctx;
      const step = 2.54;
      const tl = this.s2w({ x: 0, y: 0 }), br = this.s2w({ x: this.width, y: this.height });
      ctx.fillStyle = this.cssVar('--pcb-sch-grid', '#232a38');
      for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
        for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) {
          const s = this.w2s({ x, y });
          ctx.fillRect(s.x - 0.5, s.y - 0.5, 1, 1);
        }
      }
    },

    _drawSymbol(sym, o) {
      const def = o.symLib.get(sym.lib, sym.symParams);
      if (!def) return;
      const ctx = this.ctx;
      const bodyColor = this.cssVar('--pcb-sch-symbol', '#e0b040');
      const pinColor = this.cssVar('--pcb-sch-pin', '#c85050');
      const tx = (lx, ly) => {
        const mx = sym.mirror ? -lx : lx;
        const rp = Geo.rotatePoint(mx, ly, 0, 0, sym.rot || 0);
        return { x: sym.x + rp.x, y: sym.y + rp.y };
      };
      ctx.strokeStyle = bodyColor;
      ctx.lineWidth = Math.max(1.2, 0.12 * this.view.zoom);
      for (const g of def.draw) {
        if (g.kind === 'line') {
          ctx.beginPath();
          const a = this.w2s(tx(g.pts[0].x, g.pts[0].y)), b = this.w2s(tx(g.pts[1].x, g.pts[1].y));
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.stroke();
        } else if (g.kind === 'rect') {
          const a = this.w2s(tx(g.x, g.y)), b = this.w2s(tx(g.x + g.w, g.y + g.h));
          ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        } else if (g.kind === 'circle') {
          const c = this.w2s(tx(g.x, g.y));
          ctx.beginPath();
          ctx.arc(c.x, c.y, g.r * this.view.zoom, 0, Math.PI * 2);
          ctx.stroke();
        } else if (g.kind === 'arc') {
          const c = this.w2s(tx(g.x, g.y));
          const rot = (sym.rot || 0) * Math.PI / 180;
          ctx.beginPath();
          ctx.arc(c.x, c.y, g.r * this.view.zoom, rot + g.a0 * Math.PI / 180, rot + g.a1 * Math.PI / 180);
          ctx.stroke();
        } else if (g.kind === 'poly') {
          ctx.beginPath();
          g.pts.forEach((p, i) => {
            const s = this.w2s(tx(p.x, p.y));
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
          });
          ctx.closePath();
          ctx.fillStyle = bodyColor;
          ctx.fill();
        }
      }
      // pins
      ctx.fillStyle = pinColor;
      for (const pin of def.pins) {
        const p = this.w2s(tx(pin.x, pin.y));
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.5, 0.18 * this.view.zoom), 0, Math.PI * 2);
        ctx.fill();
        // pin name for IC-like symbols
        if (def.draw.length > 4 && pin.name && String(pin.name).length) {
          ctx.save();
          ctx.fillStyle = this.cssVar('--pcb-sch-text', '#c8d0e0');
          ctx.font = Math.max(8, 0.9 * this.view.zoom) + 'px sans-serif';
          const inward = pin.x < 0 ? 1 : -1;
          ctx.fillText(String(pin.name), p.x + inward * 4 * (inward > 0 ? 1 : -1) + (inward > 0 ? 2 : -ctx.measureText(String(pin.name)).width - 2), p.y - 3);
          ctx.restore();
          ctx.fillStyle = pinColor;
        }
      }
      // ref + value
      const Gerber = global.PCBGerber;
      const refPos = this.w2s(tx(0, this._symbolTop(def) - 1.2));
      ctx.fillStyle = this.cssVar('--pcb-sch-ref', '#4fb0ff');
      ctx.font = Math.max(9, 1.2 * this.view.zoom) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sym.ref || '?', refPos.x, refPos.y);
      if (sym.value) {
        ctx.fillStyle = this.cssVar('--pcb-sch-value', '#9fb0c8');
        ctx.fillText(String(sym.value), refPos.x, refPos.y + Math.max(10, 1.3 * this.view.zoom));
      }
      ctx.textAlign = 'left';
    },

    _symbolTop(def) {
      let minY = 0;
      for (const g of def.draw) {
        if (g.kind === 'line') { minY = Math.min(minY, g.pts[0].y, g.pts[1].y); }
        else if (g.kind === 'rect') minY = Math.min(minY, g.y);
        else if (g.kind === 'circle' || g.kind === 'arc') minY = Math.min(minY, g.y - g.r);
        else if (g.kind === 'poly') g.pts.forEach(p => { minY = Math.min(minY, p.y); });
      }
      return minY;
    },

    _drawLabel(lb, o) {
      const ctx = this.ctx;
      const s = this.w2s(lb);
      ctx.save();
      ctx.strokeStyle = this.cssVar('--pcb-sch-label', '#4fd0e0');
      ctx.fillStyle = this.cssVar('--pcb-sch-label', '#4fd0e0');
      ctx.font = Math.max(9, 1.3 * this.view.zoom) + 'px sans-serif';
      // small flag
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + 4, s.y - 6);
      ctx.lineTo(s.x + 6 + ctx.measureText(lb.text).width, s.y - 6);
      ctx.stroke();
      ctx.fillText(lb.text, s.x + 6, s.y - 8);
      ctx.restore();
    },

    _drawPower(ps, o) {
      const ctx = this.ctx;
      const s = this.w2s(ps);
      const z = this.view.zoom;
      ctx.save();
      ctx.strokeStyle = this.cssVar('--pcb-sch-power', '#e0a030');
      ctx.fillStyle = this.cssVar('--pcb-sch-power', '#e0a030');
      ctx.lineWidth = Math.max(1.2, 0.12 * z);
      const g = 2.54 * z / 2.54; // 1 grid in px
      const t = ps.ptype || 'GND';
      if (t === 'GND') {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - 0.8 * g);
        ctx.moveTo(s.x - 0.8 * g, s.y - 0.8 * g); ctx.lineTo(s.x + 0.8 * g, s.y - 0.8 * g);
        ctx.moveTo(s.x - 0.5 * g, s.y - 1.2 * g); ctx.lineTo(s.x + 0.5 * g, s.y - 1.2 * g);
        ctx.moveTo(s.x - 0.2 * g, s.y - 1.6 * g); ctx.lineTo(s.x + 0.2 * g, s.y - 1.6 * g);
        ctx.stroke();
      } else {
        // VCC style: bar with arrow + text
        ctx.beginPath();
        ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y - 1 * g);
        ctx.moveTo(s.x - 0.8 * g, s.y - 1 * g); ctx.lineTo(s.x + 0.8 * g, s.y - 1 * g);
        ctx.moveTo(s.x, s.y - 1 * g); ctx.lineTo(s.x - 0.3 * g, s.y - 1.5 * g);
        ctx.moveTo(s.x, s.y - 1 * g); ctx.lineTo(s.x + 0.3 * g, s.y - 1.5 * g);
        ctx.stroke();
        ctx.font = Math.max(9, 1.1 * z) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(t, s.x, s.y - 1.9 * g);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    },

    _drawGhost(gh) {
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = '#4fd0e0';
      ctx.lineWidth = Math.max(1.2, 0.12 * this.view.zoom);
      if (gh.kind === 'wire' && gh.pts && gh.pts.length >= 2) {
        ctx.beginPath();
        gh.pts.forEach((p, i) => { const s = this.w2s(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
        ctx.stroke();
      } else if (gh.kind === 'box') {
        ctx.setLineDash([4, 3]);
        const a = this.w2s(gh.pts[0]), b = this.w2s(gh.pts[1]);
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.setLineDash([]);
      }
      ctx.restore();
    },

    _drawSelection(sheet, o) {
      const sel = o.selection;
      if (!sel || !sel.size) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      const mark = (bb) => {
        const a = this.w2s({ x: bb.minX, y: bb.minY }), b = this.w2s({ x: bb.maxX, y: bb.maxY });
        ctx.strokeRect(a.x - 4, a.y - 4, b.x - a.x + 8, b.y - a.y + 8);
      };
      for (const id of sel) {
        const sym = sheet.symbols.find(s => s.id === id);
        if (sym) { mark({ minX: sym.x - 8, minY: sym.y - 8, maxX: sym.x + 8, maxY: sym.y + 8 }); continue; }
        const w = sheet.wires.find(w => w.id === id);
        if (w) { mark(Geo.ptsBBox(w.pts)); continue; }
        const lb = sheet.labels.find(l => l.id === id);
        if (lb) { mark({ minX: lb.x - 2, minY: lb.y - 3, maxX: lb.x + 12, maxY: lb.y + 1 }); continue; }
        const ps = sheet.powerSymbols.find(p => p.id === id);
        if (ps) { mark({ minX: ps.x - 3, minY: ps.y - 5, maxX: ps.x + 3, maxY: ps.y + 1 }); continue; }
        const j = sheet.junctions.find(j => j.id === id);
        if (j) { mark({ minX: j.x - 1, minY: j.y - 1, maxX: j.x + 1, maxY: j.y + 1 }); continue; }
      }
      ctx.restore();
    },

    pick(sheet, symLib, wx, wy, tolMm) {
      const tol = tolMm !== undefined ? tolMm : 8 / this.view.zoom;
      // symbols
      for (let i = sheet.symbols.length - 1; i >= 0; i--) {
        const sym = sheet.symbols[i];
        if (Math.abs(wx - sym.x) < 8 && Math.abs(wy - sym.y) < 8) return { type: 'symbol', obj: sym };
      }
      // labels
      for (const lb of sheet.labels) {
        if (Math.abs(wx - lb.x) < 6 && Math.abs(wy - lb.y) < 3) return { type: 'label', obj: lb };
      }
      // power
      for (const ps of sheet.powerSymbols) {
        if (Math.abs(wx - ps.x) < 3 && Math.abs(wy - ps.y) < 5) return { type: 'power', obj: ps };
      }
      // junctions
      for (const j of sheet.junctions) {
        if (Geo.dist(wx, wy, j.x, j.y) < 1) return { type: 'junction', obj: j };
      }
      // wires
      for (const w of sheet.wires) {
        for (let i = 0; i < w.pts.length - 1; i++) {
          if (Geo.pointToSegmentDist(wx, wy, w.pts[i].x, w.pts[i].y, w.pts[i + 1].x, w.pts[i + 1].y) <= tol + 0.1) {
            return { type: 'wire', obj: w };
          }
        }
      }
      // texts
      for (const t of sheet.texts) {
        if (Math.abs(wx - t.x) < 8 && Math.abs(wy - t.y) < 3) return { type: 'text', obj: t };
      }
      return null;
    },

    exportSVG(sheet, symLib) {
      // compute bbox
      const pts = [];
      for (const s of sheet.symbols) pts.push({ x: s.x - 10, y: s.y - 10 }, { x: s.x + 10, y: s.y + 10 });
      for (const w of sheet.wires) pts.push(...w.pts);
      for (const lb of sheet.labels) pts.push({ x: lb.x, y: lb.y });
      if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 100, y: 100 });
      const bb = Geo.ptsBBox(pts);
      const ox = bb.minX - 8, oy = bb.minY - 8;
      const bw = bb.maxX - bb.minX + 16, bh = bb.maxY - bb.minY + 16;
      const S = [];
      S.push('<?xml version="1.0" encoding="UTF-8"?>');
      S.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + bw.toFixed(2) + 'mm" height="' + bh.toFixed(2) + 'mm" viewBox="' + [ox, oy, bw, bh].map(v => v.toFixed(2)).join(' ') + '">');
      S.push('<rect x="' + ox + '" y="' + oy + '" width="' + bw + '" height="' + bh + '" fill="#10141c"/>');
      const wire = '#3fc96f', body = '#e0b040', pinC = '#c85050';
      for (const w of sheet.wires) {
        S.push('<polyline points="' + w.pts.map(p => p.x.toFixed(2) + ',' + p.y.toFixed(2)).join(' ') + '" fill="none" stroke="' + wire + '" stroke-width="0.25" stroke-linecap="round"/>');
      }
      for (const j of sheet.junctions) {
        S.push('<circle cx="' + j.x + '" cy="' + j.y + '" r="0.35" fill="' + wire + '"/>');
      }
      for (const sym of sheet.symbols) {
        const def = symLib.get(sym.lib, sym.symParams);
        if (!def) continue;
        const tx = (lx, ly) => {
          const mx = sym.mirror ? -lx : lx;
          const rp = Geo.rotatePoint(mx, ly, 0, 0, sym.rot || 0);
          return { x: sym.x + rp.x, y: sym.y + rp.y };
        };
        for (const g of def.draw) {
          if (g.kind === 'line') {
            const a = tx(g.pts[0].x, g.pts[0].y), b = tx(g.pts[1].x, g.pts[1].y);
            S.push('<line x1="' + a.x.toFixed(2) + '" y1="' + a.y.toFixed(2) + '" x2="' + b.x.toFixed(2) + '" y2="' + b.y.toFixed(2) + '" stroke="' + body + '" stroke-width="0.25"/>');
          } else if (g.kind === 'rect') {
            const a = tx(g.x, g.y), b = tx(g.x + g.w, g.y + g.h);
            S.push('<rect x="' + a.x.toFixed(2) + '" y="' + a.y.toFixed(2) + '" width="' + (b.x - a.x).toFixed(2) + '" height="' + (b.y - a.y).toFixed(2) + '" fill="none" stroke="' + body + '" stroke-width="0.25"/>');
          } else if (g.kind === 'circle') {
            const c = tx(g.x, g.y);
            S.push('<circle cx="' + c.x.toFixed(2) + '" cy="' + c.y.toFixed(2) + '" r="' + g.r.toFixed(2) + '" fill="none" stroke="' + body + '" stroke-width="0.25"/>');
          } else if (g.kind === 'poly') {
            S.push('<polygon points="' + g.pts.map(p => { const q = tx(p.x, p.y); return q.x.toFixed(2) + ',' + q.y.toFixed(2); }).join(' ') + '" fill="' + body + '"/>');
          } else if (g.kind === 'arc') {
            const c = tx(g.x, g.y);
            const a0 = (g.a0 + (sym.rot || 0)) * Math.PI / 180, a1 = (g.a1 + (sym.rot || 0)) * Math.PI / 180;
            const p0 = { x: c.x + g.r * Math.cos(a0), y: c.y + g.r * Math.sin(a0) };
            const p1 = { x: c.x + g.r * Math.cos(a1), y: c.y + g.r * Math.sin(a1) };
            S.push('<path d="M' + p0.x.toFixed(2) + ' ' + p0.y.toFixed(2) + ' A' + g.r + ' ' + g.r + ' 0 0 1 ' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2) + '" fill="none" stroke="' + body + '" stroke-width="0.25"/>');
          }
        }
        for (const pin of def.pins) {
          const p = tx(pin.x, pin.y);
          S.push('<circle cx="' + p.x.toFixed(2) + '" cy="' + p.y.toFixed(2) + '" r="0.2" fill="' + pinC + '"/>');
        }
        const rp = tx(0, this._symbolTop(def) - 1.2);
        S.push('<text x="' + rp.x.toFixed(2) + '" y="' + rp.y.toFixed(2) + '" fill="#4fb0ff" font-size="2.2" text-anchor="middle" font-family="sans-serif">' + (sym.ref || '?') + '</text>');
        if (sym.value) {
          S.push('<text x="' + rp.x.toFixed(2) + '" y="' + (rp.y + 2.6).toFixed(2) + '" fill="#9fb0c8" font-size="2" text-anchor="middle" font-family="sans-serif">' + String(sym.value) + '</text>');
        }
      }
      for (const lb of sheet.labels) {
        S.push('<text x="' + (lb.x + 1).toFixed(2) + '" y="' + (lb.y - 1).toFixed(2) + '" fill="#4fd0e0" font-size="2.2" font-family="sans-serif">' + lb.text + '</text>');
      }
      for (const t of sheet.texts) {
        S.push('<text x="' + t.x.toFixed(2) + '" y="' + t.y.toFixed(2) + '" fill="#c8d0e0" font-size="' + (t.size || 1.6) + '" font-family="sans-serif">' + String(t.text).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</text>');
      }
      S.push('</svg>');
      return S.join('\n');
    }
  };

  global.PCBSchRender = SchRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
