/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Computer Use（nut-js 键鼠控制 / 屏幕截图 / UI 树 / 系统信息 / shell 打开）。
 * 通过工厂函数注入 ipcMain 与图片目录访问器，避免依赖主进程全局状态。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, shell, screen, desktopCapturer, nativeImage, systemPreferences } = require('electron');
const { recognizeImageDetailed } = require('./ocr');
const { createMacComputer } = require('./services/macos-computer');
const { createComputerPermissions } = require('./services/computer-permissions');
const { toDesktopPoint } = require('./services/computer-coordinates');

module.exports = function registerComputerUseIpc({ ipcMain, getImagesDir, getVmService, getSettings, persistSettings }) {
  /**
   * 运行位置=虚拟机：电脑控制（截图/键鼠/剪贴板）作用于虚拟机（Xvfb + xdotool/xclip），
   * 返回图形控制器；非 VM 模式返回 null（走宿主实现）。
   * 这是沙盒边界：VM 模式下绝不允许落到宿主桌面。
   */
  const vmComputer = () => {
    try {
      const svc = typeof getVmService === 'function' ? getVmService() : null;
      if (!require('./vm/tool-location').isVmOperation(() => svc)) return null;
      return svc.graphicsController();
    } catch (error) { throw new Error('无法确定 VM 执行位置: ' + error.message); }
  };
  const VM_UI_GAP = 'VM 模式下该动作依赖宿主 UI 自动化（UIA/OCR），已禁用以免操作宿主机；可用：截图/键鼠注入（xdotool）、VM 桌面窗口、终端与浏览器工具';
  let macComputer;
  const getMacComputer = () => macComputer ||= createMacComputer();
  const permissions = createComputerPermissions({ platform: process.platform, preferences: systemPreferences, app, shell,
    getSettings: getSettings || (() => ({})), persistSettings: persistSettings || (() => {}),
    nativeStatus: () => getMacComputer().invoke('permissions'),
    nativeRequest: permission => getMacComputer().invoke('requestPermission', { permission }) });
  const originalIpc = ipcMain;
  const inputChannels = new Set(['computer:mouseMove', 'computer:click', 'computer:drag', 'computer:type', 'computer:key', 'computer:scroll', 'computer:clickElement']);
  const captureChannels = new Set(['computer:screenshot', 'computer:ocr', 'screenshot:take']);
  // VM routing is checked FIRST. Neither permission reads nor requests touch the host in VM mode.
  let inputQueue = Promise.resolve();
  ipcMain = { handle(channel, handler) {
    originalIpc.handle(channel, async (...args) => {
      const run = async () => {
        try {
          if (!vmComputer()) {
            const denied = inputChannels.has(channel) ? permissions.check('input') : captureChannels.has(channel) ? permissions.check('screen') : null;
            if (denied) return denied;
          }
          return await handler(...args);
        } catch (error) { return { ok: false, code: error.code || 'computer_error', error: error.message }; }
      };
      // Avoid overlapping drags/key chords from multiple sessions leaving input held.
      if (!inputChannels.has(channel)) return run();
      const pending = inputQueue.then(run, run); inputQueue = pending.then(() => {}, () => {}); return pending;
    });
  } };
  ipcMain.handle('computer:permissions', () => vmComputer() ? { ok: true, location: 'vm', ready: true, platform: 'linux', accessibility: 'not-required', screen: 'not-required' } : permissions.status());
  ipcMain.handle('computer:requestPermission', (_, permission) => vmComputer() ? { ok: false, error: 'VM 模式不请求宿主权限', location: 'vm' } : permissions.request(permission));
  ipcMain.handle('computer:openPermissionSettings', (_, permission) => vmComputer() ? { ok: false, error: 'VM 模式不打开宿主设置', location: 'vm' } : permissions.openSettings(permission));
// ---- Computer Use Protocol (CUP) ----
// Lazy-loaded nut-js for mouse/keyboard control
let _nutLoaded = null;
let _nutError = null;
async function _getNut() {
  if (process.platform === 'darwin') return getMacComputer();
  if (_nutLoaded === null) {
    try {
      const nut = require('@nut-tree-fork/nut-js');
      _nutLoaded = nut;
    } catch (e) {
      _nutLoaded = false;
      _nutError = e;
    }
  }
  if (_nutLoaded === false) throw new Error('键鼠控制原生库加载失败：' + (_nutError?.message || 'unknown error'));
  return _nutLoaded;
}

// Key name mapping: CUP key names → nut-js Key enum
function _cupKeyToNutKey(keyStr) {
  const map = {
    'return': 'Enter', 'enter': 'Enter',
    'tab': 'Tab', 'space': 'Space', 'backspace': 'Backspace',
    'escape': 'Escape', 'esc': 'Escape', 'delete': 'Delete',
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
    'capslock': 'CapsLock', 'insert': 'Insert',
    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
    'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
    'ctrl': 'LeftControl', 'control': 'LeftControl',
    'alt': 'LeftAlt', 'option': 'LeftAlt',
    'shift': 'LeftShift', 'cmd': 'LeftSuper', 'command': 'LeftSuper', 'meta': 'LeftSuper', 'win': 'LeftSuper',
    'super': 'LeftSuper'
  };
  return map[keyStr.toLowerCase()] || keyStr;
}

// ---- 显示器/坐标基础 ----
// Screenshot pixels are display-local. macOS input/AX uses desktop points;
// Windows/Linux input uses desktop pixels. Every pointer action shares one mapping.
let _lastCapture = null;
let _lastElementSnapshot = null;

function _displayList() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, index) => {
    const scale = Number(d.scaleFactor) || 1;
    const physical = {
      x: process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }).x : Math.round(d.bounds.x * scale),
      y: process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }).y : Math.round(d.bounds.y * scale),
      width: Math.round(d.size.width * scale),
      height: Math.round(d.size.height * scale),
    };
    return {
      id: d.id,
      index,
      primary: d.id === primaryId,
      scaleFactor: scale,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
      physical,
    };
  });
}

function _findDisplay(displayId) {
  const displays = _displayList();
  if (displayId === undefined || displayId === null || displayId === '') {
    return displays.find((d) => d.primary) || displays[0];
  }
  const wanted = String(displayId);
  const display = displays.find((d) => String(d.id) === wanted) || displays.find((d) => String(d.index) === wanted);
  if (!display) throw new Error('Display not found: ' + wanted);
  return display;
}

function _ensureDir(dir, fallback) {
  const target = dir && fs.existsSync(dir) ? dir : fallback;
  try { fs.mkdirSync(target, { recursive: true }); } catch { /* ignore */ }
  return target;
}

async function _grabScreen(options = {}) {
  const denied = permissions.check('screen');
  if (denied) { const error = new Error(denied.error); error.code = denied.code; throw error; }
  const display = _findDisplay(options.displayId ?? options.display_id);
  const thumbW = Math.max(1, display.physical.width);
  const thumbH = Math.max(1, display.physical.height);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbW, height: thumbH },
  });
  if (!sources.length) throw new Error('no screen source available');
  let source = null;
  if (display.id != null) {
    source = sources.find((s) => String(s.display_id) === String(display.id));
  }
  if (!source && sources.length === 1 && screen.getAllDisplays().length === 1) source = sources[0];
  if (!source) throw new Error('Requested display has no capture source');
  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error('capture returned an empty image');
  const size = image.getSize();
  return { image, width: size.width, height: size.height, display };
}

async function _captureScreen(workspacePath, options = {}) {
  const grabbed = await _grabScreen(options);
  const targetDir = _ensureDir(workspacePath, getImagesDir());
  const imgPath = path.join(targetDir, `computer_screenshot_${Date.now()}.png`);
  fs.writeFileSync(imgPath, grabbed.image.toPNG());
  const capture = {
    path: imgPath,
    width: grabbed.width,
    height: grabbed.height,
    display: grabbed.display,
    // 截图像素 → 物理虚拟桌面坐标的换算（nut-js 使用物理坐标）
    origin: { x: grabbed.display.physical.x, y: grabbed.display.physical.y },
    capturedAt: Date.now(),
  };
  _lastCapture = capture;
  return capture;
}

ipcMain.handle('computer:listDisplays', () => {
  const g = vmComputer();
  if (g) {
    const s = g.screenSize();
    return { ok: true, displays: [{ id: 1, idString: 'vm-display-:99', name: '虚拟机桌面', bounds: { x: 0, y: 0, width: s.width, height: s.height }, size: { width: s.width, height: s.height }, scaleFactor: 1, rotation: 0, internal: false, primary: true, location: 'vm' }] };
  }
  try { return { ok: true, displays: _displayList() }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:screenshot', async (_, workspacePath, options = {}) => {
  const g = vmComputer();
  if (g) {
    try {
      const cap = await g.capture({ workspacePath });
      return { ok: true, path: cap.path, vmPath: cap.vmPath, width: cap.width, height: cap.height, display: 1, origin: { x: 0, y: 0 }, coordinateSpace: 'screenshot-pixels', annotated: false, location: 'vm' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  try {
    const capture = await _captureScreen(workspacePath, options || {});
    const annotate = options && options.annotate;
    return {
      ok: true,
      path: capture.path,
      width: capture.width,
      height: capture.height,
      display: capture.display,
      origin: capture.origin,
      coordinateSpace: 'screenshot-pixels',
      note: 'All pointer actions use screenshot-local pixels by default; macOS maps pixels to desktop points. Use coord_space=physical for native desktop coordinates.',
      annotated: false,
      annotationRequested: !!annotate,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:mouseMove', async (_, x, y, options = {}) => {
  const g = vmComputer();
  if (g) { try { return await g.mouseMove(x, y); } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    const point = _toPhysical({ x, y }, options.space || 'screenshot', options.displayId);
    await nut.mouse.setPosition(new nut.Point(point.x, point.y));
    return { ok: true, ...point };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:click', async (_, button, x, y, doubleClick, options = {}) => {
  const g = vmComputer();
  if (g) { try { await g.click(button, x, y, doubleClick); return { ok: true, button: button || 'left', doubleClick: !!doubleClick }; } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    if (x !== undefined && y !== undefined) {
      const point = _toPhysical({ x, y }, options.space || 'screenshot', options.displayId);
      await nut.mouse.setPosition(new nut.Point(point.x, point.y));
    }
    const btn = button === 'right' ? nut.Button.RIGHT
              : button === 'middle' ? nut.Button.MIDDLE
              : nut.Button.LEFT;
    if (doubleClick && nut.mouse.doubleClick) await nut.mouse.doubleClick(btn);
    else { await nut.mouse.click(btn); if (doubleClick) await nut.mouse.click(btn); }
    return { ok: true, button: button || 'left', doubleClick: !!doubleClick };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:drag', async (_, startX, startY, endX, endY, options = {}) => {
  const g = vmComputer();
  if (g) { try { await g.drag(startX, startY, endX, endY); return { ok: true, startX, startY, endX, endY }; } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  let pressed = false;
  try {
    const start = _toPhysical({ x: startX, y: startY }, options.space || 'screenshot', options.displayId);
    const end = _toPhysical({ x: endX, y: endY }, options.space || 'screenshot', options.displayId);
    startX = start.x; startY = start.y; endX = end.x; endY = end.y;
    await nut.mouse.setPosition(new nut.Point(Math.round(startX), Math.round(startY)));
    pressed = true;
    await nut.mouse.pressButton(nut.Button.LEFT);
    // Move in steps for smooth drag
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(startX + (endX - startX) * i / steps);
      const y = Math.round(startY + (endY - startY) * i / steps);
      await nut.mouse.setPosition(new nut.Point(x, y));
      await nut.sleep(20);
    }
    await nut.mouse.releaseButton(nut.Button.LEFT);
    return { ok: true, startX, startY, endX, endY };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { if (pressed) try { await nut.mouse.releaseButton(nut.Button.LEFT); } catch { /* best effort release */ } }
});

ipcMain.handle('computer:type', async (_, text) => {
  const g = vmComputer();
  if (g) { try { await g.typeText(text); return { ok: true, length: String(text || '').length }; } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    await nut.keyboard.type(text);
    return { ok: true, length: text.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:key', async (_, keyStr) => {
  const g = vmComputer();
  if (g) { try { await g.pressKey(keyStr); return { ok: true, key: keyStr }; } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    // Parse key combinations like "ctrl+c", "alt+tab", "Return"
    const parts = keyStr.split('+').map(k => k.trim());
    const keys = parts.map(_cupKeyToNutKey);
    // Resolve each key to nut.Key enum value
    const nutKeys = keys.map(k => {
      // 1) Try direct lookup (handles LeftControl, Enter, F1, etc.)
      const keyVal = nut.Key[k];
      if (keyVal !== undefined) return keyVal;
      // 2) Try uppercase single char (a -> Key.A, d -> Key.D)
      if (k.length === 1) {
        const upper = k.toUpperCase();
        const upperVal = nut.Key[upper];
        if (upperVal !== undefined) return upperVal;
      }
      // 3) Try uppercase multi-char (Tab -> Key.Tab already handled by map)
      const upVal = nut.Key[k.toUpperCase()];
      if (upVal !== undefined) return upVal;
      return null;
    });

    if (!nutKeys.length || nutKeys.some(k => k === null)) return { ok: false, error: `Unknown key: ${keyStr}` };

    // Press and release
    try { if (nutKeys.length === 1) {
      await nut.keyboard.pressKey(nutKeys[0]);
      await nut.keyboard.releaseKey(nutKeys[0]);
    } else {
      const modifiers = nutKeys.slice(0, -1);
      const mainKey = nutKeys[nutKeys.length - 1];
      await nut.keyboard.pressKey(...modifiers);
      await nut.keyboard.pressKey(mainKey);
      await nut.keyboard.releaseKey(mainKey);
      await nut.keyboard.releaseKey(...modifiers.reverse());
    } } finally { try { await nut.keyboard.releaseKey(...nutKeys.slice().reverse()); } catch { /* best effort release */ } }
    return { ok: true, key: keyStr };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:scroll', async (_, x, y, direction, amount, options = {}) => {
  const g = vmComputer();
  if (g) { try { await g.scroll(x, y, direction, amount); return { ok: true, direction, amount: Math.round(amount || 3) }; } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    if (x !== undefined && y !== undefined) {
      const point = _toPhysical({ x, y }, options.space || 'screenshot', options.displayId);
      await nut.mouse.setPosition(new nut.Point(point.x, point.y));
    }
    const amt = Math.min(1000, Math.max(1, Math.round(Number(amount) || 3)));
    if (direction === 'down') {
      await nut.mouse.scrollDown(amt);
    } else if (direction === 'up') {
      await nut.mouse.scrollUp(amt);
    } else if (direction === 'right') {
      await nut.mouse.scrollRight(amt);
    } else if (direction === 'left') {
      await nut.mouse.scrollLeft(amt);
    } else {
      return { ok: false, error: `Unknown scroll direction: ${direction}` };
    }
    return { ok: true, direction, amount: amt };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:cursorPosition', async () => {
  const g = vmComputer();
  if (g) { try { return await g.cursorPosition(); } catch (e) { return { ok: false, error: e.message }; } }
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    const pos = await nut.mouse.getPosition();
    return { ok: true, x: pos.x, y: pos.y, coordinateSpace: process.platform === 'darwin' ? 'desktop-points' : 'desktop-pixels', note: 'Use coord_space=physical when reusing this position.' };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:wait', async (_, duration) => {
  const ms = Math.min(Math.max(Math.round((duration || 1) * 1000), 100), 10000);
  await new Promise(resolve => setTimeout(resolve, ms));
  return { ok: true, duration: ms / 1000 };
});

ipcMain.handle('computer:getScreenSize', async () => {
  const g = vmComputer();
  if (g) { const s = g.screenSize(); return { ok: true, width: s.width, height: s.height, location: 'vm' }; }
  try {
    const display = _findDisplay();
    return { ok: true, width: display.physical.width, height: display.physical.height, display, coordinateSpace: 'screenshot-pixels' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Cross-platform UI tree extraction helpers
function _execCmd(cmd, args, opts = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      ...opts
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error((stderr || '').trim() || err.message)); return; }
      resolve(stdout);
    });
  });
}

// Windows: inline PowerShell using UIAutomation COM via .NET
async function _getWindowsUITree() {
  // PowerShell script as inline string (no external .ps1 file needed)
  const psScript = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ErrorActionPreference = 'Stop'
$root = [System.Windows.Automation.AutomationElement]::FocusedElement
if (-not $root) { $root = [System.Windows.Automation.AutomationElement]::RootElement }
$i = 0; $els = @(); $trunc = $false
function Walk($el, $d) {
  if ($script:i -ge 300 -or $script:trunc) { $script:trunc = $true; return }
  if ($d -gt 15) { return }
  try {
    $cr = New-Object System.Windows.Automation.CacheRequest
    $cr.Add([System.Windows.Automation.AutomationElement]::NameProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
    $cr.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
    $cr.TreeScope = [System.Windows.Automation.TreeScope]::Element
    $cr.TreeFilter = [System.Windows.Automation.Condition]::TrueCondition
    $ce = $el.GetUpdatedCache($cr)
    $nm = $ce.Cached.Name
    $ct = $ce.Cached.ControlType
    $ctn = if ($ct) { $ct.ProgrammaticName -replace '^ControlType\\.','' } else { 'Unknown' }
    $aid = $ce.Cached.AutomationId
    $br = $ce.Cached.BoundingRectangle
    $en = $ce.Cached.IsEnabled
    $os = $ce.Cached.IsOffscreen
    if ($os -and $d -gt 0) { return }
    $val = $null
    try { $vp = $ce.GetCachedPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($vp) { $val = $vp.Cached.Value } } catch {}
    $acts = @()
    try { $sp = $ce.GetSupportedPatterns(); foreach ($p in $sp) { $pn = $p.ProgrammaticName; if ($pn -match 'Invoke') { $acts += 'invoke' } elseif ($pn -match 'Toggle') { $acts += 'toggle' } elseif ($pn -match 'SelectionItem') { $acts += 'select' } elseif ($pn -match 'ExpandCollapse') { $acts += 'expand' } elseif ($pn -match 'Value') { $acts += 'set_value' } elseif ($pn -match 'Scroll') { $acts += 'scroll' } } } catch {}
    $bb = $null
    if ($br.Width -gt 0 -and $br.Height -gt 0) { $bb = @{ x=[math]::Round($br.X); y=[math]::Round($br.Y); w=[math]::Round($br.Width); h=[math]::Round($br.Height); cx=[math]::Round($br.X+$br.Width/2); cy=[math]::Round($br.Y+$br.Height/2) } }
    $script:els += @{ index=$script:i; depth=$d; type=$ctn; name=$nm; value=$val; automationId=$aid; bbox=$bb; actions=$acts }
    $script:i++
    try { $w = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $ch = $w.GetFirstChild($ce); while ($ch -and -not $script:trunc) { Walk $ch ($d+1); $ch = $w.GetNextSibling($ch) } } catch {}
  } catch {}
}
Walk $root 0
@{ truncated=$trunc; count=$els.Count; elements=$els } | ConvertTo-Json -Depth 10 -Compress
`;
  const out = await _execCmd('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript
  ]);
  return JSON.parse(out.trim());
}

// macOS: in-process AX API; no System Events/AppleEvent permission chain.
async function _getMacUITree() {
  const denied = permissions.check('tree');
  if (denied) { const error = new Error(denied.error); error.code = denied.code; throw error; }
  return getMacComputer().getUITree();
}

// Linux: use Python pyatspi (AT-SPI) if available
async function _getLinuxUITree() {
  const pyScript = `
import json, sys
try:
    import pyatspi
except ImportError:
    print(json.dumps({"ok": False, "error": "pyatspi not installed. Install with: pip install pyatspi"}))
    sys.exit(0)

desktop = pyatspi.Registry.getDesktop(0)
elements = []
idx = [0]
trunc = [False]

def walk(el, d):
    if idx[0] >= 300 or d > 15:
        trunc[0] = True
        return
    try:
        role = el.getRoleName()
        name = el.name or ""
        desc = el.description or ""
        bb = el.getExtents()
        bbox = None
        if bb.width > 0 and bb.height > 0:
            bbox = {"x": bb.x, "y": bb.y, "w": bb.width, "h": bb.height, "cx": bb.x + bb.width // 2, "cy": bb.y + bb.height // 2}
        actions = []
        try:
            for i in range(el.nActions):
                an = el.getActionName(i)
                if an: actions.append(an.lower().replace(" ", "_"))
        except: pass
        val = None
        try:
            val = el.queryValue().currentValue
        except: pass
        elements.append({"index": idx[0], "depth": d, "type": role, "name": name, "value": val, "automationId": None, "bbox": bbox, "actions": actions})
        idx[0] += 1
        for i in range(el.childCount):
            if trunc[0]: break
            try:
                child = el[i]
                if child: walk(child, d + 1)
            except: pass
    except Exception:
        pass

# Start from focused application or desktop
try:
    focused = pyatspi.Registry.getFocus()
    if focused:
        walk(focused, 0)
    else:
        walk(desktop, 0)
except Exception:
    walk(desktop, 0)

print(json.dumps({"truncated": trunc[0], "count": len(elements), "elements": elements}))
`;
  // Try python3 first, then python
  let out;
  try {
    out = await _execCmd('python3', ['-c', pyScript]);
  } catch (e) {
    try {
      out = await _execCmd('python', ['-c', pyScript]);
    } catch (e2) {
      throw new Error('Python/pyatspi not available. Install with: pip install pyatspi (' + e2.message + ')');
    }
  }
  return JSON.parse(out.trim());
}

// ---- 元素层：UIA 树 + OCR 文本行融合 ----
function _rectCenter(bbox) {
  return { x: Math.round(bbox.x + bbox.w / 2), y: Math.round(bbox.y + bbox.h / 2) };
}

function _uiaToElements(tree) {
  const snapshotId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return ((tree && tree.elements) || []).map((el, i) => ({
    id: `uia-${snapshotId}-${el.index != null ? el.index : i}`,
    source: 'uia',
    name: String(el.name || ''),
    role: String(el.type || ''),
    value: el.value == null ? null : el.value,
    bbox: el.bbox ? { x: el.bbox.x, y: el.bbox.y, w: el.bbox.w, h: el.bbox.h } : null,
    center: el.bbox ? { x: el.bbox.cx, y: el.bbox.cy } : null,
    actions: Array.isArray(el.actions) ? el.actions : [],
    depth: el.depth,
  }));
}

async function _ocrToElements(workspacePath, options = {}) {
  const capture = await _captureScreen(workspacePath, options);
  const result = await recognizeImageDetailed(capture.path, { engine: options.engine });
  const scaleX = result.resized && result.width ? capture.width / result.width : 1;
  const scaleY = result.resized && result.height ? capture.height / result.height : 1;
  const elements = (result.lines || [])
    .filter((line) => line.bbox && line.text)
    .map((line, i) => {
      const bbox = {
        x: Math.round(line.bbox.x * scaleX),
        y: Math.round(line.bbox.y * scaleY),
        w: Math.round(line.bbox.w * scaleX),
        h: Math.round(line.bbox.h * scaleY),
      };
      return {
        id: `ocr-${path.basename(capture.path, '.png')}-${i}`,
        source: 'ocr',
        name: line.text,
        role: 'text',
        value: null,
        bbox,
        center: _rectCenter(bbox),
        confidence: line.confidence,
        actions: [],
      };
    });
  return { capture, engine: result.engine, elements };
}

async function _getPlatformUITree() {
  if (process.platform === 'win32') return _getWindowsUITree();
  if (process.platform === 'darwin') return _getMacUITree();
  return _getLinuxUITree();
}

async function _buildElementSnapshot(options = {}) {
  let tree = { elements: [], truncated: false, count: 0, error: null };
  if (!options.ocrOnly) {
    try {
      tree = await _getPlatformUITree();
    } catch (e) {
      tree = { elements: [], truncated: false, count: 0, error: e.message };
    }
  }
  const elements = _uiaToElements(tree);
  const uiaCount = elements.length;
  let ocr = null;
  const wantOcr = options.includeOcr === true || (options.includeOcr !== false && uiaCount < 5);
  if (wantOcr) {
    try {
      const result = await _ocrToElements(options.workspacePath, options);
      ocr = { engine: result.engine, count: result.elements.length, capture: result.capture };
      elements.push(...result.elements);
    } catch (e) {
      ocr = { engine: 'none', count: 0, error: e.message };
    }
  }
  const snapshot = {
    at: Date.now(),
    capture: (ocr && ocr.capture) || _lastCapture,
    elements,
    uiaCount,
    ocr,
    truncated: !!tree.truncated,
    uiaError: tree.error || null,
  };
  _lastElementSnapshot = snapshot;
  return snapshot;
}

ipcMain.handle('computer:getUITree', async (_, options = {}) => {
  if (vmComputer()) return { ok: false, error: VM_UI_GAP };
  try {
    const snapshot = await _buildElementSnapshot(options || {});
    if (!snapshot.elements.length && (snapshot.uiaError || snapshot.ocr?.error)) return {
      ok: false, code: 'ui_unavailable', error: snapshot.uiaError || snapshot.ocr.error,
      permissions: process.platform === 'darwin' ? permissions.status() : undefined,
    };
    return {
      ok: true,
      at: snapshot.at,
      truncated: snapshot.truncated,
      count: snapshot.elements.length,
      uiaCount: snapshot.uiaCount,
      ocr: snapshot.ocr ? { engine: snapshot.ocr.engine, count: snapshot.ocr.count, error: snapshot.ocr.error || null } : null,
      uiaError: snapshot.uiaError,
      capture: snapshot.capture ? { path: snapshot.capture.path, width: snapshot.capture.width, height: snapshot.capture.height, display: snapshot.capture.display, origin: snapshot.capture.origin } : null,
      elements: snapshot.elements,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:ocr', async (_, options = {}) => {
  if (vmComputer()) return { ok: false, error: VM_UI_GAP };
  try {
    const result = await _ocrToElements((options || {}).workspacePath, options || {});
    _lastCapture = result.capture;
    _lastElementSnapshot = { at: Date.now(), capture: result.capture, elements: result.elements, uiaCount: 0, ocr: { engine: result.engine, count: result.elements.length }, truncated: false, uiaError: null };
    return {
      ok: true,
      engine: result.engine,
      path: result.capture.path,
      width: result.capture.width,
      height: result.capture.height,
      display: result.capture.display,
      origin: result.capture.origin,
      count: result.elements.length,
      elements: result.elements,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:findElement', async (_, payload = {}) => {
  if (vmComputer()) return { ok: false, error: VM_UI_GAP };
  try {
    let snapshot = _lastElementSnapshot && (Date.now() - _lastElementSnapshot.at < 30000) ? _lastElementSnapshot : null;
    if (!snapshot || payload.refresh) {
      snapshot = await _buildElementSnapshot({ includeOcr: true, workspacePath: payload.workspacePath, displayId: payload.displayId, engine: payload.engine });
    }
    const query = String(payload.text || '').trim().toLowerCase();
    const source = payload.source ? String(payload.source) : '';
    const roleFilter = payload.role ? String(payload.role).toLowerCase() : '';
    let matches = snapshot.elements.filter((el) => {
      if (source && el.source !== source) return false;
      if (roleFilter && !String(el.role || '').toLowerCase().includes(roleFilter)) return false;
      if (!query) return true;
      return String(el.name || '').toLowerCase().includes(query);
    });
    if (!matches.length && query) {
      // 模糊兜底：按字符重合度排序（OCR 错字/空格差异）
      const chars = new Set(query.replace(/\s+/g, ''));
      matches = snapshot.elements
        .filter((el) => !source || el.source === source)
        .map((el) => {
          const name = String(el.name || '').toLowerCase();
          let hit = 0;
          for (const ch of chars) if (name.includes(ch)) hit++;
          return { el, score: chars.size ? hit / chars.size : 0 };
        })
        .filter((x) => x.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.el);
    }
    matches.sort((a, b) => {
      const aName = String(a.name || '').toLowerCase();
      const bName = String(b.name || '').toLowerCase();
      const aExact = aName === query ? 1 : 0;
      const bExact = bName === query ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      return aName.length - bName.length;
    });
    const nth = Number.isFinite(Number(payload.nth)) ? Number(payload.nth) : 0;
    const pick = matches[nth] || matches[0] || null;
    return {
      ok: true,
      query: payload.text || '',
      count: matches.length,
      matches: matches.slice(0, 20).map((el) => ({ id: el.id, source: el.source, name: el.name, role: el.role, bbox: el.bbox, center: el.center, confidence: el.confidence })),
      pick: pick ? { id: pick.id, source: pick.source, name: pick.name, center: pick.center, bbox: pick.bbox } : null,
      capture: snapshot.capture ? { path: snapshot.capture.path, width: snapshot.capture.width, height: snapshot.capture.height } : null,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

function _toPhysical(point, space, displayId) {
  const display = _findDisplay(displayId);
  const capture = _lastCapture && (displayId == null || String(_lastCapture.display.id) === String(display.id)) ? _lastCapture : null;
  return toDesktopPoint(point, { platform: process.platform, capture, display, space });
}

function _regionDiff(imageA, imageB, rect, step = 2) {
  try {
    const size = imageA.getSize();
    if (!size.width || !size.height) return { changed: 0, total: 0, ratio: 0 };
    const bmpA = imageA.toBitmap();
    const bmpB = imageB.toBitmap();
    const stride = size.width * 4;
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(size.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(size.height, Math.ceil(rect.y + rect.h));
    let changed = 0;
    let total = 0;
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = y * stride + x * 4;
        total++;
        const delta = Math.abs(bmpA[i] - bmpB[i]) + Math.abs(bmpA[i + 1] - bmpB[i + 1]) + Math.abs(bmpA[i + 2] - bmpB[i + 2]);
        if (delta > 36) changed++;
      }
    }
    return { changed, total, ratio: total ? changed / total : 0 };
  } catch {
    return { changed: 0, total: 0, ratio: 0 };
  }
}

async function _resolveElementTarget(payload) {
  if (payload.id && _lastElementSnapshot && Date.now() - _lastElementSnapshot.at < 30000) {
    const hit = _lastElementSnapshot.elements.find((el) => el.id === payload.id);
    if (hit && hit.center) return { center: hit.center, element: hit };
  }
  if (payload.id) return null; // an expired/unknown ID must never fall through to an unrelated point
  if (payload.text) {
    const result = await (async () => {
      let snapshot = _lastElementSnapshot && (Date.now() - _lastElementSnapshot.at < 30000) ? _lastElementSnapshot : null;
      if (!snapshot) snapshot = await _buildElementSnapshot({ includeOcr: true, workspacePath: payload.workspacePath, displayId: payload.displayId });
      const query = String(payload.text).trim().toLowerCase();
      const nth = Number.isFinite(Number(payload.nth)) ? Number(payload.nth) : 0;
      const matches = snapshot.elements.filter((el) => String(el.name || '').toLowerCase().includes(query));
      const pick = matches[nth] || matches[0] || null;
      return pick ? { center: pick.center, element: pick } : null;
    })();
    if (result && result.center) return result;
  }
  if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
    return { center: { x: Number(payload.x), y: Number(payload.y) }, element: null };
  }
  return null;
}

ipcMain.handle('computer:clickElement', async (_, payload = {}) => {
  if (vmComputer()) return { ok: false, error: VM_UI_GAP };
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    const resolved = await _resolveElementTarget(payload);
    if (!resolved) return { ok: false, error: 'element not found; call get_ui_tree/find_element/ocr first or provide x/y' };
    const space = payload.space || 'screenshot';
    const effectiveSpace = resolved.element?.source === 'uia' ? 'physical' : space;
    const physical = _toPhysical(resolved.center, effectiveSpace, payload.displayId);
    const button = payload.button === 'right' ? nut.Button.RIGHT : payload.button === 'middle' ? nut.Button.MIDDLE : nut.Button.LEFT;
    const verify = payload.verify !== false;
    let before = null;
    let beforeDisplay = null;
    let beforeSize = null;
    let beforeError = null;
    const targetDisplay = _displayList().find(display => {
      const bounds = process.platform === 'darwin' ? display.bounds : display.physical;
      return physical.x >= bounds.x && physical.y >= bounds.y && physical.x < bounds.x + bounds.width && physical.y < bounds.y + bounds.height;
    });
    const verifyDisplayId = payload.displayId ?? targetDisplay?.id;
    if (verify) {
      try {
        const grabbed = await _grabScreen({ displayId: verifyDisplayId });
        before = grabbed.image; beforeDisplay = grabbed.display; beforeSize = { width: grabbed.width, height: grabbed.height };
      } catch (error) { beforeError = error.message; }
    }
    await nut.mouse.setPosition(new nut.Point(physical.x, physical.y));
    if (payload.doubleClick && nut.mouse.doubleClick) await nut.mouse.doubleClick(button);
    else { await nut.mouse.click(button); if (payload.doubleClick) await nut.mouse.click(button); }
    let verification = beforeError ? { changed: null, error: beforeError } : null;
    if (verify && before) {
      await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(100, Number(payload.verifyWaitMs) || 350))));
      try {
        const grabbedAfter = await _grabScreen({ displayId: verifyDisplayId });
        // before/after 抓取的是目标显示器的完整截图；取点击点周围 80x80 区域
        // 做像素差异，判断 UI 是否发生可见变化。
        const checkedDisplay = beforeDisplay || _findDisplay(verifyDisplayId);
        const bounds = process.platform === 'darwin' ? checkedDisplay.bounds : checkedDisplay.physical;
        const regionCenter = {
          x: (physical.x - bounds.x) * beforeSize.width / bounds.width,
          y: (physical.y - bounds.y) * beforeSize.height / bounds.height,
        };
        if (grabbedAfter.width !== beforeSize.width || grabbedAfter.height !== beforeSize.height) throw new Error('Display dimensions changed during verification');
        const region = {
          x: Math.round(regionCenter.x - 40),
          y: Math.round(regionCenter.y - 40),
          w: 80,
          h: 80,
        };
        const diff = _regionDiff(before, grabbedAfter.image, region);
        verification = { changed: diff.ratio > 0.004, ratio: Number(diff.ratio.toFixed(4)) };
      } catch (e) {
        verification = { changed: null, error: e.message };
      }
    }
    return {
      ok: true,
      clicked: physical,
      screenshotPoint: resolved.center,
      space: effectiveSpace,
      target: resolved.element ? { id: resolved.element.id, source: resolved.element.source, name: resolved.element.name } : null,
      doubleClick: !!payload.doubleClick,
      verification,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Screenshot ----
ipcMain.handle('screenshot:take', async (_, workspacePath) => {
  const g = vmComputer();
  if (g) {
    try {
      const cap = await g.capture({ workspacePath });
      return { ok: true, path: cap.path, vmPath: cap.vmPath, width: cap.width, height: cap.height, display: 1, origin: { x: 0, y: 0 }, location: 'vm' };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  try {
    const capture = await _captureScreen(workspacePath, {});
    return { ok: true, path: capture.path, width: capture.width, height: capture.height, display: capture.display, origin: capture.origin };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: System Info ----
ipcMain.handle('system:info', () => ({
  ok: true,
  platform: process.platform, arch: process.arch, hostname: os.hostname(),
  cpus: os.cpus().length, totalMemory: os.totalmem(), freeMemory: os.freemem(),
  homeDir: os.homedir(), tempDir: os.tmpdir(), nodeVersion: process.versions.node,
  electronVersion: process.versions.electron
}));
ipcMain.handle('system:network', () => {
  try {
    const interfaces = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(interfaces)) {
      result[name] = addrs.map(a => ({ address: a.address, family: a.family, internal: a.internal }));
    }
    return { ok: true, interfaces: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---- IPC: Shell & Browser ----
ipcMain.handle('shell:openBrowser', async (_, url) => {
  try {
    if (vmComputer()) return getVmService().graphicsChromium({ url });
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('shell:openFileExplorer', async (_, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    // VM 模式：先把 VM 内的最新改动拉回宿主镜像，再打开宿主镜像（资源管理器无法直接浏览 VM 文件）
    const g = vmComputer();
    if (g) {
      const svc = typeof getVmService === 'function' ? getVmService() : null;
      const io = new (require('./vm/vm-fs').VmFs)({ vmService: svc });
      const target = io.resolveVmPath(p);
      if (!target.ok) return target;
      await g.start();
      return svc.instance.exec(`${g._wlEnv()} cibyp-files ${require('./vm/vm-paths').shellQuote(target.vm)} >/dev/null 2>&1 &`);
    }
    // 区分文件和目录：文件用 showItemInFolder 在资源管理器中定位并选中，
    // 目录用 openPath 直接打开。
    let isFile = false;
    try {
      const stat = require('fs').statSync(p);
      isFile = stat.isFile();
    } catch (_) { /* 路径不存在时按目录处理 */ }
    if (!require('fs').existsSync(p)) {
      return { ok: false, error: (g ? '虚拟机内文件尚未同步到宿主镜像（或路径不存在）: ' : '路径不存在: ') + p };
    }
    if (isFile) {
      shell.showItemInFolder(p);
    } else {
      shell.openPath(p);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

};
