// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - interactive editor state machine (schematic + pcb)
(function (global) {
  'use strict';

  const Geo = global.PCBGeo;
  const Model = global.PCBModel;
  const Doc = Model.Doc;

  const Editor = {
    mode: 'sch',            // 'sch' | 'pcb' | '3d'
    tool: 'select',
    selection: new Set(),
    activeNet: '',
    activeLayer: 'F.Cu',
    activeFootprint: 'R_0805',
    activeSymbol: 'R',
    activePower: 'GND',
    layerVisibility: {},
    showRatsnest: true,
    drcMarkers: [],
    ercMarkers: [],
    routeMode: '45',        // '45' | '90' | 'free'
    pcbGrid: 0.5,
    schGrid: 1.27,
    // transient states
    routeState: null,       // {pts:[], net, layer, width}
    zoneState: null,
    wireState: null,
    placing: null,          // {kind:'comp'|'symbol', rot, data}
    dragState: null,
    measurePts: [],
    cursor: { x: 0, y: 0 },
    // callbacks (set by bootstrap)
    onRefresh: null,        // re-render current view
    onStatus: null,         // status bar text
    onPanel: null,          // refresh side panel
    onModified: null,
    on3DSync: null,

    // ---------------- helpers ----------------
    board() { return Doc.board(); },
    sheet() { return Doc.sheet(); },
    fpLib() { return global.PCBFootprints; },
    symLib() { return global.PCBSymbols; },
    renderer() { return this.mode === 'sch' ? global.PCBSchRender : global.PCBRender; },
    grid() { return this.mode === 'sch' ? this.schGrid : this.pcbGrid; },
    snap(v) { return Geo.snapToGrid(v, this.grid()); },
    snapPt(p) { return { x: this.snap(p.x), y: this.snap(p.y) }; },

    status(t) { if (this.onStatus) this.onStatus(t); },
    refresh() { if (this.onRefresh) this.onRefresh(); },
    panel() { if (this.onPanel) this.onPanel(); },
    modified() { Doc.touch(); if (this.onModified) this.onModified(); },

    setMode(m) {
      this.mode = m;
      this.cancelTransient();
      this.selection.clear();
      this.refresh();
      this.panel();
    },

    setTool(t) {
      this.cancelTransient();
      this.tool = t;
      const names = {
        select: '选择/拖动', trace: '布线 (点击放点,V换层,Enter完成,Esc取消)', via: '放过孔',
        zone: '铺铜 (点击多边形顶点,Enter闭合)', comp: '放置元件 (R旋转,Esc退出)',
        silkline: '丝印线 (两点)', silktext: '丝印文字', measure: '测量 (两点)', delete: '删除 (点击对象)',
        symbol: '放置符号 (R旋转,M镜像,Esc退出)', wire: '导线 (Enter完成)', label: '网络标签',
        power: '电源符号', junction: '节点', noconnect: '不连接标记', text: '文本'
      };
      this.status('工具: ' + (names[t] || t));
      this.refresh();
    },

    cancelTransient() {
      this.routeState = null; this.zoneState = null; this.wireState = null;
      this.placing = null; this.dragState = null; this.measurePts = [];
      this._silkStart = null; this._boxSel = null;
    },

    // 切换 PCB 视图方向（顶层↔底层），类 KiCad V+B 快捷键
    // side: 'top'|'bottom'|'toggle'（默认 toggle）
    setView(side) {
      const r = global.PCBRender;
      const newSide = r.setView(side || 'toggle');
      this.status(newSide === 'bottom' ? '视图: 底层（从底向上看，X 已镜像）' : '视图: 顶层（默认）');
      this.refresh();
      this.panel();
      return newSide;
    },

    // 翻转选中元件到另一面（仅 PCB 模式生效）
    // 翻面后自动同步：side='B' 时元件焊盘将出现在 B.Cu 层
    flipSelectionToOtherSide() {
      if (this.mode !== 'pcb' || !this.selection.size) return false;
      Doc.snapshot();
      let flipped = 0;
      for (const id of this.selection) {
        const comp = this.board().components.find(c => c.id === id);
        if (comp) {
          Model.Board.flipComponentSide(this.board(), comp.ref);
          flipped++;
        }
      }
      if (flipped > 0) {
        this.modified();
        this.status('已翻转 ' + flipped + ' 个元件到另一面');
        this.refresh();
        this.panel();
      }
      return flipped > 0;
    },

    ghost() {
      if (this.routeState && this.routeState.pts.length) {
        const pts = this.routeState.pts.slice();
        if (this.routeState.preview) pts.push(this.routeState.preview);
        return { kind: 'trace', pts, width: this.routeState.width };
      }
      if (this.zoneState && this.zoneState.pts.length) {
        const pts = this.zoneState.pts.slice();
        if (this.zoneState.preview) pts.push(this.zoneState.preview);
        return { kind: 'zone', pts };
      }
      if (this.wireState && this.wireState.pts.length) {
        const pts = this.wireState.pts.slice();
        if (this.wireState.preview) pts.push(this.wireState.preview);
        return { kind: 'wire', pts };
      }
      if (this.measurePts.length === 2) return { kind: 'measure', pts: this.measurePts };
      if (this._boxSel) return { kind: 'box', pts: [this._boxSel.start, this._boxSel.cur] };
      return null;
    },

    // net at world point (from pad/via/trace hit)
    netAt(board, w) {
      const hit = global.PCBRender.pick(board, this.fpLib(), w.x, w.y, 0.3);
      if (!hit) return '';
      if (hit.type === 'pad') return hit.pad.net || '';
      return hit.obj.net || '';
    },

    // ---------------- mouse handlers (bound to active canvas) ----------------
    handleMouseDown(e, sx, sy) {
      const w = this.renderer().s2w({ x: sx, y: sy });
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this.dragState = { kind: 'pan', x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button === 2) { this.cancelTransient(); this.refresh(); return; }
      if (e.button !== 0) return;
      if (this.mode === 'pcb') this._pcbMouseDown(w, e);
      else if (this.mode === 'sch') this._schMouseDown(w, e);
    },

    handleMouseMove(e, sx, sy) {
      const r = this.renderer();
      const w = r.s2w({ x: sx, y: sy });
      this.cursor = w;
      this.status('X ' + w.x.toFixed(2) + ' mm, Y ' + w.y.toFixed(2) + ' mm' +
        (this.activeNet ? '  |  网络: ' + this.activeNet : '') + '  |  ' + this.tool);
      if (this.dragState && this.dragState.kind === 'pan') {
        r.view.panX += (e.clientX - this.dragState.x) / r.view.zoom;
        r.view.panY += (e.clientY - this.dragState.y) / r.view.zoom;
        this.dragState.x = e.clientX; this.dragState.y = e.clientY;
        this.refresh();
        return;
      }
      if (this.dragState && this.dragState.kind === 'move') {
        const dx = w.x - this.dragState.lastW.x, dy = w.y - this.dragState.lastW.y;
        this._moveSelection(dx, dy);
        this.dragState.lastW = w;
        this.refresh();
        return;
      }
      if (this._boxSel) {
        this._boxSel.cur = w;
        this.refresh();
        return;
      }
      // update previews
      if (this.routeState) {
        const anchor = this.routeState.pts[this.routeState.pts.length - 1];
        this.routeState.preview = this.snapPt(Geo.snapRoutePoint(anchor.x, anchor.y, w.x, w.y, this.routeMode));
        this.refresh();
      } else if (this.zoneState) {
        this.zoneState.preview = this.snapPt(w);
        this.refresh();
      } else if (this.wireState) {
        const anchor = this.wireState.pts[this.wireState.pts.length - 1];
        const snapped = Geo.snapRoutePoint(anchor.x, anchor.y, w.x, w.y, '90');
        this.wireState.preview = this.snapPt(snapped);
        this.refresh();
      } else if (this.placing) {
        this.refresh();
      }
    },

    handleMouseUp(e, sx, sy) {
      if (this.dragState && this.dragState.kind === 'pan') { this.dragState = null; return; }
      if (this.dragState && this.dragState.kind === 'move') {
        this.dragState = null;
        this._snapSelectionToGrid();
        this.modified();
        this.refresh();
        return;
      }
      if (this._boxSel) {
        const w1 = this._boxSel.start, w2 = this._boxSel.cur;
        this._finishBoxSelect(w1, w2, e.ctrlKey);
        this._boxSel = null;
        this.refresh();
      }
    },

    handleWheel(e, sx, sy) {
      const r = this.renderer();
      r.zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, { x: sx, y: sy });
    },

    handleDblClick(e, sx, sy) {
      if (this.routeState) this.finishRoute();
      else if (this.zoneState) this.finishZone();
      else if (this.wireState) this.finishWire();
    },

    // ---------------- PCB mode ----------------
    _pcbMouseDown(w, e) {
      const board = this.board();
      const R = global.PCBRender;
      const sp = this.snapPt(w);
      switch (this.tool) {
        case 'select': {
          const hit = R.pick(board, this.fpLib(), w.x, w.y);
          if (hit) {
            const id = hit.obj.id;
            if (!e.ctrlKey && !this.selection.has(id)) this.selection = new Set([id]);
            else if (e.ctrlKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
            if (hit.type === 'pad' || hit.type === 'comp' || hit.type === 'trace' || hit.type === 'via') {
              this.activeNet = hit.pad ? hit.pad.net : (hit.obj.net || this.activeNet);
            }
            this.dragState = { kind: 'move', lastW: w, moved: false };
            Doc.snapshot();
          } else {
            if (!e.ctrlKey) this.selection.clear();
            this._boxSel = { start: w, cur: w };
          }
          this.panel();
          this.refresh();
          break;
        }
        case 'trace': {
          if (!this.routeState) {
            const net = this.netAt(board, w) || this.activeNet || '';
            Doc.snapshot();
            this.routeState = { pts: [sp], net, layer: this.activeLayer, width: board.designRules.defaultTraceWidth || 0.25 };
            this.activeNet = net;
          } else {
            this.routeState.pts.push(this.routeState.preview || sp);
          }
          this.refresh();
          break;
        }
        case 'via': {
          Doc.snapshot();
          const net = this.netAt(board, w) || this.activeNet || '';
          Model.Board.addVia(board, {
            net, x: sp.x, y: sp.y,
            drill: board.designRules.defaultViaDrill, diameter: board.designRules.defaultViaDiameter
          });
          this.activeNet = net;
          this.modified();
          this.refresh();
          break;
        }
        case 'zone': {
          if (!this.zoneState) {
            Doc.snapshot();
            this.zoneState = { pts: [sp] };
          } else {
            this.zoneState.pts.push(this.zoneState.preview || sp);
          }
          this.refresh();
          break;
        }
        case 'comp': {
          this._placeComponentAt(sp);
          break;
        }
        case 'silkline': {
          if (!this._silkStart) {
            Doc.snapshot();
            this._silkStart = sp;
          } else {
            Model.Board.addSilk(this.board(), { side: this.activeLayer === 'B.Cu' ? 'B' : 'F', kind: 'line', pts: [this._silkStart, sp], width: 0.15 });
            this._silkStart = null;
            this.modified();
          }
          this.refresh();
          break;
        }
        case 'silktext': {
          const text = (document.getElementById('pcb-tool-text') || {}).value || 'TEXT';
          Doc.snapshot();
          Model.Board.addSilk(this.board(), { side: this.activeLayer === 'B.Cu' ? 'B' : 'F', kind: 'text', x: sp.x, y: sp.y, text, size: 1.2, rot: 0 });
          this.modified();
          this.refresh();
          break;
        }
        case 'measure': {
          this.measurePts.push(sp);
          if (this.measurePts.length === 2) {
            const d = Geo.dist(this.measurePts[0].x, this.measurePts[0].y, this.measurePts[1].x, this.measurePts[1].y);
            this.status('距离: ' + d.toFixed(3) + ' mm');
            setTimeout(() => { this.measurePts = []; this.refresh(); }, 3000);
          }
          this.refresh();
          break;
        }
        case 'delete': {
          const hit = R.pick(board, this.fpLib(), w.x, w.y);
          if (hit) {
            Doc.snapshot();
            this._deleteObject(hit.type, hit.obj, hit.pad);
            this.modified();
            this.refresh();
            this.panel();
          }
          break;
        }
      }
    },

    _placeComponentAt(sp) {
      const board = this.board();
      const ref = this._nextRef('U');
      // 从底层视图放置时自动放到 B 面（符合 KiCad/Altium 行为）
      const side = (global.PCBRender.viewFromBottom ? 'B' : 'F');
      Doc.snapshot();
      const comp = Model.Board.addComponent(board, {
        ref, footprint: this.activeFootprint, params: {},
        x: sp.x, y: sp.y, rot: (this.placing && this.placing.rot) || 0, side
      });
      this.modified();
      this.selection = new Set([comp.id]);
      this.status('已放置 ' + ref + ' (' + this.activeFootprint + ') @ ' + side + ' 面');
      this.refresh();
      this.panel();
    },

    _nextRef(prefix) {
      const board = this.board();
      let n = 1;
      const used = new Set(board.components.map(c => c.ref));
      while (used.has(prefix + n)) n++;
      return prefix + n;
    },

    finishRoute() {
      if (!this.routeState) return;
      if (this.routeState.preview) this.routeState.pts.push(this.routeState.preview);
      const pts = [];
      for (const p of this.routeState.pts) {
        if (!pts.length || Geo.dist(p.x, p.y, pts[pts.length - 1].x, pts[pts.length - 1].y) > 0.01) pts.push(p);
      }
      if (pts.length >= 2) {
        Model.Board.addTrace(this.board(), {
          net: this.routeState.net, layer: this.routeState.layer,
          width: this.routeState.width, pts
        });
        this.modified();
      } else {
        // discard: snapshot was taken; nothing added so no undo needed but pop
        Doc._undo.pop();
      }
      this.routeState = null;
      this.refresh();
      this.panel();
    },

    routeLayerSwitch() {
      if (!this.routeState) {
        // toggle active layer F<->B
        const layers = Model.Board.copperLayerIds(this.board());
        let i = layers.indexOf(this.activeLayer);
        i = (i + 1) % layers.length;
        this.activeLayer = layers[i];
        this.status('当前层: ' + this.activeLayer);
        this.panel();
        return;
      }
      const st = this.routeState;
      const layers = Model.Board.copperLayerIds(this.board());
      const curIdx = layers.indexOf(st.layer);
      const next = layers[(curIdx + 1) % layers.length];
      const endPt = st.preview || st.pts[st.pts.length - 1];
      // finish current segment, add via, continue on next layer
      st.pts.push(endPt);
      const pts = st.pts.filter((p, i) => i === 0 || Geo.dist(p.x, p.y, st.pts[i - 1].x, st.pts[i - 1].y) > 0.01);
      if (pts.length >= 2) {
        Model.Board.addTrace(this.board(), { net: st.net, layer: st.layer, width: st.width, pts });
      }
      const board = this.board();
      Model.Board.addVia(board, {
        net: st.net, x: endPt.x, y: endPt.y,
        drill: board.designRules.defaultViaDrill, diameter: board.designRules.defaultViaDiameter
      });
      this.routeState = { pts: [endPt], net: st.net, layer: next, width: st.width };
      this.refresh();
    },

    finishZone() {
      if (!this.zoneState) return;
      if (this.zoneState.preview) this.zoneState.pts.push(this.zoneState.preview);
      const pts = this.zoneState.pts;
      if (pts.length >= 3) {
        const board = this.board();
        Model.Board.addZone(board, {
          net: this.activeNet || '', layer: this.activeLayer, pts: pts.slice(),
          clearance: board.designRules.zoneClearance, thermalWidth: board.designRules.zoneThermalWidth
        });
        this.modified();
      } else {
        Doc._undo.pop();
      }
      this.zoneState = null;
      this.refresh();
      this.panel();
    },

    // ---------------- schematic mode ----------------
    _schMouseDown(w, e) {
      const sheet = this.sheet();
      const R = global.PCBSchRender;
      const sp = this.snapPt(w);
      switch (this.tool) {
        case 'select': {
          const hit = R.pick(sheet, this.symLib(), w.x, w.y);
          if (hit) {
            const id = hit.obj.id;
            if (!e.ctrlKey && !this.selection.has(id)) this.selection = new Set([id]);
            else if (e.ctrlKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
            this.dragState = { kind: 'move', lastW: w };
            Doc.snapshot();
          } else {
            if (!e.ctrlKey) this.selection.clear();
            this._boxSel = { start: w, cur: w };
          }
          this.panel();
          this.refresh();
          break;
        }
        case 'symbol': {
          this._placeSymbolAt(sp);
          break;
        }
        case 'wire': {
          if (!this.wireState) {
            Doc.snapshot();
            this.wireState = { pts: [sp] };
          } else {
            this.wireState.pts.push(this.wireState.preview || sp);
          }
          this.refresh();
          break;
        }
        case 'label': {
          const text = (document.getElementById('pcb-tool-text') || {}).value || 'NET';
          Doc.snapshot();
          sheet.labels.push({ id: Model.nextId('lb'), x: sp.x, y: sp.y, text, rot: 0 });
          this.modified();
          this.refresh();
          break;
        }
        case 'power': {
          Doc.snapshot();
          sheet.powerSymbols.push({ id: Model.nextId('pw'), x: sp.x, y: sp.y, ptype: this.activePower, rot: 0 });
          this.modified();
          this.refresh();
          break;
        }
        case 'junction': {
          Doc.snapshot();
          sheet.junctions.push({ id: Model.nextId('jn'), x: sp.x, y: sp.y });
          this.modified();
          this.refresh();
          break;
        }
        case 'noconnect': {
          Doc.snapshot();
          sheet.noConnects.push({ id: Model.nextId('nc'), x: sp.x, y: sp.y });
          this.modified();
          this.refresh();
          break;
        }
        case 'text': {
          const text = (document.getElementById('pcb-tool-text') || {}).value || '文本';
          Doc.snapshot();
          sheet.texts.push({ id: Model.nextId('tx'), x: sp.x, y: sp.y, text, size: 1.8, rot: 0 });
          this.modified();
          this.refresh();
          break;
        }
        case 'delete': {
          const hit = R.pick(sheet, this.symLib(), w.x, w.y);
          if (hit) {
            Doc.snapshot();
            this._deleteSchObject(hit.type, hit.obj);
            this.modified();
            this.refresh();
            this.panel();
          }
          break;
        }
      }
    },

    _placeSymbolAt(sp) {
      const sheet = this.sheet();
      const lib = this.activeSymbol;
      const def = this.symLib().get(lib);
      const prefix = def ? def.refPrefix : 'U';
      Doc.snapshot();
      const ref = this._nextSchRef(prefix);
      let symParams = null;
      if (lib === 'IC' || lib === 'CONN') {
        // read params from tool text field: "left:VCC,D0,D1;right:GND,O0,O1" or pin count for CONN
        const spec = ((document.getElementById('pcb-tool-text') || {}).value || '').trim();
        if (lib === 'CONN') {
          const n = parseInt(spec, 10);
          symParams = { pins: isNaN(n) ? 4 : n };
        } else {
          symParams = {};
          const lm = /left:([^;]*)/i.exec(spec), rm = /right:([^;]*)/i.exec(spec);
          symParams.left = lm ? lm[1].split(',').map(s => s.trim()).filter(Boolean) : ['P1', 'P2', 'P3'];
          symParams.right = rm ? rm[1].split(',').map(s => s.trim()).filter(Boolean) : ['P4', 'P5', 'P6'];
        }
      }
      const sym = {
        id: Model.nextId('sym'), lib, ref,
        value: '', footprint: this.symLib().defaultFootprint(lib, symParams),
        symParams, x: sp.x, y: sp.y,
        rot: (this.placing && this.placing.rot) || 0, mirror: false, fields: {}
      };
      sheet.symbols.push(sym);
      this.modified();
      this.selection = new Set([sym.id]);
      this.status('已放置 ' + ref + ' (' + lib + ')');
      this.refresh();
      this.panel();
    },

    _nextSchRef(prefix) {
      const sheet = this.sheet();
      let n = 1;
      const used = new Set(sheet.symbols.map(s => s.ref));
      while (used.has(prefix + n)) n++;
      return prefix + n;
    },

    finishWire() {
      if (!this.wireState) return;
      if (this.wireState.preview) this.wireState.pts.push(this.wireState.preview);
      const pts = [];
      for (const p of this.wireState.pts) {
        if (!pts.length || Geo.dist(p.x, p.y, pts[pts.length - 1].x, pts[pts.length - 1].y) > 0.01) pts.push(p);
      }
      if (pts.length >= 2) {
        const sheet = this.sheet();
        sheet.wires.push({ id: Model.nextId('w'), pts });
        // auto junctions at T-crossings
        this._autoJunctions(sheet, pts);
        this.modified();
      } else {
        Doc._undo.pop();
      }
      this.wireState = null;
      this.refresh();
    },

    _autoJunctions(sheet, newPts) {
      const gk = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
      const exists = new Set(sheet.junctions.map(j => gk(j.x, j.y)));
      const addJ = (x, y) => {
        const k = gk(x, y);
        if (exists.has(k)) return;
        // junction needed if point is a pin or a wire vertex already
        let isNode = false;
        for (const w of sheet.wires) {
          for (const p of w.pts) if (gk(p.x, p.y) === k) { isNode = true; break; }
          if (isNode) break;
        }
        if (!isNode) {
          const pins = Model.Sheet.symbolPins(sheet, this.symLib());
          for (const pn of pins) if (gk(pn.x, pn.y) === k) { isNode = true; break; }
        }
        if (isNode) {
          sheet.junctions.push({ id: Model.nextId('jn'), x, y });
          exists.add(k);
        }
      };
      for (let i = 1; i < newPts.length - 1; i++) addJ(newPts[i].x, newPts[i].y);
    },

    // ---------------- shared ops ----------------
    _moveSelection(dx, dy) {
      if (this.mode === 'pcb') {
        const b = this.board();
        for (const id of this.selection) {
          const comp = b.components.find(c => c.id === id);
          if (comp) { comp.x += dx; comp.y += dy; continue; }
          const tr = b.traces.find(t => t.id === id);
          if (tr) { tr.pts.forEach(p => { p.x += dx; p.y += dy; }); continue; }
          const via = b.vias.find(v => v.id === id);
          if (via) { via.x += dx; via.y += dy; continue; }
          const zn = b.zones.find(z => z.id === id);
          if (zn) { zn.pts.forEach(p => { p.x += dx; p.y += dy; }); continue; }
          const sk = b.silkscreen.find(s => s.id === id);
          if (sk) {
            if (sk.pts) sk.pts.forEach(p => { p.x += dx; p.y += dy; });
            else { sk.x += dx; sk.y += dy; }
          }
        }
      } else {
        const s = this.sheet();
        for (const id of this.selection) {
          const sym = s.symbols.find(x => x.id === id);
          if (sym) { sym.x += dx; sym.y += dy; continue; }
          const w = s.wires.find(x => x.id === id);
          if (w) { w.pts.forEach(p => { p.x += dx; p.y += dy; }); continue; }
          const lb = s.labels.find(x => x.id === id);
          if (lb) { lb.x += dx; lb.y += dy; continue; }
          const ps = s.powerSymbols.find(x => x.id === id);
          if (ps) { ps.x += dx; ps.y += dy; continue; }
          const j = s.junctions.find(x => x.id === id);
          if (j) { j.x += dx; j.y += dy; continue; }
          const t = s.texts.find(x => x.id === id);
          if (t) { t.x += dx; t.y += dy; }
        }
      }
    },

    _snapSelectionToGrid() {
      const g = this.grid();
      const snapV = v => Geo.snapToGrid(v, g);
      if (this.mode === 'pcb') {
        for (const id of this.selection) {
          const comp = this.board().components.find(c => c.id === id);
          if (comp) { comp.x = snapV(comp.x); comp.y = snapV(comp.y); }
          const via = this.board().vias.find(v => v.id === id);
          if (via) { via.x = snapV(via.x); via.y = snapV(via.y); }
        }
      } else {
        for (const id of this.selection) {
          const sym = this.sheet().symbols.find(x => x.id === id);
          if (sym) { sym.x = snapV(sym.x); sym.y = snapV(sym.y); }
        }
      }
    },

    _finishBoxSelect(w1, w2, additive) {
      const minX = Math.min(w1.x, w2.x), maxX = Math.max(w1.x, w2.x);
      const minY = Math.min(w1.y, w2.y), maxY = Math.max(w1.y, w2.y);
      if (Math.abs(maxX - minX) < 0.2 && Math.abs(maxY - minY) < 0.2) return;
      if (!additive) this.selection.clear();
      const inBox = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
      if (this.mode === 'pcb') {
        const b = this.board();
        const pads = Model.Board.allPads(b, this.fpLib());
        for (const c of b.components) {
          const cp = pads.filter(p => p.ref === c.ref);
          if (cp.length && cp.every(p => inBox(p.x, p.y))) this.selection.add(c.id);
        }
        for (const t of b.traces) if (t.pts.every(p => inBox(p.x, p.y))) this.selection.add(t.id);
        for (const v of b.vias) if (inBox(v.x, v.y)) this.selection.add(v.id);
        for (const z of b.zones) if (z.pts.length && z.pts.every(p => inBox(p.x, p.y))) this.selection.add(z.id);
      } else {
        const s = this.sheet();
        for (const sym of s.symbols) if (inBox(sym.x, sym.y)) this.selection.add(sym.id);
        for (const w of s.wires) if (w.pts.every(p => inBox(p.x, p.y))) this.selection.add(w.id);
        for (const lb of s.labels) if (inBox(lb.x, lb.y)) this.selection.add(lb.id);
        for (const ps of s.powerSymbols) if (inBox(ps.x, ps.y)) this.selection.add(ps.id);
      }
      this.panel();
    },

    _deleteObject(type, obj, pad) {
      const b = this.board();
      const rm = (arr, o) => { const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); };
      if (type === 'pad' || type === 'comp') rm(b.components, obj);
      else if (type === 'trace') rm(b.traces, obj);
      else if (type === 'via') rm(b.vias, obj);
      else if (type === 'zone') rm(b.zones, obj);
      else if (type === 'silk') rm(b.silkscreen, obj);
      if (obj && obj.id) this.selection.delete(obj.id);
    },

    _deleteSchObject(type, obj) {
      const s = this.sheet();
      const rm = (arr, o) => { const i = arr.indexOf(o); if (i >= 0) arr.splice(i, 1); };
      if (type === 'symbol') rm(s.symbols, obj);
      else if (type === 'wire') rm(s.wires, obj);
      else if (type === 'label') rm(s.labels, obj);
      else if (type === 'power') rm(s.powerSymbols, obj);
      else if (type === 'junction') rm(s.junctions, obj);
      else if (type === 'text') rm(s.texts, obj);
      if (obj && obj.id) this.selection.delete(obj.id);
    },

    deleteSelection() {
      if (!this.selection.size) return;
      Doc.snapshot();
      if (this.mode === 'pcb') {
        const b = this.board();
        b.components = b.components.filter(c => !this.selection.has(c.id));
        b.traces = b.traces.filter(t => !this.selection.has(t.id));
        b.vias = b.vias.filter(v => !this.selection.has(v.id));
        b.zones = b.zones.filter(z => !this.selection.has(z.id));
        b.silkscreen = b.silkscreen.filter(s => !this.selection.has(s.id));
      } else {
        const s = this.sheet();
        s.symbols = s.symbols.filter(x => !this.selection.has(x.id));
        s.wires = s.wires.filter(x => !this.selection.has(x.id));
        s.labels = s.labels.filter(x => !this.selection.has(x.id));
        s.powerSymbols = s.powerSymbols.filter(x => !this.selection.has(x.id));
        s.junctions = s.junctions.filter(x => !this.selection.has(x.id));
        s.texts = s.texts.filter(x => !this.selection.has(x.id));
      }
      this.selection.clear();
      this.modified();
      this.refresh();
      this.panel();
    },

    rotateSelection(delta) {
      if (this.placing) {
        this.placing.rot = ((this.placing.rot || 0) + delta + 360) % 360;
        this.refresh();
        return;
      }
      if (!this.selection.size) return;
      Doc.snapshot();
      if (this.mode === 'pcb') {
        for (const id of this.selection) {
          const comp = this.board().components.find(c => c.id === id);
          if (comp) comp.rot = ((comp.rot || 0) + delta + 360) % 360;
        }
      } else {
        for (const id of this.selection) {
          const sym = this.sheet().symbols.find(x => x.id === id);
          if (sym) sym.rot = ((sym.rot || 0) + delta + 360) % 360;
        }
      }
      this.modified();
      this.refresh();
    },

    mirrorSelection() {
      if (!this.selection.size) return;
      // sch 模式：翻转 symbol.mirror；pcb 模式：翻转 component.side (F↔B)
      if (this.mode === 'sch') {
        Doc.snapshot();
        for (const id of this.selection) {
          const sym = this.sheet().symbols.find(x => x.id === id);
          if (sym) sym.mirror = !sym.mirror;
        }
        this.modified();
        this.refresh();
      } else if (this.mode === 'pcb') {
        this.flipSelectionToOtherSide();
      }
    },

    handleKeyDown(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return false;
      const key = e.key;
      if (key === 'Escape') {
        if (this.routeState || this.zoneState || this.wireState || this.placing || this.measurePts.length) {
          this.cancelTransient();
          this.refresh();
        } else {
          this.selection.clear();
          this.refresh();
          this.panel();
        }
        return true;
      }
      if (key === 'Delete' || key === 'Backspace') {
        if (this.routeState && key === 'Backspace' && this.routeState.pts.length > 1) {
          this.routeState.pts.pop(); this.refresh(); return true;
        }
        this.deleteSelection();
        return true;
      }
      if (key === 'Enter') {
        if (this.routeState) { this.finishRoute(); return true; }
        if (this.zoneState) { this.finishZone(); return true; }
        if (this.wireState) { this.finishWire(); return true; }
        return false;
      }
      if (key === 'r' || key === 'R') { this.rotateSelection(90); return true; }
      if ((key === 'm' || key === 'M') && this.mode === 'sch') { this.mirrorSelection(); return true; }
      if ((key === 'v' || key === 'V') && this.mode === 'pcb') { this.routeLayerSwitch(); return true; }
      // B 键：PCB 模式下切换顶/底视图（类 KiCad/Altium V+B）
      if ((key === 'b' || key === 'B') && this.mode === 'pcb' && !e.ctrlKey && !e.shiftKey) {
        this.setView('toggle'); return true;
      }
      // Shift+F：PCB 模式下翻转选中元件到另一面
      if ((key === 'f' || key === 'F') && this.mode === 'pcb' && e.shiftKey) {
        this.flipSelectionToOtherSide(); return true;
      }
      if (key === 'f' || key === 'F') { this.fitView(); return true; }
      if ((key === 'z' || key === 'Z') && e.ctrlKey) { Doc.undo(); this.refresh(); this.panel(); return true; }
      if ((key === 'y' || key === 'Y') && e.ctrlKey) { Doc.redo(); this.refresh(); this.panel(); return true; }
      return false;
    },

    fitView() {
      if (this.mode === 'pcb') {
        global.PCBRender.fit(Model.Board.boardBBox(this.board(), this.fpLib()));
      } else if (this.mode === 'sch') {
        const s = this.sheet();
        const pts = [];
        s.symbols.forEach(x => pts.push({ x: x.x, y: x.y }));
        s.wires.forEach(w => pts.push(...w.pts));
        if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 100, y: 100 });
        global.PCBSchRender.fit(Geo.ptsBBox(pts));
      }
    }
  };

  global.PCBEditor = Editor;
})(typeof window !== 'undefined' ? window : globalThis);
