// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - Gerber RS-274X / Excellon / IPC-D-356 / Pick&Place / BOM exporters
// Node-requireable for unit tests. Internal coords: mm, Y-down. Gerber coords: mm, Y-up (flip at emit).
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');

  // ---------------------------------------------------------------------------
  // Stroke font (vector, for silkscreen text) - 5x7 style, cell 1.0 x 1.4
  // Each char: array of strokes [x1,y1,x2,y2] in cell units (y down)
  // ---------------------------------------------------------------------------
  const FONT = {
    'A': [[0, 1, .5, 0], [.5, 0, 1, 1], [.2, .66, .8, .66]],
    'B': [[0, 0, 0, 1], [0, 0, .6, 0], [.6, 0, .8, .1], [.8, .1, .8, .4], [.8, .4, .6, .5], [.6, .5, 0, .5], [.6, .5, .8, .6], [.8, .6, .8, .9], [.8, .9, .6, 1], [.6, 1, 0, 1]],
    'C': [[1, .15, .8, 0], [.8, 0, .2, 0], [.2, 0, 0, .15], [0, .15, 0, .85], [0, .85, .2, 1], [.2, 1, .8, 1], [.8, 1, 1, .85]],
    'D': [[0, 0, 0, 1], [0, 0, .6, 0], [.6, 0, .8, .2], [.8, .2, .8, .8], [.8, .8, .6, 1], [.6, 1, 0, 1]],
    'E': [[.8, 0, 0, 0], [0, 0, 0, 1], [0, 1, .8, 1], [0, .5, .6, .5]],
    'F': [[.8, 0, 0, 0], [0, 0, 0, 1], [0, .5, .6, .5]],
    'G': [[1, .15, .8, 0], [.8, 0, .2, 0], [.2, 0, 0, .15], [0, .15, 0, .85], [0, .85, .2, 1], [.2, 1, .8, 1], [.8, 1, 1, .85], [1, .85, 1, .55], [1, .55, .6, .55]],
    'H': [[0, 0, 0, 1], [1, 0, 1, 1], [0, .5, 1, .5]],
    'I': [[.2, 0, .8, 0], [.5, 0, .5, 1], [.2, 1, .8, 1]],
    'J': [[.8, 0, .8, .85], [.8, .85, .6, 1], [.6, 1, .2, 1], [.2, 1, 0, .85]],
    'K': [[0, 0, 0, 1], [.8, 0, 0, .5], [0, .5, .8, 1]],
    'L': [[0, 0, 0, 1], [0, 1, .8, 1]],
    'M': [[0, 1, 0, 0], [0, 0, .5, .6], [.5, .6, 1, 0], [1, 0, 1, 1]],
    'N': [[0, 1, 0, 0], [0, 0, 1, 1], [1, 1, 1, 0]],
    'O': [[.2, 0, .8, 0], [.8, 0, 1, .15], [1, .15, 1, .85], [1, .85, .8, 1], [.8, 1, .2, 1], [.2, 1, 0, .85], [0, .85, 0, .15], [0, .15, .2, 0]],
    'P': [[0, 1, 0, 0], [0, 0, .6, 0], [.6, 0, .8, .1], [.8, .1, .8, .4], [.8, .4, .6, .5], [.6, .5, 0, .5]],
    'Q': [[.2, 0, .8, 0], [.8, 0, 1, .15], [1, .15, 1, .85], [1, .85, .8, 1], [.8, 1, .2, 1], [.2, 1, 0, .85], [0, .85, 0, .15], [0, .15, .2, 0], [.6, .8, 1.05, 1.05]],
    'R': [[0, 1, 0, 0], [0, 0, .6, 0], [.6, 0, .8, .1], [.8, .1, .8, .4], [.8, .4, .6, .5], [.6, .5, 0, .5], [.5, .5, .9, 1]],
    'S': [[.8, .1, .6, 0], [.6, 0, .2, 0], [.2, 0, 0, .1], [0, .1, 0, .4], [0, .4, .2, .5], [.2, .5, .8, .5], [.8, .5, 1, .6], [1, .6, 1, .9], [1, .9, .8, 1], [.8, 1, .2, 1], [.2, 1, 0, .9]],
    'T': [[0, 0, 1, 0], [.5, 0, .5, 1]],
    'U': [[0, 0, 0, .85], [0, .85, .2, 1], [.2, 1, .8, 1], [.8, 1, 1, .85], [1, .85, 1, 0]],
    'V': [[0, 0, .5, 1], [.5, 1, 1, 0]],
    'W': [[0, 0, .2, 1], [.2, 1, .5, .4], [.5, .4, .8, 1], [.8, 1, 1, 0]],
    'X': [[0, 0, 1, 1], [1, 0, 0, 1]],
    'Y': [[0, 0, .5, .5], [1, 0, .5, .5], [.5, .5, .5, 1]],
    'Z': [[0, 0, 1, 0], [1, 0, 0, 1], [0, 1, 1, 1]],
    '0': [[.2, 0, .8, 0], [.8, 0, 1, .15], [1, .15, 1, .85], [1, .85, .8, 1], [.8, 1, .2, 1], [.2, 1, 0, .85], [0, .85, 0, .15], [0, .15, .2, 0]],
    '1': [[.3, .15, .55, 0], [.55, 0, .55, 1], [.3, 1, .8, 1]],
    '2': [[0, .15, .2, 0], [.2, 0, .8, 0], [.8, 0, 1, .15], [1, .15, 1, .35], [1, .35, 0, 1], [0, 1, 1, 1]],
    '3': [[0, .1, .2, 0], [.2, 0, .7, 0], [.7, 0, .9, .1], [.9, .1, .9, .4], [.9, .4, .7, .5], [.7, .5, .4, .5], [.7, .5, .9, .6], [.9, .6, .9, .9], [.9, .9, .7, 1], [.7, 1, .2, 1], [.2, 1, 0, .9]],
    '4': [[.7, 1, .7, 0], [.7, 0, 0, .65], [0, .65, 1, .65]],
    '5': [[.9, 0, .2, 0], [.2, 0, .1, .45], [.1, .45, .6, .4], [.6, .4, .9, .55], [.9, .55, .9, .85], [.9, .85, .7, 1], [.7, 1, .2, 1], [.2, 1, 0, .85]],
    '6': [[.8, 0, .3, 0], [.3, 0, .1, .2], [.1, .2, .1, .8], [.1, .8, .3, 1], [.3, 1, .7, 1], [.7, 1, .9, .8], [.9, .8, .9, .6], [.9, .6, .7, .45], [.7, .45, .1, .45]],
    '7': [[0, 0, 1, 0], [1, 0, .4, 1]],
    '8': [[.3, 0, .7, 0], [.7, 0, .9, .1], [.9, .1, .9, .4], [.9, .4, .7, .5], [.7, .5, .3, .5], [.3, .5, .1, .4], [.1, .4, .1, .1], [.1, .1, .3, 0], [.3, .5, .1, .6], [.1, .6, .1, .9], [.1, .9, .3, 1], [.3, 1, .7, 1], [.7, 1, .9, .9], [.9, .9, .9, .6], [.9, .6, .7, .5]],
    '9': [[.9, .55, .3, .55], [.3, .55, .1, .4], [.1, .4, .1, .2], [.1, .2, .3, 0], [.3, 0, .7, 0], [.7, 0, .9, .2], [.9, .2, .9, .8], [.9, .8, .7, 1], [.7, 1, .2, 1]],
    '-': [[.2, .5, .8, .5]],
    '_': [[0, 1.05, 1, 1.05]],
    '.': [[.45, .95, .55, .95], [.55, .95, .55, 1.05], [.55, 1.05, .45, 1.05], [.45, 1.05, .45, .95]],
    '+': [[.5, .2, .5, .8], [.2, .5, .8, .5]],
    '/': [[0, 1, 1, 0]],
    '(': [[.7, 0, .4, .15], [.4, .15, .4, .85], [.4, .85, .7, 1]],
    ')': [[.3, 0, .6, .15], [.6, .15, .6, .85], [.6, .85, .3, 1]],
    '*': [[.5, .25, .5, .75], [.25, .35, .75, .65], [.75, .35, .25, .65]],
    '=': [[.15, .4, .85, .4], [.15, .6, .85, .6]],
    '%': [[0, 1, 1, 0], [.1, .15, .3, .15], [.3, .15, .3, .35], [.3, .35, .1, .35], [.1, .35, .1, .15], [.7, .65, .9, .65], [.9, .65, .9, .85], [.9, .85, .7, .85], [.7, .85, .7, .65]],
    'Ω': [[.2, 1, .2, .7], [.2, .7, 0, .45], [0, .45, 0, .25], [0, .25, .2, 0], [.2, 0, .8, 0], [.8, 0, 1, .25], [1, .25, 1, .45], [1, .45, .8, .7], [.8, .7, .8, 1]],
    '°': [[.35, .05, .65, .05], [.65, .05, .65, .3], [.65, .3, .35, .3], [.35, .3, .35, .05]],
    ' ': []
  };

  // text -> stroke segments in mm. size = char height mm. Returns [{x1,y1,x2,y2}]
  function textToSegments(text, x, y, size, rotDeg, align) {
    const t = String(text || '');
    const cellW = size * 0.72, cellH = size;
    const advance = cellW * 1.25;
    let ox = x, oy = y;
    if (align === 'center') ox = x - (t.length * advance) / 2;
    if (align === 'right') ox = x - t.length * advance;
    const segs = [];
    const r = (rotDeg || 0) * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    for (let i = 0; i < t.length; i++) {
      const ch = t[i].toUpperCase();
      const glyph = FONT[ch];
      const bx = ox + i * advance, by = oy;
      if (glyph) {
        for (const st of glyph) {
          const pts = [
            [bx + st[0] * cellW, by + st[1] * cellH],
            [bx + st[2] * cellW, by + st[3] * cellH]
          ].map(p => {
            const dx = p[0] - x, dy = p[1] - y;
            return [x + dx * c - dy * s, y + dx * s + dy * c];
          });
          segs.push({ x1: pts[0][0], y1: pts[0][1], x2: pts[1][0], y2: pts[1][1] });
        }
      }
    }
    return segs;
  }

  // ---------------------------------------------------------------------------
  // Gerber RS-274X writer
  // ---------------------------------------------------------------------------
  class GerberWriter {
    constructor(comment) {
      this.lines = [];
      this.apertures = new Map(); // def -> D-code
      this.macros = new Set();
      this.nextD = 10;
      this.curD = null;
      this.polarity = 'D';
      this.inRegion = false;
      this.pen = { x: null, y: null };
      if (comment) this.lines.push('G04 ' + comment + ' *');
      this.lines.push('%FSLAX46Y46*%');
      this.lines.push('%MOMM*%');
      this.lines.push('%LPD*%');
    }
    _coord(v) {
      const n = Math.round(v * 1e6);
      return (n < 0 ? '-' : '') + String(Math.abs(n));
    }
    _fmtD(d) { return Math.round(d * 1e6) / 1e6; }
    aperture(def, macroDef) {
      if (this.apertures.has(def)) return this.apertures.get(def);
      const code = 'D' + (this.nextD++);
      if (macroDef) {
        const macroName = 'MACRO' + code;
        this.lines.push('%AM' + macroName + '*' + macroDef + '*%');
        this.lines.push('%ADD' + code + macroName + ',' + def + '*%');
      } else {
        this.lines.push('%ADD' + code + def + '*%');
      }
      this.apertures.set(def, code);
      return code;
    }
    circleAperture(dia) { return this.aperture('C,' + this._fmtD(dia)); }
    rectAperture(w, h) { return this.aperture('R,' + this._fmtD(w) + 'X' + this._fmtD(h)); }
    thermalAperture(od, id, gap) {
      return this.aperture(this._fmtD(od) + ',' + this._fmtD(id) + ',' + this._fmtD(gap),
        '7,0,0,$1,$2,$3,0.0');
    }
    select(code) {
      if (this.curD !== code) { this.lines.push(code + '*'); this.curD = code; }
    }
    setPolarity(p) {
      if (this.polarity !== p) {
        if (this.inRegion) this.endRegion();
        this.lines.push('%LP' + p + '*%');
        this.polarity = p;
      }
    }
    moveTo(x, y) {
      this.lines.push('X' + this._coord(x) + 'Y' + this._coord(-y) + 'D02*');
      this.pen = { x, y };
    }
    lineTo(x, y) {
      this.lines.push('X' + this._coord(x) + 'Y' + this._coord(-y) + 'D01*');
      this.pen = { x, y };
    }
    flash(x, y) {
      this.lines.push('X' + this._coord(x) + 'Y' + this._coord(-y) + 'D03*');
    }
    beginRegion() {
      if (!this.inRegion) { this.lines.push('G36*'); this.inRegion = true; }
    }
    endRegion() {
      if (this.inRegion) { this.lines.push('G37*'); this.inRegion = false; }
    }
    drawPolyline(pts, width) {
      if (!pts || pts.length < 2) return;
      this.setPolarity('D');
      this.endRegion();
      this.select(this.circleAperture(width));
      this.lines.push('G01*');
      this.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
    }
    fillPolygon(pts) {
      if (!pts || pts.length < 3) return;
      this.setPolarity('D');
      this.beginRegion();
      this.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
      this.lineTo(pts[0].x, pts[0].y);
      this.endRegion();
    }
    clearPolygon(pts) { // region in clear polarity
      if (!pts || pts.length < 3) return;
      this.setPolarity('C');
      this.beginRegion();
      this.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
      this.lineTo(pts[0].x, pts[0].y);
      this.endRegion();
      this.setPolarity('D');
    }
    // polygon corners for a (possibly rotated) rect/roundrect pad
    padPolygon(x, y, w, h, rotDeg, inflate) {
      const inf = inflate || 0;
      const hw = w / 2 + inf, hh = h / 2 + inf;
      const corners = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
      return corners.map(c => {
        const rp = Geo.rotatePoint(c.x, c.y, 0, 0, rotDeg || 0);
        return { x: x + rp.x, y: y + rp.y };
      });
    }
    // flash or region-fill a pad, honoring rotation; inflate expands uniformly
    drawPad(pad, inflate) {
      const inf = inflate || 0;
      const rot = ((pad.rot || 0) % 360 + 360) % 360;
      this.endRegion();
      const axisAligned = (rot % 180 === 0);
      if (pad.shape === 'circle') {
        this.setPolarity('D');
        this.select(this.circleAperture(pad.w + 2 * inf));
        this.flash(pad.x, pad.y);
      } else if (axisAligned) {
        this.setPolarity('D');
        const w = rot === 0 ? pad.w : pad.h, h = rot === 0 ? pad.h : pad.w;
        this.select(this.rectAperture(w + 2 * inf, h + 2 * inf));
        this.flash(pad.x, pad.y);
      } else {
        this.fillPolygon(this.padPolygon(pad.x, pad.y, pad.w, pad.h, rot, inf));
      }
    }
    clearPad(pad, inflate) {
      const inf = inflate || 0;
      const rot = ((pad.rot || 0) % 360 + 360) % 360;
      this.endRegion();
      this.setPolarity('C');
      if (pad.shape === 'circle') {
        this.select(this.circleAperture(pad.w + 2 * inf));
        this.flash(pad.x, pad.y);
      } else if (rot % 180 === 0) {
        const w = rot === 0 ? pad.w : pad.h, h = rot === 0 ? pad.h : pad.w;
        this.select(this.rectAperture(w + 2 * inf, h + 2 * inf));
        this.flash(pad.x, pad.y);
      } else {
        this.beginRegion();
        const pts = this.padPolygon(pad.x, pad.y, pad.w, pad.h, rot, inf);
        this.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
        this.lineTo(pts[0].x, pts[0].y);
        this.endRegion();
      }
      this.setPolarity('D');
    }
    finish() {
      this.endRegion();
      this.lines.push('M02*');
      return this.lines.join('\n') + '\n';
    }
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  function ensurePads(board) {
    if (Array.isArray(board._allPads)) return board._allPads;
    const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');
    const fp = (typeof PCBFootprints !== 'undefined') ? PCBFootprints : require('./pcb-footprints.js');
    board._allPads = Model.Board.allPads(board, fp);
    return board._allPads;
  }

  function layerCopperPads(pads, layerId) {
    return pads.filter(p => p.layers.includes(layerId));
  }

  function emitCopperLayer(board, fpLib, layerId, opts) {
    const g = new GerberWriter('CIBYP-PCB-EDA copper ' + layerId);
    const pads = layerCopperPads(ensurePads(board), layerId);
    // zones first (bottom of stack visually; LP technique)
    for (const zone of board.zones.filter(z => z.layer === layerId && z.pts.length >= 3)) {
      emitZone(g, board, layerId, zone);
    }
    // traces
    for (const t of board.traces.filter(t => t.layer === layerId)) {
      g.drawPolyline(t.pts, t.width);
    }
    // vias (on every copper layer)
    for (const v of board.vias) {
      g.setPolarity('D');
      g.select(g.circleAperture(v.diameter));
      g.flash(v.x, v.y);
    }
    // pads
    for (const p of pads) g.drawPad(p, 0);
    return g.finish();
  }

  function emitZone(g, board, layerId, zone) {
    const rules = board.designRules;
    const clearance = zone.clearance !== undefined ? zone.clearance : rules.zoneClearance;
    // 1) solid region
    g.fillPolygon(zone.pts);
    // 2) clear foreign objects
    const zb = Geo.ptsBBox(zone.pts);
    const inRange = (x, y, r) => x + r > zb.minX && x - r < zb.maxX && y + r > zb.minY && y - r < zb.maxY;
    for (const p of ensurePads(board)) {
      if (!p.layers.includes(layerId)) continue;
      const r = Math.max(p.w, p.h) / 2 + clearance;
      if (!inRange(p.x, p.y, r)) continue;
      if (p.net === zone.net) continue; // same-net handled by thermal below
      g.clearPad(p, clearance);
    }
    for (const v of board.vias) {
      const r = v.diameter / 2 + clearance;
      if (!inRange(v.x, v.y, r)) continue;
      if (v.net === zone.net) continue;
      g.endRegion();
      g.setPolarity('C');
      g.select(g.circleAperture(v.diameter + 2 * clearance));
      g.flash(v.x, v.y);
      g.setPolarity('D');
    }
    for (const t of board.traces) {
      if (t.layer !== layerId || t.net === zone.net) continue;
      for (let i = 0; i < t.pts.length - 1; i++) {
        const a = t.pts[i], b = t.pts[i + 1];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (!inRange(mx, my, t.width / 2 + clearance + Geo.dist(a.x, a.y, b.x, b.y) / 2)) continue;
        g.endRegion();
        g.setPolarity('C');
        g.select(g.circleAperture(t.width + 2 * clearance));
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        g.setPolarity('D');
      }
    }
    // 3) thermal relief connections for same-net pads/vias
    const tw = zone.thermalWidth !== undefined ? zone.thermalWidth : rules.zoneThermalWidth;
    for (const p of ensurePads(board)) {
      if (p.net !== zone.net || !p.layers.includes(layerId)) continue;
      const r = Math.max(p.w, p.h) / 2;
      if (!inRange(p.x, p.y, r + clearance)) continue;
      if (!Geo.pointInPolygon(p.x, p.y, zone.pts)) continue;
      const od = (r + clearance) * 2, id = r * 2 * 0.98;
      g.endRegion();
      g.setPolarity('D');
      g.select(g.thermalAperture(od, id, tw * 2));
      g.flash(p.x, p.y);
    }
    for (const v of board.vias) {
      if (v.net !== zone.net) continue;
      if (!Geo.pointInPolygon(v.x, v.y, zone.pts)) continue;
      const od = v.diameter + 2 * clearance, id = v.diameter * 0.98;
      g.endRegion();
      g.setPolarity('D');
      g.select(g.thermalAperture(od, id, tw * 2));
      g.flash(v.x, v.y);
    }
  }

  function emitMaskLayer(board, side, opts) {
    const layerId = side === 'F' ? 'F.Cu' : 'B.Cu';
    const g = new GerberWriter('CIBYP-PCB-EDA soldermask ' + side);
    const exp = board.designRules.solderMaskExpansion || 0.05;
    for (const p of ensurePads(board)) {
      if (p.side !== side && p.smd) continue; // SMD only on its side; TH on both
      g.drawPad(p, exp);
    }
    if (!opts.tentedVias) {
      for (const v of board.vias) {
        g.setPolarity('D');
        g.select(g.circleAperture(v.diameter + 2 * exp));
        g.flash(v.x, v.y);
      }
    }
    return g.finish();
  }

  function emitPasteLayer(board, side) {
    const g = new GerberWriter('CIBYP-PCB-EDA paste ' + side);
    const exp = board.designRules.pasteExpansion || 0;
    for (const p of ensurePads(board)) {
      if (!p.smd || p.side !== side) continue;
      g.drawPad(p, exp);
    }
    return g.finish();
  }

  function emitSilkLayer(board, fpLib, side) {
    const g = new GerberWriter('CIBYP-PCB-EDA silkscreen ' + side);
    const defW = 0.15; // silk stroke width mm
    // component refs + footprint silk
    for (const comp of board.components) {
      if (comp.side !== side) continue;
      const fp = fpLib.generate(comp.footprint, comp.params || {});
      if (!fp) continue;
      const mirror = comp.side === 'B';
      const tx = (lx, ly) => {
        const mx = mirror ? -lx : lx;
        const rp = Geo.rotatePoint(mx, ly, 0, 0, comp.rot || 0);
        return { x: comp.x + rp.x, y: comp.y + rp.y };
      };
      for (const s of fp.silk) {
        if (s.kind === 'line') {
          const a = tx(s.pts[0].x, s.pts[0].y), b = tx(s.pts[1].x, s.pts[1].y);
          g.drawPolyline([a, b], defW);
        } else if (s.kind === 'rect') {
          const c = [tx(s.x, s.y), tx(s.x + s.w, s.y), tx(s.x + s.w, s.y + s.h), tx(s.x, s.y + s.h)];
          g.drawPolyline([...c, c[0]], defW);
        } else if (s.kind === 'circle') {
          const cpt = tx(s.x, s.y);
          g.drawPolyline(Geo.arcToPoints(cpt.x, cpt.y, s.r, 0, 360, 10), defW);
        }
      }
      // reference designator
      const rp = tx(fp.refPos.x, fp.refPos.y);
      const segs = textToSegments(comp.ref, rp.x, rp.y, 1.2, comp.rot || 0, 'center');
      for (const sg of segs) g.drawPolyline([{ x: sg.x1, y: sg.y1 }, { x: sg.x2, y: sg.y2 }], defW);
    }
    // user silkscreen objects
    for (const sk of board.silkscreen) {
      if (sk.side !== side) continue;
      if (sk.kind === 'line' && sk.pts && sk.pts.length >= 2) {
        g.drawPolyline(sk.pts, sk.width || defW);
      } else if (sk.kind === 'rect') {
        const c = [{ x: sk.x, y: sk.y }, { x: sk.x + sk.w, y: sk.y }, { x: sk.x + sk.w, y: sk.y + sk.h }, { x: sk.x, y: sk.y + sk.h }];
        g.drawPolyline([...c, c[0]], sk.width || defW);
      } else if (sk.kind === 'circle') {
        g.drawPolyline(Geo.arcToPoints(sk.x, sk.y, sk.r, 0, 360, 10), sk.width || defW);
      } else if (sk.kind === 'text') {
        const segs = textToSegments(sk.text, sk.x, sk.y, sk.size || 1.2, sk.rot || 0, 'left');
        for (const sg of segs) g.drawPolyline([{ x: sg.x1, y: sg.y1 }, { x: sg.x2, y: sg.y2 }], sk.width || defW);
      }
    }
    return g.finish();
  }

  function emitOutline(board) {
    const g = new GerberWriter('CIBYP-PCB-EDA board outline');
    const pts = board.outline.pts;
    if (pts.length >= 2) {
      const closed = [...pts];
      if (board.outline.closed !== false) closed.push(pts[0]);
      g.drawPolyline(closed, 0.05);
    }
    return g.finish();
  }

  // ---------------------------------------------------------------------------
  // Excellon drill
  // ---------------------------------------------------------------------------
  function emitDrill(board, plated) {
    // plated=true: PTH (via holes + TH pads); false: NPTH (non-plated pads)
    const holes = []; // {x,y,d}
    for (const v of board.vias) if (plated) holes.push({ x: v.x, y: v.y, d: v.drill });
    for (const p of ensurePads(board)) {
      if (!p.drill) continue;
      const isPlated = p.plated !== false;
      if (isPlated === plated) holes.push({ x: p.x, y: p.y, d: p.drill });
    }
    const tools = new Map(); // d -> toolNum
    for (const h of holes) {
      const key = Math.round(h.d * 1000) / 1000;
      if (!tools.has(key)) tools.set(key, tools.size + 1);
    }
    const L = [];
    L.push('M48');
    L.push('; CIBYP-PCB-EDA ' + (plated ? 'PTH' : 'NPTH') + ' drill file');
    L.push('METRIC,TZ');
    for (const [d, n] of tools) {
      L.push('T' + String(n).padStart(2, '0') + 'C' + d.toFixed(3));
    }
    L.push('%');
    let curT = null;
    for (const h of holes) {
      const t = tools.get(Math.round(h.d * 1000) / 1000);
      if (t !== curT) { L.push('T' + String(t).padStart(2, '0')); curT = t; }
      L.push('X' + h.x.toFixed(3) + 'Y' + (-h.y).toFixed(3));
    }
    L.push('M30');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // IPC-D-356 netlist (KiCad-compatible subset)
  // ---------------------------------------------------------------------------
  function emitIPC356(board) {
    const L = [];
    L.push('P  CIBYP-PCB-EDA IPC-D-356 netlist');
    L.push('C  generated test netlist, units mm');
    const f9 = (v) => (v >= 0 ? '+' : '') + v.toFixed(4).padStart(9, '0');
    for (const p of ensurePads(board)) {
      const net = (p.net || 'N/C').padEnd(14, ' ').slice(0, 14);
      const padRef = (p.ref + '-' + p.num).padEnd(8, ' ').slice(0, 8);
      const x = f9(p.x), y = f9(-p.y);
      if (p.drill) {
        const d = String(Math.round(p.drill * 100)).padStart(4, '0');
        const pd = String(Math.round(p.w * 100)).padStart(4, '0');
        L.push('311' + net + padRef + 'D' + d + 'A' + x + y + 'D' + pd + 'X');
      } else {
        const pd = String(Math.round(Math.max(p.w, p.h) * 100)).padStart(4, '0');
        L.push('317' + net + padRef + 'A' + x + y + 'D' + pd + 'X');
      }
    }
    for (const v of board.vias) {
      const net = (v.net || 'N/C').padEnd(14, ' ').slice(0, 14);
      const d = String(Math.round(v.drill * 100)).padStart(4, '0');
      const pd = String(Math.round(v.diameter * 100)).padStart(4, '0');
      L.push('311' + net + 'VIA     ' + 'D' + d + 'A' + f9(v.x) + f9(-v.y) + 'D' + pd + 'X');
    }
    L.push('C  END');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // Pick & Place + BOM
  // ---------------------------------------------------------------------------
  function emitPnP(board) {
    const L = ['Designator,Value,Footprint,X(mm),Y(mm),Rotation,Side'];
    const comps = [...board.components].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
    for (const c of comps) {
      L.push([c.ref, csvEsc(c.value || ''), c.footprint,
        c.x.toFixed(3), c.y.toFixed(3), (c.rot || 0).toFixed(1), c.side === 'B' ? 'Bottom' : 'Top'].join(','));
    }
    return L.join('\n') + '\n';
  }

  function csvEsc(v) {
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function emitBOM(board) {
    const groups = new Map();
    for (const c of board.components) {
      const key = (c.value || '') + '|' + c.footprint;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c.ref);
    }
    const L = ['Quantity,Designators,Value,Footprint'];
    const keys = [...groups.keys()].sort();
    for (const k of keys) {
      const [value, fp] = k.split('|');
      const refs = groups.get(k).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      L.push([refs.length, csvEsc(refs.join(' ')), csvEsc(value), fp].join(','));
    }
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // full export
  // options: { naming:'jlc'|'protel', tentedVias, innerLayerNames }
  // returns [{name, content}]
  // ---------------------------------------------------------------------------
  const GERBER_EXTS = {
    jlc: { cu: l => l === 'F.Cu' ? '.gtl' : (l === 'B.Cu' ? '.gbl' : '.g' + l.replace('In', '').replace('.Cu', '')),
           mask: s => s === 'F' ? '.gts' : '.gbs', silk: s => s === 'F' ? '.gto' : '.gbo',
           paste: s => s === 'F' ? '.gtp' : '.gbp', outline: '.gko', pth: '-PTH.drl', npth: '-NPTH.drl' },
    protel: { cu: l => l === 'F.Cu' ? '.GTL' : (l === 'B.Cu' ? '.GBL' : '.G' + l.replace('In', '').replace('.Cu', '')),
              mask: s => s === 'F' ? '.GTS' : '.GBS', silk: s => s === 'F' ? '.GTO' : '.GBO',
              paste: s => s === 'F' ? '.GTP' : '.GBP', outline: '.GKO', pth: '.PTH.txt', npth: '.NPTH.txt' }
  };

  function exportAll(board, fpLib, baseName, options) {
    const opts = Object.assign({ naming: 'jlc', tentedVias: false, includePaste: true, includeIPC356: true, includePnP: true, includeBOM: true }, options || {});
    const base = (baseName || 'pcb').replace(/[\\/:*?"<>|]/g, '_');
    // cache absolute pads on board for emitters
    const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');
    board._allPads = Model.Board.allPads(board, fpLib);

    const exts = GERBER_EXTS[opts.naming] || GERBER_EXTS.jlc;
    const files = [];
    const layers = board.stackup.layers.filter(l => l.type === 'copper').map(l => l.id);
    for (const layerId of layers) {
      files.push({ name: base + exts.cu(layerId), content: emitCopperLayer(board, fpLib, layerId, opts) });
    }
    files.push({ name: base + exts.mask('F'), content: emitMaskLayer(board, 'F', opts) });
    files.push({ name: base + exts.mask('B'), content: emitMaskLayer(board, 'B', opts) });
    files.push({ name: base + exts.silk('F'), content: emitSilkLayer(board, fpLib, 'F') });
    files.push({ name: base + exts.silk('B'), content: emitSilkLayer(board, fpLib, 'B') });
    if (opts.includePaste) {
      files.push({ name: base + exts.paste('F'), content: emitPasteLayer(board, 'F') });
      files.push({ name: base + exts.paste('B'), content: emitPasteLayer(board, 'B') });
    }
    files.push({ name: base + exts.outline, content: emitOutline(board) });
    files.push({ name: base + exts.pth, content: emitDrill(board, true) });
    const npth = emitDrill(board, false);
    if (!/^(M48\n;[^\n]*\nMETRIC,TZ\n%?\n?M30\n?)$/.test(npth) && npth.includes('T01')) {
      files.push({ name: base + exts.npth, content: npth });
    }
    if (opts.includeIPC356) files.push({ name: base + '-IPC-D-356.net', content: emitIPC356(board) });
    if (opts.includePnP) files.push({ name: base + '-PnP.csv', content: emitPnP(board) });
    if (opts.includeBOM) files.push({ name: base + '-BOM.csv', content: emitBOM(board) });
    // readme
    files.push({
      name: base + '-README.txt',
      content: 'CIBYP-PCB-EDA Gerber 导出清单\n' +
        '层叠: ' + board.stackup.copperLayers + ' 层铜, 板厚 ' + board.stackup.boardThickness + 'mm, ' + board.stackup.material + '\n' +
        files.filter(f => !f.name.endsWith('README.txt')).map(f => f.name).join('\n') + '\n'
    });
    return files;
  }

  const PCBGerber = {
    GerberWriter, textToSegments, FONT,
    exportAll, emitCopperLayer, emitMaskLayer, emitPasteLayer, emitSilkLayer,
    emitOutline, emitDrill, emitIPC356, emitPnP, emitBOM
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PCBGerber;
  else global.PCBGerber = PCBGerber;
})(typeof window !== 'undefined' ? window : globalThis);
