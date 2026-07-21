// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - bootstrap: window, theme, toolbar, panel, canvas wiring, file I/O
(function () {
  'use strict';

  const Doc = PCBModel.Doc;
  const Editor = PCBEditor;

  // ---------------- theme ----------------
  async function applyTheme() {
    try {
      const settings = await window.pcbAPI.getSettings();
      const theme = (settings && settings.theme) || {};
      let isDark = true;
      if (theme.mode === 'light') isDark = false;
      else if (theme.mode === 'system') {
        const sysTheme = await window.pcbAPI.getTheme();
        isDark = sysTheme ? !!sysTheme.shouldUseDarkColors : true;
      }
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
      if (theme.accentColor) {
        document.documentElement.style.setProperty('--accent', theme.accentColor);
        document.documentElement.style.setProperty('--pcb-accent', theme.accentColor);
      }
    } catch (e) { /* defaults */ }
  }

  // ---------------- window controls ----------------
  function initWindowControls() {
    if (/Mac/.test(navigator.userAgent)) {
      document.getElementById('pcb-titlebar').classList.add('platform-darwin');
    }
    document.getElementById('btn-win-minimize').addEventListener('click', () => window.pcbAPI.minimize());
    const updateMaxIcon = () => {
      window.pcbAPI.isMaximized().then(r => {
        const icon = document.querySelector('#btn-win-maximize i');
        if (icon) icon.className = (r && r.maximized) ? 'fa-regular fa-window-restore' : 'fa-regular fa-square';
      });
    };
    document.getElementById('btn-win-maximize').addEventListener('click', () =>
      window.pcbAPI.maximizeToggle().then(updateMaxIcon));
    if (window.pcbAPI.onMaximizeChange) window.pcbAPI.onMaximizeChange(updateMaxIcon);
    setTimeout(updateMaxIcon, 200);
    document.getElementById('btn-win-close').addEventListener('click', () => window.pcbAPI.closeWindow());
    // close handshake
    window.pcbAPI.onCloseRequested(() => {
      if (!Doc.modified) { window.pcbAPI.confirmClose('close'); return; }
      showModal('pcb-save-prompt', true);
    });
    document.getElementById('btn-prompt-save').addEventListener('click', async () => {
      const saved = await saveProjectFlow(false);
      if (saved) window.pcbAPI.confirmClose('close');
      else showModal('pcb-save-prompt', false);
    });
    document.getElementById('btn-prompt-discard').addEventListener('click', () => window.pcbAPI.confirmClose('close'));
    document.getElementById('btn-prompt-cancel').addEventListener('click', () => showModal('pcb-save-prompt', false));
  }

  function showModal(id, show) {
    document.getElementById(id).classList.toggle('hidden', !show);
  }

  // ---------------- doc name ----------------
  function refreshDocTitle() {
    document.getElementById('doc-name').textContent = Doc.project.name + (Doc.filePath ? ' — ' + Doc.filePath : '');
    document.getElementById('doc-modified').textContent = Doc.modified ? '●' : '';
  }

  // ---------------- view tabs ----------------
  function initViewTabs() {
    document.querySelectorAll('.pcb-viewtab').forEach(btn => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
  }

  function setMode(mode) {
    Editor.setMode(mode);
    document.querySelectorAll('.pcb-viewtab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.getElementById('sch-canvas').classList.toggle('hidden', mode !== 'sch');
    document.getElementById('pcb-canvas').classList.toggle('hidden', mode !== 'pcb');
    document.getElementById('td-canvas').classList.toggle('hidden', mode !== '3d');
    document.getElementById('view-hint').textContent =
      mode === 'sch' ? '原理图编辑：放置符号 → 连线 → 标注 → 同步到PCB' :
      mode === 'pcb' ? 'PCB布局：摆放元件 → 布线 → 铺铜 → DRC → 导出Gerber' :
      '3D预览：拖拽旋转，滚轮缩放';
    if (mode === '3d') {
      PCB3D.setBoard(Doc.board(), PCBFootprints);
      PCB3D.resize();
    } else if (mode === 'pcb') {
      PCBRender.resize();
    } else {
      PCBSchRender.resize();
    }
    buildToolbar();
    refreshPanel();
    refresh();
  }

  // ---------------- toolbar ----------------
  const TOOLS = {
    sch: [
      ['select', 'fa-arrow-pointer', '选择'],
      ['symbol', 'fa-microchip', '放符号'],
      ['wire', 'fa-pen', '导线'],
      ['junction', 'fa-circle-dot', '节点'],
      ['label', 'fa-tag', '网络标签'],
      ['power', 'fa-bolt', '电源符号'],
      ['noconnect', 'fa-xmark', '不连接'],
      ['text', 'fa-font', '文本'],
      ['delete', 'fa-eraser', '删除']
    ],
    pcb: [
      ['select', 'fa-arrow-pointer', '选择/拖动'],
      ['comp', 'fa-microchip', '放元件'],
      ['trace', 'fa-route', '布线'],
      ['via', 'fa-circle', '过孔'],
      ['zone', 'fa-fill', '铺铜'],
      ['silkline', 'fa-pen-ruler', '丝印线'],
      ['silktext', 'fa-font', '丝印文字'],
      ['measure', 'fa-ruler', '测量'],
      ['delete', 'fa-eraser', '删除']
    ],
    '3d': []
  };

  function buildToolbar() {
    const bar = document.getElementById('pcb-toolbar');
    bar.innerHTML = '';
    for (const [tool, icon, label] of (TOOLS[Editor.mode] || [])) {
      const b = document.createElement('button');
      b.className = 'pcb-tool' + (Editor.tool === tool ? ' active' : '');
      b.title = label;
      b.innerHTML = '<i class="fa-solid ' + icon + '"></i>';
      b.addEventListener('click', () => {
        Editor.setTool(tool);
        bar.querySelectorAll('.pcb-tool').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
      bar.appendChild(b);
    }
  }

  // ---------------- panel ----------------
  let activePtab = 'lib';
  function initPanel() {
    document.querySelectorAll('.pcb-ptab').forEach(btn => {
      btn.addEventListener('click', () => {
        activePtab = btn.dataset.ptab;
        document.querySelectorAll('.pcb-ptab').forEach(b => b.classList.toggle('active', b === btn));
        refreshPanel();
      });
    });
  }

  function refreshPanel() {
    const body = document.getElementById('pcb-panel-body');
    body.innerHTML = '';
    if (activePtab === 'lib') renderLibPanel(body);
    else if (activePtab === 'layers') renderLayersPanel(body);
    else if (activePtab === 'nets') renderNetsPanel(body);
    else if (activePtab === 'check') renderCheckPanel(body);
    else if (activePtab === 'props') renderPropsPanel(body);
  }

  function section(body, title) {
    const d = document.createElement('div');
    d.className = 'pcb-p-section';
    d.innerHTML = '<div class="pcb-p-title">' + title + '</div>';
    body.appendChild(d);
    return d;
  }

  function renderLibPanel(body) {
    if (Editor.mode === 'sch') {
      const s = section(body, '符号库 (点击后放置)');
      for (const sym of PCBSymbols.list()) {
        const item = document.createElement('div');
        item.className = 'pcb-p-item' + (Editor.activeSymbol === sym.name ? ' active' : '');
        item.innerHTML = '<i class="fa-solid fa-puzzle-piece"></i> ' + sym.name + ' <small>' + sym.desc + '</small>';
        item.addEventListener('click', () => {
          Editor.activeSymbol = sym.name;
          Editor.setTool('symbol');
          buildToolbarActive('symbol');
          refreshPanel();
        });
        s.appendChild(item);
      }
      const p = section(body, '电源符号');
      for (const pt of ['GND', 'VCC', '+5V', '+3V3', '+12V', '-12V', 'AGND']) {
        const item = document.createElement('div');
        item.className = 'pcb-p-item' + (Editor.activePower === pt ? ' active' : '');
        item.innerHTML = '<i class="fa-solid fa-bolt"></i> ' + pt;
        item.addEventListener('click', () => {
          Editor.activePower = pt;
          Editor.setTool('power');
          buildToolbarActive('power');
          refreshPanel();
        });
        p.appendChild(item);
      }
    } else {
      const s = section(body, '封装库 (点击后放置)');
      for (const fp of PCBFootprints.list()) {
        const item = document.createElement('div');
        item.className = 'pcb-p-item' + (Editor.activeFootprint === fp.name ? ' active' : '');
        item.innerHTML = '<i class="fa-solid fa-microchip"></i> ' + fp.name + ' <small>' + fp.desc + '</small>';
        item.addEventListener('click', () => {
          Editor.activeFootprint = fp.name;
          Editor.setTool('comp');
          buildToolbarActive('comp');
          refreshPanel();
        });
        s.appendChild(item);
      }
    }
  }

  function buildToolbarActive(tool) {
    document.querySelectorAll('#pcb-toolbar .pcb-tool').forEach(b => {
      b.classList.toggle('active', b.title === (TOOLS[Editor.mode].find(t => t[0] === tool) || [])[2]);
    });
  }

  function renderLayersPanel(body) {
    const b = Doc.board();
    const s = section(body, '铜层 (点击设为当前层, 眼睛切换可见)');
    for (const lid of PCBModel.Board.copperLayerIds(b)) {
      const item = document.createElement('div');
      item.className = 'pcb-p-item' + (Editor.activeLayer === lid ? ' active' : '');
      const vis = Editor.layerVisibility[lid] !== false;
      item.innerHTML = '<span class="pcb-p-swatch" style="background:' + PCBRender.layerColor(lid) + '"></span> ' + lid +
        ' <small><i class="fa-solid ' + (vis ? 'fa-eye' : 'fa-eye-slash') + '"></i></small>';
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'SMALL') {
          Editor.layerVisibility[lid] = !vis;
        } else {
          Editor.activeLayer = lid;
        }
        refreshPanel(); refresh();
      });
      item.querySelector('small').addEventListener('click', (e) => {
        e.stopPropagation();
        Editor.layerVisibility[lid] = !(Editor.layerVisibility[lid] !== false);
        refreshPanel(); refresh();
      });
      s.appendChild(item);
    }
    const o = section(body, '显示选项');
    const mkToggle = (label, key, def) => {
      const item = document.createElement('div');
      const on = key === 'silk' ? Editor.layerVisibility['silk'] !== false : Editor[key];
      item.className = 'pcb-p-item';
      item.innerHTML = '<i class="fa-solid ' + (on ? 'fa-square-check' : 'fa-square') + '"></i> ' + label;
      item.addEventListener('click', () => {
        if (key === 'silk') Editor.layerVisibility['silk'] = Editor.layerVisibility['silk'] === false;
        else Editor[key] = !Editor[key];
        refreshPanel(); refresh();
      });
      o.appendChild(item);
    };
    mkToggle('丝印层', 'silk');
    mkToggle('飞线 (Ratsnest)', 'showRatsnest');
    const g = section(body, '网格');
    const gridSel = document.createElement('select');
    gridSel.className = 'pcb-p-btn';
    for (const gv of [0.1, 0.25, 0.5, 1.0, 1.27, 2.54, 5.0]) {
      const opt = document.createElement('option');
      opt.value = gv; opt.textContent = gv + ' mm';
      if (Editor.pcbGrid === gv) opt.selected = true;
      gridSel.appendChild(opt);
    }
    gridSel.addEventListener('change', () => { Editor.pcbGrid = parseFloat(gridSel.value); });
    g.appendChild(gridSel);
  }

  function renderNetsPanel(body) {
    const b = Doc.board();
    const nets = PCBModel.Board.netNames(b, PCBFootprints);
    const s = section(body, '网络 (' + nets.length + ') — 点击设为当前网络');
    const rats = PCBModel.Board.ratsnest(b, PCBFootprints);
    const unroutedByNet = {};
    for (const l of rats) unroutedByNet[l.net] = (unroutedByNet[l.net] || 0) + 1;
    for (const n of nets) {
      const item = document.createElement('div');
      item.className = 'pcb-p-item' + (Editor.activeNet === n ? ' active' : '');
      item.innerHTML = '<i class="fa-solid fa-circle-nodes"></i> ' + n +
        (unroutedByNet[n] ? ' <small>未布:' + unroutedByNet[n] + '</small>' : '<small><i class="fa-solid fa-check"></i></small>');
      item.addEventListener('click', () => {
        Editor.activeNet = n;
        Editor.highlightNet = Editor.highlightNet === n ? '' : n;
        refreshPanel(); refresh();
      });
      s.appendChild(item);
    }
    if (!nets.length) s.innerHTML += '<div class="pcb-p-item"><small>暂无网络。从原理图同步或手动布线时创建。</small></div>';
  }

  function renderCheckPanel(body) {
    const s = section(body, '设计规则检查');
    // live DRC toggle
    const tgl = document.createElement('div');
    tgl.className = 'pcb-p-item';
    tgl.innerHTML = '<i class="fa-solid ' + (liveDrc ? 'fa-square-check' : 'fa-square') + '"></i> 实时 DRC (编辑后自动检查)';
    tgl.addEventListener('click', () => {
      liveDrc = !liveDrc;
      if (!liveDrc) { Editor.drcMarkers = []; refresh(); }
      else scheduleLiveDrc();
      refreshPanel();
    });
    s.appendChild(tgl);
    const btnDrc = document.createElement('button');
    btnDrc.className = 'pcb-p-btn primary';
    btnDrc.innerHTML = '<i class="fa-solid fa-clipboard-check"></i> 运行 DRC (PCB)';
    btnDrc.addEventListener('click', () => {
      Editor.drcMarkers = PCBDrc.run(Doc.board(), PCBFootprints);
      refreshPanel(); refresh();
    });
    s.appendChild(btnDrc);
    const btnErc = document.createElement('button');
    btnErc.className = 'pcb-p-btn';
    btnErc.innerHTML = '<i class="fa-solid fa-clipboard-check"></i> 运行 ERC (原理图)';
    btnErc.addEventListener('click', () => {
      Editor.ercMarkers = PcbErc.run(Doc.sheet(), PCBSymbols);
      refreshPanel(); refresh();
    });
    s.appendChild(btnErc);
    const btnAuto = document.createElement('button');
    btnAuto.className = 'pcb-p-btn';
    btnAuto.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 自动布线';
    btnAuto.addEventListener('click', () => {
      const res = PCBAutorouter.autoroute(Doc.board(), PCBFootprints, {});
      if (res.ok) {
        Doc.snapshot();
        for (const tr of res.traces) PCBModel.Board.addTrace(Doc.board(), tr);
        for (const v of res.vias) PCBModel.Board.addVia(Doc.board(), v);
        Doc.touch();
        Editor.status('自动布线完成: ' + res.routed + ' 成功, ' + res.failed + ' 失败');
      } else {
        Editor.status('自动布线失败: ' + (res.error || ''));
      }
      refreshPanel(); refresh();
    });
    s.appendChild(btnAuto);
    const btnSync = document.createElement('button');
    btnSync.className = 'pcb-p-btn';
    btnSync.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> 原理图 → PCB 同步';
    btnSync.addEventListener('click', () => {
      const r = window.pcbSyncSchematic();
      Editor.status('同步完成: 新建 ' + r.created + ', 更新 ' + r.updated + ', 网络 ' + r.nets);
      refreshPanel(); refresh();
    });
    s.appendChild(btnSync);
    const list = section(body, '检查结果 (' + Editor.drcMarkers.length + ')');
    for (const m of Editor.drcMarkers.slice(0, 100)) {
      const item = document.createElement('div');
      item.className = 'pcb-check-item ' + m.severity;
      item.innerHTML = '<div class="t">' + m.type + '</div><div class="m">' + m.message + '</div>';
      item.addEventListener('click', () => {
        if (Editor.mode !== 'pcb') setMode('pcb');
        const r = PCBRender;
        r.view.panX = r.width / 2 / r.view.zoom - m.x;
        r.view.panY = r.height / 2 / r.view.zoom - m.y;
        refresh();
      });
      list.appendChild(item);
    }
  }

  function renderPropsPanel(body) {
    const s = section(body, '选中对象属性');
    if (!Editor.selection.size) {
      s.innerHTML += '<div class="pcb-p-item"><small>未选中对象</small></div>';
      const b2 = section(body, '工程信息');
      const stats = PCBModel.Board.stats(Doc.board(), PCBFootprints);
      b2.innerHTML += '<div class="pcb-prop-row"><label>工程</label><span>' + Doc.project.name + '</span></div>' +
        '<div class="pcb-prop-row"><label>元件</label><span>' + stats.components + ' (' + stats.pads + '焊盘)</span></div>' +
        '<div class="pcb-prop-row"><label>走线/过孔</label><span>' + stats.traces + ' / ' + stats.vias + '</span></div>' +
        '<div class="pcb-prop-row"><label>网络</label><span>' + stats.nets + ' (未布 ' + stats.unrouted + ')</span></div>' +
        '<div class="pcb-prop-row"><label>铜层</label><span>' + stats.layers + '</span></div>';
      return;
    }
    const id = Editor.selection.values().next().value;
    const b = Doc.board();
    const comp = b.components.find(c => c.id === id);
    if (comp) {
      const mkRow = (label, value, onChange, isSelect) => {
        const row = document.createElement('div');
        row.className = 'pcb-prop-row';
        row.innerHTML = '<label>' + label + '</label>';
        let input;
        if (isSelect) {
          input = document.createElement('select');
          for (const opt of isSelect) {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (opt === value) o.selected = true;
            input.appendChild(o);
          }
        } else {
          input = document.createElement('input');
          input.value = value;
        }
        input.addEventListener('change', () => {
          Doc.snapshot();
          onChange(input.value);
          Doc.touch(); refresh(); refreshPanel();
        });
        row.appendChild(input);
        s.appendChild(row);
      };
      mkRow('位号', comp.ref, v => { comp.ref = v; });
      mkRow('值', comp.value || '', v => { comp.value = v; });
      mkRow('封装', comp.footprint, v => {
        if (PCBFootprints.has(v)) { comp.footprint = v; comp.params = {}; }
      });
      mkRow('X (mm)', comp.x.toFixed(2), v => { comp.x = parseFloat(v) || comp.x; });
      mkRow('Y (mm)', comp.y.toFixed(2), v => { comp.y = parseFloat(v) || comp.y; });
      mkRow('旋转', comp.rot || 0, v => { comp.rot = (parseFloat(v) || 0) % 360; });
      mkRow('所在面', comp.side, v => { comp.side = v; }, ['F', 'B']);
      // pad nets
      const fp = PCBFootprints.generate(comp.footprint, comp.params || {});
      if (fp) {
        const pn = section(body, '焊盘网络');
        for (const pad of fp.pads) {
          const row = document.createElement('div');
          row.className = 'pcb-prop-row';
          row.innerHTML = '<label>Pad ' + pad.num + '</label>';
          const input = document.createElement('input');
          input.value = (comp.padNets && comp.padNets[String(pad.num)]) || '';
          input.placeholder = '(未连接)';
          input.addEventListener('change', () => {
            Doc.snapshot();
            PCBModel.Board.setPadNet(b, comp.ref, pad.num, input.value.trim());
            Doc.touch(); refresh();
          });
          row.appendChild(input);
          pn.appendChild(row);
        }
      }
      return;
    }
    const sym = Doc.sheet().symbols.find(x => x.id === id);
    if (sym) {
      const mkRow = (label, value, onChange) => {
        const row = document.createElement('div');
        row.className = 'pcb-prop-row';
        row.innerHTML = '<label>' + label + '</label>';
        const input = document.createElement('input');
        input.value = value;
        input.addEventListener('change', () => {
          Doc.snapshot();
          onChange(input.value);
          Doc.touch(); refresh(); refreshPanel();
        });
        row.appendChild(input);
        s.appendChild(row);
      };
      mkRow('位号', sym.ref, v => { sym.ref = v; });
      mkRow('值', sym.value || '', v => { sym.value = v; });
      mkRow('封装', sym.footprint || '', v => { if (PCBFootprints.has(v)) sym.footprint = v; });
      return;
    }
    s.innerHTML += '<div class="pcb-p-item"><small>该对象类型暂不支持属性编辑</small></div>';
  }

  // ---------------- live DRC (debounced) ----------------
  let liveDrc = true;
  let drcTimer = null;
  function scheduleLiveDrc() {
    if (!liveDrc || Editor.mode !== 'pcb') return;
    clearTimeout(drcTimer);
    drcTimer = setTimeout(() => {
      try {
        Editor.drcMarkers = PCBDrc.run(Doc.board(), PCBFootprints);
        const errs = Editor.drcMarkers.filter(m => m.severity === 'error').length;
        const warns = Editor.drcMarkers.length - errs;
        if (errs || warns) {
          Editor.status('实时DRC: ' + errs + ' 错误, ' + warns + ' 警告');
        }
        refresh();
        if (activePtab === 'check') refreshPanel();
      } catch (e) { /* keep editing uninterrupted */ }
    }, 900);
  }

  // ---------------- render orchestration ----------------
  function refresh() {
    refreshDocTitle();
    if (Editor.mode === 'pcb') {
      const b = Doc.board();
      PCBRender.render({
        board: b, fpLib: PCBFootprints,
        layerVisibility: Editor.layerVisibility,
        showRatsnest: Editor.showRatsnest,
        ratsnestLines: Editor.showRatsnest ? PCBModel.Board.ratsnest(b, PCBFootprints) : [],
        highlightNet: Editor.highlightNet || '',
        selection: Editor.selection,
        drcMarkers: Editor.drcMarkers,
        ghost: Editor.ghost()
      });
    } else if (Editor.mode === 'sch') {
      PCBSchRender.render({
        sheet: Doc.sheet(), symLib: PCBSymbols,
        selection: Editor.selection,
        ghost: Editor.ghost(),
        ercMarkers: Editor.ercMarkers
      });
    }
  }

  // ---------------- canvas wiring ----------------
  function wireCanvas(canvas) {
    canvas.addEventListener('mousedown', e => {
      const r = canvas.getBoundingClientRect();
      Editor.handleMouseDown(e, e.clientX - r.left, e.clientY - r.top);
    });
    window.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      if (e.clientX < r.left || e.clientY < r.top || e.clientX > r.right || e.clientY > r.bottom) {
        if (Editor.dragState) Editor.handleMouseMove(e, e.clientX - r.left, e.clientY - r.top);
        return;
      }
      Editor.handleMouseMove(e, e.clientX - r.left, e.clientY - r.top);
    });
    window.addEventListener('mouseup', e => {
      const r = canvas.getBoundingClientRect();
      Editor.handleMouseUp(e, e.clientX - r.left, e.clientY - r.top);
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      Editor.handleWheel(e, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    canvas.addEventListener('dblclick', e => {
      const r = canvas.getBoundingClientRect();
      Editor.handleDblClick(e, e.clientX - r.left, e.clientY - r.top);
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ---------------- file flows ----------------
  async function saveProjectFlow(forceDialog) {
    try {
      let path = Doc.filePath;
      if (forceDialog || !path) {
        const r = await window.pcbAPI.saveProjectDialog();
        if (!r || !r.ok) return false;
        path = r.path;
      }
      const res = await window.pcbAPI.saveProject(path, path.endsWith('.cibypcbproj'));
      if (res && res.ok) {
        Doc.filePath = path;
        Doc.modified = false;
        refreshDocTitle();
        Editor.status('工程已保存: ' + path);
        return true;
      }
      Editor.status('保存失败: ' + ((res && res.error) || '未知错误'));
      return false;
    } catch (e) {
      Editor.status('保存失败: ' + e.message);
      return false;
    }
  }

  async function openProjectFlow() {
    const r = await window.pcbAPI.loadProjectDialog();
    if (!r || !r.ok) return;
    const res = await window.pcbAPI.loadProject(r.path);
    if (res && res.ok) {
      Doc.filePath = r.path.endsWith('.cibypcbproj') || r.path.endsWith('.cipypcb') ? r.path : null;
      Editor.selection.clear();
      Editor.drcMarkers = []; Editor.ercMarkers = [];
      refreshDocTitle();
      refreshPanel(); refresh();
      Editor.fitView();
      Editor.status('已加载: ' + r.path);
    } else {
      Editor.status('加载失败: ' + ((res && res.error) || ''));
    }
  }

  async function importNetlistFlow() {
    const r = await window.pcbAPI.importFileDialog();
    if (!r || !r.ok) return;
    const res = await window.pcbImportData(r.name, r.content);
    if (res && res.ok) {
      Doc.modified = true;
      refreshPanel(); refresh();
      Editor.status('导入成功: ' + r.name + ' (' + res.type + ')');
      Editor.fitView();
    } else {
      Editor.status('导入失败: ' + ((res && res.error) || ''));
    }
  }

  // ---------------- export ----------------
  function initExport() {
    document.getElementById('btn-export').addEventListener('click', () => showModal('pcb-export-modal', true));
    document.getElementById('btn-export-cancel').addEventListener('click', () => showModal('pcb-export-modal', false));
    document.querySelectorAll('.pcb-exp-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        showModal('pcb-export-modal', false);
        await doExport(btn.dataset.exp);
      });
    });
  }

  async function doExport(kind) {
    const base = Doc.project.name || 'pcb';
    try {
      if (kind === 'gerber' || kind === 'gerber-dir') {
        const g = window.pcbGetGerberFiles(base, { naming: 'jlc' });
        if (!g.ok) { Editor.status('Gerber 生成失败: ' + g.error); return; }
        const d = await window.pcbAPI.exportDirDialog(base + '-gerber');
        if (!d || !d.ok) return;
        const zipName = kind === 'gerber' ? base + '-gerber.zip' : null;
        const res = await window.pcbAPI.exportFiles(d.path, g.files, zipName);
        Editor.status(res.ok ? ('Gerber 已导出: ' + (res.zipPath || d.path) + ' (' + g.files.length + ' 个文件)') : ('导出失败: ' + res.error));
        return;
      }
      const textExports = {
        'kicad': () => ({ name: base + '.kicad_pcb', content: window.pcbGetKicadPcb().content, filter: 'KiCad PCB' }),
        'netlist-kicad': () => ({ name: base + '.net', content: window.pcbGetNetlist('kicad').content, filter: 'KiCad Netlist' }),
        'netlist-csv': () => ({ name: base + '-netlist.csv', content: window.pcbGetNetlist('csv').content, filter: 'CSV' }),
        'pnp': () => ({ name: base + '-PnP.csv', content: PCBGerber.emitPnP(Doc.board()), filter: 'CSV' }),
        'bom': () => ({ name: base + '-BOM.csv', content: PCBGerber.emitBOM(Doc.board()), filter: 'CSV' }),
        'svg-pcb': () => ({ name: base + '-pcb.svg', content: window.pcbGetSVGString('pcb').svg, filter: 'SVG' }),
        'svg-sch': () => ({ name: base + '-sch.svg', content: window.pcbGetSVGString('sch').svg, filter: 'SVG' })
      };
      if (textExports[kind]) {
        const f = textExports[kind]();
        const d = await window.pcbAPI.saveFileDialog(f.name, f.filter);
        if (!d || !d.ok) return;
        const res = await window.pcbAPI.writeFile(d.path, f.content);
        Editor.status(res.ok ? ('已导出: ' + d.path) : ('导出失败: ' + res.error));
        return;
      }
      if (kind === 'png-pcb' || kind === 'png-3d') {
        const r = window.pcbGetPNGDataUrl(kind === 'png-3d' ? '3d' : 'pcb', 1920);
        const d = await window.pcbAPI.saveFileDialog(base + (kind === 'png-3d' ? '-3d.png' : '-pcb.png'), 'PNG');
        if (!d || !d.ok) return;
        const res = await window.pcbAPI.writeFileBase64(d.path, r.dataUrl.replace(/^data:image\/\w+;base64,/, ''));
        Editor.status(res.ok ? ('已导出: ' + d.path) : ('导出失败: ' + res.error));
        return;
      }
      if (kind === 'obj') {
        const r = window.pcbGet3DOBJ(base);
        const d = await window.pcbAPI.saveFileDialog(base + '.obj', 'OBJ 3D');
        if (!d || !d.ok) return;
        let res = await window.pcbAPI.writeFile(d.path, r.data.obj);
        if (res.ok) {
          const mtlPath = d.path.replace(/\.obj$/i, '.mtl');
          await window.pcbAPI.writeFile(mtlPath, r.data.mtl);
        }
        Editor.status(res.ok ? ('已导出: ' + d.path) : ('导出失败: ' + res.error));
        return;
      }
    } catch (e) {
      Editor.status('导出失败: ' + e.message);
    }
  }

  // ---------------- command line ----------------
  function initCommandLine() {
    const input = document.getElementById('pcb-cmd');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cmd = input.value.trim();
        if (!cmd) return;
        const r = window.pcbExecuteCommand(cmd);
        if (r.ok) {
          Editor.status('✓ ' + cmd + (r.error ? '' : ''));
          input.value = '';
        } else {
          Editor.status('✗ ' + (r.error || '命令失败'));
        }
        refreshPanel(); refresh(); refreshDocTitle();
        e.stopPropagation();
      }
    });
  }

  // ---------------- misc toolbar buttons ----------------
  function initButtons() {
    document.getElementById('btn-new').addEventListener('click', () => {
      if (Doc.modified && !confirm('当前工程有未保存更改，确定新建？')) return;
      Doc.reset('Untitled', 100, 80, 2);
      Editor.selection.clear();
      refreshDocTitle(); refreshPanel(); refresh();
    });
    document.getElementById('btn-open').addEventListener('click', openProjectFlow);
    document.getElementById('btn-save').addEventListener('click', () => saveProjectFlow(true));
    document.getElementById('btn-import-netlist').addEventListener('click', importNetlistFlow);
    document.getElementById('btn-undo').addEventListener('click', () => { Doc.undo(); refreshPanel(); refresh(); });
    document.getElementById('btn-redo').addEventListener('click', () => { Doc.redo(); refreshPanel(); refresh(); });
    document.getElementById('btn-fit').addEventListener('click', () => Editor.fitView());
  }

  // ---------------- autosave (non-blocking restore banner; default = ignore, never blocks Agent) ----------------
  function initAutosave() {
    try {
      const saved = localStorage.getItem('cibyp-pcbeda-autosave');
      if (saved) {
        const data = JSON.parse(saved);
        if (data && data.kind === 'cibyp-pcb-project') {
          const banner = document.getElementById('pcb-restore-banner');
          banner.classList.remove('hidden');
          const hide = () => banner.classList.add('hidden');
          // 默认不恢复：超时自动隐藏
          const timer = setTimeout(hide, 12000);
          document.getElementById('btn-restore-yes').addEventListener('click', () => {
            clearTimeout(timer);
            try { Doc.loadJSON(data); Doc.modified = true; refreshDocTitle(); refreshPanel(); refresh(); } catch (e) { /* ignore */ }
            hide();
          });
          document.getElementById('btn-restore-no').addEventListener('click', () => { clearTimeout(timer); hide(); });
        }
      }
    } catch (e) { /* ignore */ }
    setInterval(() => {
      try {
        if (Doc.modified) localStorage.setItem('cibyp-pcbeda-autosave', JSON.stringify(Doc.project));
        else localStorage.removeItem('cibyp-pcbeda-autosave');
      } catch (e) { /* quota */ }
    }, 15000);
  }

  // ---------------- boot ----------------
  function start() {
    applyTheme().then(() => refresh());
    Editor.onRefresh = refresh;
    Editor.onStatus = (t) => { document.getElementById('pcb-status').textContent = t; };
    Editor.onPanel = refreshPanel;
    Editor.onModified = refreshDocTitle;
    Doc.onChange = scheduleLiveDrc;

    PCBSchRender.init(document.getElementById('sch-canvas'));
    PCBRender.init(document.getElementById('pcb-canvas'));
    PCB3D.init(document.getElementById('td-canvas'));
    wireCanvas(document.getElementById('sch-canvas'));
    wireCanvas(document.getElementById('pcb-canvas'));

    initWindowControls();
    initViewTabs();
    initPanel();
    initCommandLine();
    initButtons();
    initExport();
    initAutosave();

    document.addEventListener('keydown', (e) => {
      const consumed = Editor.handleKeyDown(e);
      if (consumed) { e.preventDefault(); refreshDocTitle(); }
    });

    setMode('sch');
    refreshDocTitle();
    Editor.fitView();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
