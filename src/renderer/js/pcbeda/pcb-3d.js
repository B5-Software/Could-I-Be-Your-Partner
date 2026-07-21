// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - software 3D preview (painter's algorithm on Canvas 2D) + OBJ/MTL export
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // ---- ear clipping triangulation (simple polygon) ----
  function triangulate(pts) {
    const n = pts.length;
    if (n < 3) return [];
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    // ensure CCW (in Y-down world, positive area means CW... handle both)
    const area = Geo.polygonArea(pts);
    if (area > 0) idx.reverse();
    const tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let earFound = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        // convex check (CCW winding)
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cross <= 0) continue;
        // no other point inside triangle
        let ok = true;
        for (const j of idx) {
          if (j === i0 || j === i1 || j === i2) continue;
          if (pointInTriangle(pts[j], a, b, c)) { ok = false; break; }
        }
        if (!ok) continue;
        tris.push([i0, i1, i2]);
        idx.splice(i, 1);
        earFound = true;
        break;
      }
      if (!earFound) break; // degenerate; bail with what we have
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }

  function pointInTriangle(p, a, b, c) {
    const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }
  function sign(p1, p2, p3) {
    return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  }

  // ---- mesh builder: faces = [{verts:[[x,y,z]...], color:'#rrggbb', mat}] ----
  function buildScene(board, fpLib) {
    const faces = [];
    const T = board.stackup.boardThickness || 1.6;
    const maskColor = '#0d6b32'; // soldermask green
    const copperColor = '#d8b64a';
    const holeColor = '#101010';

    // board body (soldermask color)
    const outline = board.outline.pts;
    if (outline.length >= 3) {
      const tris = triangulate(outline);
      for (const t of tris) {
        faces.push({ verts: [pt3(outline[t[0]], T), pt3(outline[t[1]], T), pt3(outline[t[2]], T)], color: maskColor });
        faces.push({ verts: [pt3(outline[t[2]], 0), pt3(outline[t[1]], 0), pt3(outline[t[0]], 0)], color: maskColor });
      }
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        faces.push({ verts: [[a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, T], [a.x, a.y, T]], color: '#c8b060' });
      }
    }

    const pads = Model.Board.allPads(board, fpLib);
    // pads as thin prisms on surface
    for (const p of pads) {
      const zTop = p.side === 'B' ? 0 : T;
      const dz = p.side === 'B' ? -0.05 : 0.05;
      if (p.drill) {
        // annular ring on both sides + hole illusion
        addCylinder(faces, p.x, p.y, p.w / 2, T + 0.05, 0.05, copperColor, 12);
        addCylinder(faces, p.x, p.y, p.drill / 2 + 0.01, T + 0.06, 0.05, holeColor, 12);
      } else {
        addBox(faces, p.x, p.y, 0, p.w, p.h, 0.05, zTop + dz / 2, copperColor, p.rot || 0);
      }
    }
    // vias
    for (const v of board.vias) {
      addCylinder(faces, v.x, v.y, v.diameter / 2, T + 0.05, 0.05, copperColor, 10);
      addCylinder(faces, v.x, v.y, v.drill / 2 + 0.01, T + 0.06, 0.05, holeColor, 10);
    }
    // traces as flat ribbons on their outer layer only (skip inner for preview)
    for (const t of board.traces) {
      if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue;
      const z = t.layer === 'F.Cu' ? T + 0.02 : -0.02;
      for (let i = 0; i < t.pts.length - 1; i++) {
        addRibbon(faces, t.pts[i], t.pts[i + 1], t.width, z, copperColor);
      }
    }
    // components as boxes (top only for bottom side mirrored)
    for (const comp of board.components) {
      const fp = fpLib.generate(comp.footprint, comp.params || {});
      if (!fp || !fp.three || !fp.three.w) continue;
      const z0 = comp.side === 'B' ? 0 : T;
      addBox(faces, comp.x, comp.y, 0, fp.three.w, fp.three.l, fp.three.h,
        comp.side === 'B' ? z0 - fp.three.h / 2 : z0 + fp.three.h / 2, fp.three.color, comp.rot || 0);
    }
    return faces;
  }

  function pt3(p, z) { return [p.x, p.y, z]; }

  function addBox(faces, cx, cy, cz, w, l, h, zCenter, color, rotDeg) {
    const hw = w / 2, hl = l / 2;
    const corners = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(c => {
      const rp = Geo.rotatePoint(c[0], c[1], 0, 0, rotDeg || 0);
      return [cx + rp.x, cy + rp.y];
    });
    const zb = zCenter - h / 2, zt = zCenter + h / 2;
    const v = corners.map(c => [c[0], c[1], zb]);
    const u = corners.map(c => [c[0], c[1], zt]);
    faces.push({ verts: [u[0], u[1], u[2], u[3]], color });       // top
    faces.push({ verts: [v[3], v[2], v[1], v[0]], color });       // bottom
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      faces.push({ verts: [v[i], v[j], u[j], u[i]], color });     // sides
    }
  }

  function addCylinder(faces, cx, cy, r, zTop, h, color, seg) {
    const n = seg || 12;
    const zb = zTop - h;
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      if (prev) {
        faces.push({ verts: [[prev[0], prev[1], zb], [p[0], p[1], zb], [p[0], p[1], zTop], [prev[0], prev[1], zTop]], color });
      }
      prev = p;
    }
    // caps
    const topPts = [], botPts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      topPts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zTop]);
      botPts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zb]);
    }
    faces.push({ verts: topPts, color });
    faces.push({ verts: botPts.slice().reverse(), color });
  }

  function addRibbon(faces, a, b, width, z, color) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * width / 2, ny = dx / len * width / 2;
    faces.push({
      verts: [
        [a.x + nx, a.y + ny, z], [b.x + nx, b.y + ny, z],
        [b.x - nx, b.y - ny, z], [a.x - nx, a.y - ny, z]
      ], color
    });
  }

  // ---------------------------------------------------------------------------
  // renderer
  // ---------------------------------------------------------------------------
  const PCB3D = {
    canvas: null, ctx: null, width: 0, height: 0,
    faces: [],
    rotX: -0.5, rotZ: 0.6, dist: 260, cx: 0, cy: 0,
    _drag: null,

    init(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.resize();
      window.addEventListener('resize', () => this.resize());
      canvas.addEventListener('mousedown', (e) => {
        this._drag = { x: e.clientX, y: e.clientY, rotX: this.rotX, rotZ: this.rotZ };
      });
      window.addEventListener('mousemove', (e) => {
        if (!this._drag) return;
        this.rotZ = this._drag.rotZ + (e.clientX - this._drag.x) * 0.008;
        this.rotX = Geo.clamp(this._drag.rotX + (e.clientY - this._drag.y) * 0.008, -1.5, -0.05);
        this.render();
      });
      window.addEventListener('mouseup', () => { this._drag = null; });
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.dist = Geo.clamp(this.dist * (e.deltaY > 0 ? 1.1 : 0.9), 60, 1200);
        this.render();
      }, { passive: false });
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

    setBoard(board, fpLib) {
      this.faces = buildScene(board, fpLib);
      const bb = Model.Board.boardBBox(board, fpLib);
      this.cx = (bb.minX + bb.maxX) / 2;
      this.cy = (bb.minY + bb.maxY) / 2;
      this.dist = Math.max(120, Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * 2.4);
      this.render();
    },

    _project(x, y, z, out) {
      // translate to center
      let px = x - this.cx, py = y - this.cy, pz = z;
      // rotate Z then X
      const cz = Math.cos(this.rotZ), sz = Math.sin(this.rotZ);
      const cxr = Math.cos(this.rotX), sxr = Math.sin(this.rotX);
      const x1 = px * cz - py * sz, y1 = px * sz + py * cz;
      const y2 = y1 * cxr - pz * sxr, z2 = y1 * sxr + pz * cxr;
      const scale = this.dist / (this.dist + z2 * 8);
      out.x = this.width / 2 + x1 * scale * 4;
      out.y = this.height / 2 + y2 * scale * 4;
      out.z = z2;
      out.s = scale;
      return out;
    },

    render() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pcb-3d-bg').trim() || '#0b0e14';
      ctx.fillRect(0, 0, this.width, this.height);
      if (!this.faces.length) {
        ctx.fillStyle = '#5a6a80';
        ctx.font = '14px sans-serif';
        ctx.fillText('3D 预览：PCB 视图中生成板子后自动显示', 20, 30);
        return;
      }
      // project + sort
      const light = { x: 0.4, y: -0.6, z: 0.7 };
      const tmp = { x: 0, y: 0, z: 0, s: 1 };
      const items = [];
      for (const f of this.faces) {
        const proj = f.verts.map(v => this._project(v[0], v[1], v[2], { x: 0, y: 0, z: 0, s: 1 }));
        let zSum = 0;
        for (const p of proj) zSum += p.z;
        // face normal (world, pre-projection approx via two edges)
        const e1 = [f.verts[1][0] - f.verts[0][0], f.verts[1][1] - f.verts[0][1], f.verts[1][2] - f.verts[0][2]];
        const e2 = [f.verts[f.verts.length - 1][0] - f.verts[0][0], f.verts[f.verts.length - 1][1] - f.verts[0][1], f.verts[f.verts.length - 1][2] - f.verts[0][2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        let shade = 0.55 + 0.45 * Math.abs(nx * light.x + ny * light.y + nz * light.z);
        items.push({ proj, color: shadeColor(f.color, shade), z: zSum / proj.length });
      }
      items.sort((a, b) => b.z - a.z);
      for (const it of items) {
        ctx.beginPath();
        it.proj.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = it.color;
        ctx.fill();
      }
      // hint
      ctx.fillStyle = '#5a6a80';
      ctx.font = '12px sans-serif';
      ctx.fillText('拖拽旋转 · 滚轮缩放', 12, this.height - 12);
    },

    exportPNG(pixelW) {
      const off = document.createElement('canvas');
      const w = pixelW || 1600;
      const h = Math.round(w * (this.height / Math.max(1, this.width)));
      off.width = w; off.height = h;
      const saved = { canvas: this.canvas, ctx: this.ctx, width: this.width, height: this.height };
      this.canvas = off; this.ctx = off.getContext('2d'); this.width = w; this.height = h;
      this.render();
      const url = off.toDataURL('image/png');
      this.canvas = saved.canvas; this.ctx = saved.ctx; this.width = saved.width; this.height = saved.height;
      this.render();
      return url;
    },

    // OBJ + MTL export
    exportOBJ(board, fpLib, name) {
      const faces = buildScene(board, fpLib);
      const matNames = new Map();
      const obj = ['# CIBYP-PCB-EDA 3D export', 'mtllib ' + (name || 'pcb') + '.mtl', 'o board'];
      const mtl = [];
      let vOff = 1;
      const getMat = (color) => {
        if (!matNames.has(color)) {
          const mn = 'mat_' + matNames.size;
          matNames.set(color, mn);
          const c = color.replace('#', '');
          const r = parseInt(c.slice(0, 2), 16) / 255, g = parseInt(c.slice(2, 4), 16) / 255, b = parseInt(c.slice(4, 6), 16) / 255;
          mtl.push('newmtl ' + mn, 'Kd ' + r.toFixed(4) + ' ' + g.toFixed(4) + ' ' + b.toFixed(4), 'Ka 0.1 0.1 0.1', 'Ks 0.2 0.2 0.2', '');
        }
        return matNames.get(color);
      };
      let curMat = null;
      for (const f of faces) {
        const mn = getMat(f.color);
        if (mn !== curMat) { obj.push('usemtl ' + mn); curMat = mn; }
        const idx = [];
        for (const v of f.verts) {
          obj.push('v ' + v[0].toFixed(4) + ' ' + (-v[1]).toFixed(4) + ' ' + v[2].toFixed(4));
          idx.push(vOff++);
        }
        obj.push('f ' + idx.join(' '));
      }
      return { obj: obj.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
    }
  };

  function shadeColor(hex, factor) {
    const c = hex.replace('#', '');
    const r = Math.min(255, Math.round(parseInt(c.slice(0, 2), 16) * factor));
    const g = Math.min(255, Math.round(parseInt(c.slice(2, 4), 16) * factor));
    const b = Math.min(255, Math.round(parseInt(c.slice(4, 6), 16) * factor));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  global.PCB3D = PCB3D;
  global.PCB3DUtil = { triangulate, buildScene };
})(typeof window !== 'undefined' ? window : globalThis);
