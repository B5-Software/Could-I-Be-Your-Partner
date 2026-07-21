// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - command DSL executor + window.pcb* bridge for main-process/agent driving
(function (global) {
  'use strict';

  const Geo = global.PCBGeo;
  const Model = global.PCBModel;
  const Doc = Model.Doc;
  const fpLib = () => global.PCBFootprints;
  const symLib = () => global.PCBSymbols;
  const Editor = () => global.PCBEditor;

  function parseCmd(line) {
    // tokenize honoring "quoted strings"
    const tokens = [];
    let cur = '', inQ = false;
    for (const ch of String(line)) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (/\s/.test(ch) && !inQ) {
        if (cur) { tokens.push(cur); cur = ''; }
      } else cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  function parsePt(s) {
    const m = /^(-?[\d.]+),(-?[\d.]+)$/.exec(s || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : null;
  }

  function ok(data) { return Object.assign({ ok: true }, data || {}); }
  function fail(msg) { return { ok: false, error: msg }; }

  // ---------------------------------------------------------------------------
  // schematic -> pcb synchronization
  // ---------------------------------------------------------------------------
  function syncFromSchematic(sheetIdx, boardIdx) {
    const sheet = Doc.sheet(sheetIdx);
    const board = Doc.board(boardIdx);
    Model.Sheet.annotate(sheet);
    const pinNets = Model.Sheet.resolveNets(sheet, symLib());
    let created = 0, updated = 0;
    const bb = Model.Board.boardBBox(board, fpLib());
    let cx = bb.minX + 8, cy = bb.minY + 8;
    for (const sym of sheet.symbols) {
      let comp = board.components.find(c => c.ref === sym.ref);
      const fpName = fpLib().has(sym.footprint) ? sym.footprint : (global.PCBIO ? (global.PCBIO.guessFootprint(sym.footprint, fpLib()) || 'R_0805') : 'R_0805');
      if (!comp) {
        comp = Model.Board.addComponent(board, {
          ref: sym.ref, value: sym.value || '', footprint: fpName,
          params: sym.fpParams || {}, x: cx, y: cy, rot: 0, side: 'F'
        });
        cx += 12;
        if (cx > bb.maxX - 8) { cx = bb.minX + 8; cy += 12; }
        created++;
      } else {
        if (sym.value !== undefined) comp.value = sym.value;
        if (fpName && comp.footprint !== fpName) { comp.footprint = fpName; comp.params = sym.fpParams || {}; }
        updated++;
      }
    }
    for (const comp of board.components) comp.padNets = {};
    for (const pn of pinNets) {
      Model.Board.setPadNet(board, pn.ref, pn.num, pn.net);
    }
    Doc.touch();
    return { created, updated, nets: new Set(pinNets.map(p => p.net)).size };
  }

  // ---------------------------------------------------------------------------
  // executor
  // ---------------------------------------------------------------------------
  const Executor = {
    execute(line) {
      const t = parseCmd(line);
      if (!t.length) return fail('空命令');
      const cmd = t[0].toLowerCase();
      const args = t.slice(1);
      try {
        switch (cmd) {
          case 'help': return ok({ help: HELP_TEXT });
          case 'new': {
            Doc.reset(args[0] || 'Untitled', parseFloat(args[1]) || 100, parseFloat(args[2]) || 80, parseInt(args[3], 10) || 2);
            this._ui();
            return ok({ name: Doc.project.name });
          }
          case 'board': return this._board(args);
          case 'rules': return this._rules(args);
          case 'stackup': return this._stackup(args);
          case 'comp': return this._comp(args);
          case 'net': return this._net(args);
          case 'trace': return this._trace(args);
          case 'via': return this._via(args);
          case 'zone': return this._zone(args);
          case 'silk': return this._silk(args);
          case 'sch': return this._sch(args);
          case 'drc': {
            const errs = global.PCBDrc.run(Doc.board(), fpLib());
            if (Editor()) { Editor().drcMarkers = errs; Editor().refresh(); }
            return ok({ count: errs.length, errors: errs.slice(0, 200) });
          }
          case 'erc': {
            const errs = global.PcbErc.run(Doc.sheet(), symLib());
            if (Editor()) { Editor().ercMarkers = errs; Editor().refresh(); }
            return ok({ count: errs.length, errors: errs.slice(0, 200) });
          }
          case 'autoroute': {
            const nets = args.length ? args[0].split(',').map(s => s.trim()).filter(Boolean) : null;
            const res = global.PCBAutorouter.autoroute(Doc.board(), fpLib(), { onlyNets: nets });
            if (res.ok) {
              Doc.snapshot();
              for (const tr of res.traces) Model.Board.addTrace(Doc.board(), tr);
              for (const v of res.vias) Model.Board.addVia(Doc.board(), v);
              Doc.touch();
              this._ui();
            }
            return res.ok ? ok({ routed: res.routed, failed: res.failed, failedNets: res.failedNets, traces: res.traces.length, vias: res.vias.length }) : res;
          }
          case 'clear': {
            if (!args.length) {
              return ok({
                usage: 'clear 命令用法:',
                options: [
                  'clear routes [net] — 删除所有走线和过孔（可指定仅某个网络）',
                  'clear traces — 同 clear routes',
                  'clear all — 删除整块板的全部内容（元件/走线/过孔/铺铜/丝印）',
                  '提示: 误操作可用 undo 命令撤销'
                ]
              });
            }
            const sub = args[0].toLowerCase();
            if (sub === 'routes' || sub === 'traces') {
              Doc.snapshot();
              const b = Doc.board();
              const net = args[1];
              const nT = b.traces.length, nV = b.vias.length;
              b.traces = net ? b.traces.filter(t => t.net !== net) : [];
              b.vias = net ? b.vias.filter(v => v.net !== net) : [];
              Doc.touch(); this._ui();
              return ok({ removedTraces: net ? nT - b.traces.length : nT, removedVias: net ? nV - b.vias.length : nV });
            }
            if (sub === 'all') {
              Doc.snapshot();
              const b = Doc.board();
              b.components = []; b.traces = []; b.vias = []; b.zones = []; b.silkscreen = []; b.keepouts = [];
              Doc.touch(); this._ui();
              return ok({});
            }
            return fail('未知 clear 目标: ' + args[0] + ' (输入 clear 查看用法)');
          }
          case 'del': {
            Doc.snapshot();
            const b = Doc.board();
            const id = args[1];
            const lists = { trace: b.traces, via: b.vias, zone: b.zones, silk: b.silkscreen };
            const arr = lists[args[0]];
            if (!arr) { Doc._undo.pop(); return fail('用法: del trace|via|zone|silk <id|last> (last=删除最近添加的)'); }
            if (id === 'last') {
              if (!arr.length) { Doc._undo.pop(); return fail('没有可删除的对象'); }
              const removed = arr.pop();
              Doc.touch(); this._ui();
              return ok({ removed: removed.id });
            }
            const i = arr.findIndex(o => o.id === id);
            if (i < 0) { Doc._undo.pop(); return fail('未找到对象 ' + id); }
            arr.splice(i, 1);
            Doc.touch(); this._ui();
            return ok({});
          }
          case 'info':
          case 'state': return this._state();
          case 'mode': {
            if (Editor() && ['sch', 'pcb', '3d'].includes(args[0])) Editor().setMode(args[0]);
            return ok({ mode: args[0] });
          }
          case 'footprints': return ok({ footprints: fpLib().list() });
          case 'symbols': return ok({ symbols: symLib().list() });
          case 'fit': if (Editor()) Editor().fitView(); return ok({});
          case 'undo': return ok({ done: Doc.undo() });
          case 'redo': return ok({ done: Doc.redo() });
          default: return fail('未知命令: ' + cmd + ' (输入 help 查看)');
        }
      } catch (e) {
        return fail(e.message);
      }
    },

    _ui() {
      const E = Editor();
      if (E) { E.refresh(); E.panel(); }
    },

    _board(args) {
      const b = Doc.board();
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'size') {
        Doc.snapshot();
        const w = parseFloat(args[1]) || 100, h = parseFloat(args[2]) || 80;
        b.outline = { pts: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], closed: true };
        Doc.touch(); this._ui();
        return ok({ width: w, height: h });
      }
      if (sub === 'outline') {
        const pts = args.slice(1).map(parsePt).filter(Boolean);
        if (pts.length < 3) return fail('至少需要3个顶点: board outline x1,y1 x2,y2 x3,y3 ...');
        Doc.snapshot();
        b.outline = { pts, closed: true };
        Doc.touch(); this._ui();
        return ok({ points: pts.length });
      }
      if (sub === 'name') {
        b.name = args.slice(1).join(' ') || b.name;
        Doc.touch();
        return ok({ name: b.name });
      }
      return fail('用法: board size <w> <h> | board outline x,y ... | board name <名称>');
    },

    _rules(args) {
      const b = Doc.board();
      if (args[0] === 'list' || !args.length) return ok({ rules: b.designRules });
      if (args[0] === 'set') {
        const key = args[1], val = parseFloat(args[2]);
        if (!(key in b.designRules)) return fail('未知规则: ' + key + ' (rules list 查看全部)');
        if (isNaN(val)) return fail('规则值必须是数字');
        Doc.snapshot();
        b.designRules[key] = val;
        Doc.touch();
        return ok({ rules: b.designRules });
      }
      return fail('用法: rules set <key> <value> | rules list');
    },

    _stackup(args) {
      const b = Doc.board();
      if (args[0] === 'layers') {
        const n = parseInt(args[1], 10);
        if (!n || n < 1 || n > 16) return fail('层数范围 1-16');
        Doc.snapshot();
        b.stackup = Model.defaultStackup(n);
        Doc.touch(); this._ui();
        return ok({ layers: n });
      }
      if (args[0] === 'thickness') {
        const t = parseFloat(args[1]);
        if (!t) return fail('用法: stackup thickness <mm>');
        Doc.snapshot();
        b.stackup.boardThickness = t;
        Doc.touch();
        return ok({ thickness: t });
      }
      return ok({ stackup: b.stackup });
    },

    _comp(args) {
      const b = Doc.board();
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'add') {
        // comp add <footprint> <ref> <x> <y> [rot] [side] [k=v ...]
        const fp = args[1];
        if (!fpLib().has(fp)) return fail('未知封装: ' + fp + ' (可用 footprints 命令查看列表)');
        const ref = args[2];
        if (!ref) return fail('需要位号 (如 R1)');
        if (b.components.some(c => c.ref === ref)) return fail('位号已存在: ' + ref);
        const x = parseFloat(args[3]) || 0, y = parseFloat(args[4]) || 0;
        const rot = parseFloat(args[5]) || 0;
        const side = (args[6] || 'F').toUpperCase().startsWith('B') ? 'B' : 'F';
        const params = {};
        for (const kv of args.slice(7)) {
          const m = /^(\w+)=([\w.\-#]+)$/.exec(kv);
          if (m) params[m[1]] = isNaN(Number(m[2])) ? m[2] : Number(m[2]);
        }
        Doc.snapshot();
        const c = Model.Board.addComponent(b, { ref, footprint: fp, params, x, y, rot, side });
        Doc.touch(); this._ui();
        // 返回完整 pad 全局坐标（让 Agent 立即知道每个 pad 的位置，便于布线）
        const pads = Model.Board.allPads(b, fpLib()).filter(p => p.ref === ref)
          .map(p => ({ num: p.num, x: p.x, y: p.y, w: p.w, h: p.h, net: p.net || '', side: p.side }));
        return ok({ id: c.id, ref, x, y, rot, side, pads });
      }
      if (sub === 'move') {
        const c = Model.Board.findComponent(b, args[1]);
        if (!c) return fail('未找到元件 ' + args[1]);
        Doc.snapshot();
        c.x = parseFloat(args[2]) || 0; c.y = parseFloat(args[3]) || 0;
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'rot') {
        const c = Model.Board.findComponent(b, args[1]);
        if (!c) return fail('未找到元件 ' + args[1]);
        Doc.snapshot();
        c.rot = ((parseFloat(args[2]) || 0) + 360) % 360;
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'side') {
        const c = Model.Board.findComponent(b, args[1]);
        if (!c) return fail('未找到元件 ' + args[1]);
        Doc.snapshot();
        c.side = (args[2] || 'F').toUpperCase().startsWith('B') ? 'B' : 'F';
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'value') {
        const c = Model.Board.findComponent(b, args[1]);
        if (!c) return fail('未找到元件 ' + args[1]);
        Doc.snapshot();
        c.value = args.slice(2).join(' ');
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'del') {
        Doc.snapshot();
        if (!Model.Board.deleteComponent(b, args[1])) { Doc._undo.pop(); return fail('未找到元件 ' + args[1]); }
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'list') {
        // 返回每个 component 的中心坐标 + 所有 pad 全局坐标（含 rot/side 变换后）
        // Agent 据此可直接画 trace 而无需查阅封装库定义
        const allPads = Model.Board.allPads(b, fpLib());
        return ok({
          components: b.components.map(c => {
            const pads = allPads.filter(p => p.ref === c.ref)
              .map(p => ({ num: p.num, x: p.x, y: p.y, w: p.w, h: p.h, net: p.net || '', side: p.side }));
            return {
              ref: c.ref, value: c.value, footprint: c.footprint,
              x: c.x, y: c.y, rot: c.rot, side: c.side, pads
            };
          })
        });
      }
      if (sub === 'pads') {
        // comp pads <ref> — 返回指定 component 的所有 pad 全局坐标
        const ref = args[1];
        if (!ref) return fail('用法: comp pads <ref>');
        const c = Model.Board.findComponent(b, ref);
        if (!c) return fail('未找到元件 ' + ref);
        const pads = Model.Board.allPads(b, fpLib()).filter(p => p.ref === ref)
          .map(p => ({ num: p.num, x: p.x, y: p.y, w: p.w, h: p.h, drill: p.drill, net: p.net || '', side: p.side }));
        return ok({ ref, x: c.x, y: c.y, rot: c.rot, side: c.side, pads });
      }
      if (sub === 'net') {
        // comp net <ref> <pad> <net>
        if (!Model.Board.setPadNet(b, args[1], args[2], args[3] || '')) return fail('未找到元件 ' + args[1]);
        Doc.touch(); this._ui();
        return ok({});
      }
      return fail('用法: comp add|move|rot|side|value|del|list|pads|net ...');
    },

    _net(args) {
      const b = Doc.board();
      if (args[0] === 'list') return ok({ nets: Model.Board.netNames(b, fpLib()) });
      if (args[0] === 'rename') {
        const oldN = args[1], newN = args[2];
        if (!oldN || !newN) return fail('用法: net rename <旧名> <新名>');
        Doc.snapshot();
        for (const c of b.components) {
          for (const k of Object.keys(c.padNets || {})) if (c.padNets[k] === oldN) c.padNets[k] = newN;
        }
        for (const t of b.traces) if (t.net === oldN) t.net = newN;
        for (const v of b.vias) if (v.net === oldN) v.net = newN;
        for (const z of b.zones) if (z.net === oldN) z.net = newN;
        Doc.touch(); this._ui();
        return ok({});
      }
      return fail('用法: net list | net rename <旧> <新>');
    },

    _trace(args) {
      // trace <net> <layer> <width> x1,y1 x2,y2 ...
      const net = args[0] || '';
      const layer = args[1] || 'F.Cu';
      if (!Model.Board.copperLayerIds(Doc.board()).includes(layer)) return fail('未知铜层: ' + layer);
      const width = parseFloat(args[2]) || Doc.board().designRules.defaultTraceWidth;
      const pts = args.slice(3).map(parsePt).filter(Boolean);
      if (pts.length < 2) return fail('至少需要2个点: trace <net> <layer> <width> x1,y1 x2,y2 ...');
      Doc.snapshot();
      const t = Model.Board.addTrace(Doc.board(), { net, layer, width, pts });
      Doc.touch(); this._ui();
      return ok({ id: t.id });
    },

    _via(args) {
      // via <net> <x> <y> [drill] [diameter]
      const net = args[0] || '';
      const x = parseFloat(args[1]), y = parseFloat(args[2]);
      if (isNaN(x) || isNaN(y)) return fail('用法: via <net> <x> <y> [drill] [diameter]');
      const b = Doc.board();
      Doc.snapshot();
      const v = Model.Board.addVia(b, {
        net, x, y,
        drill: parseFloat(args[3]) || b.designRules.defaultViaDrill,
        diameter: parseFloat(args[4]) || b.designRules.defaultViaDiameter
      });
      Doc.touch(); this._ui();
      return ok({ id: v.id });
    },

    _zone(args) {
      // zone <net> <layer> x1,y1 x2,y2 ... [--clearance n] [--thermal n]
      const net = args[0] || '';
      const layer = args[1] || 'F.Cu';
      const rest = args.slice(2);
      const pts = [];
      let clearance, thermal;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--clearance') { clearance = parseFloat(rest[++i]); continue; }
        if (rest[i] === '--thermal') { thermal = parseFloat(rest[++i]); continue; }
        const p = parsePt(rest[i]);
        if (p) pts.push(p);
      }
      if (pts.length < 3) return fail('至少需要3个顶点');
      const b = Doc.board();
      Doc.snapshot();
      const z = Model.Board.addZone(b, {
        net, layer, pts,
        clearance: isNaN(clearance) ? b.designRules.zoneClearance : clearance,
        thermalWidth: isNaN(thermal) ? b.designRules.zoneThermalWidth : thermal
      });
      Doc.touch(); this._ui();
      return ok({ id: z.id });
    },

    _silk(args) {
      const b = Doc.board();
      const side = 'F';
      const sub = (args[0] || '').toLowerCase();
      Doc.snapshot();
      if (sub === 'line') {
        const a = parsePt(args[1]), c = parsePt(args[2]);
        if (!a || !c) { Doc._undo.pop(); return fail('用法: silk line x1,y1 x2,y2 [F|B]'); }
        Model.Board.addSilk(b, { side: (args[3] || 'F').toUpperCase().startsWith('B') ? 'B' : 'F', kind: 'line', pts: [a, c], width: 0.15 });
      } else if (sub === 'rect') {
        const a = parsePt(args[1]), c = parsePt(args[2]);
        if (!a || !c) { Doc._undo.pop(); return fail('用法: silk rect x1,y1 x2,y2 [F|B]'); }
        Model.Board.addSilk(b, { side: (args[3] || 'F').toUpperCase().startsWith('B') ? 'B' : 'F', kind: 'rect', x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y });
      } else if (sub === 'circle') {
        const a = parsePt(args[1]), r = parseFloat(args[2]);
        if (!a || !r) { Doc._undo.pop(); return fail('用法: silk circle cx,cy r [F|B]'); }
        Model.Board.addSilk(b, { side: (args[3] || 'F').toUpperCase().startsWith('B') ? 'B' : 'F', kind: 'circle', x: a.x, y: a.y, r });
      } else if (sub === 'text') {
        const a = parsePt(args[args.length - 1]);
        const text = args.slice(1, args.length - 1).join(' ');
        if (!a || !text) { Doc._undo.pop(); return fail('用法: silk text "内容" x,y'); }
        Model.Board.addSilk(b, { side, kind: 'text', x: a.x, y: a.y, text, size: 1.2, rot: 0 });
      } else {
        Doc._undo.pop();
        return fail('用法: silk line|rect|circle|text ...');
      }
      Doc.touch(); this._ui();
      return ok({});
    },

    _sch(args) {
      const s = Doc.sheet();
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'sym') {
        // sch sym <lib> <x> <y> [rot] [--ref R1] [--value 10k] [--fp R_0805]
        const lib = args[1];
        if (!symLib().has(lib)) return fail('未知符号: ' + lib);
        const x = parseFloat(args[2]) || 0, y = parseFloat(args[3]) || 0;
        const rot = parseFloat(args[4]) || 0;
        let ref = null, value = '', fp = null, symParams = null;
        for (let i = 5; i < args.length; i++) {
          if (args[i] === '--ref') ref = args[++i];
          else if (args[i] === '--value') value = args[++i];
          else if (args[i] === '--fp') fp = args[++i];
          else if (args[i] === '--pins') symParams = { pins: parseInt(args[++i], 10) || 4 };
          else if (args[i] === '--left' || args[i] === '--right') {
            symParams = symParams || {};
            symParams[args[i].slice(2)] = args[++i].split(',').map(z => z.trim()).filter(Boolean);
          }
        }
        Doc.snapshot();
        if (!ref) {
          let n = 1;
          const prefix = (symLib().get(lib, symParams) || {}).refPrefix || 'U';
          const used = new Set(s.symbols.map(z => z.ref));
          while (used.has(prefix + n)) n++;
          ref = prefix + n;
        }
        const sym = {
          id: Model.nextId('sym'), lib, ref, value,
          footprint: fp || symLib().defaultFootprint(lib, symParams),
          symParams, x, y, rot, mirror: false, fields: {}
        };
        s.symbols.push(sym);
        Doc.touch(); this._ui();
        // 返回完整 pin 全局坐标（让 Agent 立即知道每个 pin 的位置，便于连线）
        const pins = Model.Sheet.symbolPins(s, symLib()).filter(p => p.ref === ref)
          .map(p => ({ num: p.num, name: p.name, x: p.x, y: p.y }));
        return ok({ id: sym.id, ref, x, y, rot, pins });
      }
      if (sub === 'wire') {
        const pts = args.slice(1).map(parsePt).filter(Boolean);
        if (pts.length < 2) return fail('至少需要2个点');
        Doc.snapshot();
        s.wires.push({ id: Model.nextId('w'), pts });
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'label') {
        const p = parsePt(args[args.length - 1]);
        const text = args.slice(1, args.length - 1).join(' ');
        if (!p || !text) return fail('用法: sch label "网络名" x,y');
        Doc.snapshot();
        s.labels.push({ id: Model.nextId('lb'), x: p.x, y: p.y, text, rot: 0 });
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'power') {
        const ptype = args[1] || 'GND';
        const p = parsePt(args[2]);
        if (!p) return fail('用法: sch power <GND|VCC|+5V|+3V3|...> x,y');
        Doc.snapshot();
        s.powerSymbols.push({ id: Model.nextId('pw'), x: p.x, y: p.y, ptype, rot: 0 });
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'junction') {
        const p = parsePt(args[1]);
        if (!p) return fail('用法: sch junction x,y');
        Doc.snapshot();
        s.junctions.push({ id: Model.nextId('jn'), x: p.x, y: p.y });
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'noconnect') {
        const p = parsePt(args[1]);
        if (!p) return fail('用法: sch noconnect x,y');
        Doc.snapshot();
        s.noConnects.push({ id: Model.nextId('nc'), x: p.x, y: p.y });
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'value') {
        const sym = s.symbols.find(z => z.ref === args[1]);
        if (!sym) return fail('未找到符号 ' + args[1]);
        Doc.snapshot();
        sym.value = args.slice(2).join(' ');
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'fp') {
        const sym = s.symbols.find(z => z.ref === args[1]);
        if (!sym) return fail('未找到符号 ' + args[1]);
        if (!fpLib().has(args[2])) return fail('未知封装 ' + args[2]);
        Doc.snapshot();
        sym.footprint = args[2];
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'del') {
        const i = s.symbols.findIndex(z => z.ref === args[1]);
        if (i < 0) return fail('未找到符号 ' + args[1]);
        Doc.snapshot();
        s.symbols.splice(i, 1);
        Doc.touch(); this._ui();
        return ok({});
      }
      if (sub === 'annotate') {
        Doc.snapshot();
        const n = Model.Sheet.annotate(s);
        Doc.touch(); this._ui();
        return ok({ annotated: n });
      }
      if (sub === 'list') {
        // 返回每个 symbol 的中心坐标 + 所有 pin 全局坐标（含 mirror/rot 变换后）
        // Agent 据此可直接画 wire 而无需查阅符号库定义
        const allPins = Model.Sheet.symbolPins(s, symLib());
        return ok({
          symbols: s.symbols.map(z => {
            const pins = allPins.filter(p => p.ref === z.ref)
              .map(p => ({ num: p.num, name: p.name, x: p.x, y: p.y }));
            return {
              ref: z.ref, lib: z.lib, value: z.value, footprint: z.footprint,
              x: z.x, y: z.y, rot: z.rot || 0, mirror: !!z.mirror, pins
            };
          })
        });
      }
      if (sub === 'pins') {
        // sch pins <ref> — 返回指定 symbol 的所有 pin 全局坐标
        const ref = args[1];
        if (!ref) return fail('用法: sch pins <ref>');
        const sym = s.symbols.find(z => z.ref === ref);
        if (!sym) return fail('未找到符号 ' + ref);
        const pins = Model.Sheet.symbolPins(s, symLib()).filter(p => p.ref === ref)
          .map(p => ({ num: p.num, name: p.name, x: p.x, y: p.y }));
        return ok({ ref, x: sym.x, y: sym.y, rot: sym.rot || 0, mirror: !!sym.mirror, pins });
      }
      if (sub === 'nets') {
        return ok({ pinNets: Model.Sheet.resolveNets(s, symLib()) });
      }
      if (sub === 'sync') {
        Doc.snapshot();
        const r = syncFromSchematic();
        this._ui();
        return ok(r);
      }
      return fail('用法: sch sym|wire|label|power|junction|noconnect|value|fp|del|annotate|list|pins|nets|sync');
    },

    _state() {
      const b = Doc.board();
      const s = Doc.sheet();
      return ok({
        project: Doc.project.name,
        modified: Doc.modified,
        filePath: Doc.filePath,
        board: Model.Board.stats(b, fpLib()),
        schematic: { symbols: s.symbols.length, wires: s.wires.length, labels: s.labels.length },
        sheets: Doc.project.schematics.length,
        boards: Doc.project.boards.length,
        layers: Model.Board.copperLayerIds(b),
        designRules: b.designRules,
        stackup: b.stackup,
        outline: b.outline
      });
    }
  };

  const HELP_TEXT = [
    'CIBYP-PCB-EDA 命令一览:',
    'new <名称> [宽] [高] [层数] — 新建工程',
    'board size <w> <h> | board outline x,y ... | board name <名>',
    'rules list | rules set <key> <value> — 设计规则',
    'stackup layers <n> | stackup thickness <mm> — 层叠',
    'comp add <封装> <位号> <x> <y> [rot] [F|B] [k=v ...] — 放元件（返回 pad 全局坐标）',
    'comp move|rot|side|value|del|list|pads|net — 元件操作（list/pads 返回 pad 坐标）',
    'net list | net rename <旧> <新>',
    'trace <网络> <层> <线宽> x1,y1 x2,y2 ... — 布线',
    'via <网络> <x> <y> [钻孔] [外径] — 过孔',
    'zone <网络> <层> x1,y1 ... [--clearance n] [--thermal n] — 铺铜',
    'silk line|rect|circle|text — 丝印',
    'sch sym <符号> <x> <y> [rot] [--ref] [--value] [--fp] — 放符号（返回 pin 全局坐标）',
    'sch wire|label|power|junction|noconnect|value|fp|del|annotate|list|pins|nets|sync',
    'drc / erc / autoroute [net1,net2] / clear routes [net]',
    'mode sch|pcb|3d / fit / undo / redo / state / help'
  ].join('\n');

  // ---------------------------------------------------------------------------
  // window.pcb* bridge (called by main process via executeJavaScript)
  // ---------------------------------------------------------------------------
  function ensureReady() { return typeof global.PCBEditor !== 'undefined'; }

  global.pcbExecuteCommand = function (cmd) {
    const r = Executor.execute(cmd);
    return r;
  };
  global.pcbExecuteCommands = function (cmds) {
    const results = [];
    for (const c of (Array.isArray(cmds) ? cmds : [])) {
      results.push(Executor.execute(c));
    }
    return { ok: true, results };
  };
  global.pcbGetState = function () { return Executor._state(); };
  global.pcbGetProjectJSON = function () { return { ok: true, data: Doc.toSingleFileJSON() }; };
  global.pcbGetMultiFiles = function (baseName) { return { ok: true, data: Doc.toMultiFiles(baseName) }; };
  global.pcbLoadProjectJSON = function (data) {
    const r = Doc.loadJSON(data);
    if (r.ok && Editor()) { Editor().selection.clear(); Editor().refresh(); Editor().panel(); }
    return r;
  };
  global.pcbLoadMultiFiles = function (manifest, fileContents) {
    const r = Doc.loadMultiFiles(manifest, fileContents || {});
    if (r.ok && Editor()) { Editor().selection.clear(); Editor().refresh(); Editor().panel(); }
    return r;
  };
  global.pcbGetGerberFiles = function (baseName, options) {
    try {
      const files = global.PCBGerber.exportAll(Doc.board(), fpLib(), baseName || Doc.project.name || 'pcb', options || {});
      return { ok: true, files };
    } catch (e) { return fail(e.message); }
  };
  global.pcbGetSVGString = function (target) {
    try {
      if (target === 'sch') return { ok: true, svg: global.PCBSchRender.exportSVG(Doc.sheet(), symLib()) };
      return { ok: true, svg: global.PCBRender.exportSVG(Doc.board(), fpLib()) };
    } catch (e) { return fail(e.message); }
  };
  global.pcbGetPNGDataUrl = function (target, width) {
    try {
      if (target === '3d') {
        global.PCB3D.setBoard(Doc.board(), fpLib());
        return { ok: true, dataUrl: global.PCB3D.exportPNG(width || 1600) };
      }
      if (target === 'sch') {
        // render sch svg into canvas via image? simpler: rasterize current sch canvas
        const R = global.PCBSchRender;
        return { ok: true, dataUrl: R.canvas ? R.canvas.toDataURL('image/png') : '' };
      }
      return { ok: true, dataUrl: global.PCBRender.exportPNG(Doc.board(), fpLib(), width || 1920) };
    } catch (e) { return fail(e.message); }
  };
  global.pcbGet3DOBJ = function (name) {
    try {
      return { ok: true, data: global.PCB3D.exportOBJ(Doc.board(), fpLib(), name || 'pcb') };
    } catch (e) { return fail(e.message); }
  };
  global.pcbGetAuxExport = function (kind) {
    try {
      const G = global.PCBGerber;
      if (kind === 'pnp') return { ok: true, content: G.emitPnP(Doc.board()) };
      if (kind === 'bom') return { ok: true, content: G.emitBOM(Doc.board()) };
      return fail('未知辅助导出类型: ' + kind);
    } catch (e) { return fail(e.message); }
  };
  global.pcbGetKicadPcb = function () {
    try {
      return { ok: true, content: global.PCBIO.exportKicadPcb(Doc.board(), fpLib()) };
    } catch (e) { return fail(e.message); }
  };
  global.pcbGetNetlist = function (format) {
    try {
      if (format === 'kicad') return { ok: true, content: global.PCBIO.exportKiCadNetlist(Doc.board()) };
      const pads = Model.Board.allPads(Doc.board(), fpLib());
      const lines = ['Ref,Pad,Net'];
      for (const p of pads) lines.push(p.ref + ',' + p.num + ',' + (p.net || ''));
      return { ok: true, content: lines.join('\n') + '\n' };
    } catch (e) { return fail(e.message); }
  };
  global.pcbImportData = function (fileName, content) {
    try {
      const r = global.PCBIO.detectAndImport(fileName, content, fpLib());
      if (!r.ok) return r;
      if (r.type === 'kicad_pcb') {
        Doc.project.boards[Doc.project.activeBoard] = r.board;
        Doc.touch();
        if (Editor()) { Editor().selection.clear(); Editor().refresh(); Editor().panel(); }
        return ok({ type: r.type, components: r.board.components.length, traces: r.board.traces.length });
      }
      if (r.type === 'kicad_netlist' || r.type === 'csv_netlist') {
        Doc.snapshot();
        const ar = global.PCBIO.applyNetlist(Doc.board(), r.netlist, fpLib());
        Doc.touch(); this._ui && this._ui();
        if (Editor()) { Editor().refresh(); Editor().panel(); }
        return ok(Object.assign({ type: r.type }, ar));
      }
      if (r.type === 'json') {
        return global.pcbLoadProjectJSON(r.data);
      }
      return fail('未支持的导入类型: ' + r.type);
    } catch (e) { return fail(e.message); }
  };
  global.pcbListFootprints = function () { return ok({ footprints: fpLib().list() }); };
  global.pcbListSymbols = function () { return ok({ symbols: symLib().list() }); };
  global.pcbSyncSchematic = function () {
    Doc.snapshot();
    const r = syncFromSchematic();
    if (Editor()) { Editor().refresh(); Editor().panel(); }
    return ok(r);
  };
  global.pcbSetModified = function (m) { Doc.modified = !!m; return ok({}); };

  global.PCBCommands = { Executor, syncFromSchematic, HELP_TEXT };
})(typeof window !== 'undefined' ? window : globalThis);
