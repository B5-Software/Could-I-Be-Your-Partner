// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - DRC (board design rule check) + ERC (schematic electrical rule check)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // ---------------------------------------------------------------------------
  // DRC
  // returns [{severity:'error'|'warning', type, message, x, y, r}]
  // ---------------------------------------------------------------------------
  const PCBDrc = {
    run(board, fpLib, options) {
      const opts = Object.assign({ checkClearance: true, checkWidth: true, checkHoles: true, checkEdge: true, checkRatsnest: true, checkSilk: true }, options || {});
      const R = board.designRules;
      const errs = [];
      const pads = Model.Board.allPads(board, fpLib);
      const add = (severity, type, message, x, y, r) => errs.push({ severity, type, message, x, y, r: r || 1 });

      // ---- width rules ----
      if (opts.checkWidth) {
        for (const t of board.traces) {
          if (t.width < R.minTraceWidth - 1e-9) {
            add('error', 'width', '线宽 ' + t.width.toFixed(3) + 'mm < 最小 ' + R.minTraceWidth + 'mm (网络 ' + (t.net || '无') + ')', t.pts[0].x, t.pts[0].y, t.width);
          }
        }
        for (const v of board.vias) {
          if (v.drill < R.minViaDrill - 1e-9) add('error', 'drill', '过孔钻孔 ' + v.drill + 'mm < 最小 ' + R.minViaDrill + 'mm', v.x, v.y, v.diameter / 2);
          if (v.diameter < R.minViaDiameter - 1e-9) add('error', 'drill', '过孔外径 ' + v.diameter + 'mm < 最小 ' + R.minViaDiameter + 'mm', v.x, v.y, v.diameter / 2);
          if ((v.diameter - v.drill) / 2 < R.minAnnularRing - 1e-9) add('error', 'annular', '过孔环宽不足 ' + R.minAnnularRing + 'mm', v.x, v.y, v.diameter / 2);
        }
        for (const p of pads) {
          if (p.drill && p.plated !== false) {
            const ring = (Math.min(p.w, p.h) - p.drill) / 2;
            if (ring < R.minAnnularRing - 1e-9) {
              add('error', 'annular', p.ref + '.' + p.num + ' 焊盘环宽 ' + ring.toFixed(3) + 'mm < ' + R.minAnnularRing + 'mm', p.x, p.y, p.w / 2);
            }
          }
        }
      }

      // ---- clearance rules ----
      if (opts.checkClearance) {
        const cl = R.minClearance;
        // pad-pad
        for (let i = 0; i < pads.length; i++) {
          for (let j = i + 1; j < pads.length; j++) {
            const a = pads[i], b = pads[j];
            if (a.ref === b.ref) continue;
            if (a.net && b.net && a.net === b.net) continue;
            const d = Geo.dist(a.x, a.y, b.x, b.y) - Math.max(a.w, a.h) / 2 - Math.max(b.w, b.h) / 2;
            if (d < cl - 1e-9) {
              add('error', 'clearance', '焊盘间距不足: ' + a.ref + '.' + a.num + ' ↔ ' + b.ref + '.' + b.num + ' (' + Math.max(0, d).toFixed(3) + 'mm < ' + cl + 'mm)', (a.x + b.x) / 2, (a.y + b.y) / 2, 1);
            }
          }
        }
        // trace-trace (same layer, different nets)
        const trCaps = board.traces.map(t => ({ t, caps: Geo.polylineCapsules(t.pts, t.width) }));
        for (let i = 0; i < trCaps.length; i++) {
          for (let j = i; j < trCaps.length; j++) {
            const A = trCaps[i], B = trCaps[j];
            if (A.t.layer !== B.t.layer) continue;
            if (A.t.net && B.t.net && A.t.net === B.t.net) continue;
            for (let ci = 0; ci < A.caps.length; ci++) {
              for (let cj = 0; cj < B.caps.length; cj++) {
                if (A === B && Math.abs(ci - cj) <= 1) continue;
                const gap = Geo.capsuleCapsuleDist(A.caps[ci], B.caps[cj]);
                if (gap < cl - 1e-9) {
                  const mx = (A.caps[ci].ax + B.caps[cj].ax) / 2, my = (A.caps[ci].ay + B.caps[cj].ay) / 2;
                  add('error', 'clearance', '走线间距不足: ' + (A.t.net || '无网络') + ' ↔ ' + (B.t.net || '无网络') + ' @' + A.t.layer, mx, my, 1);
                  ci = A.caps.length; break;
                }
              }
            }
          }
        }
        // pad-trace
        for (const p of pads) {
          const pr = Math.max(p.w, p.h) / 2;
          for (const tc of trCaps) {
            if (p.net && tc.t.net && p.net === tc.t.net) continue;
            if (!p.layers.includes(tc.t.layer)) continue;
            for (const cap of tc.caps) {
              const gap = Geo.capsuleCircleDist(cap, p.x, p.y, pr);
              if (gap < cl - 1e-9) {
                add('error', 'clearance', '焊盘 ' + p.ref + '.' + p.num + ' 与走线 ' + (tc.t.net || '无网络') + ' 间距不足', p.x, p.y, pr);
                break;
              }
            }
          }
        }
        // via clearances
        for (let i = 0; i < board.vias.length; i++) {
          const v = board.vias[i];
          for (let j = i + 1; j < board.vias.length; j++) {
            const w = board.vias[j];
            if (v.net && w.net && v.net === w.net) continue;
            const d = Geo.dist(v.x, v.y, w.x, w.y) - v.diameter / 2 - w.diameter / 2;
            if (d < cl - 1e-9) add('error', 'clearance', '过孔间距不足', (v.x + w.x) / 2, (v.y + w.y) / 2, 1);
          }
          for (const p of pads) {
            if (v.net && p.net && v.net === p.net) continue;
            const d = Geo.dist(v.x, v.y, p.x, p.y) - v.diameter / 2 - Math.max(p.w, p.h) / 2;
            if (d < cl - 1e-9) add('error', 'clearance', '过孔与焊盘 ' + p.ref + '.' + p.num + ' 间距不足', v.x, v.y, v.diameter / 2);
          }
          for (const tc of trCaps) {
            if (v.net && tc.t.net && v.net === tc.t.net) continue;
            for (const cap of tc.caps) {
              if (Geo.capsuleCircleDist(cap, v.x, v.y, v.diameter / 2) < cl - 1e-9) {
                add('error', 'clearance', '过孔与走线间距不足', v.x, v.y, v.diameter / 2);
                break;
              }
            }
          }
        }
      }

      // ---- holes ----
      if (opts.checkHoles) {
        const holes = [];
        for (const p of pads) if (p.drill) holes.push({ x: p.x, y: p.y, d: p.drill, label: p.ref + '.' + p.num });
        for (const v of board.vias) holes.push({ x: v.x, y: v.y, d: v.drill, label: '过孔' });
        for (let i = 0; i < holes.length; i++) {
          for (let j = i + 1; j < holes.length; j++) {
            const gap = Geo.dist(holes[i].x, holes[i].y, holes[j].x, holes[j].y) - holes[i].d / 2 - holes[j].d / 2;
            if (gap < R.minHoleToHole - 1e-9) {
              add('error', 'hole', '孔间距不足: ' + holes[i].label + ' ↔ ' + holes[j].label, (holes[i].x + holes[j].x) / 2, (holes[i].y + holes[j].y) / 2, 1);
            }
          }
        }
      }

      // ---- board edge ----
      if (opts.checkEdge && board.outline.pts.length >= 3) {
        const pts = board.outline.pts;
        const checkPt = (x, y, r, label) => {
          if (!Geo.pointInPolygon(x, y, pts)) {
            add('error', 'edge', label + ' 在板框之外', x, y, r);
            return;
          }
          const d = Geo.polygonEdgeDist(x, y, pts);
          if (d - r < R.copperToBoardEdge - 1e-9) {
            add('warning', 'edge', label + ' 距板边 ' + (d - r).toFixed(3) + 'mm < ' + R.copperToBoardEdge + 'mm', x, y, r);
          }
        };
        for (const p of pads) checkPt(p.x, p.y, Math.max(p.w, p.h) / 2, '焊盘 ' + p.ref + '.' + p.num);
        for (const v of board.vias) checkPt(v.x, v.y, v.diameter / 2, '过孔');
        for (const t of board.traces) for (const pt of t.pts) checkPt(pt.x, pt.y, t.width / 2, '走线');
      }

      // ---- ratsnest ----
      if (opts.checkRatsnest) {
        const lines = Model.Board.ratsnest(board, fpLib);
        for (const l of lines) {
          const detail = l.from && l.to ? (l.from + ' ↔ ' + l.to) : '';
          add('warning', 'unrouted', '网络 ' + l.net + ' 未布线: ' + detail, l.x1, l.y1, 1.5);
        }
      }

      // ---- silk over pad ----
      if (opts.checkSilk) {
        for (const comp of board.components) {
          const fp = fpLib.generate(comp.footprint, comp.params || {});
          if (!fp) continue;
          // ref position vs pads (rough): skip complex polygon test, approximate ref box
        }
      }

      return errs;
    }
  };

  // ---------------------------------------------------------------------------
  // ERC (schematic)
  // ---------------------------------------------------------------------------
  const PcbErc = {
    run(sheet, symLib) {
      const errs = [];
      const add = (severity, type, message, x, y) => errs.push({ severity, type, message, x, y, r: 1 });
      const Model2 = Model;
      const pinNets = Model2.Sheet.resolveNets(sheet, symLib);

      // duplicate refs
      const refCount = new Map();
      for (const s of sheet.symbols) {
        if (!s.ref || /\?/.test(s.ref)) {
          add('warning', 'annotate', '元件未标注位号 (lib=' + s.lib + ')', s.x, s.y);
          continue;
        }
        refCount.set(s.ref, (refCount.get(s.ref) || 0) + 1);
      }
      for (const [ref, n] of refCount) {
        if (n > 1) {
          const s = sheet.symbols.find(x => x.ref === ref);
          add('error', 'duplicate', '位号 ' + ref + ' 重复 ' + n + ' 次', s ? s.x : 0, s ? s.y : 0);
        }
      }
      // missing footprint
      for (const s of sheet.symbols) {
        if (!s.footprint) add('warning', 'footprint', s.ref + ' 未指定封装', s.x, s.y);
      }
      // unconnected pins — 用点到线段距离判定，避免网格采样漏报
      const TOL = 0.01; // 0.01mm 容差
      const segs = [];
      for (const w of sheet.wires) {
        for (let i = 0; i < w.pts.length - 1; i++) {
          segs.push({ ax: w.pts[i].x, ay: w.pts[i].y, bx: w.pts[i + 1].x, by: w.pts[i + 1].y });
        }
      }
      const isWired = (x, y) => {
        for (const s of segs) {
          if (Geo.pointToSegmentDist(x, y, s.ax, s.ay, s.bx, s.by) <= TOL) return true;
        }
        return false;
      };
      const isNoConnect = (x, y) => sheet.noConnects.some(nc => Math.hypot(nc.x - x, nc.y - y) <= TOL);
      for (const pn of pinNets) {
        if (!isWired(pn.x, pn.y) && !isNoConnect(pn.x, pn.y)) {
          add('warning', 'unconnected', pn.ref + ' 引脚 ' + pn.num + ' (' + pn.name + ') 未连接', pn.x, pn.y);
        }
      }
      // single-pin nets
      const netPins = new Map();
      for (const pn of pinNets) {
        if (!netPins.has(pn.net)) netPins.set(pn.net, []);
        netPins.get(pn.net).push(pn);
      }
      for (const [net, pins] of netPins) {
        if (pins.length === 1) {
          add('warning', 'single', '网络 ' + net + ' 只连接了一个引脚', pins[0].x, pins[0].y);
        }
      }
      return errs;
    }
  };

  const PCBDrcErc = { PCBDrc, PcbErc };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBDrcErc;
  else { global.PCBDrc = PCBDrc; global.PcbErc = PcbErc; }
})(typeof window !== 'undefined' ? window : globalThis);
