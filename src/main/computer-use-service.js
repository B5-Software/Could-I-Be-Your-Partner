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
const { shell } = require('electron');

module.exports = function registerComputerUseIpc({ ipcMain, getImagesDir }) {
// ---- Computer Use Protocol (CUP) ----
// Lazy-loaded nut-js for mouse/keyboard control
let _nutLoaded = null;
async function _getNut() {
  if (_nutLoaded === null) {
    try {
      const nut = require('@nut-tree-fork/nut-js');
      _nutLoaded = nut;
    } catch (e) {
      _nutLoaded = false;
    }
  }
  return _nutLoaded;
}

// Key name mapping: CUP key names → nut-js Key enum
function _cupKeyToNutKey(keyStr) {
  const map = {
    'return': 'Enter', 'enter': 'Enter', 'return': 'Enter',
    'tab': 'Tab', 'space': 'Space', 'backspace': 'Backspace',
    'escape': 'Escape', 'esc': 'Escape', 'delete': 'Delete',
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
    'capslock': 'CapsLock', 'insert': 'Insert',
    'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
    'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
    'ctrl': 'LeftControl', 'control': 'LeftControl',
    'alt': 'LeftAlt', 'option': 'LeftAlt',
    'shift': 'LeftShift', 'cmd': 'LeftSuper', 'meta': 'LeftSuper', 'win': 'LeftSuper',
    'super': 'LeftSuper'
  };
  return map[keyStr.toLowerCase()] || keyStr;
}

ipcMain.handle('computer:screenshot', async (_, workspacePath) => {
  try {
    const sources = await require('electron').desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 1920, height: 1080 }
    });
    if (sources.length > 0) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : getImagesDir();
      const imgPath = path.join(targetDir, `computer_screenshot_${Date.now()}.png`);
      fs.writeFileSync(imgPath, sources[0].thumbnail.toPNG());
      return { ok: true, path: imgPath };
    }
    return { ok: false, error: '无法截取屏幕' };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:mouseMove', async (_, x, y) => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    await nut.mouse.setPosition(new nut.Point(Math.round(x), Math.round(y)));
    return { ok: true, x: Math.round(x), y: Math.round(y) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:click', async (_, button, x, y, doubleClick) => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    if (x !== undefined && y !== undefined) {
      await nut.mouse.setPosition(new nut.Point(Math.round(x), Math.round(y)));
    }
    const btn = button === 'right' ? nut.Button.RIGHT
              : button === 'middle' ? nut.Button.MIDDLE
              : nut.Button.LEFT;
    await nut.mouse.click(btn);
    if (doubleClick) await nut.mouse.click(btn);
    return { ok: true, button: button || 'left', doubleClick: !!doubleClick };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:drag', async (_, startX, startY, endX, endY) => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    await nut.mouse.setPosition(new nut.Point(Math.round(startX), Math.round(startY)));
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
});

ipcMain.handle('computer:type', async (_, text) => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    await nut.keyboard.type(text);
    return { ok: true, length: text.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:key', async (_, keyStr) => {
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
    }).filter(k => k !== null);

    if (nutKeys.length === 0) return { ok: false, error: `Unknown key: ${keyStr}` };

    // Press and release
    if (nutKeys.length === 1) {
      await nut.keyboard.pressKey(nutKeys[0]);
      await nut.keyboard.releaseKey(nutKeys[0]);
    } else {
      const modifiers = nutKeys.slice(0, -1);
      const mainKey = nutKeys[nutKeys.length - 1];
      await nut.keyboard.pressKey(...modifiers);
      await nut.keyboard.pressKey(mainKey);
      await nut.keyboard.releaseKey(mainKey);
      await nut.keyboard.releaseKey(...modifiers.reverse());
    }
    return { ok: true, key: keyStr };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:scroll', async (_, x, y, direction, amount) => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    if (x !== undefined && y !== undefined) {
      await nut.mouse.setPosition(new nut.Point(Math.round(x), Math.round(y)));
    }
    const amt = Math.round(amount || 3);
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
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    const pos = await nut.mouse.getPosition();
    return { ok: true, x: pos.x, y: pos.y };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('computer:wait', async (_, duration) => {
  const ms = Math.min(Math.max(Math.round((duration || 1) * 1000), 100), 10000);
  await new Promise(resolve => setTimeout(resolve, ms));
  return { ok: true, duration: ms / 1000 };
});

ipcMain.handle('computer:getScreenSize', async () => {
  const nut = await _getNut();
  if (!nut) return { ok: false, error: 'nut-js not available' };
  try {
    const w = await nut.screen.width();
    const h = await nut.screen.height();
    return { ok: true, width: w, height: h };
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

// macOS: use osascript (AppleScript) via System Events to enumerate UI elements
async function _getMacUITree() {
  const scpt = `
on walk(el, d, maxD, maxN)
  set output to ""
  set cnt to 0
  if d > maxD then return ""
  try
    set kids to UI elements of el
  on error
    set kids to {}
  end try
  repeat with k in kids
    if cnt >= maxN then
      set output to output & "TRUNCATED"
      return output
    end if
    try
      set kClass to class of k as text
      set kName to ""
      set kDesc to ""
      set kVal to ""
      set kRole to ""
      try
        set kRole to role of k
      end try
      try
        set kName to name of k
      end try
      try
        set kDesc to description of k
      end try
      try
        set kVal to value of k
      end try
      set kPos to ""
      try
        set kPos to position of k
      end try
      set kSize to ""
      try
        set kSize to size of k
      end try
      set posStr to ""
      if kPos is not "" and kSize is not "" then
        set px to item 1 of kPos
        set py to item 2 of kPos
        set sw to item 1 of kSize
        set sh to item 2 of kSize
        set cx to px + sw / 2
        set cy to py + sh / 2
        set posStr to "BBOX:" & (px as integer) & "," & (py as integer) & "," & (sw as integer) & "," & (sh as integer) & "," & (cx as integer) & "," & (cy as integer)
      end if
      set indent to ""
      repeat d times
        set indent to indent & "  "
      end repeat
      set output to output & indent & "- [" & kRole & "] " & kName & " | " & kClass & " | " & kVal & " | " & kDesc & " | " & posStr & linefeed
      set output to output & my walk(k, d + 1, maxD, maxN)
      set cnt to cnt + 1
    end try
  end repeat
  return output
end walk

tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set winList to windows of frontApp
  set output to ""
  if (count of winList) > 0 then
    set w to item 1 of winList
    set winName to name of w
    set output to "- [AXWindow] " & winName & linefeed
    set output to output & my walk(w, 1, 15, 300)
  end if
  return output
end tell
`;
  // osascript doesn't easily produce JSON; we get text and parse minimally
  let out;
  try {
    out = await _execCmd('osascript', ['-e', scpt]);
  } catch (e) {
    // Accessibility permission not granted or osascript failed
    // 只做静默检测，不再触发系统授权弹窗（启动时已按“只弹一次”策略处理）
    if (process.platform === 'darwin') {
      try { systemPreferences.isTrustedAccessibilityClient(false); } catch {}
      try { require('child_process').exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"'); } catch {}
    }
    throw new Error('macOS 无障碍权限未授权，请在系统设置 > 隐私与安全性 > 辅助功能中启用本应用后重试。原始错误: ' + e.message);
  }
  // Parse the text output into a structured form
  const lines = out.split('\n').filter(l => l.trim() && !l.startsWith('TRUNCATED'));
  const truncated = out.includes('TRUNCATED');
  const elements = [];
  let idx = 0;
  for (const line of lines) {
    const m = line.match(/^(\s*)- \[(\w+)\]\s*(.*?) \| (.+?) \| (.+?) \| (.+?) \| (.*)$/);
    if (!m) continue;
    const depth = Math.floor((m[1] || '').length / 2);
    const role = m[2];
    const name = m[3] || '';
    const cls = m[4] || '';
    const val = m[5] || '';
    const desc = m[6] || '';
    const bboxStr = m[7] || '';
    let bbox = null;
    if (bboxStr.startsWith('BBOX:')) {
      const parts = bboxStr.slice(5).split(',').map(Number);
      if (parts.length === 6) {
        bbox = { x: parts[0], y: parts[1], w: parts[2], h: parts[3], cx: parts[4], cy: parts[5] };
      }
    }
    const actions = [];
    if (cls === 'button' || cls === 'Button') actions.push('invoke');
    if (cls === 'checkbox' || cls === 'CheckBox') actions.push('toggle');
    elements.push({ index: idx++, depth, type: role, name, value: val || null, automationId: null, bbox, actions });
  }
  return { truncated, count: elements.length, elements };
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

ipcMain.handle('computer:getUITree', async () => {
  try {
    let tree;
    if (process.platform === 'win32') {
      tree = await _getWindowsUITree();
    } else if (process.platform === 'darwin') {
      tree = await _getMacUITree();
    } else {
      tree = await _getLinuxUITree();
    }
    return { ok: true, ...tree };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- IPC: Screenshot ----
ipcMain.handle('screenshot:take', async (_, workspacePath) => {
  try {
    const sources = await require('electron').desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) {
      const targetDir = workspacePath && fs.existsSync(workspacePath) ? workspacePath : getImagesDir();
      const imgPath = path.join(targetDir, `screenshot_${Date.now()}.png`);
      fs.writeFileSync(imgPath, sources[0].thumbnail.toPNG());
      return { ok: true, path: imgPath };
    }
    return { ok: false, error: '无法截取屏幕' };
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
ipcMain.handle('shell:openBrowser', (_, url) => {
  try {
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('shell:openFileExplorer', (_, p) => {
  try {
    if (!p) return { ok: false, error: '路径为空' };
    // 区分文件和目录：文件用 showItemInFolder 在资源管理器中定位并选中，
    // 目录用 openPath 直接打开。
    let isFile = false;
    try {
      const stat = require('fs').statSync(p);
      isFile = stat.isFile();
    } catch (_) { /* 路径不存在时按目录处理 */ }
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
