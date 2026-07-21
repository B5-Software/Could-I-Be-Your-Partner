// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - schematic symbol library (local coords, mm, grid 2.54)
// symbol def: { name, desc, refPrefix, footprint, pins:[{num,name,x,y}], draw:[{kind,...}] }
(function (global) {
  'use strict';

  function line(x1, y1, x2, y2) { return { kind: 'line', pts: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }; }
  function rect(x, y, w, h) { return { kind: 'rect', x, y, w, h }; }
  function circle(x, y, r) { return { kind: 'circle', x, y, r }; }
  function arc(x, y, r, a0, a1) { return { kind: 'arc', x, y, r, a0, a1 }; }
  function poly(pts) { return { kind: 'poly', pts: pts.map(p => ({ x: p[0], y: p[1] })) }; }

  const G = 2.54; // standard grid

  const LIB = {
    'R': {
      desc: '电阻', refPrefix: 'R', footprint: 'R_0805',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [rect(-G, -0.5 * G, 2 * G, G)]
    },
    'C': {
      desc: '无极性电容', refPrefix: 'C', footprint: 'C_0805',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [line(-0.25 * G, -G, -0.25 * G, G), line(0.25 * G, -G, 0.25 * G, G),
             line(-2 * G, 0, -0.25 * G, 0), line(0.25 * G, 0, 2 * G, 0)]
    },
    'C_Polar': {
      desc: '极性电容', refPrefix: 'C', footprint: 'CAP-RADIAL-5',
      pins: [{ num: '1', name: '+', x: -2 * G, y: 0 }, { num: '2', name: '-', x: 2 * G, y: 0 }],
      draw: [line(-0.25 * G, -G, -0.25 * G, G), arc(0.9 * G, 0, 1.15 * G, 115, 245),
             line(-2 * G, 0, -0.25 * G, 0), line(0.25 * G, 0, 2 * G, 0),
             line(-0.75 * G, -1.3 * G, -0.25 * G, -1.3 * G), line(-0.5 * G, -1.55 * G, -0.5 * G, -1.05 * G)]
    },
    'L': {
      desc: '电感', refPrefix: 'L', footprint: 'L_0805',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [arc(-1.5 * G, 0, 0.5 * G, 180, 360), arc(-0.5 * G, 0, 0.5 * G, 180, 360),
             arc(0.5 * G, 0, 0.5 * G, 180, 360), arc(1.5 * G, 0, 0.5 * G, 180, 360)]
    },
    'D': {
      desc: '二极管', refPrefix: 'D', footprint: 'D_SOD123',
      pins: [{ num: '1', name: 'A', x: -2 * G, y: 0 }, { num: '2', name: 'K', x: 2 * G, y: 0 }],
      draw: [poly([[-0.5 * G, -0.5 * G], [-0.5 * G, 0.5 * G], [0.5 * G, 0]]),
             line(0.5 * G, -0.5 * G, 0.5 * G, 0.5 * G),
             line(-2 * G, 0, -0.5 * G, 0), line(0.5 * G, 0, 2 * G, 0)]
    },
    'LED': {
      desc: '发光二极管', refPrefix: 'D', footprint: 'LED_0805',
      pins: [{ num: '1', name: 'A', x: -2 * G, y: 0 }, { num: '2', name: 'K', x: 2 * G, y: 0 }],
      draw: [poly([[-0.5 * G, -0.5 * G], [-0.5 * G, 0.5 * G], [0.5 * G, 0]]),
             line(0.5 * G, -0.5 * G, 0.5 * G, 0.5 * G),
             line(-2 * G, 0, -0.5 * G, 0), line(0.5 * G, 0, 2 * G, 0),
             line(0.1 * G, -0.8 * G, 0.55 * G, -1.25 * G), line(0.7 * G, -0.6 * G, 1.15 * G, -1.05 * G)]
    },
    'Zener': {
      desc: '稳压二极管', refPrefix: 'D', footprint: 'D_SOD123',
      pins: [{ num: '1', name: 'A', x: -2 * G, y: 0 }, { num: '2', name: 'K', x: 2 * G, y: 0 }],
      draw: [poly([[-0.5 * G, -0.5 * G], [-0.5 * G, 0.5 * G], [0.5 * G, 0]]),
             line(0.5 * G, -0.5 * G, 0.5 * G, 0.5 * G),
             line(0.5 * G, -0.5 * G, 0.75 * G, -0.7 * G), line(0.5 * G, 0.5 * G, 0.25 * G, 0.7 * G),
             line(-2 * G, 0, -0.5 * G, 0), line(0.5 * G, 0, 2 * G, 0)]
    },
    'Q_NPN': {
      desc: 'NPN 三极管', refPrefix: 'Q', footprint: 'SOT23-3',
      pins: [{ num: '1', name: 'B', x: -2 * G, y: 0 }, { num: '2', name: 'E', x: G, y: 2 * G }, { num: '3', name: 'C', x: G, y: -2 * G }],
      draw: [circle(0, 0, 1.5 * G), line(-0.55 * G, -0.85 * G, -0.55 * G, 0.85 * G),
             line(-2 * G, 0, -0.55 * G, 0),
             line(-0.55 * G, -0.5 * G, G, -2 * G), line(-0.55 * G, 0.5 * G, G, 2 * G),
             line(G, -2 * G, G, -2 * G), poly([[0.42 * G, 1.35 * G], [G, 2 * G], [0.95 * G, 1.15 * G]])]
    },
    'Q_PNP': {
      desc: 'PNP 三极管', refPrefix: 'Q', footprint: 'SOT23-3',
      pins: [{ num: '1', name: 'B', x: -2 * G, y: 0 }, { num: '2', name: 'E', x: G, y: 2 * G }, { num: '3', name: 'C', x: G, y: -2 * G }],
      draw: [circle(0, 0, 1.5 * G), line(-0.55 * G, -0.85 * G, -0.55 * G, 0.85 * G),
             line(-2 * G, 0, -0.55 * G, 0),
             line(-0.55 * G, -0.5 * G, G, -2 * G), line(-0.55 * G, 0.5 * G, G, 2 * G),
             poly([[-0.55 * G, 0.5 * G], [0.15 * G, 1.3 * G], [-0.35 * G, 1.5 * G]])]
    },
    'NMOS': {
      desc: 'NMOS 场效应管', refPrefix: 'Q', footprint: 'SOT23-3',
      pins: [{ num: '1', name: 'G', x: -2 * G, y: 0 }, { num: '2', name: 'S', x: G, y: 2 * G }, { num: '3', name: 'D', x: G, y: -2 * G }],
      draw: [circle(0, 0, 1.5 * G), line(-0.55 * G, -0.85 * G, -0.55 * G, 0.85 * G),
             line(-2 * G, 0, -0.55 * G, 0),
             line(0, -0.85 * G, 0, 0.85 * G),
             line(0, -0.55 * G, G, -2 * G), line(0, 0.55 * G, G, 2 * G),
             poly([[0, 0], [0.45 * G, -0.18 * G], [0.45 * G, 0.18 * G]])]
    },
    'OPAMP': {
      desc: '运算放大器', refPrefix: 'U', footprint: 'SOIC-8',
      pins: [{ num: '1', name: '+', x: -2 * G, y: -G }, { num: '2', name: '-', x: -2 * G, y: G },
             { num: '3', name: 'OUT', x: 2.5 * G, y: 0 }, { num: '4', name: 'V-', x: 0, y: 2.5 * G }, { num: '8', name: 'V+', x: 0, y: -2.5 * G }],
      draw: [poly([[-1.5 * G, -2 * G], [-1.5 * G, 2 * G], [2 * G, 0]]),
             line(-1.1 * G, -G, -0.6 * G, -G), line(-1.1 * G, G, -0.6 * G, G), line(-0.85 * G, 0.75 * G, -0.85 * G, 1.25 * G)]
    },
    'XTAL': {
      desc: '晶振', refPrefix: 'Y', footprint: 'XTAL-HC49',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [rect(-0.8 * G, -G, 1.6 * G, 2 * G), line(-0.35 * G, -G, -0.35 * G, G), line(0.35 * G, -G, 0.35 * G, G)]
    },
    'FUSE': {
      desc: '保险丝', refPrefix: 'F', footprint: 'AXIAL-10.16',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [rect(-G, -0.5 * G, 2 * G, G), line(-2 * G, 0, 2 * G, 0)]
    },
    'SW': {
      desc: '拨动开关', refPrefix: 'S', footprint: 'HDR-1x3',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 }],
      draw: [circle(-G, 0, 0.2 * G), circle(G, 0, 0.2 * G), line(-G, 0, 0.7 * G, -0.8 * G)]
    },
    'SW_PUSH': {
      desc: '轻触按键', refPrefix: 'S', footprint: 'BUTTON-6x6',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: '2', x: 2 * G, y: 0 },
             { num: '3', name: '3', x: -2 * G, y: 2 * G }, { num: '4', name: '4', x: 2 * G, y: 2 * G }],
      draw: [circle(-G, 0, 0.2 * G), circle(G, 0, 0.2 * G), line(-G, -0.7 * G, G, -0.7 * G),
             line(0, -0.7 * G, 0, -1.3 * G),
             circle(-G, 2 * G, 0.2 * G), circle(G, 2 * G, 0.2 * G), line(-G, 2 * G, -G, 0), line(G, 2 * G, G, 0)]
    },
    'SPK': {
      desc: '扬声器/蜂鸣器', refPrefix: 'LS', footprint: 'BUZZER-12',
      pins: [{ num: '1', name: '+', x: -2 * G, y: 0 }, { num: '2', name: '-', x: 2 * G, y: 0 }],
      draw: [rect(-0.8 * G, -0.6 * G, 0.8 * G, 1.2 * G), poly([[0, -0.6 * G], [0.9 * G, -1.3 * G], [0.9 * G, 1.3 * G], [0, 0.6 * G]])]
    },
    'ANT': {
      desc: '天线', refPrefix: 'E', footprint: 'TP-SMD',
      pins: [{ num: '1', name: '1', x: 0, y: 2 * G }],
      draw: [line(0, 2 * G, 0, 0), line(-G, -G, 0, 0), line(G, -G, 0, 0), line(-0.5 * G, -0.5 * G, 0, 0), line(0.5 * G, -0.5 * G, 0, 0)]
    },
    'BAT': {
      desc: '电池', refPrefix: 'BT', footprint: 'BAT-CR2032',
      pins: [{ num: '1', name: '+', x: 0, y: -2 * G }, { num: '2', name: '-', x: 0, y: 2 * G }],
      draw: [line(-G, -G, G, -G), line(-0.5 * G, 0, 0.5 * G, 0),
             line(-G, G, G, G), line(-0.5 * G, 2 * G, 0.5 * G, 2 * G),
             line(-G - 0.3 * G, -G - 0.6 * G, -G + 0.3 * G, -G - 0.6 * G), line(-G, -G - 0.9 * G, -G, -G - 0.3 * G)]
    },
    'TP': {
      desc: '测试点', refPrefix: 'TP', footprint: 'TP-SMD',
      pins: [{ num: '1', name: '1', x: 0, y: G }],
      draw: [circle(0, 0, 0.5 * G), line(0, 0.5 * G, 0, G)]
    },
    'POT': {
      desc: '电位器', refPrefix: 'RP', footprint: 'POT-3296',
      pins: [{ num: '1', name: '1', x: -2 * G, y: 0 }, { num: '2', name: 'W', x: 0, y: 2 * G }, { num: '3', name: '3', x: 2 * G, y: 0 }],
      draw: [rect(-G, -0.5 * G, 2 * G, G), line(0, 2 * G, 0, 0.6 * G),
             line(-0.25 * G, 0.85 * G, 0, 0.6 * G), line(0.25 * G, 0.85 * G, 0, 0.6 * G)]
    }
  };

  // parametric IC: params {left:['VCC','D0'], right:['GND','O0'], top:[], bottom:[]}
  function makeIC(params) {
    const p = params || {};
    const left = p.left || ['P1', 'P2'];
    const right = p.right || ['P3', 'P4'];
    const rows = Math.max(left.length, right.length);
    const H = (rows + 1) * G;
    const W = Math.max(4 * G, (p.widthGrids || 4) * G);
    const pins = [];
    const draw = [rect(-W / 2, -H / 2, W, H), circle(-W / 2 + 0.35 * G, -H / 2 + 0.35 * G, 0.15 * G)];
    let num = 1;
    left.forEach((nm, i) => {
      const y = -H / 2 + (i + 1) * G;
      pins.push({ num: String(num++), name: nm, x: -W / 2 - G, y });
      draw.push(line(-W / 2 - G, y, -W / 2, y));
    });
    right.forEach((nm, i) => {
      const y = -H / 2 + (i + 1) * G;
      pins.push({ num: String(num++), name: nm, x: W / 2 + G, y });
      draw.push(line(W / 2, y, W / 2 + G, y));
    });
    return { pins, draw, w: W, h: H };
  }

  // parametric connector: N pins left side
  function makeConn(params) {
    const p = params || {};
    const n = Math.max(1, p.pins || 4);
    const H = (n + 1) * G;
    const W = 3 * G;
    const pins = [];
    const draw = [rect(-W / 2, -H / 2, W, H)];
    for (let i = 0; i < n; i++) {
      const y = -H / 2 + (i + 1) * G;
      pins.push({ num: String(i + 1), name: String(i + 1), x: -W / 2 - G, y });
      draw.push(line(-W / 2 - G, y, -W / 2, y));
      draw.push(rect(-W / 2 + 0.2 * G, y - 0.15 * G, W - 0.4 * G, 0.3 * G));
    }
    return { pins, draw, w: W, h: H };
  }

  const PCBSymbols = {
    list() {
      const base = Object.keys(LIB).map(name => ({
        name, desc: LIB[name].desc, refPrefix: LIB[name].refPrefix, footprint: LIB[name].footprint
      }));
      base.push({ name: 'IC', desc: '通用IC(自定义引脚)', refPrefix: 'U', footprint: 'SOIC-8', parametric: true });
      base.push({ name: 'CONN', desc: '连接器(自定义针数)', refPrefix: 'J', footprint: 'HDR-1x4', parametric: true });
      return base;
    },
    has(name) { return !!LIB[name] || name === 'IC' || name === 'CONN'; },
    get(name, params) {
      if (name === 'IC') {
        const d = makeIC(params);
        return { name, refPrefix: 'U', pins: d.pins, draw: d.draw, footprint: (params && params.footprint) || 'SOIC-8' };
      }
      if (name === 'CONN') {
        const d = makeConn(params);
        return { name, refPrefix: 'J', pins: d.pins, draw: d.draw, footprint: (params && params.footprint) || ('HDR-1x' + ((params && params.pins) || 4)) };
      }
      return LIB[name] || null;
    },
    defaultFootprint(name, params) {
      if (name === 'CONN') return 'HDR-1x' + ((params && params.pins) || 4);
      const def = LIB[name];
      return def ? def.footprint : 'SOIC-8';
    },
    pinCount(name, params) {
      const def = this.get(name, params);
      return def ? def.pins.length : 0;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PCBSymbols;
  else global.PCBSymbols = PCBSymbols;
})(typeof window !== 'undefined' ? window : globalThis);
