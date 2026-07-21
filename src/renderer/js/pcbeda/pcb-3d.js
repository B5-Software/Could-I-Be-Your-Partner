// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - 3D preview (Three.js / WebGL) + OBJ/MTL export
// 依赖: assets/lib/three/three.min.js + assets/lib/three/OrbitControls.js (由 fetch-assets 脚本下载)
(function (global) {
  'use strict';

  const Geo = (typeof PCBGeo !== 'undefined') ? PCBGeo : require('./pcb-geometry.js');
  const Model = (typeof PCBModel !== 'undefined') ? PCBModel : require('./pcb-model.js');
  const THREE = (typeof global.THREE !== 'undefined') ? global.THREE : null;

  // ---- ear clipping triangulation (simple polygon) ----
  function triangulate(pts) {
    const n = pts.length;
    if (n < 3) return [];
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    const area = Geo.polygonArea(pts);
    if (area > 0) idx.reverse();
    const tris = [];
    let guard = 0;
    while (idx.length > 3 && guard++ < 10000) {
      let earFound = false;
      for (let i = 0; i < idx.length; i++) {
        const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
        const a = pts[i0], b = pts[i1], c = pts[i2];
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (cross <= 0) continue;
        let ok = true;
        for (const j of idx) {
          if (j === i0 || j === i1 || j === i2) continue;
          if (pointInTriangle(pts[j], a, b, c)) { ok = false; break; }
        }
        if (!ok) continue;
        tris.push([i0, i1, i2]);
        idx.splice(i, 1);
        earFound = true;
        break;
      }
      if (!earFound) break;
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris;
  }

  function pointInTriangle(p, a, b, c) {
    const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  }
  function sign(p1, p2, p3) {
    return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  }

  // ---- mesh builder: faces = [{verts:[[x,y,z]...], color:'#rrggbb', mat}] ----
  function buildScene(board, fpLib) {
    const faces = [];
    const T = board.stackup.boardThickness || 1.6;
    const maskColor = '#0d6b32'; // soldermask green
    const copperColor = '#d8b64a';
    const holeColor = '#101010';

    const outline = board.outline.pts;
    if (outline.length >= 3) {
      const tris = triangulate(outline);
      for (const t of tris) {
        faces.push({ verts: [pt3(outline[t[0]], T), pt3(outline[t[1]], T), pt3(outline[t[2]], T)], color: maskColor });
        faces.push({ verts: [pt3(outline[t[2]], 0), pt3(outline[t[1]], 0), pt3(outline[t[0]], 0)], color: maskColor });
      }
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        faces.push({ verts: [[a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, T], [a.x, a.y, T]], color: '#c8b060' });
      }
    }

    const pads = Model.Board.allPads(board, fpLib);
    for (const p of pads) {
      const zTop = p.side === 'B' ? 0 : T;
      const dz = p.side === 'B' ? -0.05 : 0.05;
      if (p.drill) {
        addCylinder(faces, p.x, p.y, p.w / 2, T + 0.05, 0.05, copperColor, 12);
        addCylinder(faces, p.x, p.y, p.drill / 2 + 0.01, T + 0.06, 0.05, holeColor, 12);
      } else {
        addBox(faces, p.x, p.y, 0, p.w, p.h, 0.05, zTop + dz / 2, copperColor, p.rot || 0);
      }
    }
    for (const v of board.vias) {
      addCylinder(faces, v.x, v.y, v.diameter / 2, T + 0.05, 0.05, copperColor, 10);
      addCylinder(faces, v.x, v.y, v.drill / 2 + 0.01, T + 0.06, 0.05, holeColor, 10);
    }
    for (const t of board.traces) {
      if (t.layer !== 'F.Cu' && t.layer !== 'B.Cu') continue;
      const z = t.layer === 'F.Cu' ? T + 0.02 : -0.02;
      for (let i = 0; i < t.pts.length - 1; i++) {
        addRibbon(faces, t.pts[i], t.pts[i + 1], t.width, z, copperColor);
      }
    }
    for (const comp of board.components) {
      const fp = fpLib.generate(comp.footprint, comp.params || {});
      if (!fp || !fp.three || !fp.three.w) continue;
      const z0 = comp.side === 'B' ? 0 : T;
      addBox(faces, comp.x, comp.y, 0, fp.three.w, fp.three.l, fp.three.h,
        comp.side === 'B' ? z0 - fp.three.h / 2 : z0 + fp.three.h / 2, fp.three.color, comp.rot || 0);
    }
    return faces;
  }

  function pt3(p, z) { return [p.x, p.y, z]; }

  function addBox(faces, cx, cy, cz, w, l, h, zCenter, color, rotDeg) {
    const hw = w / 2, hl = l / 2;
    const corners = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(c => {
      const rp = Geo.rotatePoint(c[0], c[1], 0, 0, rotDeg || 0);
      return [cx + rp.x, cy + rp.y];
    });
    const zb = zCenter - h / 2, zt = zCenter + h / 2;
    const v = corners.map(c => [c[0], c[1], zb]);
    const u = corners.map(c => [c[0], c[1], zt]);
    faces.push({ verts: [u[0], u[1], u[2], u[3]], color });
    faces.push({ verts: [v[3], v[2], v[1], v[0]], color });
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      faces.push({ verts: [v[i], v[j], u[j], u[i]], color });
    }
  }

  function addCylinder(faces, cx, cy, r, zTop, h, color, seg) {
    const n = seg || 12;
    const zb = zTop - h;
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const a = i / n * Math.PI * 2;
      const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      if (prev) {
        faces.push({ verts: [[prev[0], prev[1], zb], [p[0], p[1], zb], [p[0], p[1], zTop], [prev[0], prev[1], zTop]], color });
      }
      prev = p;
    }
    const topPts = [], botPts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      topPts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zTop]);
      botPts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zb]);
    }
    faces.push({ verts: topPts, color });
    faces.push({ verts: botPts.slice().reverse(), color });
  }

  function addRibbon(faces, a, b, width, z, color) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len * width / 2, ny = dx / len * width / 2;
    faces.push({
      verts: [
        [a.x + nx, a.y + ny, z], [b.x + nx, b.y + ny, z],
        [b.x - nx, b.y - ny, z], [a.x - nx, a.y - ny, z]
      ], color
    });
  }

  // ---------------------------------------------------------------------------
  // Three.js renderer
  // 坐标系约定：X/Y 为 PCB 平面，Z 为板厚方向（向上）。
  // 与 PCB-2D 编辑器一致（pcb-canvas 中 Y 朝下，3D 视图中我们改为 Y 朝下/上皆可）。
  // 这里保持 PCB 原始坐标 (x,y,z) 直接喂给 Three.js，camera.up = +Z。
  // ---------------------------------------------------------------------------
  const PCB3D = {
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    controls: null,
    _animId: null,
    _mesh: null,
    _grid: null,
    _axes: null,
    _hintOverlay: null,
    _hasThree: false,

    init(canvas) {
      this.canvas = canvas;
      this._hasThree = !!(THREE && THREE.WebGLRenderer);
      if (!this._hasThree) {
        // Three.js 未加载（fetch-assets 未执行），降级到 Canvas 2D 占位提示
        console.warn('[PCB3D] Three.js not loaded — fallback to placeholder. Run scripts/fetch-assets.ps1');
        this._drawPlaceholder(canvas, 'Three.js 未加载\n请运行 scripts/fetch-assets.ps1 下载资源');
        return;
      }

      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: true,
          preserveDrawingBuffer: true,  // 让 toDataURL 可用
          alpha: false
        });
      } catch (e) {
        console.error('[PCB3D] WebGL init failed:', e);
        this._hasThree = false;
        this._drawPlaceholder(canvas, 'WebGL 初始化失败\n' + (e.message || ''));
        return;
      }

      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.scene = new THREE.Scene();

      // 背景：读取 CSS 变量 --pcb-3d-bg（暗色），失败时用 #0b0e14
      const bg = (getComputedStyle(document.documentElement).getPropertyValue('--pcb-3d-bg').trim()) || '#0b0e14';
      this.scene.background = new THREE.Color(bg);

      // 相机：透视，Z 向上（板厚方向）
      this.camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
      this.camera.up.set(0, 0, 1);

      // 光照：环境光 + 方向光 + 半球光
      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      this.scene.add(ambient);
      const dir = new THREE.DirectionalLight(0xffffff, 0.75);
      dir.position.set(60, -90, 110);
      this.scene.add(dir);
      const hemi = new THREE.HemisphereLight(0xb0c4de, 0x404020, 0.35);
      this.scene.add(hemi);

      // OrbitControls：内置轻量实现（球面坐标 + 阻尼）
      // Three.js 0.160 已移除 UMD 版的 OrbitControls.js，故自实现
      this.controls = this._createOrbitControls(this.camera, this.renderer.domElement);

      this.resize();
      window.addEventListener('resize', () => this.resize());
      this._startAnim();
    },

    _drawPlaceholder(canvas, msg) {
      const ctx = canvas.getContext('2d');
      const draw = () => {
        const r = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(r.width * dpr));
        canvas.height = Math.max(1, Math.floor(r.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#0b0e14';
        ctx.fillRect(0, 0, r.width, r.height);
        ctx.fillStyle = '#7a8898';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lines = msg.split('\n');
        const lh = 20;
        const startY = r.height / 2 - (lines.length - 1) * lh / 2;
        lines.forEach((line, i) => ctx.fillText(line, r.width / 2, startY + i * lh));
      };
      draw();
      this._placeholderDraw = draw;
      window.addEventListener('resize', draw);
    },

    _startAnim() {
      const loop = () => {
        this._animId = requestAnimationFrame(loop);
        if (this.controls) this.controls.update();
        if (this.renderer && this.scene && this.camera) {
          this.renderer.render(this.scene, this.camera);
        }
      };
      loop();
    },

    // 内置轻量 OrbitControls：左键旋转 / 滚轮缩放 / 右键平移
    // 与 Three.js 官方 OrbitControls API 基本对齐（target / enableDamping / dampingFactor / update / dispose）
    _createOrbitControls(camera, domElement) {
      const self = this;
      const state = {
        target: new THREE.Vector3(0, 0, 0),
        // 球面坐标：theta 绕 Z（水平转角），phi 与 Z 的夹角（从 +Z 朝 XY 平面）
        theta: Math.PI / 4,    // 45° (从 +X 轴朝 +Y 方向)
        phi: Math.PI / 3,      // 60° (从 +Z 朝 XY 平面，0..PI)
        radius: 100,
        // 阻尼后的目标值
        targetTheta: Math.PI / 4,
        targetPhi: Math.PI / 3,
        targetRadius: 100,
        targetTarget: new THREE.Vector3(0, 0, 0),
        // 配置
        enableDamping: true,
        dampingFactor: 0.12,
        rotateSpeed: 0.005,
        zoomSpeed: 0.0014,
        panSpeed: 0.0022,
        minDistance: 5,
        maxDistance: 3000,
        minPhi: 0.02,
        maxPhi: Math.PI - 0.02,
        // 内部
        _drag: null,
        _pan: null,
        enabled: true
      };

      function applyCamera() {
        const sinPhi = Math.sin(state.phi);
        const cosPhi = Math.cos(state.phi);
        const x = state.target.x + state.radius * sinPhi * Math.cos(state.theta);
        const y = state.target.y + state.radius * sinPhi * Math.sin(state.theta);
        const z = state.target.z + state.radius * cosPhi;
        camera.position.set(x, y, z);
        camera.lookAt(state.target);
      }

      function onPointerDown(e) {
        if (!state.enabled) return;
        if (e.button === 0) {
          state._drag = { x: e.clientX, y: e.clientY, theta: state.targetTheta, phi: state.targetPhi };
        } else if (e.button === 2) {
          state._pan = { x: e.clientX, y: e.clientY, tx: state.targetTarget.x, ty: state.targetTarget.y, tz: state.targetTarget.z };
        }
        e.preventDefault();
      }

      function onPointerMove(e) {
        if (state._drag) {
          const dx = e.clientX - state._drag.x;
          const dy = e.clientY - state._drag.y;
          state.targetTheta = state._drag.theta - dx * state.rotateSpeed;
          state.targetPhi = Math.max(state.minPhi, Math.min(state.maxPhi, state._drag.phi - dy * state.rotateSpeed));
        } else if (state._pan) {
          const dx = e.clientX - state._pan.x;
          const dy = e.clientY - state._pan.y;
          // 平移：在相机的"右"和"上"方向上移动
          const right = new THREE.Vector3();
          const up = new THREE.Vector3();
          camera.matrix.extractBasis(right, up, new THREE.Vector3());
          const scale = state.radius * state.panSpeed;
          state.targetTarget.x = state._pan.tx - right.x * dx * scale + up.x * (-dy) * scale;
          state.targetTarget.y = state._pan.ty - right.y * dx * scale + up.y * (-dy) * scale;
          state.targetTarget.z = state._pan.tz - right.z * dx * scale + up.z * (-dy) * scale;
        }
      }

      function onPointerUp() {
        state._drag = null;
        state._pan = null;
      }

      function onWheel(e) {
        if (!state.enabled) return;
        e.preventDefault();
        const factor = Math.exp(e.deltaY * state.zoomSpeed);
        state.targetRadius = Math.max(state.minDistance, Math.min(state.maxDistance, state.targetRadius * factor));
      }

      function onContext(e) { e.preventDefault(); }

      domElement.addEventListener('mousedown', onPointerDown);
      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', onPointerUp);
      domElement.addEventListener('wheel', onWheel, { passive: false });
      domElement.addEventListener('contextmenu', onContext);

      applyCamera();

      return {
        target: state.target,
        enabled: true,
        enableDamping: true,
        dampingFactor: 0.12,
        update() {
          if (state.enableDamping) {
            const k = state.dampingFactor;
            state.theta += (state.targetTheta - state.theta) * k;
            state.phi += (state.targetPhi - state.phi) * k;
            state.radius += (state.targetRadius - state.radius) * k;
            state.target.x += (state.targetTarget.x - state.target.x) * k;
            state.target.y += (state.targetTarget.y - state.target.y) * k;
            state.target.z += (state.targetTarget.z - state.target.z) * k;
          } else {
            state.theta = state.targetTheta;
            state.phi = state.targetPhi;
            state.radius = state.targetRadius;
            state.target.copy(state.targetTarget);
          }
          applyCamera();
        },
        setTarget(x, y, z) {
          state.target.set(x, y, z);
          state.targetTarget.set(x, y, z);
        },
        setView(theta, phi, radius) {
          state.targetTheta = theta;
          state.targetPhi = phi;
          state.targetRadius = radius;
        },
        dispose() {
          domElement.removeEventListener('mousedown', onPointerDown);
          window.removeEventListener('mousemove', onPointerMove);
          window.removeEventListener('mouseup', onPointerUp);
          domElement.removeEventListener('wheel', onWheel);
          domElement.removeEventListener('contextmenu', onContext);
        }
      };
    },

    resize() {
      if (!this.canvas) return;
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(r.width));
      const h = Math.max(1, Math.floor(r.height));
      if (this._hasThree && this.renderer) {
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      } else if (this._placeholderDraw) {
        this._placeholderDraw();
      }
    },

    setBoard(board, fpLib) {
      if (!this._hasThree) {
        if (this._placeholderDraw) this._placeholderDraw();
        return;
      }
      // 清理旧 mesh
      if (this._mesh) {
        this.scene.remove(this._mesh);
        this._mesh.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
        this._mesh = null;
      }
      if (this._grid) { this.scene.remove(this._grid); this._grid.geometry.dispose(); this._grid = null; }
      if (this._axes) { this.scene.remove(this._axes); this._axes.dispose(); this._axes = null; }

      if (!board) return;
      const faces = buildScene(board, fpLib);

      // 板子边界
      const bb = Model.Board.boardBBox(board, fpLib);
      const cx = (bb.minX + bb.maxX) / 2;
      const cy = (bb.minY + bb.maxY) / 2;
      const size = Math.max(50, Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY));

      if (!faces.length) {
        // 没板子内容：仅画网格 + 重置相机
      } else {
        const group = this._buildMesh(faces);
        this._mesh = group;
        this.scene.add(group);
      }

      // 网格辅助（XY 平面，Z=0）
      const gridSize = Math.max(50, size * 1.6);
      const divisions = Math.max(20, Math.floor(gridSize / 2.54));
      this._grid = new THREE.GridHelper(gridSize, divisions, 0x4a5a70, 0x252a35);
      this._grid.rotation.x = Math.PI / 2;  // 旋转到 XY 平面
      this._grid.position.set(cx, cy, -0.05);
      this.scene.add(this._grid);

      // 坐标轴辅助（红=X 绿=Y 蓝=Z，长度=板尺寸*0.6）
      const axisLen = size * 0.6;
      this._axes = new THREE.AxesHelper(axisLen);
      this._axes.position.set(bb.minX - 5, bb.minY - 5, 0);
      this.scene.add(this._axes);

      // 相机位置：从板子右前上方观察
      const dist = size * 2.0;
      if (this.controls) {
        // 通过 controls 设置初始视角（避免阻尼把状态拉回旧值）
        this.controls.setTarget(cx, cy, 0);
        // theta=-PI*0.3 让相机从板子的 +X +Y 方向看，phi=PI*0.35 让相机俯视约 63°
        this.controls.setView(-Math.PI * 0.3, Math.PI * 0.35, dist);
        this.controls.update();
      } else {
        this.camera.position.set(cx + dist * 0.45, cy - dist * 0.7, dist * 0.8);
        this.camera.lookAt(cx, cy, 0);
      }
      this.camera.near = 0.5;
      this.camera.far = dist * 10;
      this.camera.updateProjectionMatrix();
    },

    _buildMesh(faces) {
      // 把每个 face 拆成三角形（fan-out），构建 BufferGeometry + vertexColors
      const positions = [];
      const colors = [];
      const colorCache = new Map();
      const colorToRGB = (hex) => {
        if (colorCache.has(hex)) return colorCache.get(hex);
        const c = hex.replace('#', '');
        const r = parseInt(c.slice(0, 2), 16) / 255;
        const g = parseInt(c.slice(2, 4), 16) / 255;
        const b = parseInt(c.slice(4, 6), 16) / 255;
        const col = { r, g, b };
        colorCache.set(hex, col);
        return col;
      };

      for (const f of faces) {
        const verts = f.verts;
        if (!verts || verts.length < 3) continue;
        const col = colorToRGB(f.color);
        // fan-out from vertex 0
        for (let i = 1; i < verts.length - 1; i++) {
          const a = verts[0], b = verts[i], c = verts[i + 1];
          positions.push(a[0], a[1], a[2]);
          positions.push(b[0], b[1], b[2]);
          positions.push(c[0], c[1], c[2]);
          for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
        }
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geom.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.55,
        metalness: 0.18,
        side: THREE.DoubleSide,  // 防止 pad/cylinder 法线方向不一致被剔除
        flatShading: false        // fan-out 模式下每个顶点法线独立，自动呈现 flat 效果
      });

      return new THREE.Mesh(geom, mat);
    },

    render() {
      if (!this._hasThree || !this.renderer || !this.scene || !this.camera) {
        if (this._placeholderDraw) this._placeholderDraw();
        return;
      }
      this.renderer.render(this.scene, this.camera);
    },

    exportPNG(pixelW) {
      if (!this._hasThree || !this.renderer) return null;
      const w = pixelW || 1600;
      const savedSize = this.renderer.getSize(new THREE.Vector2());
      const savedRatio = this.renderer.getPixelRatio();
      const savedAspect = this.camera.aspect;

      this.renderer.setPixelRatio(1);
      const h = Math.round(w * (savedSize.y / Math.max(1, savedSize.x)));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = 1;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      const url = this.renderer.domElement.toDataURL('image/png');

      // 恢复
      this.renderer.setPixelRatio(savedRatio);
      this.renderer.setSize(savedSize.x, savedSize.y, false);
      this.camera.aspect = savedAspect;
      this.camera.updateProjectionMatrix();
      return url;
    },

    // OBJ + MTL export（保持原有逻辑，独立于 Three.js renderer）
    exportOBJ(board, fpLib, name) {
      const faces = buildScene(board, fpLib);
      const matNames = new Map();
      const obj = ['# CIBYP-PCB-EDA 3D export', 'mtllib ' + (name || 'pcb') + '.mtl', 'o board'];
      const mtl = [];
      let vOff = 1;
      const getMat = (color) => {
        if (!matNames.has(color)) {
          const mn = 'mat_' + matNames.size;
          matNames.set(color, mn);
          const c = color.replace('#', '');
          const r = parseInt(c.slice(0, 2), 16) / 255, g = parseInt(c.slice(2, 4), 16) / 255, b = parseInt(c.slice(4, 6), 16) / 255;
          mtl.push('newmtl ' + mn, 'Kd ' + r.toFixed(4) + ' ' + g.toFixed(4) + ' ' + b.toFixed(4), 'Ka 0.1 0.1 0.1', 'Ks 0.2 0.2 0.2', '');
        }
        return matNames.get(color);
      };
      let curMat = null;
      for (const f of faces) {
        const mn = getMat(f.color);
        if (mn !== curMat) { obj.push('usemtl ' + mn); curMat = mn; }
        const idx = [];
        for (const v of f.verts) {
          obj.push('v ' + v[0].toFixed(4) + ' ' + (-v[1]).toFixed(4) + ' ' + v[2].toFixed(4));
          idx.push(vOff++);
        }
        obj.push('f ' + idx.join(' '));
      }
      return { obj: obj.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
    },

    // 释放资源
    dispose() {
      if (this._animId) cancelAnimationFrame(this._animId);
      this._animId = null;
      if (this._mesh) {
        this._mesh.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
        this._mesh = null;
      }
      if (this._grid) { this._grid.geometry.dispose(); this._grid = null; }
      if (this._axes) { this._axes.dispose(); this._axes = null; }
      if (this.controls) { this.controls.dispose(); this.controls = null; }
      if (this.renderer) { this.renderer.dispose(); this.renderer = null; }
      this.scene = null;
      this.camera = null;
    }
  };

  global.PCB3D = PCB3D;
  global.PCB3DUtil = { triangulate, buildScene };
})(typeof window !== 'undefined' ? window : globalThis);
