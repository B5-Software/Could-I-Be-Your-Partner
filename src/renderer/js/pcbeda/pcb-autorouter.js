// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - simple grid-based A* autorouter (multi-net, rip-up free, sequential)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // options: {traceWidth, clearance, viaDrill, viaDiameter, gridSize, maxNets}
  function autoroute(board, fpLib, options) {
    const R = board.designRules;
    const opts = Object.assign({
      traceWidth: R.defaultTraceWidth || 0.25,
      clearance: R.minClearance || 0.2,
      viaDrill: R.defaultViaDrill || 0.3,
      viaDiameter: R.defaultViaDiameter || 0.6,
      gridSize: 0, // 0 = auto
      onlyNets: null // array of net names or null = all unrouted
    }, options || {});

    const layers = Model.Board.copperLayerIds(board);
    const layerIdx = new Map(layers.map((l, i) => [l, i]));
    const NL = layers.length;

    // workspace bbox
    const bb = Model.Board.boardBBox(board, fpLib);
    const margin = 4;
    const ox = bb.minX - margin, oy = bb.minY - margin;
    const gs = opts.gridSize || Math.max(0.2, (opts.traceWidth + opts.clearance) / 2);
    const W = Math.ceil((bb.maxX - bb.minX + 2 * margin) / gs) + 1;
    const H = Math.ceil((bb.maxY - bb.minY + 2 * margin) / gs) + 1;
    if (W * H > 4e6) return { ok: false, error: '板子太大/网格太细，无法自动布线 (' + W + 'x' + H + ')' };

    // blocked[layer] = Uint8Array(W*H)
    const blocked = layers.map(() => new Uint8Array(W * H));
    const inflate = (opts.traceWidth / 2 + opts.clearance);
    const gIdx = (x, y) => y * W + x;
    const toGrid = (x, y) => ({ gx: Math.round((x - ox) / gs), gy: Math.round((y - oy) / gs) });
    const toWorld = (gx, gy) => ({ x: ox + gx * gs, y: oy + gy * gs });

    function blockCircle(x, y, r, layerIds) {
      const g = toGrid(x, y);
      const gr = Math.ceil(r / gs);
      for (const lid of layerIds) {
        const li = layerIdx.get(lid);
        if (li === undefined) continue; // pad on layer not present in stackup
        const arr = blocked[li];
        for (let dy = -gr; dy <= gr; dy++) {
          for (let dx = -gr; dx <= gr; dx++) {
            const wx = ox + (g.gx + dx) * gs, wy = oy + (g.gy + dy) * gs;
            if (Geo.dist(wx, wy, x, y) <= r && g.gx + dx >= 0 && g.gy + dy >= 0 && g.gx + dx < W && g.gy + dy < H) {
              arr[gIdx(g.gx + dx, g.gy + dy)] = 1;
            }
          }
        }
      }
    }
    function blockSegment(ax, ay, bx, by, r, layerId) {
      const li = layerIdx.get(layerId);
      if (li === undefined) return;
      const arr = blocked[li];
      const len = Geo.dist(ax, ay, bx, by);
      const steps = Math.max(1, Math.ceil(len / (gs / 2)));
      for (let k = 0; k <= steps; k++) {
        const x = ax + (bx - ax) * k / steps, y = ay + (by - ay) * k / steps;
        const g = toGrid(x, y);
        const gr = Math.ceil(r / gs);
        for (let dy = -gr; dy <= gr; dy++) {
          for (let dx = -gr; dx <= gr; dx++) {
            const wx = ox + (g.gx + dx) * gs, wy = oy + (g.gy + dy) * gs;
            if (Geo.dist(wx, wy, x, y) <= r && g.gx + dx >= 0 && g.gy + dy >= 0 && g.gx + dx < W && g.gy + dy < H) {
              arr[gIdx(g.gx + dx, g.gy + dy)] = 1;
            }
          }
        }
      }
    }

    // block existing copper (foreign nets)
    const allPads = Model.Board.allPads(board, fpLib);
    function blockPad(p, skipNet) {
      if (p.net === skipNet) return;
      const r = Math.max(p.w, p.h) / 2 + inflate;
      const lids = p.drill ? layers : p.layers;
      blockCircle(p.x, p.y, r, lids);
    }
    function blockAll(skipNet) {
      for (const p of allPads) blockPad(p, skipNet);
      for (const v of board.vias) {
        if (v.net === skipNet) continue;
        blockCircle(v.x, v.y, v.diameter / 2 + inflate, layers);
      }
      for (const t of board.traces) {
        if (t.net === skipNet) continue;
        for (let i = 0; i < t.pts.length - 1; i++) {
          blockSegment(t.pts[i].x, t.pts[i].y, t.pts[i + 1].x, t.pts[i + 1].y, t.width / 2 + inflate, t.layer);
        }
      }
      // board edge keep-out
      if (board.outline.pts.length >= 3) {
        for (let gy = 0; gy < H; gy++) {
          for (let gx = 0; gx < W; gx++) {
            const w = toWorld(gx, gy);
            if (!Geo.pointInPolygon(w.x, w.y, board.outline.pts) ||
                Geo.polygonEdgeDist(w.x, w.y, board.outline.pts) < R.copperToBoardEdge) {
              for (const arr of blocked) arr[gIdx(gx, gy)] = 1;
            }
          }
        }
      }
    }

    // A* between two world points on given start layers
    function routeSegment(sx, sy, sLayerLi, tx, ty, tLayerLi) {
      const s = toGrid(sx, sy), t = toGrid(tx, ty);
      const sg = gIdx(Geo.clamp(s.gx, 0, W - 1), Geo.clamp(s.gy, 0, H - 1));
      const tg = gIdx(Geo.clamp(t.gx, 0, W - 1), Geo.clamp(t.gy, 0, H - 1));
      const state = (gi, li) => gi * NL + li;
      const open = new MinHeap();
      const gScore = new Map();
      const came = new Map();
      const startState = state(sg, sLayerLi);
      gScore.set(startState, 0);
      open.push(state(sg, sLayerLi), heuristic(sg, sLayerLi));
      function heuristic(gi, li) {
        const gx = gi % W, gy = (gi / W) | 0;
        const tx2 = tg % W, ty2 = (tg / W) | 0;
        return Math.abs(gx - tx2) + Math.abs(gy - ty2) + (li === tLayerLi ? 0 : 6);
      }
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let pops = 0;
      const maxPops = 600000;
      while (open.size() > 0) {
        if (++pops > maxPops) return null;
        const cur = open.pop();
        const gi = (cur / NL) | 0, li = cur % NL;
        if (gi === tg && li === tLayerLi) {
          // reconstruct
          const path = [];
          let s2 = cur;
          while (s2 !== undefined) {
            const g2 = (s2 / NL) | 0, l2 = s2 % NL;
            path.push({ gx: g2 % W, gy: (g2 / W) | 0, li: l2 });
            s2 = came.get(s2);
          }
          path.reverse();
          return path;
        }
        const gx = gi % W, gy = (gi / W) | 0;
        const g0 = gScore.get(cur);
        for (const d of DIRS) {
          const nx = gx + d[0], ny = gy + d[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = gIdx(nx, ny);
          if (blocked[li][ni] && ni !== tg && ni !== sg) continue;
          const ns = state(ni, li);
          const ng = g0 + 1;
          if (ng < (gScore.get(ns) === undefined ? Infinity : gScore.get(ns))) {
            gScore.set(ns, ng);
            came.set(ns, cur);
            open.push(ns, ng + heuristic(ni, li));
          }
        }
        // layer change (via) at same cell
        for (let nl = 0; nl < NL; nl++) {
          if (nl === li) continue;
          if (blocked[nl][gi] && gi !== tg && gi !== sg) continue;
          const ns = state(gi, nl);
          const ng = g0 + 6;
          if (ng < (gScore.get(ns) === undefined ? Infinity : gScore.get(ns))) {
            gScore.set(ns, ng);
            came.set(ns, cur);
            open.push(ns, ng + heuristic(gi, nl));
          }
        }
      }
      return null;
    }

    // main loop: route ratsnest lines
    const lines = Model.Board.ratsnest(board, fpLib);
    const todo = opts.onlyNets ? lines.filter(l => opts.onlyNets.includes(l.net)) : lines;
    todo.sort((a, b) => Geo.dist(a.x1, a.y1, a.x2, a.y2) - Geo.dist(b.x1, b.y1, b.x2, b.y2));

    const newTraces = [], newVias = [];
    let routed = 0, failed = 0;
    const failedNets = new Set();

    // pad lookup for layer determination
    const padAt = (x, y, net) => {
      let best = null, bd = 1.5;
      for (const p of allPads) {
        if (p.net !== net) continue;
        const d = Geo.dist(x, y, p.x, p.y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };

    for (const ln of todo) {
      blockAll(ln.net); // rebuild obstacles excluding this net
      const pA = padAt(ln.x1, ln.y1, ln.net);
      const pB = padAt(ln.x2, ln.y2, ln.net);
      const layerOf = (p) => {
        if (!p) return 0;
        if (p.drill) return 0; // start routing TH on F.Cu
        return layerIdx.get(p.side === 'B' ? 'B.Cu' : 'F.Cu') || 0;
      };
      const sLi = layerOf(pA), tLi = layerOf(pB);
      const path = routeSegment(ln.x1, ln.y1, sLi, ln.x2, ln.y2, tLi);
      if (!path) { failed++; failedNets.add(ln.net); continue; }
      // compress into polylines per layer
      let segStart = 0;
      for (let i = 1; i <= path.length; i++) {
        const endRun = (i === path.length) || (path[i].li !== path[segStart].li);
        if (!endRun) continue;
        // path[segStart..i-1] same layer
        const run = path.slice(segStart, i);
        const pts = [];
        let dir = null;
        let runStart = toWorld(run[0].gx, run[0].gy);
        pts.push(runStart);
        for (let k = 1; k < run.length; k++) {
          const d = [run[k].gx - run[k - 1].gx, run[k].gy - run[k - 1].gy];
          const key = d[0] + ',' + d[1];
          if (dir === null) dir = key;
          else if (key !== dir) {
            pts.push(toWorld(run[k - 1].gx, run[k - 1].gy));
            dir = key;
          }
        }
        pts.push(toWorld(run[run.length - 1].gx, run[run.length - 1].gy));
        if (pts.length >= 2) {
          newTraces.push({ net: ln.net, layer: layers[run[0].li], width: opts.traceWidth, pts });
          // block new trace
          for (let k = 0; k < pts.length - 1; k++) blockSegment(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y, opts.traceWidth / 2 + inflate, layers[run[0].li]);
        }
        // via between layers
        if (i < path.length) {
          const vp = toWorld(path[i].gx, path[i].gy);
          newVias.push({ net: ln.net, x: vp.x, y: vp.y, drill: opts.viaDrill, diameter: opts.viaDiameter });
          blockCircle(vp.x, vp.y, opts.viaDiameter / 2 + inflate, layers);
        }
        segStart = i;
      }
      routed++;
    }

    return {
      ok: true, routed, failed,
      failedNets: Array.from(failedNets),
      traces: newTraces, vias: newVias,
      gridSize: gs
    };
  }

  // binary min-heap
  class MinHeap {
    constructor() { this.k = []; this.v = []; }
    size() { return this.k.length; }
    push(key, val) {
      this.k.push(key); this.v.push(val);
      let i = this.k.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.v[p] <= this.v[i]) break;
        this._swap(i, p); i = p;
      }
    }
    pop() {
      const top = this.k[0];
      const lk = this.k.pop(), lv = this.v.pop();
      if (this.k.length) {
        this.k[0] = lk; this.v[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < this.v.length && this.v[l] < this.v[m]) m = l;
          if (r < this.v.length && this.v[r] < this.v[m]) m = r;
          if (m === i) break;
          this._swap(i, m); i = m;
        }
      }
      return top;
    }
    _swap(a, b) {
      const tk = this.k[a]; this.k[a] = this.k[b]; this.k[b] = tk;
      const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv;
    }
  }

  const PCBAutorouter = { autoroute };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBAutorouter;
  else global.PCBAutorouter = PCBAutorouter;
})(typeof window !== 'undefined' ? window : globalThis);
