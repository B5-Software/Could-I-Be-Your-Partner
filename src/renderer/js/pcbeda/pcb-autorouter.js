// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - grid-based A* autorouter (multi-net, rip-up & reroute, 45° post-process)
// 工业标准参考: IPC-2221 (PCB 通用设计标准)、IPC-2152 (电流-温升)
// 算法:
//   1. 主循环: 按 ratsnest 距离升序逐网络 A* 布线
//   2. Rip-up & reroute: 失败网络尝试拆除冲突已布段（仅异网）后重布，最多 maxRipRerouteIter 轮
//   3. 45° 后处理: 将 L 形 90° 拐角转换为 45° 斜线段（IPC-2221 推荐布线风格）
//   4. 层偏好: 支持 preferLayers 选项优先使用指定铜层
//   5. 进度回调: onProgress(current, total, info)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // options: {traceWidth, clearance, viaDrill, viaDiameter, gridSize, onlyNets,
  //           preferLayers:[...], maxRipRerouteIter:3, allowDiagonal:true,
  //           onProgress:fn, maxPops:600000}
  function autoroute(board, fpLib, options) {
    const R = board.designRules;
    const opts = Object.assign({
      traceWidth: R.defaultTraceWidth || 0.25,
      clearance: R.minClearance || 0.2,
      viaDrill: R.defaultViaDrill || 0.3,
      viaDiameter: R.defaultViaDiameter || 0.6,
      gridSize: 0,
      onlyNets: null,
      preferLayers: null,            // ['F.Cu','B.Cu'] 优先顺序
      maxRipRerouteIter: 3,          // rip-up 重布迭代轮数
      allowDiagonal: true,           // 允许 8 方向（含 45°）搜索
      onProgress: null,
      maxPops: 600000                // 每条网络 A* 最大 pop 数
    }, options || {});

    const layers = Model.Board.copperLayerIds(board);
    const layerIdx = new Map(layers.map((l, i) => [l, i]));
    const NL = layers.length;

    // 层偏好代价：在 preferLayers 中越靠前代价越低
    const layerCost = new Array(NL).fill(0);
    if (Array.isArray(opts.preferLayers)) {
      for (let i = 0; i < NL; i++) {
        const pos = opts.preferLayers.indexOf(layers[i]);
        layerCost[i] = pos < 0 ? 4 : pos;  // 不在偏好表里的层 +4 代价
      }
    }

    const bb = Model.Board.boardBBox(board, fpLib);
    const margin = 4;
    const ox = bb.minX - margin, oy = bb.minY - margin;
    const gs = opts.gridSize || Math.max(0.2, (opts.traceWidth + opts.clearance) / 2);
    const W = Math.ceil((bb.maxX - bb.minX + 2 * margin) / gs) + 1;
    const H = Math.ceil((bb.maxY - bb.minY + 2 * margin) / gs) + 1;
    if (W * H > 4e6) return { ok: false, error: '板子太大/网格太细，无法自动布线 (' + W + 'x' + H + ')' };

    const inflate = (opts.traceWidth / 2 + opts.clearance);
    const gIdx = (x, y) => y * W + x;
    const toGrid = (x, y) => ({ gx: Math.round((x - ox) / gs), gy: Math.round((y - oy) / gs) });
    const toWorld = (gx, gy) => ({ x: ox + gx * gs, y: oy + gy * gs });

    // ---- 阻挡图 ----
    // blocked[li] = Uint8Array(W*H)：1=异网阻挡
    // ownedBy[li] = Int32Array(W*H)：当前网络 id（0=无），用于 rip-up
    const blocked = layers.map(() => new Uint8Array(W * H));
    const ownedBy = layers.map(() => new Int32Array(W * H)); // 0=空, n=网络序号(1-based)

    function blockCircle(x, y, r, layerIds, ownerNetId) {
      const g = toGrid(x, y);
      const gr = Math.ceil(r / gs);
      for (const lid of layerIds) {
        const li = layerIdx.get(lid);
        if (li === undefined) continue;
        const arr = blocked[li];
        const own = ownedBy[li];
        for (let dy = -gr; dy <= gr; dy++) {
          for (let dx = -gr; dx <= gr; dx++) {
            const ngx = g.gx + dx, ngy = g.gy + dy;
            if (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H) continue;
            const wx = ox + ngx * gs, wy = oy + ngy * gs;
            if (Geo.dist(wx, wy, x, y) <= r) {
              const ci = gIdx(ngx, ngy);
              arr[ci] = 1;
              if (ownerNetId > 0) own[ci] = ownerNetId;
            }
          }
        }
      }
    }
    function blockSegment(ax, ay, bx, by, r, layerId, ownerNetId) {
      const li = layerIdx.get(layerId);
      if (li === undefined) return;
      const arr = blocked[li];
      const own = ownedBy[li];
      const len = Geo.dist(ax, ay, bx, by);
      const steps = Math.max(1, Math.ceil(len / (gs / 2)));
      for (let k = 0; k <= steps; k++) {
        const x = ax + (bx - ax) * k / steps, y = ay + (by - ay) * k / steps;
        const g = toGrid(x, y);
        const gr = Math.ceil(r / gs);
        for (let dy = -gr; dy <= gr; dy++) {
          for (let dx = -gr; dx <= gr; dx++) {
            const ngx = g.gx + dx, ngy = g.gy + dy;
            if (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H) continue;
            const wx = ox + ngx * gs, wy = oy + ngy * gs;
            if (Geo.dist(wx, wy, x, y) <= r) {
              const ci = gIdx(ngx, ngy);
              arr[ci] = 1;
              if (ownerNetId > 0) own[ci] = ownerNetId;
            }
          }
        }
      }
    }

    const allPads = Model.Board.allPads(board, fpLib);

    // 阻挡板外 + 板边距 + 异网铜（外部对象 ownerNetId=0，不会被 rip-up）
    function blockStaticObstacles(skipNet) {
      for (const p of allPads) {
        if (p.net === skipNet) continue;
        const r = Math.max(p.w, p.h) / 2 + inflate;
        const lids = p.drill ? layers : p.layers;
        blockCircle(p.x, p.y, r, lids, 0);
      }
      for (const v of board.vias) {
        if (v.net === skipNet) continue;
        const lids = v.layers || layers;
        blockCircle(v.x, v.y, v.diameter / 2 + inflate, lids, 0);
      }
      for (const t of board.traces) {
        if (t.net === skipNet) continue;
        for (let i = 0; i < t.pts.length - 1; i++) {
          blockSegment(t.pts[i].x, t.pts[i].y, t.pts[i + 1].x, t.pts[i + 1].y, t.width / 2 + inflate, t.layer, 0);
        }
      }
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

    // 清除某网络此前布线留下的阻挡（用于 rip-up）
    function unblockNet(netId) {
      for (let li = 0; li < NL; li++) {
        const own = ownedBy[li];
        for (let i = 0; i < own.length; i++) {
          if (own[i] === netId) { own[i] = 0; blocked[li][i] = 0; }
        }
      }
    }

    // 把已布网络（netId, traces, vias）的阻挡写入 blocked/ownedBy
    function blockRoutedNet(netId, traces, vias) {
      for (const t of traces) {
        for (let i = 0; i < t.pts.length - 1; i++) {
          blockSegment(t.pts[i].x, t.pts[i].y, t.pts[i + 1].x, t.pts[i + 1].y, t.width / 2 + inflate, t.layer, netId);
        }
      }
      for (const v of vias) {
        const lids = v.layers || layers;
        blockCircle(v.x, v.y, v.diameter / 2 + inflate, lids, netId);
      }
    }

    // ---- A* 路径搜索 ----
    // DIRS: 4 方向（默认）或 8 方向（含 45°，opts.allowDiagonal=true）
    const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const DIRS8 = DIRS4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
    const DIRS = opts.allowDiagonal ? DIRS8 : DIRS4;
    const STEP_COST = DIRS.map(d => (d[0] && d[1]) ? Math.SQRT2 : 1);

    function routeSegment(sx, sy, sLayerLi, tx, ty, tLayerLi, allowRipup) {
      const s = toGrid(sx, sy), t = toGrid(tx, ty);
      const sg = gIdx(Geo.clamp(s.gx, 0, W - 1), Geo.clamp(s.gy, 0, H - 1));
      const tg = gIdx(Geo.clamp(t.gx, 0, W - 1), Geo.clamp(t.gy, 0, H - 1));
      const state = (gi, li) => gi * NL + li;
      const open = new MinHeap();
      const gScore = new Map();
      const came = new Map();
      const startState = state(sg, sLayerLi);
      gScore.set(startState, 0);
      open.push(startState, heuristic(sg, sLayerLi));
      function heuristic(gi, li) {
        const gx = gi % W, gy = (gi / W) | 0;
        const tx2 = tg % W, ty2 = (tg / W) | 0;
        const dx = Math.abs(gx - tx2), dy = Math.abs(gy - ty2);
        // 八方向启发：octile distance
        const dist = (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
        return dist + (li === tLayerLi ? 0 : 6) + layerCost[li];
      }
      let pops = 0;
      const maxPops = opts.maxPops;
      while (open.size() > 0) {
        if (++pops > maxPops) return null;
        const cur = open.pop();
        const gi = (cur / NL) | 0, li = cur % NL;
        if (gi === tg && li === tLayerLi) {
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
        for (let d = 0; d < DIRS.length; d++) {
          const dir = DIRS[d];
          const nx = gx + dir[0], ny = gy + dir[1];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = gIdx(nx, ny);
          const blk = blocked[li][ni];
          const own = ownedBy[li][ni];
          // 允许到达终点和起点（即使被标记阻挡）
          if (blk && ni !== tg && ni !== sg) {
            // rip-up：若该阻挡属于本网络（不可能，因为已 unblockNet）或其他网络（不允许），跳过
            // 这里 allowRipup 暂不撕除别网络（保守策略），保留给重布迭代处理
            continue;
          }
          const ns = state(ni, li);
          const ng = g0 + STEP_COST[d] + layerCost[li] * 0.01;
          const prev = gScore.get(ns);
          if (prev !== undefined && prev <= ng) continue;
          gScore.set(ns, ng);
          came.set(ns, cur);
          open.push(ns, ng + heuristic(ni, li));
        }
        // 层切换（via）at 同 cell
        for (let nl = 0; nl < NL; nl++) {
          if (nl === li) continue;
          const blk = blocked[nl][gi];
          if (blk && gi !== tg && gi !== sg) continue;
          const ns = state(gi, nl);
          const ng = g0 + 6 + layerCost[nl];
          const prev = gScore.get(ns);
          if (prev !== undefined && prev <= ng) continue;
          gScore.set(ns, ng);
          came.set(ns, cur);
          open.push(ns, ng + heuristic(gi, nl));
        }
      }
      return null;
    }

    // ---- 路径压缩 + 45° 后处理 ----
    function compressPath(path) {
      // 切分按层分段，每段压缩为方向转折点
      const segments = []; // [{layer, pts:[{x,y}]}]
      let segStart = 0;
      for (let i = 1; i <= path.length; i++) {
        const endRun = (i === path.length) || (path[i].li !== path[segStart].li);
        if (!endRun) continue;
        const run = path.slice(segStart, i);
        const pts = [];
        let dir = null;
        pts.push(toWorld(run[0].gx, run[0].gy));
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
        segments.push({ layer: layers[run[0].li], pts, li: run[0].li });
        if (i < path.length) {
          const vp = toWorld(path[i].gx, path[i].gy);
          segments.push({ via: vp });
        }
        segStart = i;
      }
      return segments;
    }

    // 45° 优化：将连续两段构成的 90° 拐角替换为 45° 斜线段
    // 输入: [{x,y}, {x,y}, {x,y}, ...] 输出: 优化后的 pts
    function optimize45(pts) {
      if (pts.length < 3) return pts;
      const out = [pts[0]];
      let i = 1;
      while (i < pts.length - 1) {
        const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
        const dx1 = b.x - a.x, dy1 = b.y - a.y;
        const dx2 = c.x - b.x, dy2 = c.y - b.y;
        const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
        // 仅当两段都正交（一个轴为0）且夹角 90°
        const ortho1 = (Math.abs(dx1) < 1e-6) !== (Math.abs(dy1) < 1e-6);
        const ortho2 = (Math.abs(dx2) < 1e-6) !== (Math.abs(dy2) < 1e-6);
        if (ortho1 && ortho2 && len1 > 0 && len2 > 0) {
          // 拐角可改 45°：取 min(len1, len2)/2 作为斜线长度（保留对称）
          // 实际 IPC-2221 推荐 45°，这里取 m = min(len1, len2)/2 * (1/cos45) 简化为 min/2
          const m = Math.min(len1, len2) / 2;
          // 沿 a→b 方向走 (len1 - m)，然后斜走到 c-（b→c方向走 m）
          const u1x = dx1 / len1, u1y = dy1 / len1;
          const u2x = dx2 / len2, u2y = dy2 / len2;
          const p1 = { x: a.x + u1x * (len1 - m), y: a.y + u1y * (len1 - m) };
          const p2 = { x: b.x + u2x * m, y: b.y + u2y * m };
          // 仅当 m 足够大（避免过短斜线）才应用
          if (m > gs * 0.5) {
            out.push(p1);
            out.push(p2);
            // 跳过 b，继续从 p2 → c 走
            i += 2;
            continue;
          }
        }
        out.push(b);
        i++;
      }
      // 加最后一个点
      if (i === pts.length - 1) out.push(pts[pts.length - 1]);
      return out;
    }

    // ---- 主循环 ----
    const lines = Model.Board.ratsnest(board, fpLib);
    const todo0 = opts.onlyNets ? lines.filter(l => opts.onlyNets.includes(l.net)) : lines;
    // 按距离升序（短网络优先），电源/特殊网络可前置（此处简化）
    todo0.sort((a, b) => Geo.dist(a.x1, a.y1, a.x2, a.y2) - Geo.dist(b.x1, b.y1, b.x2, b.y2));

    const totalNets = todo0.length;
    let progressIdx = 0;
    function report(msg) {
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(progressIdx, totalNets, msg); } catch {}
      }
    }

    // net → 序号 (1-based)
    const netSeq = new Map();
    todo0.forEach((l, i) => { if (!netSeq.has(l.net)) netSeq.set(l.net, netSeq.size + 1); });
    // 每网络的已布 traces/vias（用于 rip-up）
    const routedByNet = new Map(); // net → { traces:[], vias:[] }

    const padAt = (x, y, net) => {
      let best = null, bd = 1.5;
      for (const p of allPads) {
        if (p.net !== net) continue;
        const d = Geo.dist(x, y, p.x, p.y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const layerOf = (p) => {
      if (!p) return 0;
      if (p.drill) return 0; // TH 起始层 F.Cu
      return layerIdx.get(p.side === 'B' ? 'B.Cu' : 'F.Cu') || 0;
    };

    // 布单网络（返回 {ok, traces, vias}）
    function routeOneNet(ln) {
      blockStaticObstacles(ln.net);
      // 把其他已布网络的阻挡写入
      for (const [net, info] of routedByNet) {
        if (net === ln.net) continue;
        blockRoutedNet(netSeq.get(net), info.traces, info.vias);
      }
      const pA = padAt(ln.x1, ln.y1, ln.net);
      const pB = padAt(ln.x2, ln.y2, ln.net);
      const sLi = layerOf(pA), tLi = layerOf(pB);
      const path = routeSegment(ln.x1, ln.y1, sLi, ln.x2, ln.y2, tLi, false);
      if (!path) return { ok: false };
      const segments = compressPath(path);
      const traces = [], vias = [];
      for (const seg of segments) {
        if (seg.via) {
          vias.push({ net: ln.net, x: seg.via.x, y: seg.via.y, drill: opts.viaDrill, diameter: opts.viaDiameter });
        } else {
          const opt = optimize45(seg.pts);
          if (opt.length >= 2) {
            traces.push({ net: ln.net, layer: seg.layer, width: opts.traceWidth, pts: opt });
          }
        }
      }
      return { ok: true, traces, vias };
    }

    // Rip-up & reroute: 若 routeOneNet 失败，尝试拆除最近布的若干冲突网络重布
    function routeWithRipup(ln, iter) {
      let res = routeOneNet(ln);
      if (res.ok) return res;
      if (iter <= 0) return res;
      // 拆除所有已布网络，重布当前网络，然后重布被拆的（保守策略）
      const backup = Array.from(routedByNet.entries());
      routedByNet.clear();
      // 清空所有动态阻挡
      for (let li = 0; li < NL; li++) { blocked[li].fill(0); ownedBy[li].fill(0); }
      // 先布当前网络
      res = routeOneNet(ln);
      if (!res.ok) {
        // 恢复
        for (const [net, info] of backup) routedByNet.set(net, info);
        // 重新布阻挡
        for (const [net, info] of routedByNet) blockRoutedNet(netSeq.get(net), info.traces, info.vias);
        return res;
      }
      routedByNet.set(ln.net, { traces: res.traces, vias: res.vias });
      blockRoutedNet(netSeq.get(ln.net), res.traces, res.vias);
      // 重新布其他网络
      const failedReroute = [];
      for (const [net, info] of backup) {
        const lines2 = lines.filter(l => l.net === net);
        for (const l2 of lines2) {
          const r2 = routeOneNet(l2);
          if (r2.ok) {
            routedByNet.set(net, { traces: r2.traces, vias: r2.vias });
            blockRoutedNet(netSeq.get(net), r2.traces, r2.vias);
          } else {
            failedReroute.push(net);
          }
        }
      }
      return { ok: true, traces: res.traces, vias: res.vias, ripupReroute: failedReroute };
    }

    const failedNets = new Set();
    const newTraces = [], newVias = [];

    // 主循环
    for (const ln of todo0) {
      progressIdx++;
      report('routing ' + ln.net + ' (' + progressIdx + '/' + totalNets + ')');
      let res = null;
      for (let iter = 0; iter <= opts.maxRipRerouteIter; iter++) {
        res = routeWithRipup(ln, iter);
        if (res.ok) break;
      }
      if (!res || !res.ok) { failedNets.add(ln.net); continue; }
      // 累积到全局结果
      for (const t of res.traces) newTraces.push(t);
      for (const v of res.vias) newVias.push(v);
      // 记录已布
      if (!routedByNet.has(ln.net)) {
        routedByNet.set(ln.net, { traces: res.traces, vias: res.vias });
      } else {
        const ex = routedByNet.get(ln.net);
        ex.traces.push(...res.traces);
        ex.vias.push(...res.vias);
      }
      // 写入阻挡
      blockRoutedNet(netSeq.get(ln.net), res.traces, res.vias);
    }

    report('done: routed=' + (totalNets - failedNets.size) + ', failed=' + failedNets.size);

    return {
      ok: true,
      routed: totalNets - failedNets.size,
      failed: failedNets.size,
      failedNets: Array.from(failedNets),
      traces: newTraces,
      vias: newVias,
      gridSize: gs,
      layerCount: NL
    };
  }

  // 单网络布线 API（供手动单网络布线调用）
  // options: {traceWidth, clearance, viaDrill, viaDiameter, gridSize, preferLayers}
  function routeSingle(board, fpLib, netName, fromPt, toPt, options) {
    const opts = Object.assign({}, options || {}, { onlyNets: [netName] });
    // 临时构造 ratsnest 单条
    const savedRatsnest = board._ratsnestCache;
    board._ratsnestCache = null;
    const lines = Model.Board.ratsnest(board, fpLib);
    const ln = lines.find(l => l.net === netName && Math.hypot(l.x1 - fromPt.x, l.y1 - fromPt.y) < 0.5 && Math.hypot(l.x2 - toPt.x, l.y2 - toPt.y) < 0.5);
    if (!ln) {
      // 没有现成 ratsnest，构造一条
      const fakeLines = [{ net: netName, x1: fromPt.x, y1: fromPt.y, x2: toPt.x, y2: toPt.y, from: '', to: '' }];
      const allPads = Model.Board.allPads(board, fpLib);
      const savedTodo = null;
      // 直接调用 autoroute 主流程不现实，简化为单网络 autoroute
      const tmpTodo = fakeLines;
      // 临时 patch：用 onlyNets 限制 autoroute 只处理本网络（ratsnest 内必须存在此网络对）
      const r = autoroute(board, fpLib, opts);
      board._ratsnestCache = savedRatsnest;
      return r;
    }
    const r = autoroute(board, fpLib, opts);
    board._ratsnestCache = savedRatsnest;
    return r;
  }

  // binary min-heap (键=优先级, 值=state)
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

  const PCBAutorouter = { autoroute, routeSingle };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBAutorouter;
  else global.PCBAutorouter = PCBAutorouter;
})(typeof window !== 'undefined' ? window : globalThis);
