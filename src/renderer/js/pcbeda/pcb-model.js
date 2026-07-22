// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - document model: project / schematic sheets / pcb boards / nets / connectivity / undo
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');

  let _idCounter = 1;
  function nextId(prefix) { return (prefix || 'id') + '_' + (_idCounter++); }
  function _bumpCounter(id) {
    const m = /_(\d+)$/.exec(id || '');
    if (m) _idCounter = Math.max(_idCounter, parseInt(m[1], 10) + 1);
  }

  const DEFAULT_RULES = {
    minClearance: 0.2,        // 最小铜间距 mm
    minTraceWidth: 0.15,      // 最小线宽 mm
    minViaDrill: 0.3,         // 最小过孔钻孔 mm
    minViaDiameter: 0.6,      // 最小过孔外径 mm
    minAnnularRing: 0.13,     // 最小环宽 mm
    minHoleToHole: 0.25,      // 最小孔间距 mm
    copperToBoardEdge: 0.3,   // 铜到板边距离 mm
    solderMaskExpansion: 0.05,// 阻焊膨胀 mm
    pasteExpansion: 0,        // 钢网收缩(-)/膨胀(+) mm
    defaultTraceWidth: 0.25,  // 默认线宽
    defaultViaDrill: 0.3,
    defaultViaDiameter: 0.6,
    zoneClearance: 0.3,       // 铺铜默认避让
    zoneThermalWidth: 0.25    // 热焊盘辐条宽
  };

  function defaultStackup(copperLayers) {
    const n = Math.max(1, Math.min(16, copperLayers || 2));
    const layers = [];
    layers.push({ id: 'F.Cu', type: 'copper', side: 'F', thickness: 0.035 });
    for (let i = 2; i < n; i++) layers.push({ id: 'In' + (i - 1) + '.Cu', type: 'copper', side: 'In', thickness: 0.035 });
    if (n > 1) layers.push({ id: 'B.Cu', type: 'copper', side: 'B', thickness: 0.035 });
    return { copperLayers: n, boardThickness: 1.6, material: 'FR4', er: 4.5, layers };
  }

  function newBoard(name, width, height, copperLayers) {
    const w = width || 100, h = height || 80;
    return {
      id: nextId('brd'), kind: 'board', name: name || 'PCB',
      outline: { pts: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], closed: true },
      stackup: defaultStackup(copperLayers || 2),
      designRules: Object.assign({}, DEFAULT_RULES),
      components: [],   // {id,ref,value,footprint,params,x,y,rot,side,locked,padNets:{}}
      traces: [],       // {id,net,layer,width,pts:[{x,y}]}
      vias: [],         // {id,net,x,y,drill,diameter}
      zones: [],        // {id,net,layer,pts,clearance,thermalWidth,priority}
      silkscreen: [],   // {id,side,kind:'line'|'rect'|'circle'|'text',...}
      keepouts: []      // {id,kind:'rect'|'poly',pts,layer}
    };
  }

  function newSheet(name) {
    return {
      id: nextId('sch'), kind: 'sheet', name: name || 'Sheet1',
      symbols: [],      // {id,lib,ref,value,footprint,fpParams,x,y,rot,mirror,fields:{}}
      wires: [],        // {id,pts:[{x,y}]}
      junctions: [],    // {id,x,y}
      labels: [],       // {id,x,y,text,rot}
      powerSymbols: [], // {id,ptype,x,y,rot}  ptype: GND/VCC/+5V/+3V3/...
      noConnects: [],   // {id,x,y}
      texts: []         // {id,x,y,text,size,rot}
    };
  }

  function newProject(name, width, height, layers) {
    return {
      version: 1, kind: 'cibyp-pcb-project', name: name || 'Untitled',
      schematics: [newSheet('Sheet1')],
      boards: [newBoard('PCB', width || 100, height || 80, layers || 2)],
      activeSchematic: 0, activeBoard: 0
    };
  }

  // ---------------------------------------------------------------------------
  // Document singleton
  // ---------------------------------------------------------------------------
  const Doc = {
    project: newProject(),
    modified: false,
    filePath: null,       // current save target (single-file or manifest path)
    _undo: [], _redo: [],
    UNDO_LIMIT: 120,
    onChange: null,       // set by editor: called after any mutation

    reset(name, width, height, layers) {
      this.project = newProject(name, width, height, layers);
      this.modified = false; this.filePath = null;
      this._undo = []; this._redo = [];
      this._emit();
    },

    board(idx) {
      const p = this.project;
      return p.boards[Math.max(0, Math.min(p.boards.length - 1, idx === undefined ? p.activeBoard : idx))];
    },
    sheet(idx) {
      const p = this.project;
      return p.schematics[Math.max(0, Math.min(p.schematics.length - 1, idx === undefined ? p.activeSchematic : idx))];
    },

    _emit() { if (typeof this.onChange === 'function') this.onChange(); },
    touch() { this.modified = true; this._emit(); },

    snapshot() {
      this._undo.push(JSON.stringify(this.project));
      if (this._undo.length > this.UNDO_LIMIT) this._undo.shift();
      this._redo = [];
    },
    undo() {
      if (!this._undo.length) return false;
      this._redo.push(JSON.stringify(this.project));
      this.project = JSON.parse(this._undo.pop());
      this.modified = true; this._emit();
      return true;
    },
    redo() {
      if (!this._redo.length) return false;
      this._undo.push(JSON.stringify(this.project));
      this.project = JSON.parse(this._redo.pop());
      this.modified = true; this._emit();
      return true;
    },
    canUndo() { return this._undo.length > 0; },
    canRedo() { return this._redo.length > 0; },

    // ---------------- serialization ----------------
    toSingleFileJSON() {
      return this.project;
    },
    // multi-file: manifest + one file per sheet/board
    toMultiFiles(baseName) {
      const base = (baseName || this.project.name || 'project').replace(/[\\/:*?"<>|]/g, '_');
      const files = [];
      const entries = [];
      this.project.schematics.forEach((s, i) => {
        const fn = base + '.sheet' + (i + 1) + '.cipysch';
        files.push({ name: fn, data: { version: 1, kind: 'cibyp-pcb-schematic', sheet: s } });
        entries.push({ type: 'schematic', file: fn });
      });
      this.project.boards.forEach((b, i) => {
        const fn = base + '.board' + (i + 1) + '.cipypcb';
        files.push({ name: fn, data: { version: 1, kind: 'cibyp-pcb-board', board: b } });
        entries.push({ type: 'board', file: fn });
      });
      const manifest = {
        version: 1, kind: 'cibyp-pcb-manifest', name: this.project.name,
        activeSchematic: this.project.activeSchematic, activeBoard: this.project.activeBoard,
        files: entries
      };
      return { manifestName: base + '.cibypcbproj', manifest, files };
    },

    loadJSON(data) {
      if (!data) return { ok: false, error: '空数据' };
      if (data.kind === 'cibyp-pcb-project') {
        this.project = this._normalizeProject(data);
      } else if (data.kind === 'cibyp-pcb-board' && data.board) {
        this.project = newProject(data.board.name || 'Imported');
        this.project.boards = [this._normalizeBoard(data.board)];
      } else if (data.kind === 'cibyp-pcb-schematic' && data.sheet) {
        this.project = newProject('Imported');
        this.project.schematics = [this._normalizeSheet(data.sheet)];
      } else {
        return { ok: false, error: '无法识别的工程格式: ' + (data.kind || 'unknown') };
      }
      this.modified = false; this._undo = []; this._redo = [];
      this._emit();
      return { ok: true };
    },

    loadMultiFiles(manifest, fileContents) {
      if (!manifest || manifest.kind !== 'cibyp-pcb-manifest') return { ok: false, error: '不是有效的工程清单' };
      const p = newProject(manifest.name || 'Project');
      p.schematics = []; p.boards = [];
      for (const ent of (manifest.files || [])) {
        const c = fileContents[ent.file];
        if (!c) return { ok: false, error: '缺少工程文件: ' + ent.file };
        if (ent.type === 'schematic' && c.sheet) p.schematics.push(this._normalizeSheet(c.sheet));
        if (ent.type === 'board' && c.board) p.boards.push(this._normalizeBoard(c.board));
      }
      if (!p.schematics.length) p.schematics.push(newSheet('Sheet1'));
      if (!p.boards.length) p.boards.push(newBoard('PCB', 100, 80, 2));
      p.activeSchematic = Math.min(manifest.activeSchematic || 0, p.schematics.length - 1);
      p.activeBoard = Math.min(manifest.activeBoard || 0, p.boards.length - 1);
      this.project = p;
      this.modified = false; this._undo = []; this._redo = [];
      this._emit();
      return { ok: true };
    },

    _normalizeProject(p) {
      const np = newProject(p.name || 'Untitled');
      np.schematics = (p.schematics || []).map(s => this._normalizeSheet(s));
      np.boards = (p.boards || []).map(b => this._normalizeBoard(b));
      if (!np.schematics.length) np.schematics.push(newSheet('Sheet1'));
      if (!np.boards.length) np.boards.push(newBoard('PCB', 100, 80, 2));
      np.activeSchematic = Math.min(p.activeSchematic || 0, np.schematics.length - 1);
      np.activeBoard = Math.min(p.activeBoard || 0, np.boards.length - 1);
      return np;
    },
    _normalizeSheet(s) {
      const ns = newSheet(s.name || 'Sheet');
      ns.id = s.id || ns.id; _bumpCounter(ns.id);
      ns.symbols = s.symbols || []; ns.wires = s.wires || [];
      ns.junctions = s.junctions || []; ns.labels = s.labels || [];
      ns.powerSymbols = s.powerSymbols || []; ns.noConnects = s.noConnects || [];
      ns.texts = s.texts || [];
      [...ns.symbols, ...ns.wires, ...ns.junctions, ...ns.labels, ...ns.powerSymbols, ...ns.noConnects, ...ns.texts]
        .forEach(o => { if (o.id) _bumpCounter(o.id); else o.id = nextId('obj'); });
      return ns;
    },
    _normalizeBoard(b) {
      const nb = newBoard(b.name || 'PCB');
      nb.id = b.id || nb.id; _bumpCounter(nb.id);
      if (b.outline && b.outline.pts && b.outline.pts.length >= 3) nb.outline = b.outline;
      if (b.stackup && b.stackup.layers) nb.stackup = b.stackup;
      nb.designRules = Object.assign({}, DEFAULT_RULES, b.designRules || {});
      nb.components = b.components || []; nb.traces = b.traces || [];
      nb.vias = b.vias || []; nb.zones = b.zones || [];
      nb.silkscreen = b.silkscreen || []; nb.keepouts = b.keepouts || [];
      [...nb.components, ...nb.traces, ...nb.vias, ...nb.zones, ...nb.silkscreen, ...nb.keepouts]
        .forEach(o => { if (o.id) _bumpCounter(o.id); else o.id = nextId('obj'); });
      nb.components.forEach(c => { if (!c.padNets) c.padNets = {}; });
      return nb;
    }
  };

  // ---------------------------------------------------------------------------
  // Board-level helpers
  // ---------------------------------------------------------------------------
  const Board = {
    copperLayerIds(board) {
      return board.stackup.layers.filter(l => l.type === 'copper').map(l => l.id);
    },
    isTopLayer(id) { return id === 'F.Cu'; },
    isBottomLayer(id) { return id === 'B.Cu'; },

    findComponent(board, ref) {
      return board.components.find(c => c.ref === ref) || null;
    },

    addComponent(board, comp) {
      const c = Object.assign({
        id: nextId('cmp'), ref: 'U?', value: '', footprint: 'R_0805', params: {},
        x: 10, y: 10, rot: 0, side: 'F', locked: false, padNets: {}
      }, comp);
      board.components.push(c);
      return c;
    },

    deleteComponent(board, ref) {
      const i = board.components.findIndex(c => c.ref === ref);
      if (i < 0) return false;
      board.components.splice(i, 1);
      return true;
    },

    // 翻转元件到另一面（F↔B），自动镜像 X 坐标（保持板上的视觉位置）
    flipComponentSide(board, ref) {
      const c = this.findComponent(board, ref);
      if (!c) return false;
      c.side = c.side === 'B' ? 'F' : 'B';
      // 翻面后保持元件在板上的视觉位置不变：X 坐标取镜像（板中心为 X=0）
      // 但板原点不一定是中心，因此保持 (x,y) 不变；pad 镜像由 allPads 推导
      return c.side;
    },

    // 设置元件面（F 或 B）
    setComponentSide(board, ref, side) {
      const c = this.findComponent(board, ref);
      if (!c) return false;
      const s = String(side || 'F').toUpperCase().startsWith('B') ? 'B' : 'F';
      c.side = s;
      return s;
    },

    addTrace(board, t) {
      const tr = Object.assign({ id: nextId('trk'), net: '', layer: 'F.Cu', width: 0.25, pts: [] }, t);
      board.traces.push(tr);
      return tr;
    },
    addVia(board, v) {
      // via.layers 可选：未指定=null 表示 PTH 贯通所有铜层；['F.Cu','B.Cu'] 表示盲/埋孔
      const via = Object.assign({ id: nextId('via'), net: '', x: 0, y: 0, drill: 0.3, diameter: 0.6, layers: null }, v);
      board.vias.push(via);
      return via;
    },
    addZone(board, z) {
      const zone = Object.assign({ id: nextId('zn'), net: '', layer: 'F.Cu', pts: [], clearance: 0.3, thermalWidth: 0.25, priority: 0 }, z);
      board.zones.push(zone);
      return zone;
    },
    addSilk(board, s) {
      const sk = Object.assign({ id: nextId('slk'), side: 'F', kind: 'line' }, s);
      board.silkscreen.push(sk);
      return sk;
    },

    // absolute-position pad list (footprint-generated, transformed by component placement)
    allPads(board, fpLib) {
      const out = [];
      for (const comp of board.components) {
        const fp = fpLib.generate(comp.footprint, comp.params || {});
        if (!fp) continue;
        for (const pad of fp.pads) {
          let lx = pad.x, ly = pad.y;
          if (comp.side === 'B') lx = -lx; // mirror
          const rp = Geo.rotatePoint(lx, ly, 0, 0, comp.rot || 0);
          const abs = {
            ref: comp.ref, num: String(pad.num),
            x: comp.x + rp.x, y: comp.y + rp.y,
            w: pad.w, h: pad.h, shape: pad.shape || 'rect',
            drill: pad.drill || 0, rot: ((comp.rot || 0) + (pad.rot || 0)) % 360,
            plated: pad.plated !== false,
            side: comp.side,
            smd: !pad.drill,
            layers: pad.drill ? Board.copperLayerIds(board) : [comp.side === 'B' ? 'B.Cu' : 'F.Cu'],
            net: (comp.padNets && comp.padNets[String(pad.num)]) || ''
          };
          out.push(abs);
        }
      }
      return out;
    },

    padKey(ref, num) { return ref + '.' + String(num); },

    setPadNet(board, ref, num, net) {
      const comp = this.findComponent(board, ref);
      if (!comp) return false;
      if (!comp.padNets) comp.padNets = {};
      if (net) comp.padNets[String(num)] = net;
      else delete comp.padNets[String(num)];
      return true;
    },

    netNames(board, fpLib) {
      const s = new Set();
      for (const p of this.allPads(board, fpLib)) if (p.net) s.add(p.net);
      for (const t of board.traces) if (t.net) s.add(t.net);
      for (const v of board.vias) if (v.net) s.add(v.net);
      for (const z of board.zones) if (z.net) s.add(z.net);
      return Array.from(s).sort();
    },

    // ---------------- connectivity (union-find over pads/traces/vias/zones) ----------------
    connectivity(board, fpLib) {
      const pads = this.allPads(board, fpLib);
      const parent = new Map();
      const find = (k) => {
        let r = k;
        while (parent.get(r) !== r) { parent.set(r, parent.get(parent.get(r))); r = parent.get(r); }
        return r;
      };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      const keys = [];
      const addKey = (k) => { if (!parent.has(k)) { parent.set(k, k); keys.push(k); } };

      // electrical primitives: pads, trace endpoints, via points
      const prim = []; // {key, net, kind, x,y, r, seg?}
      for (const p of pads) {
        const k = this.padKey(p.ref, p.num);
        addKey(k);
        prim.push({ key: k, net: p.net, kind: 'pad', x: p.x, y: p.y, r: Math.max(p.w, p.h) / 2, pad: p });
      }
      board.traces.forEach((t, ti) => {
        for (let i = 0; i < t.pts.length; i++) {
          const k = 'trk' + ti + '.' + i;
          addKey(k);
          prim.push({ key: k, net: t.net, kind: 'trkpt', x: t.pts[i].x, y: t.pts[i].y, r: t.width / 2, trk: ti });
        }
        // consecutive points of same trace are connected
        for (let i = 0; i < t.pts.length - 1; i++) union('trk' + ti + '.' + i, 'trk' + ti + '.' + (i + 1));
      });
      board.vias.forEach((v, vi) => {
        const k = 'via' + vi;
        addKey(k);
        prim.push({ key: k, net: v.net, kind: 'via', x: v.x, y: v.y, r: v.diameter / 2, vLayers: v.layers || null });
      });

      // geometric touch => electrical connection (same-net or net-merge by design)
      const touchR = 0.02;
      for (let i = 0; i < prim.length; i++) {
        for (let j = i + 1; j < prim.length; j++) {
          const a = prim[i], b = prim[j];
          if (a.net !== b.net) continue;
          if (!a.net) continue;
          if (Geo.dist(a.x, a.y, b.x, b.y) <= a.r + b.r + touchR) union(a.key, b.key);
        }
      }
      // pad/via vs trace SEGMENTS (a trace passing through a pad connects even
      // when no polyline vertex lands exactly on the pad)
      board.traces.forEach((t, ti) => {
        if (!t.net) return;
        for (const p of prim) {
          if (p.net !== t.net || p.kind === 'trkpt') continue;
          for (let i = 0; i < t.pts.length - 1; i++) {
            if (Geo.pointToSegmentDist(p.x, p.y, t.pts[i].x, t.pts[i].y, t.pts[i + 1].x, t.pts[i + 1].y) <= p.r + t.width / 2 + touchR) {
              union(p.key, 'trk' + ti + '.' + i);
              break;
            }
          }
        }
      });
      // zones: same-net primitive whose point is inside zone polygon joins the zone group
      // Bug 9 修复：增加层匹配 + 焊盘边缘重叠判定，确保铺铜正确连接同层同网络焊盘
      for (const z of board.zones) {
        if (!z.net || !z.pts || z.pts.length < 3) continue;
        const members = prim.filter(p => {
          if (p.net !== z.net) return false;
          // 层匹配：焊盘/走线/过孔必须与铺铜在同一铜层才电气连通
          if (p.kind === 'pad' && !p.pad.layers.includes(z.layer)) return false;
          if (p.kind === 'trkpt' && board.traces[p.trk].layer !== z.layer) return false;
          if (p.kind === 'via') {
            const vl = p.vLayers || Board.copperLayerIds(board);
            if (!vl.includes(z.layer)) return false;
          }
          // 焊盘中心在铺铜多边形内，或焊盘边缘与铺铜边界距离 ≤ 半径（部分重叠也算连通）
          if (Geo.pointInPolygon(p.x, p.y, z.pts)) return true;
          if (p.r > 0 && Geo.polygonEdgeDist(p.x, p.y, z.pts) <= p.r + 0.02) return true;
          return false;
        });
        for (let i = 1; i < members.length; i++) union(members[0].key, members[i].key);
      }

      // group pads by net -> connected groups
      const netGroups = new Map(); // net -> Map(root -> [padKeys])
      for (const p of pads) {
        if (!p.net) continue;
        const k = this.padKey(p.ref, p.num);
        const root = find(k);
        if (!netGroups.has(p.net)) netGroups.set(p.net, new Map());
        const g = netGroups.get(p.net);
        if (!g.has(root)) g.set(root, []);
        g.get(root).push(k);
      }
      return { netGroups, pads, find, parent };
    },

    // ratsnest: remaining unrouted connections (shortest spanning per net group set)
    ratsnest(board, fpLib) {
      const conn = this.connectivity(board, fpLib);
      const lines = [];
      const padPos = new Map(conn.pads.map(p => [this.padKey(p.ref, p.num), p]));
      for (const [net, groups] of conn.netGroups) {
        const roots = Array.from(groups.keys());
        if (roots.length <= 1) continue;
        // greedy: connect each subsequent group to nearest pad of already-connected set
        const connected = [roots[0]];
        const remaining = roots.slice(1);
        while (remaining.length) {
          let best = null;
          for (const r of remaining) {
            for (const cr of connected) {
              for (const pkA of groups.get(r)) {
                for (const pkB of groups.get(cr)) {
                  const a = padPos.get(pkA), b = padPos.get(pkB);
                  const d = Geo.dist(a.x, a.y, b.x, b.y);
                  if (!best || d < best.d) best = { d, a, b, r };
                }
              }
            }
          }
          lines.push({
            net, x1: best.a.x, y1: best.a.y, x2: best.b.x, y2: best.b.y,
            from: best.a.ref + '.' + best.a.num, to: best.b.ref + '.' + best.b.num
          });
          connected.push(best.r);
          remaining.splice(remaining.indexOf(best.r), 1);
        }
      }
      return lines;
    },

    boardBBox(board, fpLib) {
      const pts = board.outline.pts.slice();
      for (const p of this.allPads(board, fpLib)) pts.push({ x: p.x, y: p.y });
      for (const t of board.traces) pts.push(...t.pts);
      for (const v of board.vias) pts.push({ x: v.x, y: v.y });
      for (const z of board.zones) pts.push(...z.pts);
      if (!pts.length) return { minX: 0, minY: 0, maxX: 100, maxY: 80 };
      return Geo.ptsBBox(pts);
    },

    stats(board, fpLib) {
      const pads = this.allPads(board, fpLib);
      return {
        components: board.components.length,
        pads: pads.length,
        smdPads: pads.filter(p => p.smd).length,
        thPads: pads.filter(p => !p.smd).length,
        traces: board.traces.length,
        vias: board.vias.length,
        zones: board.zones.length,
        nets: this.netNames(board, fpLib).length,
        unrouted: this.ratsnest(board, fpLib).length,
        layers: board.stackup.copperLayers
      };
    }
  };

  // ---------------------------------------------------------------------------
  // Schematic helpers: net resolution from wires/labels/power
  // ---------------------------------------------------------------------------
  const Sheet = {
    symbolPins(sheet, symLib) {
      // absolute pin positions for all symbols: [{ref,num,name,x,y}]
      const out = [];
      for (const sym of sheet.symbols) {
        const def = symLib.get(sym.lib, sym.symParams);
        if (!def) continue;
        for (const pin of def.pins) {
          let lx = pin.x, ly = pin.y;
          if (sym.mirror) lx = -lx;
          const rp = Geo.rotatePoint(lx, ly, 0, 0, sym.rot || 0);
          out.push({ ref: sym.ref, num: String(pin.num), name: pin.name, x: sym.x + rp.x, y: sym.y + rp.y });
        }
      }
      return out;
    },

    // resolve nets: union pins/wires/junctions/labels/power into named nets
    // CONNECT_TOL: 连接容差 mm，需大于半个 2.54 网格(1.27)以兼容标签/引脚偏移
    CONNECT_TOL: 1.5,
    // power 引脚名 → power 网络名 映射（IC 的 VCC/GND 等引脚自动归属对应 power 网络）
    POWER_PIN_MAP: {
      'VCC': 'VCC', 'VDD': 'VDD', 'VEE': 'VEE', 'VBAT': 'VBAT',
      'GND': 'GND', 'VSS': 'VSS', 'AVCC': 'AVCC', 'AGND': 'AGND'
    },
    resolveNets(sheet, symLib) {
      const TOL = this.CONNECT_TOL;
      const pins = this.symbolPins(sheet, symLib);
      const parent = new Map();
      const find = (k) => {
        let r = k;
        while (parent.get(r) !== r) { parent.set(r, parent.get(parent.get(r))); r = parent.get(r); }
        return r;
      };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      const addK = (k) => { if (!parent.has(k)) parent.set(k, k); };

      const gridKey = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
      const ptNode = new Map(); // gridKey -> node key
      const nodeAt = (x, y) => {
        const gk = gridKey(x, y);
        if (!ptNode.has(gk)) { const k = 'pt:' + gk; addK(k); ptNode.set(gk, k); }
        return ptNode.get(gk);
      };

      // wires: connect their own vertices
      const wirePts = [];
      sheet.wires.forEach(w => {
        const ks = w.pts.map(p => nodeAt(p.x, p.y));
        for (let i = 0; i < ks.length - 1; i++) union(ks[i], ks[i + 1]);
        w.pts.forEach(p => wirePts.push(p));
      });
      // wire vertices near each other (T-junctions / loose endpoints) => same node
      for (let i = 0; i < wirePts.length; i++) {
        for (let j = i + 1; j < wirePts.length; j++) {
          if (Geo.dist(wirePts[i].x, wirePts[i].y, wirePts[j].x, wirePts[j].y) <= TOL) {
            union(nodeAt(wirePts[i].x, wirePts[i].y), nodeAt(wirePts[j].x, wirePts[j].y));
          }
        }
      }
      // wire vertices lying on another wire's segment => same node
      sheet.wires.forEach(w => {
        for (let i = 0; i < w.pts.length - 1; i++) {
          const a = w.pts[i], b = w.pts[i + 1];
          for (const q of wirePts) {
            if (Geo.pointToSegmentDist(q.x, q.y, a.x, a.y, b.x, b.y) <= TOL) {
              union(nodeAt(a.x, a.y), nodeAt(q.x, q.y));
            }
          }
        }
      });

      // pins attach to nodes at their position
      const pinNodes = pins.map(p => ({ pin: p, key: nodeAt(p.x, p.y) }));
      // pin near a wire vertex or segment => connected
      sheet.wires.forEach(w => {
        for (const pn of pinNodes) {
          let attached = false;
          for (let i = 0; i < w.pts.length && !attached; i++) {
            if (Geo.dist(pn.pin.x, pn.pin.y, w.pts[i].x, w.pts[i].y) <= TOL) {
              union(pn.key, nodeAt(w.pts[i].x, w.pts[i].y));
              attached = true;
            }
          }
          if (attached) continue;
          for (let i = 0; i < w.pts.length - 1 && !attached; i++) {
            if (Geo.pointToSegmentDist(pn.pin.x, pn.pin.y, w.pts[i].x, w.pts[i].y, w.pts[i + 1].x, w.pts[i + 1].y) <= TOL) {
              union(pn.key, nodeAt(w.pts[i].x, w.pts[i].y));
              attached = true;
            }
          }
        }
      });

      // labels & power symbols force net names onto their node
      // (snapped to the nearest wire vertex within tolerance, so a label placed
      // "close enough" to a wire still names that wire's net)
      const nearestWireNode = (x, y) => {
        let best = null, bd = TOL;
        // 1) 检查 wire 顶点（端点）
        for (const p of wirePts) {
          const d = Geo.dist(x, y, p.x, p.y);
          if (d <= bd) { bd = d; best = p; }
        }
        // 2) 检查 wire 线段（标签/电源符号可能放在导线中间而非顶点上）
        //    返回距离最近端点（wire 所有顶点已 union，连到任一端点即可）
        for (const w of sheet.wires) {
          for (let i = 0; i < w.pts.length - 1; i++) {
            const a = w.pts[i], b = w.pts[i + 1];
            const d = Geo.pointToSegmentDist(x, y, a.x, a.y, b.x, b.y);
            if (d <= bd) {
              const da = Geo.dist(x, y, a.x, a.y);
              const db = Geo.dist(x, y, b.x, b.y);
              best = da <= db ? a : b;
              bd = d;
            }
          }
        }
        return best;
      };
      const rootNames = new Map(); // root -> name
      const claim = (key, name) => {
        const r = find(key);
        if (!rootNames.has(r)) rootNames.set(r, name);
      };
      for (const lb of sheet.labels) {
        const n = nearestWireNode(lb.x, lb.y);
        claim(n ? nodeAt(n.x, n.y) : nodeAt(lb.x, lb.y), lb.text);
      }
      for (const ps of sheet.powerSymbols) {
        const n = nearestWireNode(ps.x, ps.y);
        claim(n ? nodeAt(n.x, n.y) : nodeAt(ps.x, ps.y), ps.ptype);
      }
      // global: same label text anywhere = same net (via their snapped nodes)
      const nodeFor = (o) => {
        const n = nearestWireNode(o.x, o.y);
        return n ? nodeAt(n.x, n.y) : nodeAt(o.x, o.y);
      };
      const labelName2Root = new Map();
      for (const lb of sheet.labels) {
        const r = find(nodeFor(lb));
        if (labelName2Root.has(lb.text)) union(r, labelName2Root.get(lb.text));
        else labelName2Root.set(lb.text, r);
      }
      const pwrName2Root = new Map();
      for (const ps of sheet.powerSymbols) {
        const r = find(nodeFor(ps));
        if (pwrName2Root.has(ps.ptype)) union(r, pwrName2Root.get(ps.ptype));
        else pwrName2Root.set(ps.ptype, r);
      }
      // re-claim after unions
      rootNames.clear();
      for (const lb of sheet.labels) claim(nodeFor(lb), lb.text);
      for (const ps of sheet.powerSymbols) claim(nodeFor(ps), ps.ptype);
      // power 引脚自动归属对应 power 网络（VCC/GND/VDD/VSS/AVCC/AGND 等）
      // 即使未画导线连接电源符号，IC 的 VCC/GND 引脚也会自动连接到同名 power 网络
      for (const pn of pinNodes) {
        const pwrName = Sheet.POWER_PIN_MAP[String(pn.pin.name).toUpperCase()];
        if (pwrName) claim(pn.key, pwrName);
      }

      // assign net names to every pin
      const rootAutoName = new Map();
      const pinNets = []; // {ref,num,name,net,x,y}
      for (const pn of pinNodes) {
        const r = find(pn.key);
        let net = rootNames.get(r);
        if (!net) {
          if (!rootAutoName.has(r)) rootAutoName.set(r, 'Net-(' + pn.pin.ref + '-' + pn.pin.name + ')');
          net = rootAutoName.get(r);
        }
        pinNets.push({ ref: pn.pin.ref, num: pn.pin.num, name: pn.pin.name, net, x: pn.pin.x, y: pn.pin.y });
      }
      return pinNets;
    },

    annotate(sheet) {
      // assign refs to symbols with '?' refs, per prefix
      const counters = new Map();
      for (const s of sheet.symbols) {
        const m = /^([A-Za-z]+)(\d+)$/.exec(s.ref || '');
        if (m) counters.set(m[1], Math.max(counters.get(m[1]) || 0, parseInt(m[2], 10)));
      }
      let changed = 0;
      for (const s of sheet.symbols) {
        if (!s.ref || /\?/.test(s.ref)) {
          const prefix = (s.ref || 'U?').replace(/[?\d]+$/, '') || 'U';
          const n = (counters.get(prefix) || 0) + 1;
          counters.set(prefix, n);
          s.ref = prefix + n;
          changed++;
        }
      }
      return changed;
    }
  };

  const PCBModel = { Doc, Board, Sheet, newProject, newBoard, newSheet, defaultStackup, DEFAULT_RULES, nextId };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBModel;
  else global.PCBModel = PCBModel;
})(typeof window !== 'undefined' ? window : globalThis);
