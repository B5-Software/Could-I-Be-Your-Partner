// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - external EDA format I/O: KiCad netlist / kicad_pcb / CSV netlist
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');

  // ---------------------------------------------------------------------------
  // generic S-expression parser -> nested arrays (atoms as strings)
  // ---------------------------------------------------------------------------
  function parseSExpr(text) {
    const tokens = [];
    let i = 0, n = text.length;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === ';' && text[i - 1] !== '\\') { while (i < n && text[i] !== '\n') i++; continue; }
      if (c === '(' || c === ')') { tokens.push(c); i++; continue; }
      if (c === '"') {
        let s = '';
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n) { s += text[i + 1]; i += 2; }
          else { s += text[i]; i++; }
        }
        i++;
        tokens.push('"' + s);
        continue;
      }
      let s = '';
      while (i < n && !/[\s()]/.test(text[i])) { s += text[i]; i++; }
      tokens.push(s);
    }
    let pos = 0;
    function parseOne() {
      const t = tokens[pos++];
      if (t === '(') {
        const arr = [];
        while (pos < tokens.length && tokens[pos] !== ')') arr.push(parseOne());
        pos++; // consume ')'
        return arr;
      }
      return t;
    }
    return parseOne();
  }

  function sxGet(node, key) {
    if (!Array.isArray(node)) return null;
    for (const ch of node) {
      if (Array.isArray(ch) && ch[0] === key) return ch;
    }
    return null;
  }
  function sxAll(node, key) {
    const out = [];
    if (!Array.isArray(node)) return out;
    for (const ch of node) {
      if (Array.isArray(ch) && ch[0] === key) out.push(ch);
    }
    return out;
  }
  function sxStr(v) {
    if (typeof v === 'string' && v.startsWith('"')) return v.slice(1);
    return v;
  }
  function sxNum(v) { return Number(sxStr(v)) || 0; }

  // ---------------------------------------------------------------------------
  // KiCad netlist (.net) import -> {components:[{ref,value,footprint}], nets:[{name,pads:['R1.1']}]}
  // ---------------------------------------------------------------------------
  function importKiCadNetlist(text) {
    const root = parseSExpr(text);
    const out = { components: [], nets: [] };
    const comps = sxGet(root, 'components');
    if (comps) {
      for (const c of sxAll(comps, 'comp')) {
        const ref = sxStr((sxGet(c, 'ref') || [])[1] || '');
        const value = sxStr((sxGet(c, 'value') || [])[1] || '');
        const fp = sxStr((sxGet(c, 'footprint') || [])[1] || '');
        if (ref) out.components.push({ ref, value, footprint: fp.split(':').pop() });
      }
    }
    const nets = sxGet(root, 'nets');
    if (nets) {
      for (const net of sxAll(nets, 'net')) {
        const name = sxStr((sxGet(net, 'name') || [])[1] || '');
        const pads = [];
        for (const node of sxAll(net, 'node')) {
          const ref = sxStr((sxGet(node, 'ref') || [])[1] || '');
          const pin = sxStr((sxGet(node, 'pin') || [])[1] || '');
          if (ref && pin) pads.push(ref + '.' + pin);
        }
        if (name) out.nets.push({ name, pads });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // CSV netlist: "ref,pad,net" per line (header tolerated)
  // ---------------------------------------------------------------------------
  function importCSVNetlist(text) {
    const nets = new Map();
    const refs = new Set();
    const lines = text.split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const parts = line.split(/[,\t;]/).map(s => s.trim().replace(/^"|"$/g, ''));
      if (parts.length < 3) continue;
      if (/^(ref|designator|位号)/i.test(parts[0])) continue; // header
      const [ref, pad, net] = parts;
      if (!ref || !pad || !net) continue;
      refs.add(ref);
      if (!nets.has(net)) nets.set(net, []);
      nets.get(net).push(ref + '.' + pad);
    }
    return {
      components: Array.from(refs).map(r => ({ ref: r, value: '', footprint: '' })),
      nets: Array.from(nets, ([name, pads]) => ({ name, pads }))
    };
  }

  // apply netlist data to board: create missing components (auto-cascade), assign pad nets
  function applyNetlist(board, data, fpLib) {
    let created = 0, updated = 0;
    let cascadeX = 10, cascadeY = 10;
    const bb = Model.Board.boardBBox(board, fpLib);
    for (const c of data.components) {
      let comp = board.components.find(x => x.ref === c.ref);
      const fpName = fpLib.has(c.footprint) ? c.footprint : guessFootprint(c.footprint, fpLib);
      if (!comp) {
        comp = Model.Board.addComponent(board, {
          ref: c.ref, value: c.value || '',
          footprint: fpName || 'R_0805', params: {},
          x: cascadeX, y: cascadeY
        });
        cascadeX += 10;
        if (cascadeX > bb.maxX - 5) { cascadeX = 10; cascadeY += 10; }
        created++;
      } else {
        if (c.value) comp.value = c.value;
        if (fpName && comp.footprint !== fpName) { comp.footprint = fpName; comp.params = {}; }
        updated++;
      }
    }
    // clear old pad nets then assign
    for (const comp of board.components) comp.padNets = {};
    for (const net of data.nets) {
      for (const padRef of net.pads) {
        const m = /^(.+)\.(\w+)$/.exec(padRef);
        if (!m) continue;
        Model.Board.setPadNet(board, m[1], m[2], net.name);
      }
    }
    return { created, updated, nets: data.nets.length };
  }

  // heuristic footprint name mapping (KiCad/EasyEDA names -> our lib)
  function guessFootprint(name, fpLib) {
    if (!name) return null;
    if (fpLib.has(name)) return name;
    const n = name.toUpperCase().replace(/[_\-\s]/g, '');
    const tries = [
      [/R.*(0201|0402|0603|0805|1206|2512)/, m => 'R_' + m[1]],
      [/^C.*(0402|0603|0805|1206)/, m => 'C_' + m[1]],
      [/LED.*(0603|0805)/, m => 'LED_' + m[1]],
      [/(^|)LED.*3MM/, () => 'LED-3mm'],
      [/LED.*5MM/, () => 'LED-5mm'],
      [/SOT23[^6]?6|TSOT6|SOT26/, () => 'SOT23-6'],
      [/SOT23.?5|TSOT5|SOT25/, () => 'SOT23-5'],
      [/SOT23|SOT323/, () => 'SOT23-3'],
      [/SOT223/, () => 'SOT223'],
      [/SOIC8|SOP8|SO8/, () => 'SOIC-8'],
      [/SOIC14|SOP14/, () => 'SOIC-14'],
      [/SOIC16|SOP16/, () => 'SOIC-16'],
      [/TSSOP8/, () => 'TSSOP-8'],
      [/TSSOP16/, () => 'TSSOP-16'],
      [/TSSOP20/, () => 'TSSOP-20'],
      [/QFP32/, () => 'QFP-32'],
      [/QFP44/, () => 'QFP-44'],
      [/QFP48|LQFP48/, () => 'QFP-48'],
      [/QFP64|LQFP64/, () => 'QFP-64'],
      [/QFP100|LQFP100/, () => 'QFP-100'],
      [/QFN16/, () => 'QFN-16'],
      [/QFN32/, () => 'QFN-32'],
      [/QFN48/, () => 'QFN-48'],
      [/DIP8(?!W)|PDIP8/, () => 'DIP-8'],
      [/DIP14/, () => 'DIP-14'],
      [/DIP16/, () => 'DIP-16'],
      [/DIP20/, () => 'DIP-20'],
      [/DIP28/, () => 'DIP-28'],
      [/DIP40/, () => 'DIP-40'],
      [/SOD123/, () => 'D_SOD123'],
      [/HC49/, () => 'XTAL-HC49'],
      [/3225|X32/, () => 'XTAL-3225'],
      [/USBC|TYPEC/, () => 'USB-C-16'],
      [/PINHDR?1X(\d+)/, m => 'HDR-1x' + m[1]],
      [/HDR1X(\d+)/, m => 'HDR-1x' + m[1]],
      [/TERMINAL.*2/, () => 'TBLOCK-2'],
      [/TERMINAL.*3/, () => 'TBLOCK-3'],
      [/CR2032/, () => 'BAT-CR2032'],
      [/3296/, () => 'POT-3296'],
      [/BUTTON|SWITCH6X6|TACT/, () => 'BUTTON-6x6'],
      [/BUZZER/, () => 'BUZZER-12']
    ];
    for (const [re, fn] of tries) {
      const m = re.exec(n);
      if (m) {
        const name2 = fn(m);
        if (fpLib.has(name2)) return name2;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // KiCad netlist export
  // ---------------------------------------------------------------------------
  function exportKiCadNetlist(board) {
    const fp = (typeof PCBFootprints !== 'undefined') ? PCBFootprints : require('./pcb-footprints.js');
    const pads = Model.Board.allPads(board, fp);
    const netMap = new Map();
    for (const p of pads) {
      if (!p.net) continue;
      if (!netMap.has(p.net)) netMap.set(p.net, []);
      netMap.get(p.net).push(p);
    }
    const L = [];
    L.push('(export (version "E")');
    L.push('  (design (source "CIBYP-PCB-EDA") (date "' + new Date().toISOString() + '"))');
    L.push('  (components');
    for (const c of board.components) {
      L.push('    (comp (ref "' + c.ref + '") (value "' + (c.value || '') + '") (footprint "CIBYP:' + c.footprint + '"))');
    }
    L.push('  )');
    L.push('  (nets');
    let code = 1;
    for (const [name, ps] of netMap) {
      L.push('    (net (code "' + (code++) + '") (name "' + name + '")');
      for (const p of ps) L.push('      (node (ref "' + p.ref + '") (pin "' + p.num + '"))');
      L.push('    )');
    }
    L.push('  )');
    L.push(')');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // .kicad_pcb export (version 20221018 subset)
  // ---------------------------------------------------------------------------
  function exportKicadPcb(board, fpLib) {
    const pads = Model.Board.allPads(board, fpLib);
    const netNames = [''].concat(Model.Board.netNames(board, fpLib));
    const netCode = new Map(netNames.map((n, i) => [n, i]));
    const L = [];
    L.push('(kicad_pcb (version 20221018) (generator "cibyp_pcb_eda")');
    L.push('  (general (thickness ' + (board.stackup.boardThickness || 1.6) + '))');
    L.push('  (paper "A4")');
    const layerDefs = [];
    const cuLayers = board.stackup.layers.filter(l => l.type === 'copper');
    for (const l of cuLayers) {
      const num = l.id === 'F.Cu' ? 0 : (l.id === 'B.Cu' ? 31 : 1 + parseInt(l.id.replace(/\D/g, ''), 10) - 1);
      layerDefs.push('(' + num + " \"" + l.id + "\" signal)");
    }
    layerDefs.push('(36 "B.SilkS" user)', '(37 "F.SilkS" user)', '(44 "Edge.Cuts" user)');
    L.push('  (layers ' + layerDefs.join(' ') + ')');
    L.push('  (setup (pad_to_mask_clearance 0))');
    for (const [name, code] of netCode) L.push('  (net ' + code + ' "' + name + '")');
    // footprints
    for (const comp of board.components) {
      const fp = fpLib.generate(comp.footprint, comp.params || {});
      if (!fp) continue;
      L.push('  (footprint "CIBYP:' + comp.footprint + '" (layer "' + (comp.side === 'B' ? 'B.Cu' : 'F.Cu') + '")');
      L.push('    (at ' + comp.x.toFixed(4) + ' ' + comp.y.toFixed(4) + ' ' + (comp.rot || 0) + ')');
      L.push('    (fp_text reference "' + comp.ref + '" (at 0 -2 0 unlocked) (layer "' + (comp.side === 'B' ? 'B.SilkS' : 'F.SilkS') + '") (effects (font (size 1 1) (thickness 0.15))))');
      L.push('    (fp_text value "' + (comp.value || '') + '" (at 0 2 0 unlocked) (layer "' + (comp.side === 'B' ? 'B.SilkS' : 'F.SilkS') + '") (effects (font (size 1 1) (thickness 0.15))))');
      for (const pad of fp.pads) {
        const type = pad.drill ? 'thru_hole' : 'smd';
        const shape = pad.shape === 'circle' ? 'circle' : (pad.shape === 'oval' ? 'oval' : 'rect');
        const layers = pad.drill ? '(layers "*.Cu" "*.Mask")' :
          (comp.side === 'B' ? '(layers "B.Cu" "B.Mask" "B.Paste")' : '(layers "F.Cu" "F.Mask" "F.Paste")');
        const net = (comp.padNets && comp.padNets[String(pad.num)]) || '';
        L.push('    (pad "' + pad.num + '" ' + type + ' ' + shape +
          ' (at ' + pad.x.toFixed(4) + ' ' + pad.y.toFixed(4) + (pad.rot ? ' ' + pad.rot : '') + ')' +
          ' (size ' + pad.w.toFixed(3) + ' ' + pad.h.toFixed(3) + ')' +
          (pad.drill ? ' (drill ' + pad.drill.toFixed(3) + ')' : '') +
          ' ' + layers +
          (net ? ' (net ' + netCode.get(net) + ' "' + net + '")' : '') + ')');
      }
      L.push('  )');
    }
    // traces
    for (const t of board.traces) {
      const code = netCode.get(t.net || '') || 0;
      for (let i = 0; i < t.pts.length - 1; i++) {
        L.push('  (segment (start ' + t.pts[i].x.toFixed(4) + ' ' + t.pts[i].y.toFixed(4) + ') (end ' + t.pts[i + 1].x.toFixed(4) + ' ' + t.pts[i + 1].y.toFixed(4) + ') (width ' + t.width.toFixed(3) + ') (layer "' + t.layer + '") (net ' + code + '))');
      }
    }
    // vias
    for (const v of board.vias) {
      const code = netCode.get(v.net || '') || 0;
      L.push('  (via (at ' + v.x.toFixed(4) + ' ' + v.y.toFixed(4) + ') (size ' + v.diameter.toFixed(3) + ') (drill ' + v.drill.toFixed(3) + ') (layers "F.Cu" "B.Cu") (net ' + code + '))');
    }
    // zones
    for (const z of board.zones) {
      if (z.pts.length < 3) continue;
      const code = netCode.get(z.net || '') || 0;
      L.push('  (zone (net ' + code + ') (net_name "' + (z.net || '') + '") (layer "' + z.layer + '") (hatch edge 0.5)');
      L.push('    (connect_pads (clearance ' + (z.clearance || 0.3) + '))');
      L.push('    (min_thickness 0.2) (filled_areas_thickness no)');
      L.push('    (polygon (pts ' + z.pts.map(p => '(xy ' + p.x.toFixed(4) + ' ' + p.y.toFixed(4) + ')').join(' ') + '))');
      L.push('  )');
    }
    // outline
    const pts = board.outline.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (i === pts.length - 1 && board.outline.closed === false) break;
      L.push('  (gr_line (start ' + a.x.toFixed(4) + ' ' + a.y.toFixed(4) + ') (end ' + b.x.toFixed(4) + ' ' + b.y.toFixed(4) + ') (layer "Edge.Cuts") (width 0.05))');
    }
    L.push(')');
    return L.join('\n') + '\n';
  }

  // ---------------------------------------------------------------------------
  // .kicad_pcb import (subset: footprints/segments/vias/zones/edge cuts)
  // ---------------------------------------------------------------------------
  function importKicadPcb(text, fpLib, boardName) {
    const root = parseSExpr(text);
    if (!Array.isArray(root) || root[0] !== 'kicad_pcb') return { ok: false, error: '不是有效的 kicad_pcb 文件' };
    const board = Model.newBoard(boardName || 'KiCad导入', 100, 80, 2);
    board.components = []; board.traces = []; board.vias = []; board.zones = []; board.outline.pts = [];

    // nets
    const netNames = new Map();
    for (const n of sxAll(root, 'net')) {
      netNames.set(String(sxNum(n[1])), sxStr(n[2] || ''));
    }
    // layers
    let cuCount = 0;
    const layersNode = sxGet(root, 'layers');
    if (layersNode) {
      for (const ln of layersNode.slice(1)) {
        if (Array.isArray(ln) && /Cu$/.test(sxStr(ln[1] || ''))) cuCount++;
      }
    }
    if (cuCount > 2) board.stackup = Model.defaultStackup(Math.min(16, cuCount));

    // edge cuts
    for (const gl of sxAll(root, 'gr_line')) {
      const layer = sxStr((sxGet(gl, 'layer') || [])[1] || '');
      if (!/Edge/.test(layer)) continue;
      const s = sxGet(gl, 'start'), e = sxGet(gl, 'end');
      if (!s || !e) continue;
      const a = { x: sxNum(s[1]), y: sxNum(s[2]) };
      const b = { x: sxNum(e[1]), y: sxNum(e[2]) };
      const pts = board.outline.pts;
      if (!pts.length) pts.push(a, b);
      else {
        const last = pts[pts.length - 1];
        if (Geo.dist(last.x, last.y, a.x, a.y) < 0.01) pts.push(b);
        else pts.push(a, b);
      }
    }
    if (board.outline.pts.length < 3) {
      board.outline.pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
    }

    // footprints
    for (const fpNode of sxAll(root, 'footprint')) {
      const fpNameRaw = sxStr(fpNode[1] || 'UNKNOWN').split(':').pop();
      const at = sxGet(fpNode, 'at') || [0, 0, 0];
      const layer = sxStr((sxGet(fpNode, 'layer') || [])[1] || 'F.Cu');
      let ref = 'U?';
      for (const ft of sxAll(fpNode, 'fp_text')) {
        if (sxStr(ft[1] || '') === 'reference') ref = sxStr(ft[2] || 'U?');
      }
      // try our lib, else dynamic-register parsed pads
      let ourName = fpLib.has(fpNameRaw) ? fpNameRaw : guessFootprint(fpNameRaw, fpLib);
      const padNets = {};
      if (!ourName) {
        const dynName = 'KI_' + fpNameRaw.replace(/[^\w]/g, '_');
        if (!fpLib.has(dynName)) {
          const parsedPads = [];
          for (const pd of sxAll(fpNode, 'pad')) {
            const num = sxStr(pd[1] || '?');
            const type = sxStr(pd[2] || 'smd');
            const shape = sxStr(pd[3] || 'rect');
            const pat = sxGet(pd, 'at') || [0, 0, 0];
            const psize = sxGet(pd, 'size') || [0, 1, 1];
            const pdrill = sxGet(pd, 'drill');
            parsedPads.push({
              num, x: sxNum(pat[1]), y: sxNum(pat[2]),
              w: sxNum(psize[1]) || 1, h: sxNum(psize[2]) || sxNum(psize[1]) || 1,
              shape: shape === 'circle' ? 'circle' : (shape === 'oval' ? 'oval' : 'rect'),
              drill: pdrill ? sxNum(pdrill[1]) : 0,
              rot: sxNum(pat[3])
            });
          }
          if (parsedPads.length) {
            const bb = Geo.ptsBBox(parsedPads);
            fpLib.register(dynName, 'KiCad导入封装 ' + fpNameRaw, () => ({
              name: dynName, pads: parsedPads,
              silk: [], refPos: { x: 0, y: bb.minY - 1 },
              courtyard: { x: bb.minX - 0.3, y: bb.minY - 0.3, w: bb.maxX - bb.minX + 0.6, h: bb.maxY - bb.minY + 0.6 },
              three: { w: bb.maxX - bb.minX, l: bb.maxY - bb.minY, h: 1.5, color: '#404858' }
            }), []);
          }
        }
        if (fpLib.has(dynName)) ourName = dynName;
      }
      if (!ourName) ourName = 'R_0805';
      const comp = Model.Board.addComponent(board, {
        ref, footprint: ourName, params: {},
        x: sxNum(at[1]), y: sxNum(at[2]), rot: sxNum(at[3]),
        side: layer.startsWith('B') ? 'B' : 'F'
      });
      for (const pd of sxAll(fpNode, 'pad')) {
        const num = sxStr(pd[1] || '?');
        const netNode = sxGet(pd, 'net');
        if (netNode) {
          const nm = netNames.get(String(sxNum(netNode[1]))) || sxStr(netNode[2] || '');
          if (nm) padNets[num] = nm;
        }
      }
      comp.padNets = padNets;
    }
    // segments
    for (const sg of sxAll(root, 'segment')) {
      const s = sxGet(sg, 'start'), e = sxGet(sg, 'end');
      const w = sxGet(sg, 'width'), ly = sxGet(sg, 'layer'), nt = sxGet(sg, 'net');
      if (!s || !e) continue;
      Model.Board.addTrace(board, {
        net: nt ? (netNames.get(String(sxNum(nt[1]))) || '') : '',
        layer: ly ? sxStr(ly[1]) : 'F.Cu',
        width: w ? sxNum(w[1]) : 0.25,
        pts: [{ x: sxNum(s[1]), y: sxNum(s[2]) }, { x: sxNum(e[1]), y: sxNum(e[2]) }]
      });
    }
    // vias
    for (const vn of sxAll(root, 'via')) {
      const at = sxGet(vn, 'at'), size = sxGet(vn, 'size'), drill = sxGet(vn, 'drill'), nt = sxGet(vn, 'net');
      if (!at) continue;
      Model.Board.addVia(board, {
        net: nt ? (netNames.get(String(sxNum(nt[1]))) || '') : '',
        x: sxNum(at[1]), y: sxNum(at[2]),
        diameter: size ? sxNum(size[1]) : 0.6,
        drill: drill ? sxNum(drill[1]) : 0.3
      });
    }
    // zones
    for (const zn of sxAll(root, 'zone')) {
      const nt = sxGet(zn, 'net'), nn = sxGet(zn, 'net_name'), ly = sxGet(zn, 'layer');
      const polyNode = sxGet(zn, 'polygon');
      let pts = [];
      if (polyNode) {
        const ptsNode = sxGet(polyNode, 'pts');
        if (ptsNode) pts = sxAll(ptsNode, 'xy').map(p => ({ x: sxNum(p[1]), y: sxNum(p[2]) }));
      }
      if (pts.length >= 3) {
        Model.Board.addZone(board, {
          net: nn ? sxStr(nn[1]) : (nt ? (netNames.get(String(sxNum(nt[1]))) || '') : ''),
          layer: ly ? sxStr(ly[1]) : 'F.Cu',
          pts
        });
      }
    }
    return { ok: true, board };
  }

  // ---------------------------------------------------------------------------
  // auto-detect & import
  // ---------------------------------------------------------------------------
  function detectAndImport(fileName, content, fpLib) {
    const fn = (fileName || '').toLowerCase();
    if (fn.endsWith('.kicad_pcb') || /^\s*\(kicad_pcb/.test(content)) {
      const r = importKicadPcb(content, fpLib);
      if (r.ok) return { ok: true, type: 'kicad_pcb', board: r.board };
      return r;
    }
    if (fn.endsWith('.net') || fn.endsWith('.kicad_net') || /^\s*\(export/.test(content)) {
      return { ok: true, type: 'kicad_netlist', netlist: importKiCadNetlist(content) };
    }
    if (fn.endsWith('.csv') || fn.endsWith('.txt')) {
      return { ok: true, type: 'csv_netlist', netlist: importCSVNetlist(content) };
    }
    if (fn.endsWith('.cipypcb') || fn.endsWith('.cipysch') || fn.endsWith('.json') || fn.endsWith('.cibypcbproj')) {
      try {
        const data = JSON.parse(content);
        return { ok: true, type: 'json', data };
      } catch (e) {
        return { ok: false, error: 'JSON 解析失败: ' + e.message };
      }
    }
    return { ok: false, error: '无法识别的文件格式: ' + fileName };
  }

  const PCBIO = {
    parseSExpr, importKiCadNetlist, importCSVNetlist, applyNetlist,
    exportKiCadNetlist, exportKicadPcb, importKicadPcb,
    guessFootprint, detectAndImport
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PCBIO;
  else global.PCBIO = PCBIO;
})(typeof window !== 'undefined' ? window : globalThis);
