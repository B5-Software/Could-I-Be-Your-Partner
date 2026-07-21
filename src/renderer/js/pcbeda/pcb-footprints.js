// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - parametric footprint library (local coords, mm, Y-down)
// generate(name, params) -> { name, pads:[{num,x,y,w,h,shape,drill,rot}], silk:[...],
//                             refPos:{x,y}, courtyard:{x,y,w,h}, three:{w,l,h,color} }
(function (global) {
  'use strict';

  function line(x1, y1, x2, y2) { return { kind: 'line', pts: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }; }
  function rect(x, y, w, h) { return { kind: 'rect', x, y, w, h }; }
  function circle(x, y, r) { return { kind: 'circle', x, y, r }; }

  // ---- 2-terminal chip (R/C/L/LED/D) ----
  const CHIP_DIMS = {
    '0201': { padW: 0.40, padH: 0.45, gap: 0.35, bw: 0.60, bl: 0.30, bh: 0.25 },
    '0402': { padW: 0.60, padH: 0.70, gap: 0.40, bw: 1.00, bl: 0.50, bh: 0.35 },
    '0603': { padW: 0.80, padH: 0.90, gap: 0.70, bw: 1.60, bl: 0.80, bh: 0.45 },
    '0805': { padW: 1.00, padH: 1.30, gap: 0.90, bw: 2.00, bl: 1.25, bh: 0.55 },
    '1206': { padW: 1.20, padH: 1.80, gap: 1.30, bw: 3.20, bl: 1.60, bh: 0.60 },
    '1210': { padW: 1.20, padH: 2.70, gap: 1.30, bw: 3.20, bl: 2.50, bh: 0.60 },
    '1812': { padW: 1.40, padH: 3.40, gap: 1.90, bw: 4.50, bl: 3.20, bh: 0.65 },
    '2010': { padW: 1.40, padH: 2.70, gap: 2.60, bw: 5.00, bl: 2.50, bh: 0.65 },
    '2512': { padW: 1.60, padH: 3.40, gap: 3.30, bw: 6.30, bl: 3.20, bh: 0.65 }
  };
  function chip(p) {
    const d = CHIP_DIMS[p.size] || CHIP_DIMS['0805'];
    const padW = p.padW || d.padW, padH = p.padH || d.padH, gap = p.gap !== undefined ? p.gap : d.gap;
    const off = gap / 2 + padW / 2;
    const color = p.color || '#30343c';
    return {
      name: p.name, pads: [
        { num: '1', x: -off, y: 0, w: padW, h: padH, shape: 'rect' },
        { num: '2', x: off, y: 0, w: padW, h: padH, shape: 'rect' }
      ],
      silk: [line(-gap / 2 - 0.2, -d.bl / 2 - 0.15, gap / 2 + 0.2, -d.bl / 2 - 0.15),
             line(-gap / 2 - 0.2, d.bl / 2 + 0.15, gap / 2 + 0.2, d.bl / 2 + 0.15)],
      refPos: { x: 0, y: -d.bl / 2 - 0.9 },
      courtyard: { x: -(gap / 2 + padW + 0.3), y: -(padH / 2 + 0.3), w: gap + 2 * padW + 0.6, h: padH + 0.6 },
      three: { w: d.bw, l: d.bl, h: d.bh, color }
    };
  }

  // ---- SOT-23 family ----
  function sot23(p) {
    const pins = p.pins || 3;
    const pads = [];
    if (pins === 3) {
      pads.push({ num: '1', x: -1.05, y: -0.95, w: 0.9, h: 0.95, shape: 'rect' });
      pads.push({ num: '2', x: -1.05, y: 0.95, w: 0.9, h: 0.95, shape: 'rect' });
      pads.push({ num: '3', x: 1.05, y: 0, w: 0.9, h: 0.95, shape: 'rect' });
    } else { // SOT23-5/6: pitch 0.95
      const n = pins / 2; // per side (5 => left 3 right 2 handled below)
      const pitch = 0.95;
      if (pins === 5) {
        for (let i = 0; i < 3; i++) pads.push({ num: String(i + 1), x: -1.35, y: -pitch + i * pitch, w: 0.6, h: 0.95, shape: 'rect' });
        pads.push({ num: '4', x: 1.35, y: 0.475, w: 0.6, h: 0.95, shape: 'rect' });
        pads.push({ num: '5', x: 1.35, y: -0.475, w: 0.6, h: 0.95, shape: 'rect' });
      } else { // 6
        for (let i = 0; i < 3; i++) pads.push({ num: String(i + 1), x: -1.35, y: -pitch + i * pitch, w: 0.6, h: 0.95, shape: 'rect' });
        for (let i = 0; i < 3; i++) pads.push({ num: String(pins - i), x: 1.35, y: -pitch + i * pitch, w: 0.6, h: 0.95, shape: 'rect' });
      }
    }
    return {
      name: p.name, pads,
      silk: [rect(-1.6, -1.55, 3.2, 3.1), circle(-1.9, -1.2, 0.25)],
      refPos: { x: 0, y: -2.3 },
      courtyard: { x: -2.1, y: -2.1, w: 4.2, h: 4.2 },
      three: { w: 2.9, l: 1.6, h: 1.0, color: '#1c1f26' }
    };
  }

  function sot223(p) {
    const pads = [];
    for (let i = 0; i < 3; i++) pads.push({ num: String(i + 1), x: -3.1, y: -2.3 + i * 2.3, w: 1.5, h: 2.0, shape: 'rect' });
    pads.push({ num: '4', x: 2.15, y: 0, w: 3.8, h: 3.6, shape: 'rect' }); // tab = pin 2 electrically
    return {
      name: p.name, pads,
      silk: [rect(-4.2, -3.4, 6.6, 6.8), circle(-4.5, -2.6, 0.3)],
      refPos: { x: 0, y: -4.2 },
      courtyard: { x: -4.8, y: -4.0, w: 9.8, h: 8.0 },
      three: { w: 6.5, l: 3.5, h: 1.6, color: '#1c1f26' }
    };
  }

  // ---- SOIC/SOP/TSSOP family (parametric) ----
  function soic(p) {
    const pins = p.pins || 8;
    const pitch = p.pitch || 1.27;
    const padW = p.padW || Math.min(0.65, pitch * 0.5);
    const padL = p.padL || 2.0;
    const rowDist = p.rowDist || 5.4; // pad-center to pad-center across body
    const half = pins / 2;
    const pads = [];
    for (let i = 0; i < half; i++) {
      pads.push({ num: String(i + 1), x: -rowDist / 2, y: -((half - 1) * pitch) / 2 + i * pitch, w: padW, h: padL, shape: 'rect' });
    }
    for (let i = 0; i < half; i++) {
      pads.push({ num: String(pins - i), x: rowDist / 2, y: -((half - 1) * pitch) / 2 + i * pitch, w: padW, h: padL, shape: 'rect' });
    }
    const bodyW = rowDist - padL + 0.6;
    const bodyL = (half - 1) * pitch + padW + 1.0;
    return {
      name: p.name, pads,
      silk: [rect(-bodyW / 2, -bodyL / 2, bodyW, bodyL), circle(-rowDist / 2 - 0.6, -((half - 1) * pitch) / 2, 0.3)],
      refPos: { x: 0, y: -bodyL / 2 - 0.9 },
      courtyard: { x: -rowDist / 2 - padL / 2 - 0.3, y: -bodyL / 2 - 0.3, w: rowDist + padL + 0.6, h: bodyL + 0.6 },
      three: { w: bodyL, l: bodyW, h: 1.55, color: '#1c1f26' }
    };
  }

  // ---- QFP (parametric, pins total = 4 sides) ----
  function qfp(p) {
    const pins = p.pins || 44;
    const pitch = p.pitch || 0.8;
    const perSide = pins / 4;
    const padW = p.padW || Math.min(0.5, pitch * 0.55);
    const padL = p.padL || 1.6;
    const span = (perSide - 1) * pitch;
    const bodyW = p.body || span + 2.2;
    const off = bodyW / 2 + padL / 2 + 0.3;
    const pads = [];
    let n = 1;
    // left side top->bottom (pins 1..perSide)
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: -off, y: -span / 2 + i * pitch, w: padW, h: padL, shape: 'rect', rot: 0 });
    // bottom side left->right
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: -span / 2 + i * pitch, y: off, w: padL, h: padW, shape: 'rect' });
    // right side bottom->top
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: off, y: span / 2 - i * pitch, w: padW, h: padL, shape: 'rect' });
    // top side right->left
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: span / 2 - i * pitch, y: -off, w: padL, h: padW, shape: 'rect' });
    return {
      name: p.name, pads,
      silk: [rect(-bodyW / 2, -bodyW / 2, bodyW, bodyW), circle(-bodyW / 2 - 0.8, -span / 2, 0.35)],
      refPos: { x: 0, y: -off - padL / 2 - 1.2 },
      courtyard: { x: -off - padL / 2 - 0.3, y: -off - padL / 2 - 0.3, w: 2 * off + padL + 0.6, h: 2 * off + padL + 0.6 },
      three: { w: bodyW, l: bodyW, h: 1.4, color: '#1c1f26' }
    };
  }

  // ---- QFN/DFN ----
  function qfn(p) {
    const pins = p.pins || 16;
    const pitch = p.pitch || 0.5;
    const perSide = pins / 4;
    const padW = p.padW || Math.min(0.3, pitch * 0.5);
    const padL = p.padL || 0.9;
    const span = (perSide - 1) * pitch;
    const bodyW = p.body || span + 1.1;
    const off = bodyW / 2 + padL / 2 - 0.05;
    const pads = [];
    let n = 1;
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: -off, y: -span / 2 + i * pitch, w: padW, h: padL, shape: 'rect' });
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: -span / 2 + i * pitch, y: off, w: padL, h: padW, shape: 'rect' });
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: off, y: span / 2 - i * pitch, w: padW, h: padL, shape: 'rect' });
    for (let i = 0; i < perSide; i++) pads.push({ num: String(n++), x: span / 2 - i * pitch, y: -off, w: padL, h: padW, shape: 'rect' });
    if (p.epad !== false) {
      const ep = p.epadSize || bodyW * 0.55;
      pads.push({ num: String(pins + 1), x: 0, y: 0, w: ep, h: ep, shape: 'rect' });
    }
    return {
      name: p.name, pads,
      silk: [rect(-bodyW / 2, -bodyW / 2, bodyW, bodyW), circle(-bodyW / 2 - 0.6, -span / 2, 0.3)],
      refPos: { x: 0, y: -bodyW / 2 - 1.0 },
      courtyard: { x: -bodyW / 2 - 0.4, y: -bodyW / 2 - 0.4, w: bodyW + 0.8, h: bodyW + 0.8 },
      three: { w: bodyW, l: bodyW, h: 0.85, color: '#1c1f26' }
    };
  }

  // ---- DIP (through-hole) ----
  function dip(p) {
    const pins = p.pins || 8;
    const pitch = p.pitch || 2.54;
    const rowPitch = p.rowPitch || 7.62;
    const hole = p.holeD || 0.9;
    const padD = p.padD || 1.8;
    const half = pins / 2;
    const pads = [];
    for (let i = 0; i < half; i++) {
      pads.push({ num: String(i + 1), x: -rowPitch / 2, y: -((half - 1) * pitch) / 2 + i * pitch, w: padD, h: padD, shape: i === 0 ? 'rect' : 'circle', drill: hole });
    }
    for (let i = 0; i < half; i++) {
      pads.push({ num: String(pins - i), x: rowPitch / 2, y: -((half - 1) * pitch) / 2 + i * pitch, w: padD, h: padD, shape: 'circle', drill: hole });
    }
    const bodyL = (half - 1) * pitch + 1.6;
    return {
      name: p.name, pads,
      silk: [rect(-rowPitch / 2 + 0.6, -bodyL / 2, rowPitch - 1.2, bodyL), circle(-rowPitch / 2 - 0.9, -((half - 1) * pitch) / 2, 0.4)],
      refPos: { x: 0, y: -bodyL / 2 - 1.0 },
      courtyard: { x: -rowPitch / 2 - padD / 2 - 0.3, y: -bodyL / 2 - 0.3, w: rowPitch + padD + 0.6, h: bodyL + 0.6 },
      three: { w: bodyL, l: rowPitch - 1.0, h: 3.3, color: '#1c1f26' }
    };
  }

  // ---- pin header 1xN / 2xN ----
  function header(p) {
    const pins = p.pins || 4;
    const rows = p.rows || 1;
    const pitch = p.pitch || 2.54;
    const hole = p.holeD || 1.0;
    const padD = p.padD || 1.9;
    const pads = [];
    const per = pins / rows;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < per; i++) {
        const x = rows === 1 ? 0 : (r === 0 ? -pitch / 2 : pitch / 2);
        const y = -((per - 1) * pitch) / 2 + i * pitch;
        pads.push({ num: String(r * per + i + 1), x, y, w: padD, h: padD, shape: (r === 0 && i === 0) ? 'rect' : 'circle', drill: hole });
      }
    }
    const L = (per - 1) * pitch + 2.4;
    const W = rows === 1 ? 2.4 : pitch + 2.4;
    return {
      name: p.name, pads,
      silk: [rect(-W / 2, -L / 2, W, L)],
      refPos: { x: 0, y: -L / 2 - 1.0 },
      courtyard: { x: -W / 2 - 0.3, y: -L / 2 - 0.3, w: W + 0.6, h: L + 0.6 },
      three: { w: L, l: W, h: 8.5, color: '#d4a017' }
    };
  }

  // ---- terminal block ----
  function terminalBlock(p) {
    const pins = p.pins || 2;
    const pitch = p.pitch || 5.08;
    const hole = p.holeD || 1.3;
    const padD = p.padD || 2.4;
    const pads = [];
    for (let i = 0; i < pins; i++) {
      pads.push({ num: String(i + 1), x: 0, y: -((pins - 1) * pitch) / 2 + i * pitch, w: padD, h: padD, shape: 'circle', drill: hole });
    }
    const L = (pins - 1) * pitch + 5;
    return {
      name: p.name, pads,
      silk: [rect(-3.5, -L / 2, 7, L)],
      refPos: { x: 0, y: -L / 2 - 1.2 },
      courtyard: { x: -4.0, y: -L / 2 - 0.3, w: 8.0, h: L + 0.6 },
      three: { w: L, l: 7, h: 8.0, color: '#1e7a3c' }
    };
  }

  // ---- radial electrolytic capacitor ----
  function radialCap(p) {
    const dia = p.bodyD || 5.0;
    const pitch = p.pitch || (dia <= 5 ? 2.0 : (dia <= 8 ? 3.5 : 5.0));
    const hole = p.holeD || 0.8;
    const padD = p.padD || 1.7;
    return {
      name: p.name, pads: [
        { num: '1', x: -pitch / 2, y: 0, w: padD, h: padD, shape: 'rect', drill: hole },
        { num: '2', x: pitch / 2, y: 0, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [circle(0, 0, dia / 2 + 0.3), line(-dia / 2 - 0.6, -0.5, -dia / 2 - 0.6, 0.5)],
      refPos: { x: 0, y: -dia / 2 - 1.0 },
      courtyard: { x: -dia / 2 - 0.5, y: -dia / 2 - 0.5, w: dia + 1.0, h: dia + 1.0 },
      three: { w: dia, l: dia, h: dia * 1.6, color: '#25408f' }
    };
  }

  // ---- axial (R/D through hole) ----
  function axial(p) {
    const span = p.span || 10.16; // pad spacing
    const hole = p.holeD || 0.8;
    const padD = p.padD || 1.8;
    const bodyL = p.bodyL || 6.3, bodyD = p.bodyD || 2.4;
    return {
      name: p.name, pads: [
        { num: '1', x: -span / 2, y: 0, w: padD, h: padD, shape: 'rect', drill: hole },
        { num: '2', x: span / 2, y: 0, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [line(-bodyL / 2, -bodyD / 2, bodyL / 2, -bodyD / 2), line(-bodyL / 2, bodyD / 2, bodyL / 2, bodyD / 2),
             line(-bodyL / 2, -bodyD / 2, -bodyL / 2, bodyD / 2), line(bodyL / 2, -bodyD / 2, bodyL / 2, bodyD / 2)],
      refPos: { x: 0, y: -bodyD / 2 - 0.9 },
      courtyard: { x: -span / 2 - padD / 2 - 0.3, y: -padD / 2 - 0.3, w: span + padD + 0.6, h: padD + 0.6 },
      three: { w: bodyL, l: bodyD, h: bodyD, color: p.color || '#b07a3f' }
    };
  }

  // ---- crystals ----
  function xtalHC49(p) {
    const hole = p.holeD || 0.8, padD = p.padD || 1.7, pitch = 4.88;
    return {
      name: p.name, pads: [
        { num: '1', x: -pitch / 2, y: 0, w: padD, h: padD, shape: 'rect', drill: hole },
        { num: '2', x: pitch / 2, y: 0, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [rect(-5.6, -2.2, 11.2, 4.4)],
      refPos: { x: 0, y: -3.2 },
      courtyard: { x: -6.0, y: -2.6, w: 12.0, h: 5.2 },
      three: { w: 10.8, l: 4.1, h: 3.5, color: '#c8ccd4' }
    };
  }

  function xtal3225(p) {
    const pads = [];
    const px = 1.15, py = 1.05;
    const coords = [[-px, -py], [px, -py], [px, py], [-px, py]];
    coords.forEach((c, i) => pads.push({ num: String(i + 1), x: c[0], y: c[1], w: 1.1, h: 0.9, shape: 'rect' }));
    return {
      name: p.name, pads,
      silk: [rect(-1.7, -1.35, 3.4, 2.7)],
      refPos: { x: 0, y: -2.2 },
      courtyard: { x: -2.0, y: -1.65, w: 4.0, h: 3.3 },
      three: { w: 3.2, l: 2.5, h: 0.8, color: '#c8ccd4' }
    };
  }

  // ---- LED through-hole ----
  function ledTH(p) {
    const dia = p.bodyD || 5.0;
    const pitch = 2.54, hole = p.holeD || 0.8, padD = p.padD || 1.7;
    return {
      name: p.name, pads: [
        { num: '1', x: -pitch / 2, y: 0, w: padD, h: padD, shape: 'rect', drill: hole }, // anode
        { num: '2', x: pitch / 2, y: 0, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [circle(0, 0, dia / 2 + 0.3), line(dia / 2, -1.0, dia / 2 + 0.8, -1.0)],
      refPos: { x: 0, y: -dia / 2 - 1.0 },
      courtyard: { x: -dia / 2 - 0.5, y: -dia / 2 - 0.5, w: dia + 1.2, h: dia + 1.0 },
      three: { w: dia, l: dia, h: dia + 3, color: p.color || '#e03030' }
    };
  }

  // ---- tactile button 6x6 ----
  function button6x6(p) {
    const hole = p.holeD || 0.9, padD = p.padD || 1.8;
    const px = 3.25, py = 2.25;
    return {
      name: p.name, pads: [
        { num: '1', x: -px, y: -py, w: padD, h: padD, shape: 'circle', drill: hole },
        { num: '2', x: -px, y: py, w: padD, h: padD, shape: 'circle', drill: hole },
        { num: '3', x: px, y: -py, w: padD, h: padD, shape: 'circle', drill: hole },
        { num: '4', x: px, y: py, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [rect(-3.2, -3.2, 6.4, 6.4), circle(0, 0, 1.8)],
      refPos: { x: 0, y: -4.2 },
      courtyard: { x: -4.4, y: -3.4, w: 8.8, h: 6.8 },
      three: { w: 6, l: 6, h: 4.3, color: '#333a44' }
    };
  }

  // ---- mounting hole ----
  function mountingHole(p) {
    const hole = p.holeD || 3.2;
    const padD = p.padD || (p.plated === false ? hole : hole + 1.2);
    return {
      name: p.name, pads: [{ num: '1', x: 0, y: 0, w: padD, h: padD, shape: 'circle', drill: hole, plated: p.plated !== false }],
      silk: [circle(0, 0, padD / 2 + 0.6)],
      refPos: { x: 0, y: -padD / 2 - 1.0 },
      courtyard: { x: -padD / 2 - 0.3, y: -padD / 2 - 0.3, w: padD + 0.6, h: padD + 0.6 },
      three: { w: 0, l: 0, h: 0, color: '#888888' }
    };
  }

  // ---- test pad ----
  function testPad(p) {
    const d = p.padD || 1.5;
    const hole = p.th ? (p.holeD || 0.9) : 0;
    return {
      name: p.name, pads: [{ num: '1', x: 0, y: 0, w: d, h: d, shape: p.shape || 'circle', drill: hole }],
      silk: [circle(0, 0, d / 2 + 0.5)],
      refPos: { x: 0, y: -d / 2 - 0.8 },
      courtyard: { x: -d / 2 - 0.3, y: -d / 2 - 0.3, w: d + 0.6, h: d + 0.6 },
      three: { w: 0, l: 0, h: 0, color: '#888888' }
    };
  }

  // ---- USB-C 16P (simplified mid-mount) ----
  function usbC(p) {
    const pads = [];
    for (let i = 0; i < 16; i++) {
      pads.push({ num: String(i + 1), x: -3.75 + i * 0.5, y: 2.6, w: 0.25, h: 1.2, shape: 'rect' });
    }
    // shell tabs (4 TH)
    [[-4.35, 0], [4.35, 0], [-4.35, 2.0], [4.35, 2.0]].forEach((c, i) => {
      pads.push({ num: 'S' + (i + 1), x: c[0], y: c[1], w: 1.8, h: 1.8, shape: 'circle', drill: 1.0 });
    });
    return {
      name: p.name, pads,
      silk: [rect(-4.5, -3.0, 9.0, 6.6)],
      refPos: { x: 0, y: -3.9 },
      courtyard: { x: -5.3, y: -3.4, w: 10.6, h: 7.6 },
      three: { w: 8.9, l: 6.5, h: 3.2, color: '#c8ccd4' }
    };
  }

  // ---- CR2032 holder ----
  function cr2032(p) {
    const hole = p.holeD || 0.9, padD = p.padD || 2.0;
    return {
      name: p.name, pads: [
        { num: '1', x: 0, y: -10, w: padD, h: padD, shape: 'rect', drill: hole }, // +
        { num: '2', x: 0, y: 10, w: padD, h: padD, shape: 'circle', drill: hole }  // -
      ],
      silk: [circle(0, 0, 11), line(-2, -11.6, 2, -11.6)],
      refPos: { x: 0, y: -12.4 },
      courtyard: { x: -11.4, y: -11.4, w: 22.8, h: 22.8 },
      three: { w: 20, l: 20, h: 4.0, color: '#e8b400' }
    };
  }

  // ---- buzzer ----
  function buzzer(p) {
    const hole = p.holeD || 0.9, padD = p.padD || 1.8, pitch = 7.5;
    return {
      name: p.name, pads: [
        { num: '1', x: -pitch / 2, y: 0, w: padD, h: padD, shape: 'rect', drill: hole },
        { num: '2', x: pitch / 2, y: 0, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [circle(0, 0, 6.2), circle(0, 0, 1.5)],
      refPos: { x: 0, y: -7.2 },
      courtyard: { x: -6.6, y: -6.6, w: 13.2, h: 13.2 },
      three: { w: 12, l: 12, h: 7.0, color: '#22262e' }
    };
  }

  // ---- potentiometer 3296 ----
  function pot3296(p) {
    const hole = p.holeD || 0.8, padD = p.padD || 1.6;
    return {
      name: p.name, pads: [
        { num: '1', x: -2.54, y: -2.54, w: padD, h: padD, shape: 'rect', drill: hole },
        { num: '2', x: 2.54, y: 0, w: padD, h: padD, shape: 'circle', drill: hole },
        { num: '3', x: -2.54, y: 2.54, w: padD, h: padD, shape: 'circle', drill: hole }
      ],
      silk: [rect(-2.4, -2.4, 4.8, 4.8)],
      refPos: { x: 0, y: -3.6 },
      courtyard: { x: -3.7, y: -3.7, w: 7.4, h: 7.4 },
      three: { w: 4.8, l: 4.8, h: 4.5, color: '#2040a0' }
    };
  }

  // ---------------------------------------------------------------------------
  // registry: name -> {desc, gen, params:[{key,label,def}], defaults}
  // ---------------------------------------------------------------------------
  const LIB = {
    // chip passives
    'R_0201': { desc: '贴片电阻 0201', gen: p => chip(Object.assign({ size: '0201', color: '#8a5a2a' }, p)), params: [] },
    'R_0402': { desc: '贴片电阻 0402', gen: p => chip(Object.assign({ size: '0402', color: '#8a5a2a' }, p)), params: [] },
    'R_0603': { desc: '贴片电阻 0603', gen: p => chip(Object.assign({ size: '0603', color: '#8a5a2a' }, p)), params: [] },
    'R_0805': { desc: '贴片电阻 0805', gen: p => chip(Object.assign({ size: '0805', color: '#8a5a2a' }, p)), params: [] },
    'R_1206': { desc: '贴片电阻 1206', gen: p => chip(Object.assign({ size: '1206', color: '#8a5a2a' }, p)), params: [] },
    'R_2512': { desc: '贴片电阻 2512', gen: p => chip(Object.assign({ size: '2512', color: '#8a5a2a' }, p)), params: [] },
    'C_0402': { desc: '贴片电容 0402', gen: p => chip(Object.assign({ size: '0402', color: '#c09040' }, p)), params: [] },
    'C_0603': { desc: '贴片电容 0603', gen: p => chip(Object.assign({ size: '0603', color: '#c09040' }, p)), params: [] },
    'C_0805': { desc: '贴片电容 0805', gen: p => chip(Object.assign({ size: '0805', color: '#c09040' }, p)), params: [] },
    'C_1206': { desc: '贴片电容 1206', gen: p => chip(Object.assign({ size: '1206', color: '#c09040' }, p)), params: [] },
    'L_0603': { desc: '贴片电感 0603', gen: p => chip(Object.assign({ size: '0603', color: '#404850' }, p)), params: [] },
    'L_0805': { desc: '贴片电感 0805', gen: p => chip(Object.assign({ size: '0805', color: '#404850' }, p)), params: [] },
    'LED_0603': { desc: '贴片LED 0603', gen: p => chip(Object.assign({ size: '0603', color: '#e03030' }, p)), params: [{ key: 'color', label: '颜色', def: '#e03030' }] },
    'LED_0805': { desc: '贴片LED 0805', gen: p => chip(Object.assign({ size: '0805', color: '#e03030' }, p)), params: [{ key: 'color', label: '颜色', def: '#e03030' }] },
    'D_SOD123': { desc: '二极管 SOD-123', gen: p => chip(Object.assign({ size: '0805', color: '#30343c' }, p)), params: [] },
    'CHIP_CUSTOM': {
      desc: '自定义片式元件(全参数)', gen: p => chip(Object.assign({ size: '0805' }, p)),
      params: [
        { key: 'size', label: '尺寸代码(0201~2512)', def: '0805' },
        { key: 'padW', label: '焊盘宽(mm)', def: 0 },
        { key: 'padH', label: '焊盘高(mm)', def: 0 },
        { key: 'gap', label: '焊盘间距(mm)', def: -1 }
      ]
    },
    // SOT
    'SOT23-3': { desc: 'SOT-23 三脚', gen: p => sot23(Object.assign({ pins: 3 }, p)), params: [] },
    'SOT23-5': { desc: 'SOT-23-5', gen: p => sot23(Object.assign({ pins: 5 }, p)), params: [] },
    'SOT23-6': { desc: 'SOT-23-6', gen: p => sot23(Object.assign({ pins: 6 }, p)), params: [] },
    'SOT223': { desc: 'SOT-223(带散热片)', gen: p => sot223(p), params: [] },
    // SOIC family
    'SOIC-8': { desc: 'SOIC-8 (1.27mm)', gen: p => soic(Object.assign({ pins: 8 }, p)), params: [] },
    'SOIC-14': { desc: 'SOIC-14 (1.27mm)', gen: p => soic(Object.assign({ pins: 14 }, p)), params: [] },
    'SOIC-16': { desc: 'SOIC-16 (1.27mm)', gen: p => soic(Object.assign({ pins: 16 }, p)), params: [] },
    'TSSOP-8': { desc: 'TSSOP-8 (0.65mm)', gen: p => soic(Object.assign({ pins: 8, pitch: 0.65, padW: 0.35, padL: 1.5, rowDist: 4.4 }, p)), params: [] },
    'TSSOP-16': { desc: 'TSSOP-16 (0.65mm)', gen: p => soic(Object.assign({ pins: 16, pitch: 0.65, padW: 0.35, padL: 1.5, rowDist: 4.4 }, p)), params: [] },
    'TSSOP-20': { desc: 'TSSOP-20 (0.65mm)', gen: p => soic(Object.assign({ pins: 20, pitch: 0.65, padW: 0.35, padL: 1.5, rowDist: 4.4 }, p)), params: [] },
    'SOIC_CUSTOM': {
      desc: '自定义SOIC/SOP(全参数)', gen: p => soic(p),
      params: [
        { key: 'pins', label: '引脚数(偶数)', def: 8 },
        { key: 'pitch', label: '引脚间距(mm)', def: 1.27 },
        { key: 'padW', label: '焊盘宽(mm)', def: 0 },
        { key: 'padL', label: '焊盘长(mm)', def: 2.0 },
        { key: 'rowDist', label: '两侧焊盘中心距(mm)', def: 5.4 }
      ]
    },
    // QFP/QFN
    'QFP-32': { desc: 'QFP-32 (0.8mm)', gen: p => qfp(Object.assign({ pins: 32, pitch: 0.8, body: 7 }, p)), params: [] },
    'QFP-44': { desc: 'QFP-44 (0.8mm)', gen: p => qfp(Object.assign({ pins: 44, pitch: 0.8, body: 10 }, p)), params: [] },
    'QFP-48': { desc: 'QFP-48 (0.5mm)', gen: p => qfp(Object.assign({ pins: 48, pitch: 0.5, body: 7, padW: 0.3, padL: 1.5 }, p)), params: [] },
    'QFP-64': { desc: 'QFP-64 (0.5mm)', gen: p => qfp(Object.assign({ pins: 64, pitch: 0.5, body: 10, padW: 0.3, padL: 1.5 }, p)), params: [] },
    'QFP-100': { desc: 'QFP-100 (0.5mm)', gen: p => qfp(Object.assign({ pins: 100, pitch: 0.5, body: 14, padW: 0.3, padL: 1.5 }, p)), params: [] },
    'QFN-16': { desc: 'QFN-16 (0.5mm)', gen: p => qfn(Object.assign({ pins: 16, pitch: 0.5, body: 3 }, p)), params: [] },
    'QFN-32': { desc: 'QFN-32 (0.5mm)', gen: p => qfn(Object.assign({ pins: 32, pitch: 0.5, body: 5 }, p)), params: [] },
    'QFN-48': { desc: 'QFN-48 (0.5mm)', gen: p => qfn(Object.assign({ pins: 48, pitch: 0.5, body: 7 }, p)), params: [] },
    'QFP_CUSTOM': {
      desc: '自定义QFP(全参数)', gen: p => qfp(p),
      params: [
        { key: 'pins', label: '引脚数(4的倍数)', def: 44 },
        { key: 'pitch', label: '引脚间距(mm)', def: 0.8 },
        { key: 'body', label: '本体边长(mm)', def: 0 },
        { key: 'padW', label: '焊盘宽(mm)', def: 0 },
        { key: 'padL', label: '焊盘长(mm)', def: 1.6 }
      ]
    },
    'QFN_CUSTOM': {
      desc: '自定义QFN(全参数)', gen: p => qfn(p),
      params: [
        { key: 'pins', label: '引脚数(4的倍数)', def: 16 },
        { key: 'pitch', label: '引脚间距(mm)', def: 0.5 },
        { key: 'body', label: '本体边长(mm)', def: 0 },
        { key: 'epad', label: '散热焊盘(true/false)', def: true },
        { key: 'epadSize', label: '散热焊盘边长(mm)', def: 0 }
      ]
    },
    // DIP
    'DIP-8': { desc: 'DIP-8 (2.54mm)', gen: p => dip(Object.assign({ pins: 8 }, p)), params: [] },
    'DIP-14': { desc: 'DIP-14 (2.54mm)', gen: p => dip(Object.assign({ pins: 14 }, p)), params: [] },
    'DIP-16': { desc: 'DIP-16 (2.54mm)', gen: p => dip(Object.assign({ pins: 16 }, p)), params: [] },
    'DIP-20': { desc: 'DIP-20 (2.54mm)', gen: p => dip(Object.assign({ pins: 20 }, p)), params: [] },
    'DIP-28': { desc: 'DIP-28 宽体', gen: p => dip(Object.assign({ pins: 28, rowPitch: 15.24 }, p)), params: [] },
    'DIP-40': { desc: 'DIP-40 宽体', gen: p => dip(Object.assign({ pins: 40, rowPitch: 15.24 }, p)), params: [] },
    'DIP_CUSTOM': {
      desc: '自定义DIP(全参数)', gen: p => dip(p),
      params: [
        { key: 'pins', label: '引脚数(偶数)', def: 8 },
        { key: 'pitch', label: '引脚间距(mm)', def: 2.54 },
        { key: 'rowPitch', label: '排距(mm)', def: 7.62 },
        { key: 'holeD', label: '孔径(mm)', def: 0.9 },
        { key: 'padD', label: '焊盘直径(mm)', def: 1.8 }
      ]
    },
    // headers/connectors
    'HDR-1x4': { desc: '单排针 1x4 (2.54mm)', gen: p => header(Object.assign({ pins: 4, rows: 1 }, p)), params: [] },
    'HDR-1x6': { desc: '单排针 1x6 (2.54mm)', gen: p => header(Object.assign({ pins: 6, rows: 1 }, p)), params: [] },
    'HDR-1x8': { desc: '单排针 1x8 (2.54mm)', gen: p => header(Object.assign({ pins: 8, rows: 1 }, p)), params: [] },
    'HDR-1x10': { desc: '单排针 1x10 (2.54mm)', gen: p => header(Object.assign({ pins: 10, rows: 1 }, p)), params: [] },
    'HDR-2x3': { desc: '双排针 2x3 (2.54mm)', gen: p => header(Object.assign({ pins: 6, rows: 2 }, p)), params: [] },
    'HDR-2x5': { desc: '双排针 2x5 (2.54mm)', gen: p => header(Object.assign({ pins: 10, rows: 2 }, p)), params: [] },
    'HDR-2x10': { desc: '双排针 2x10 (2.54mm)', gen: p => header(Object.assign({ pins: 20, rows: 2 }, p)), params: [] },
    'HDR_CUSTOM': {
      desc: '自定义排针/排母(全参数)', gen: p => header(p),
      params: [
        { key: 'pins', label: '总针数', def: 4 },
        { key: 'rows', label: '排数(1/2)', def: 1 },
        { key: 'pitch', label: '间距(mm,2.54/2.0/1.27)', def: 2.54 },
        { key: 'holeD', label: '孔径(mm)', def: 1.0 },
        { key: 'padD', label: '焊盘直径(mm)', def: 1.9 }
      ]
    },
    'TBLOCK-2': { desc: '接线端子 2P (5.08mm)', gen: p => terminalBlock(Object.assign({ pins: 2 }, p)), params: [] },
    'TBLOCK-3': { desc: '接线端子 3P (5.08mm)', gen: p => terminalBlock(Object.assign({ pins: 3 }, p)), params: [] },
    'TBLOCK-4': { desc: '接线端子 4P (5.08mm)', gen: p => terminalBlock(Object.assign({ pins: 4 }, p)), params: [] },
    'TBLOCK_CUSTOM': {
      desc: '自定义接线端子(全参数)', gen: p => terminalBlock(p),
      params: [
        { key: 'pins', label: '位数', def: 2 },
        { key: 'pitch', label: '间距(mm,5.08/3.81)', def: 5.08 },
        { key: 'holeD', label: '孔径(mm)', def: 1.3 },
        { key: 'padD', label: '焊盘直径(mm)', def: 2.4 }
      ]
    },
    'USB-C-16': { desc: 'USB Type-C 16P 母座', gen: p => usbC(p), params: [] },
    // electromechanical / misc
    'CAP-RADIAL-5': { desc: '直插电解电容 Φ5', gen: p => radialCap(Object.assign({ bodyD: 5.0 }, p)), params: [] },
    'CAP-RADIAL-6.3': { desc: '直插电解电容 Φ6.3', gen: p => radialCap(Object.assign({ bodyD: 6.3 }, p)), params: [] },
    'CAP-RADIAL-8': { desc: '直插电解电容 Φ8', gen: p => radialCap(Object.assign({ bodyD: 8.0 }, p)), params: [] },
    'CAP-RADIAL-10': { desc: '直插电解电容 Φ10', gen: p => radialCap(Object.assign({ bodyD: 10.0 }, p)), params: [] },
    'CAP_CUSTOM': {
      desc: '自定义直插电容器(全参数)', gen: p => radialCap(p),
      params: [
        { key: 'bodyD', label: '本体直径(mm)', def: 5.0 },
        { key: 'pitch', label: '脚距(mm)', def: 0 },
        { key: 'holeD', label: '孔径(mm)', def: 0.8 },
        { key: 'padD', label: '焊盘直径(mm)', def: 1.7 }
      ]
    },
    'AXIAL-10.16': { desc: '轴向元件 10.16mm(电阻/二极管)', gen: p => axial(Object.assign({ span: 10.16 }, p)), params: [] },
    'AXIAL-7.62': { desc: '轴向元件 7.62mm', gen: p => axial(Object.assign({ span: 7.62 }, p)), params: [] },
    'AXIAL-15.24': { desc: '轴向元件 15.24mm', gen: p => axial(Object.assign({ span: 15.24, bodyL: 9.0 }, p)), params: [] },
    'XTAL-HC49': { desc: '晶振 HC-49S 直插', gen: p => xtalHC49(p), params: [] },
    'XTAL-3225': { desc: '晶振 3225 贴片', gen: p => xtal3225(p), params: [] },
    'LED-3mm': { desc: '直插LED 3mm', gen: p => ledTH(Object.assign({ bodyD: 3.0 }, p)), params: [] },
    'LED-5mm': { desc: '直插LED 5mm', gen: p => ledTH(Object.assign({ bodyD: 5.0 }, p)), params: [] },
    'BUTTON-6x6': { desc: '轻触按键 6x6mm', gen: p => button6x6(p), params: [] },
    'POT-3296': { desc: '可调电位器 3296', gen: p => pot3296(p), params: [] },
    'BUZZER-12': { desc: '蜂鸣器 Φ12', gen: p => buzzer(p), params: [] },
    'BAT-CR2032': { desc: 'CR2032 电池座', gen: p => cr2032(p), params: [] },
    'MOUNT-M2': { desc: '安装孔 M2', gen: p => mountingHole(Object.assign({ holeD: 2.2 }, p)), params: [] },
    'MOUNT-M3': { desc: '安装孔 M3', gen: p => mountingHole(Object.assign({ holeD: 3.2 }, p)), params: [] },
    'MOUNT-M4': { desc: '安装孔 M4', gen: p => mountingHole(Object.assign({ holeD: 4.2 }, p)), params: [] },
    'MOUNT-NPTH-M3': { desc: '安装孔 M3 非金属化', gen: p => mountingHole(Object.assign({ holeD: 3.2, plated: false, padD: 3.2 }, p)), params: [] },
    'TP-SMD': { desc: '测试点 贴片', gen: p => testPad(Object.assign({ padD: 1.5 }, p)), params: [] },
    'TP-TH': { desc: '测试点 直插', gen: p => testPad(Object.assign({ th: true, padD: 1.8, holeD: 0.9 }, p)), params: [] }
  };

  const PCBFootprints = {
    list() {
      return Object.keys(LIB).map(name => ({
        name, desc: LIB[name].desc, params: LIB[name].params
      }));
    },
    has(name) { return !!LIB[name]; },
    generate(name, params) {
      const ent = LIB[name];
      if (!ent) return null;
      const p = Object.assign({}, params || {});
      p.name = name;
      // normalize numeric params
      for (const k of Object.keys(p)) {
        if (typeof p[k] === 'string' && p[k] !== '' && !isNaN(Number(p[k]))) p[k] = Number(p[k]);
      }
      const fp = ent.gen(p);
      fp.name = name;
      return fp;
    },
    register(name, desc, gen, params) { LIB[name] = { desc, gen, params: params || [] }; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PCBFootprints;
  else global.PCBFootprints = PCBFootprints;
})(typeof window !== 'undefined' ? window : globalThis);
