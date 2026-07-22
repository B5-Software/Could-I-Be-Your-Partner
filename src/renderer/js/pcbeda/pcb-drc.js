// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - DRC (board design rule check) + ERC (schematic electrical rule check)
// 工业标准参考: IPC-2221 (PCB 通用设计)、IPC-2152 (电流-温升)
// 增量 DRC: DrcIndex 维护上次违规快照，runIncremental 只重算受影响对象
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // ---------------------------------------------------------------------------
  // violation 稳定 key（用于增量 diff）
  // 同一对对象+类型+大致位置 → 视为同一条违规
  // ---------------------------------------------------------------------------
  function vkey(v) {
    const idA = v.idA || '';
    const idB = v.idB || '';
    const x = (v.x || 0).toFixed(2);
    const y = (v.y || 0).toFixed(2);
    const layer = v.layer || '';
    return [v.type, idA, idB, layer, x, y].join('|');
  }

  function mkV(severity, type, message, x, y, r, extra) {
    const v = { severity, type, message, x: x || 0, y: y || 0, r: r || 1 };
    if (extra) Object.assign(v, extra);
    return v;
  }

  // ---------------------------------------------------------------------------
  // DRC
  // returns [{severity:'error'|'warning', type, message, x, y, r, idA, idB, layer}]
  // ---------------------------------------------------------------------------
  const PCBDrc = {
    run(board, fpLib, options) {
      const opts = Object.assign({ checkClearance: true, checkWidth: true, checkHoles: true, checkEdge: true, checkRatsnest: true, checkSilk: true }, options || {});
      const R = board.designRules;
      const errs = [];
      const pads = Model.Board.allPads(board, fpLib);
      const add = (severity, type, message, x, y, r, extra) => {
        const v = mkV(severity, type, message, x, y, r, extra);
        v.key = vkey(v);
        errs.push(v);
      };

      // ---- width rules ----
      if (opts.checkWidth) {
        for (const t of board.traces) {
          if (t.width < R.minTraceWidth - 1e-9) {
            add('error', 'width', '线宽 ' + t.width.toFixed(3) + 'mm < 最小 ' + R.minTraceWidth + 'mm (网络 ' + (t.net || '无') + ')', t.pts[0].x, t.pts[0].y, t.width, { idA: t.id, layer: t.layer });
          }
        }
        for (const v of board.vias) {
          if (v.drill < R.minViaDrill - 1e-9) add('error', 'drill', '过孔钻孔 ' + v.drill + 'mm < 最小 ' + R.minViaDrill + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
          if (v.diameter < R.minViaDiameter - 1e-9) add('error', 'drill', '过孔外径 ' + v.diameter + 'mm < 最小 ' + R.minViaDiameter + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
          if ((v.diameter - v.drill) / 2 < R.minAnnularRing - 1e-9) add('error', 'annular', '过孔环宽不足 ' + R.minAnnularRing + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
        }
        for (const p of pads) {
          if (p.drill && p.plated !== false) {
            const ring = (Math.min(p.w, p.h) - p.drill) / 2;
            if (ring < R.minAnnularRing - 1e-9) {
              add('error', 'annular', p.ref + '.' + p.num + ' 焊盘环宽 ' + ring.toFixed(3) + 'mm < ' + R.minAnnularRing + 'mm', p.x, p.y, p.w / 2, { idA: p.ref + '.' + p.num });
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
            // 不同层 SMD 焊盘无间距要求（不同面上）
            if (a.smd && b.smd && a.side !== b.side) continue;
            const d = Geo.dist(a.x, a.y, b.x, b.y) - Math.max(a.w, a.h) / 2 - Math.max(b.w, b.h) / 2;
            if (d < cl - 1e-9) {
              add('error', 'clearance', '焊盘间距不足: ' + a.ref + '.' + a.num + ' ↔ ' + b.ref + '.' + b.num + ' (' + Math.max(0, d).toFixed(3) + 'mm < ' + cl + 'mm)', (a.x + b.x) / 2, (a.y + b.y) / 2, 1, { idA: a.ref + '.' + a.num, idB: b.ref + '.' + b.num });
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
                  add('error', 'clearance', '走线间距不足: ' + (A.t.net || '无网络') + ' ↔ ' + (B.t.net || '无网络') + ' @' + A.t.layer, mx, my, 1, { idA: A.t.id, idB: B.t.id, layer: A.t.layer });
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
                add('error', 'clearance', '焊盘 ' + p.ref + '.' + p.num + ' 与走线 ' + (tc.t.net || '无网络') + ' 间距不足', p.x, p.y, pr, { idA: p.ref + '.' + p.num, idB: tc.t.id, layer: tc.t.layer });
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
            if (d < cl - 1e-9) add('error', 'clearance', '过孔间距不足', (v.x + w.x) / 2, (v.y + w.y) / 2, 1, { idA: v.id, idB: w.id });
          }
          for (const p of pads) {
            if (v.net && p.net && v.net === p.net) continue;
            // PTH 过孔与所有焊盘都可能冲突；盲/埋孔按 layers 过滤
            const vLayers = v.layers || Model.Board.copperLayerIds(board);
            const overlaps = p.layers.some(l => vLayers.includes(l));
            if (!overlaps) continue;
            const d = Geo.dist(v.x, v.y, p.x, p.y) - v.diameter / 2 - Math.max(p.w, p.h) / 2;
            if (d < cl - 1e-9) add('error', 'clearance', '过孔与焊盘 ' + p.ref + '.' + p.num + ' 间距不足', v.x, v.y, v.diameter / 2, { idA: v.id, idB: p.ref + '.' + p.num });
          }
          for (const tc of trCaps) {
            if (v.net && tc.t.net && v.net === tc.t.net) continue;
            const vLayers = v.layers || Model.Board.copperLayerIds(board);
            if (!vLayers.includes(tc.t.layer)) continue;
            for (const cap of tc.caps) {
              if (Geo.capsuleCircleDist(cap, v.x, v.y, v.diameter / 2) < cl - 1e-9) {
                add('error', 'clearance', '过孔与走线间距不足', v.x, v.y, v.diameter / 2, { idA: v.id, idB: tc.t.id, layer: tc.t.layer });
                break;
              }
            }
          }
        }
      }

      // ---- holes ----
      if (opts.checkHoles) {
        const holes = [];
        for (const p of pads) if (p.drill) holes.push({ x: p.x, y: p.y, d: p.drill, label: p.ref + '.' + p.num, id: p.ref + '.' + p.num });
        for (const v of board.vias) holes.push({ x: v.x, y: v.y, d: v.drill, label: '过孔', id: v.id });
        for (let i = 0; i < holes.length; i++) {
          for (let j = i + 1; j < holes.length; j++) {
            const gap = Geo.dist(holes[i].x, holes[i].y, holes[j].x, holes[j].y) - holes[i].d / 2 - holes[j].d / 2;
            if (gap < R.minHoleToHole - 1e-9) {
              add('error', 'hole', '孔间距不足: ' + holes[i].label + ' ↔ ' + holes[j].label, (holes[i].x + holes[j].x) / 2, (holes[i].y + holes[j].y) / 2, 1, { idA: holes[i].id, idB: holes[j].id });
            }
          }
        }
      }

      // ---- board edge ----
      if (opts.checkEdge && board.outline.pts.length >= 3) {
        const pts = board.outline.pts;
        const checkPt = (x, y, r, label, idA) => {
          if (!Geo.pointInPolygon(x, y, pts)) {
            add('error', 'edge', label + ' 在板框之外', x, y, r, { idA });
            return;
          }
          const d = Geo.polygonEdgeDist(x, y, pts);
          if (d - r < R.copperToBoardEdge - 1e-9) {
            add('warning', 'edge', label + ' 距板边 ' + (d - r).toFixed(3) + 'mm < ' + R.copperToBoardEdge + 'mm', x, y, r, { idA });
          }
        };
        for (const p of pads) checkPt(p.x, p.y, Math.max(p.w, p.h) / 2, '焊盘 ' + p.ref + '.' + p.num, p.ref + '.' + p.num);
        for (const v of board.vias) checkPt(v.x, v.y, v.diameter / 2, '过孔', v.id);
        for (const t of board.traces) for (const pt of t.pts) checkPt(pt.x, pt.y, t.width / 2, '走线', t.id);
      }

      // ---- ratsnest ----
      if (opts.checkRatsnest) {
        const lines = Model.Board.ratsnest(board, fpLib);
        for (const l of lines) {
          const detail = l.from && l.to ? (l.from + ' ↔ ' + l.to) : '';
          add('warning', 'unrouted', '网络 ' + l.net + ' 未布线: ' + detail, l.x1, l.y1, 1.5, { idA: 'net:' + l.net, idB: l.from + '|' + l.to });
        }
      }

      // ---- silk over pad (IPC-2221 §9 - 丝印不得覆盖焊盘影响可焊性) ----
      if (opts.checkSilk) {
        for (const sk of board.silkscreen) {
          const silkPads = pads.filter(p => p.side === sk.side);
          for (const p of silkPads) {
            if (silkOverlapsPad(sk, p)) {
              add('warning', 'silk_over_pad', '丝印覆盖焊盘 ' + p.ref + '.' + p.num + ' (' + sk.kind + ')', p.x, p.y, Math.max(p.w, p.h) / 2, { idA: sk.id, idB: p.ref + '.' + p.num, layer: 'silk' });
            }
          }
        }
      }

      return errs;
    }
  };

  // 判断 silk 对象是否覆盖焊盘（粗略但保守，宁误报不漏报）
  function silkOverlapsPad(sk, p) {
    const pr = Math.max(p.w, p.h) / 2;
    if (sk.kind === 'line' && sk.pts && sk.pts.length >= 2) {
      for (let i = 0; i < sk.pts.length - 1; i++) {
        if (Geo.pointToSegmentDist(p.x, p.y, sk.pts[i].x, sk.pts[i].y, sk.pts[i + 1].x, sk.pts[i + 1].y) <= pr + (sk.width || 0.15) / 2) return true;
      }
      return false;
    }
    if (sk.kind === 'rect') {
      const x1 = sk.x, y1 = sk.y, x2 = sk.x + sk.w, y2 = sk.y + sk.h;
      const L = Math.min(x1, x2), R = Math.max(x1, x2), T = Math.min(y1, y2), B = Math.max(y1, y2);
      const cx = Geo.clamp(p.x, L, R), cy = Geo.clamp(p.y, T, B);
      return Geo.dist(cx, cy, p.x, p.y) <= pr;
    }
    if (sk.kind === 'circle') {
      return Geo.dist(sk.x, sk.y, p.x, p.y) <= (sk.r || 0) + pr;
    }
    if (sk.kind === 'text') {
      // 用文本尺寸估算 bbox（不含旋转，粗略）
      const w = (sk.text || '').length * (sk.size || 1.2) * 0.6;
      const h = (sk.size || 1.2);
      const cx = Geo.clamp(p.x, sk.x, sk.x + w), cy = Geo.clamp(p.y, sk.y - h, sk.y);
      return Geo.dist(cx, cy, p.x, p.y) <= pr;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // DrcIndex - 增量 DRC 索引
  // 维护上次违规快照，runIncremental 只重算受影响对象
  // changedIds 格式: ['comp:R1','trace:tr_abc','via:via_xyz','silk:slk_1','net:GND','board','rules']
  // ---------------------------------------------------------------------------
  const DrcIndex = {
    create() {
      return {
        lastAll: [],
        lastByKey: new Map(),
        // 完整重算（重置快照）
        run(board, fpLib, options) {
          const all = PCBDrc.run(board, fpLib, options);
          const byKey = new Map();
          for (const v of all) byKey.set(v.key, v);
          const delta = this._diff(this.lastByKey, byKey);
          this.lastAll = all;
          this.lastByKey = byKey;
          return { all, added: delta.added, removed: delta.removed, summary: this._summary(all) };
        },
        // 增量：仅重算与 changedIds 相关的违规
        runIncremental(board, fpLib, changedIds, options) {
          const opts = Object.assign({ checkClearance: true, checkWidth: true, checkHoles: true, checkEdge: true, checkRatsnest: true, checkSilk: true }, options || {});
          // 'board' 或 'rules' 或空 → 完整重算
          if (!Array.isArray(changedIds) || !changedIds.length || changedIds.includes('board') || changedIds.includes('rules')) {
            return this.run(board, fpLib, options);
          }
          // 解析 changedIds
          const refs = new Set(), traceIds = new Set(), viaIds = new Set(), silkIds = new Set(), netNames = new Set();
          for (const cid of changedIds) {
            if (!cid) continue;
            const idx = cid.indexOf(':');
            const kind = idx > 0 ? cid.slice(0, idx) : '';
            const val = idx > 0 ? cid.slice(idx + 1) : '';
            if (kind === 'comp') refs.add(val);
            else if (kind === 'trace') traceIds.add(val);
            else if (kind === 'via') viaIds.add(val);
            else if (kind === 'silk') silkIds.add(val);
            else if (kind === 'net') netNames.add(val);
          }
          // 找出与变更对象相关的 pads（用于 clearance/edge/holes 重判）
          const allPads = Model.Board.allPads(board, fpLib);
          const changedPads = allPads.filter(p => refs.has(p.ref) || netNames.has(p.net));
          const changedPadKeys = new Set(changedPads.map(p => p.ref + '.' + p.num));

          // 旧违规按是否涉及变更对象分类
          const keep = [], recheck = [];
          for (const v of this.lastAll) {
            const involved = this._involves(v, refs, traceIds, viaIds, silkIds, netNames, changedPadKeys);
            if (involved) recheck.push(v); else keep.push(v);
          }

          // 重新检查（仅与变更对象相关的违规）
          const newOnes = this._runTargeted(board, fpLib, opts, { refs, traceIds, viaIds, silkIds, netNames, changedPads, changedPadKeys, allPads });
          const merged = keep.concat(newOnes);
          const byKey = new Map();
          for (const v of merged) byKey.set(v.key, v);
          const delta = this._diff(this.lastByKey, byKey);
          this.lastAll = merged;
          this.lastByKey = byKey;
          return { all: merged, added: delta.added, removed: delta.removed, summary: this._summary(merged) };
        },
        clear() { this.lastAll = []; this.lastByKey = new Map(); },

        // ---- helpers ----
        _summary(all) {
          let errors = 0, warnings = 0;
          for (const v of all) { if (v.severity === 'error') errors++; else warnings++; }
          return { errors, warnings, total: all.length };
        },
        _diff(oldByKey, newByKey) {
          const added = [], removed = [];
          for (const [k, v] of newByKey) if (!oldByKey.has(k)) added.push(v);
          for (const [k, v] of oldByKey) if (!newByKey.has(k)) removed.push(v);
          return { added, removed };
        },
        _involves(v, refs, traceIds, viaIds, silkIds, netNames, changedPadKeys) {
          const a = v.idA || '', b = v.idB || '';
          if (v.type === 'unrouted') {
            if (netNames.has(a.replace(/^net:/, ''))) return true;
            return false;
          }
          if (v.type === 'silk_over_pad') {
            if (silkIds.has(a)) return true;
            const padB = b;
            if (changedPadKeys.has(padB)) return true;
            return false;
          }
          // width / drill / annular / edge 等 idA-only 类型
          if (v.type === 'width' || v.type === 'drill' || v.type === 'annular' || v.type === 'edge') {
            return this._idInvolved(a, refs, traceIds, viaIds, silkIds, changedPadKeys);
          }
          if (v.type === 'hole') {
            // 任一端变更即相关
            return this._idInvolved(a, refs, traceIds, viaIds, silkIds, changedPadKeys) ||
                   this._idInvolved(b, refs, traceIds, viaIds, silkIds, changedPadKeys);
          }
          if (v.type === 'clearance') {
            return this._idInvolved(a, refs, traceIds, viaIds, silkIds, changedPadKeys) ||
                   this._idInvolved(b, refs, traceIds, viaIds, silkIds, changedPadKeys);
          }
          // 默认保守：视为相关
          return true;
        },
        _idInvolved(id, refs, traceIds, viaIds, silkIds, changedPadKeys) {
          if (!id) return false;
          // ref.pad 格式
          if (/^[A-Z]+\d+\.\d+$/.test(id) || /^[A-Z]+\d+\.[A-Za-z]/.test(id)) {
            return changedPadKeys.has(id);
          }
          if (traceIds.has(id) || viaIds.has(id) || silkIds.has(id)) return true;
          // ref 直接（如 R1，未带 pad）
          if (refs.has(id)) return true;
          return false;
        },
        // 只重算与变更对象相关的检查
        _runTargeted(board, fpLib, opts, sel) {
          const R = board.designRules;
          const out = [];
          const add = (severity, type, message, x, y, r, extra) => {
            const v = mkV(severity, type, message, x, y, r, extra);
            v.key = vkey(v);
            out.push(v);
          };
          const allPads = sel.allPads;

          // ---- width / drill / annular (只查变更的 trace/via/pad) ----
          if (opts.checkWidth) {
            for (const t of board.traces) {
              if (!sel.traceIds.has(t.id)) continue;
              if (t.width < R.minTraceWidth - 1e-9) {
                add('error', 'width', '线宽 ' + t.width.toFixed(3) + 'mm < 最小 ' + R.minTraceWidth + 'mm (网络 ' + (t.net || '无') + ')', t.pts[0].x, t.pts[0].y, t.width, { idA: t.id, layer: t.layer });
              }
            }
            for (const v of board.vias) {
              if (!sel.viaIds.has(v.id)) continue;
              if (v.drill < R.minViaDrill - 1e-9) add('error', 'drill', '过孔钻孔 ' + v.drill + 'mm < 最小 ' + R.minViaDrill + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
              if (v.diameter < R.minViaDiameter - 1e-9) add('error', 'drill', '过孔外径 ' + v.diameter + 'mm < 最小 ' + R.minViaDiameter + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
              if ((v.diameter - v.drill) / 2 < R.minAnnularRing - 1e-9) add('error', 'annular', '过孔环宽不足 ' + R.minAnnularRing + 'mm', v.x, v.y, v.diameter / 2, { idA: v.id });
            }
            for (const p of sel.changedPads) {
              if (p.drill && p.plated !== false) {
                const ring = (Math.min(p.w, p.h) - p.drill) / 2;
                if (ring < R.minAnnularRing - 1e-9) {
                  add('error', 'annular', p.ref + '.' + p.num + ' 焊盘环宽 ' + ring.toFixed(3) + 'mm < ' + R.minAnnularRing + 'mm', p.x, p.y, p.w / 2, { idA: p.ref + '.' + p.num });
                }
              }
            }
          }

          // ---- clearance: 变更 pads/traces/vias vs 全量 ----
          if (opts.checkClearance) {
            const cl = R.minClearance;
            // pad-pad: 任一为变更 pad
            for (let i = 0; i < allPads.length; i++) {
              for (let j = i + 1; j < allPads.length; j++) {
                const a = allPads[i], b = allPads[j];
                if (a.ref === b.ref) continue;
                if (a.net && b.net && a.net === b.net) continue;
                if (a.smd && b.smd && a.side !== b.side) continue;
                if (!sel.changedPadKeys.has(a.ref + '.' + a.num) && !sel.changedPadKeys.has(b.ref + '.' + b.num)) continue;
                const d = Geo.dist(a.x, a.y, b.x, b.y) - Math.max(a.w, a.h) / 2 - Math.max(b.w, b.h) / 2;
                if (d < cl - 1e-9) {
                  add('error', 'clearance', '焊盘间距不足: ' + a.ref + '.' + a.num + ' ↔ ' + b.ref + '.' + b.num + ' (' + Math.max(0, d).toFixed(3) + 'mm < ' + cl + 'mm)', (a.x + b.x) / 2, (a.y + b.y) / 2, 1, { idA: a.ref + '.' + a.num, idB: b.ref + '.' + b.num });
                }
              }
            }
            // trace-trace: 变更 trace vs 全量 trace
            const trCaps = board.traces.map(t => ({ t, caps: Geo.polylineCapsules(t.pts, t.width) }));
            for (let i = 0; i < trCaps.length; i++) {
              for (let j = i; j < trCaps.length; j++) {
                const A = trCaps[i], B = trCaps[j];
                if (A.t.layer !== B.t.layer) continue;
                if (A.t.net && B.t.net && A.t.net === B.t.net) continue;
                if (!sel.traceIds.has(A.t.id) && !sel.traceIds.has(B.t.id)) continue;
                for (let ci = 0; ci < A.caps.length; ci++) {
                  for (let cj = 0; cj < B.caps.length; cj++) {
                    if (A === B && Math.abs(ci - cj) <= 1) continue;
                    const gap = Geo.capsuleCapsuleDist(A.caps[ci], B.caps[cj]);
                    if (gap < cl - 1e-9) {
                      const mx = (A.caps[ci].ax + B.caps[cj].ax) / 2, my = (A.caps[ci].ay + B.caps[cj].ay) / 2;
                      add('error', 'clearance', '走线间距不足: ' + (A.t.net || '无网络') + ' ↔ ' + (B.t.net || '无网络') + ' @' + A.t.layer, mx, my, 1, { idA: A.t.id, idB: B.t.id, layer: A.t.layer });
                      ci = A.caps.length; break;
                    }
                  }
                }
              }
            }
            // pad-trace: 变更 pad vs 全量 trace + 变更 trace vs 全量 pad
            const padSet = sel.changedPadKeys;
            for (const p of allPads) {
              const isChangedPad = padSet.has(p.ref + '.' + p.num);
              if (!isChangedPad && !sel.traceIds.size) continue;
              const pr = Math.max(p.w, p.h) / 2;
              for (const tc of trCaps) {
                if (!isChangedPad && !sel.traceIds.has(tc.t.id)) continue;
                if (p.net && tc.t.net && p.net === tc.t.net) continue;
                if (!p.layers.includes(tc.t.layer)) continue;
                for (const cap of tc.caps) {
                  const gap = Geo.capsuleCircleDist(cap, p.x, p.y, pr);
                  if (gap < cl - 1e-9) {
                    add('error', 'clearance', '焊盘 ' + p.ref + '.' + p.num + ' 与走线 ' + (tc.t.net || '无网络') + ' 间距不足', p.x, p.y, pr, { idA: p.ref + '.' + p.num, idB: tc.t.id, layer: tc.t.layer });
                    break;
                  }
                }
              }
            }
            // via clearances: 变更 via vs 全量
            for (let i = 0; i < board.vias.length; i++) {
              const v = board.vias[i];
              if (!sel.viaIds.has(v.id)) continue;
              for (let j = i + 1; j < board.vias.length; j++) {
                const w = board.vias[j];
                if (v.net && w.net && v.net === w.net) continue;
                const d = Geo.dist(v.x, v.y, w.x, w.y) - v.diameter / 2 - w.diameter / 2;
                if (d < cl - 1e-9) add('error', 'clearance', '过孔间距不足', (v.x + w.x) / 2, (v.y + w.y) / 2, 1, { idA: v.id, idB: w.id });
              }
              for (const p of allPads) {
                if (v.net && p.net && v.net === p.net) continue;
                const vLayers = v.layers || Model.Board.copperLayerIds(board);
                const overlaps = p.layers.some(l => vLayers.includes(l));
                if (!overlaps) continue;
                const d = Geo.dist(v.x, v.y, p.x, p.y) - v.diameter / 2 - Math.max(p.w, p.h) / 2;
                if (d < cl - 1e-9) add('error', 'clearance', '过孔与焊盘 ' + p.ref + '.' + p.num + ' 间距不足', v.x, v.y, v.diameter / 2, { idA: v.id, idB: p.ref + '.' + p.num });
              }
              for (const tc of trCaps) {
                if (v.net && tc.t.net && v.net === tc.t.net) continue;
                const vLayers = v.layers || Model.Board.copperLayerIds(board);
                if (!vLayers.includes(tc.t.layer)) continue;
                for (const cap of tc.caps) {
                  if (Geo.capsuleCircleDist(cap, v.x, v.y, v.diameter / 2) < cl - 1e-9) {
                    add('error', 'clearance', '过孔与走线间距不足', v.x, v.y, v.diameter / 2, { idA: v.id, idB: tc.t.id, layer: tc.t.layer });
                    break;
                  }
                }
              }
            }
          }

          // ---- holes: 变更对象 vs 全量 ----
          if (opts.checkHoles) {
            const holes = [];
            for (const p of allPads) if (p.drill) holes.push({ x: p.x, y: p.y, d: p.drill, label: p.ref + '.' + p.num, id: p.ref + '.' + p.num, changed: sel.changedPadKeys.has(p.ref + '.' + p.num) });
            for (const v of board.vias) holes.push({ x: v.x, y: v.y, d: v.drill, label: '过孔', id: v.id, changed: sel.viaIds.has(v.id) });
            for (let i = 0; i < holes.length; i++) {
              for (let j = i + 1; j < holes.length; j++) {
                if (!holes[i].changed && !holes[j].changed) continue;
                const gap = Geo.dist(holes[i].x, holes[i].y, holes[j].x, holes[j].y) - holes[i].d / 2 - holes[j].d / 2;
                if (gap < R.minHoleToHole - 1e-9) {
                  add('error', 'hole', '孔间距不足: ' + holes[i].label + ' ↔ ' + holes[j].label, (holes[i].x + holes[j].x) / 2, (holes[i].y + holes[j].y) / 2, 1, { idA: holes[i].id, idB: holes[j].id });
                }
              }
            }
          }

          // ---- edge: 变更对象 ----
          if (opts.checkEdge && board.outline.pts.length >= 3) {
            const pts = board.outline.pts;
            const checkPt = (x, y, r, label, idA, changed) => {
              if (!changed) return;
              if (!Geo.pointInPolygon(x, y, pts)) {
                add('error', 'edge', label + ' 在板框之外', x, y, r, { idA });
                return;
              }
              const d = Geo.polygonEdgeDist(x, y, pts);
              if (d - r < R.copperToBoardEdge - 1e-9) {
                add('warning', 'edge', label + ' 距板边 ' + (d - r).toFixed(3) + 'mm < ' + R.copperToBoardEdge + 'mm', x, y, r, { idA });
              }
            };
            for (const p of sel.changedPads) checkPt(p.x, p.y, Math.max(p.w, p.h) / 2, '焊盘 ' + p.ref + '.' + p.num, p.ref + '.' + p.num, true);
            for (const v of board.vias) if (sel.viaIds.has(v.id)) checkPt(v.x, v.y, v.diameter / 2, '过孔', v.id, true);
            for (const t of board.traces) if (sel.traceIds.has(t.id)) for (const pt of t.pts) checkPt(pt.x, pt.y, t.width / 2, '走线', t.id, true);
          }

          // ---- ratsnest: 仅变更网络 ----
          if (opts.checkRatsnest && sel.netNames.size) {
            const lines = Model.Board.ratsnest(board, fpLib).filter(l => sel.netNames.has(l.net));
            for (const l of lines) {
              const detail = l.from && l.to ? (l.from + ' ↔ ' + l.to) : '';
              add('warning', 'unrouted', '网络 ' + l.net + ' 未布线: ' + detail, l.x1, l.y1, 1.5, { idA: 'net:' + l.net, idB: l.from + '|' + l.to });
            }
          }

          // ---- silk-over-pad: 变更 silk vs 全量 pad + 变更 pad vs 全量 silk ----
          if (opts.checkSilk) {
            for (const sk of board.silkscreen) {
              const isChangedSilk = sel.silkIds.has(sk.id);
              const silkPads = allPads.filter(p => p.side === sk.side);
              for (const p of silkPads) {
                if (!isChangedSilk && !sel.changedPadKeys.has(p.ref + '.' + p.num)) continue;
                if (silkOverlapsPad(sk, p)) {
                  add('warning', 'silk_over_pad', '丝印覆盖焊盘 ' + p.ref + '.' + p.num + ' (' + sk.kind + ')', p.x, p.y, Math.max(p.w, p.h) / 2, { idA: sk.id, idB: p.ref + '.' + p.num, layer: 'silk' });
                }
              }
            }
          }

          return out;
        }
      };
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

  const PCBDrcErc = { PCBDrc, PcbErc, DrcIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBDrcErc;
  else { global.PCBDrc = PCBDrc; global.PcbErc = PcbErc; global.PCBDrcIndex = DrcIndex; }
})(typeof window !== 'undefined' ? window : globalThis);
