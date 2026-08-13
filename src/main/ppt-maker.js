/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * PPT Maker：基于 pptxgenjs（MIT）生成可编辑的 .pptx。
 * 视觉风格跟随主窗口主题（强调色 + 深浅色模式），支持封面/目录/章节/
 * 内容卡片/图文分栏/表格/图表/KPI/引用/对比/时间线/结束页等版式。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MAX_SLIDES = 60;
const MAX_TABLE_ROWS = 30;
const MAX_TABLE_COLS = 12;
const MAX_CHART_POINTS = 24;
const MAX_CHART_SERIES = 6;
const MAX_BULLETS = 12;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

// 风格模板只决定装饰与辅助色，主配色（强调色、深浅背景）由主窗口主题注入
const THEMES = {
  modern: { secondary: '#23C9A6', deco: 'blocks' },
  corporate: { secondary: '#12294D', deco: 'lines' },
  gradient: { secondary: '#8C6BFF', deco: 'layers' },
  minimal: { secondary: '#7A8CA0', deco: 'plain' },
  tech: { secondary: '#22D3EE', deco: 'grid' },
  warm: { secondary: '#FF8A5C', deco: 'circles' }
};

const FONT_FAMILY = process.platform === 'darwin'
  ? 'PingFang SC'
  : (process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC');

function requirePptx() {
  try { return require('pptxgenjs'); } catch { return null; }
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16);
  if (!/^[0-9a-fA-F]{6}$/.test(full) || Number.isNaN(num)) return { r: 79, g: 140, b: 255 };
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgbToHex({ r, g, b }) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `${c(r)}${c(g)}${c(b)}`;
}

function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t
  });
}

function lighten(hex, t) { return mixHex(hex, '#FFFFFF', t); }
function darken(hex, t) { return mixHex(hex, '#000000', t); }

/**
 * 按主窗口主题构建调色板。
 * @param {{mode?:string, accentColor?:string}} appTheme 主进程 settings.theme
 * @param {boolean} nativeDark 系统是否深色
 */
function buildPalette(appTheme = {}, nativeDark = false) {
  const mode = appTheme.mode || 'system';
  const dark = mode === 'dark' || (mode === 'system' && nativeDark);
  const accentRaw = appTheme.accentColor || '#4f8cff';
  const accent = (() => {
    const { r, g, b } = hexToRgb(accentRaw);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // 深色底上强调色太暗会看不清，自动提亮；浅色底上太亮则压暗
    return dark
      ? (lum < 80 ? lighten(accentRaw, 0.45) : accentRaw)
      : (lum > 210 ? darken(accentRaw, 0.25) : accentRaw);
  })();

  return {
    dark,
    bg: dark ? '#12151E' : '#F7F9FC',
    bgDeep: dark ? '#0D1017' : '#EDF1F7',
    surface: dark ? '#1C222E' : '#FFFFFF',
    surfaceAlt: dark ? '#232B3A' : '#EEF3F9',
    text: dark ? '#F3F6FB' : '#1B2431',
    muted: dark ? '#A6B2C4' : '#5B6B7D',
    accent,
    accentContrast: dark ? '#0E1520' : '#FFFFFF',
    accentSoft: mixHex(accent, dark ? '#12151E' : '#F7F9FC', 0.82),
    line: dark ? '#303A4B' : '#DCE4EE',
    ok: dark ? '#4BD9A5' : '#1FA97B',
    bad: dark ? '#FF8A80' : '#D64545'
  };
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function cleanText(value, maxLen = 400) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maxLen);
}

function sanitizeFileName(name) {
  let n = cleanText(name, 120).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  if (!n) n = 'presentation';
  if (!/\.pptx$/i.test(n)) n += '.pptx';
  return n;
}

/**
 * 图片路径解析与安全校验：
 * - 相对路径基于工作区解析
 * - 解析后的真实路径必须位于工作区根目录内（防目录穿越）
 * - 仅允许常见图片扩展名与大小上限
 * @returns {{ok:true, abs:string} | {ok:false, error:string}}
 */
function resolveImagePath(imagePath, workspaceRoot) {
  const raw = cleanText(imagePath, 2000);
  if (!raw) return { ok: false, error: 'imagePath 为空' };
  let abs;
  try {
    abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceRoot || '', raw);
    if (fs.existsSync(abs)) abs = fs.realpathSync(abs);
  } catch (e) {
    return { ok: false, error: `图片路径无效：${e.message}` };
  }
  if (workspaceRoot) {
    const rootReal = fs.realpathSync(workspaceRoot);
    const rel = path.relative(rootReal, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: '图片必须位于工作区目录内' };
    }
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: `图片不存在：${raw}` };
  }
  const ext = path.extname(abs).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.emf', '.wmf'].includes(ext)) {
    return { ok: false, error: `不支持的图片格式：${ext}` };
  }
  const size = fs.statSync(abs).size;
  if (size > MAX_IMAGE_BYTES) {
    return { ok: false, error: `图片过大（上限 30MB）：${raw}` };
  }
  return { ok: true, abs };
}

/**
 * 校验并规范化一张幻灯片定义，返回 null 表示该页应跳过。
 */
function validateSlide(slide, index, workspaceRoot) {
  if (!slide || typeof slide !== 'object') throw new Error(`第 ${index + 1} 张幻灯片定义无效`);
  const type = cleanText(slide.type, 32).toLowerCase() || 'content';
  const base = { type, title: cleanText(slide.title || slide.heading || '', 160) };

  const images = [];
  const addImage = (p) => {
    if (!p) return;
    const r = resolveImagePath(p, workspaceRoot);
    if (!r.ok) throw new Error(`第 ${index + 1} 张幻灯片图片错误：${r.error}`);
    images.push(r.abs);
  };

  switch (type) {
    case 'cover':
    case 'end':
      base.subtitle = cleanText(slide.subtitle, 240);
      if (slide.imagePath) addImage(slide.imagePath);
      break;
    case 'agenda': {
      const items = Array.isArray(slide.items) ? slide.items : (Array.isArray(slide.bullets) ? slide.bullets : []);
      base.items = items.slice(0, 14).map(t => cleanText(t, 180)).filter(Boolean);
      break;
    }
    case 'section':
      base.subtitle = cleanText(slide.subtitle, 200);
      break;
    case 'content': {
      const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
      base.bullets = bullets.slice(0, MAX_BULLETS).map(t => cleanText(t, 300)).filter(Boolean);
      base.layout = cleanText(slide.layout, 32) || (slide.imagePath ? 'split' : 'bullets');
      if (slide.imagePath) addImage(slide.imagePath);
      if (base.layout === 'split' && !images.length) base.layout = 'bullets';
      break;
    }
    case 'twocolumn': {
      const cols = Array.isArray(slide.columns) ? slide.columns.slice(0, 2) : [];
      base.columns = cols.map(c => ({
        heading: cleanText(c && c.heading, 120),
        items: (Array.isArray(c && c.items) ? c.items : []).slice(0, 8).map(t => cleanText(t, 220)).filter(Boolean)
      }));
      if (!base.columns.length) base.columns = [{ heading: '', items: [] }, { heading: '', items: [] }];
      break;
    }
    case 'table': {
      const t = slide.table || {};
      const headers = (Array.isArray(t.headers) ? t.headers : []).slice(0, MAX_TABLE_COLS).map(h => cleanText(h, 80));
      const rows = (Array.isArray(t.rows) ? t.rows : []).slice(0, MAX_TABLE_ROWS)
        .map(r => (Array.isArray(r) ? r : []).slice(0, MAX_TABLE_COLS).map(c => cleanText(c, 200)));
      if (!headers.length && !rows.length) throw new Error(`第 ${index + 1} 张表格幻灯片缺少数据`);
      base.table = { headers, rows };
      break;
    }
    case 'chart': {
      const c = slide.chart || {};
      const chartType = cleanText(c.type, 24).toLowerCase();
      const allowed = ['bar', 'column', 'line', 'area', 'pie', 'doughnut'];
      if (!allowed.includes(chartType)) throw new Error(`第 ${index + 1} 张图表类型无效：${chartType || '(空)'}`);
      const labels = (Array.isArray(c.labels) ? c.labels : []).slice(0, MAX_CHART_POINTS).map(l => cleanText(l, 60));
      let series = Array.isArray(c.series) ? c.series : [];
      if (!series.length && Array.isArray(c.values)) series = [{ name: '', values: c.values }];
      series = series.slice(0, MAX_CHART_SERIES).map(s => {
        const values = (Array.isArray(s && s.values) ? s.values : []).slice(0, MAX_CHART_POINTS).map(v => {
          const n = Number(v);
          if (!Number.isFinite(n)) throw new Error(`第 ${index + 1} 张图表包含非数值数据`);
          return n;
        });
        if (!values.length) throw new Error(`第 ${index + 1} 张图表系列缺少数据`);
        return { name: cleanText(s && s.name, 80), values };
      });
      if (!series.length) throw new Error(`第 ${index + 1} 张图表缺少数据`);
      if (labels.length && series.some(s => s.values.length > labels.length)) {
        throw new Error(`第 ${index + 1} 张图表标签数量不足`);
      }
      base.chart = { type: chartType, labels, series };
      break;
    }
    case 'stats': {
      const stats = Array.isArray(slide.stats) ? slide.stats.slice(0, 5) : [];
      base.stats = stats.map(s => ({
        value: cleanText(s && s.value, 40),
        label: cleanText(s && s.label, 120)
      })).filter(s => s.value);
      if (!base.stats.length) throw new Error(`第 ${index + 1} 张数据卡幻灯片缺少数据`);
      break;
    }
    case 'quote':
      base.quote = cleanText(slide.quote || slide.text, 500);
      base.author = cleanText(slide.author, 160);
      if (!base.quote) throw new Error(`第 ${index + 1} 张引用幻灯片缺少内容`);
      break;
    case 'comparison': {
      const side = (obj) => ({
        title: cleanText(obj && obj.title, 120),
        items: (Array.isArray(obj && obj.items) ? obj.items : []).slice(0, 10).map(t => cleanText(t, 200)).filter(Boolean)
      });
      base.left = side(slide.left);
      base.right = side(slide.right);
      if (!base.left.title && !base.right.title) throw new Error(`第 ${index + 1} 张对比幻灯片缺少内容`);
      break;
    }
    case 'timeline': {
      const events = Array.isArray(slide.events) ? slide.events.slice(0, 8) : [];
      base.events = events.map(e => ({
        date: cleanText(e && e.date, 40),
        title: cleanText(e && e.title, 120),
        desc: cleanText(e && e.desc, 200)
      })).filter(e => e.title);
      if (!base.events.length) throw new Error(`第 ${index + 1} 张时间线幻灯片缺少事件`);
      break;
    }
    default:
      throw new Error(`第 ${index + 1} 张幻灯片类型不支持：${type}`);
  }

  base.notes = cleanText(slide.notes, 2000);
  if (images.length) base.images = images;
  return base;
}

function addDecoration(slide, P, palette, theme, style) {
  const accent = palette.accent;
  if (style === 'blocks') {
    slide.addShape(P.ShapeType.roundRect, { x: SLIDE_W - 1.9, y: 0.5, w: 1.15, h: 1.15, fill: { color: accent, transparency: 16 }, line: { type: 'none' }, rectRadius: 0.28, rotate: 8 });
    slide.addShape(P.ShapeType.roundRect, { x: SLIDE_W - 2.65, y: 1.35, w: 0.8, h: 0.8, fill: { color: theme.secondary, transparency: 24 }, line: { type: 'none' }, rectRadius: 0.22, rotate: -10 });
  } else if (style === 'circles') {
    slide.addShape(P.ShapeType.ellipse, { x: SLIDE_W - 1.7, y: -0.8, w: 2.2, h: 2.2, fill: { color: accent, transparency: 78 }, line: { type: 'none' } });
    slide.addShape(P.ShapeType.ellipse, { x: SLIDE_W - 3.1, y: 0.6, w: 1.1, h: 1.1, fill: { color: theme.secondary, transparency: 62 }, line: { type: 'none' } });
  } else if (style === 'lines') {
    slide.addShape(P.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.09, fill: { color: accent }, line: { type: 'none' } });
    slide.addShape(P.ShapeType.rect, { x: 0, y: 0.22, w: SLIDE_W, h: 0.028, fill: { color: palette.line }, line: { type: 'none' } });
  } else if (style === 'layers') {
    for (let i = 0; i < 3; i++) {
      slide.addShape(P.ShapeType.rect, {
        x: SLIDE_W - 0.6 - i * 0.55, y: 0.45 + i * 0.45, w: 0.42, h: 2.8 - i * 0.45,
        fill: { color: i === 0 ? accent : (i === 1 ? theme.secondary : palette.muted), transparency: 74 - i * 12 },
        line: { type: 'none' }
      });
    }
  } else if (style === 'grid') {
    for (let i = 0; i < 5; i++) {
      slide.addShape(P.ShapeType.rect, { x: SLIDE_W - 1.35 + i * 0.28, y: 0.35, w: 0.02, h: 1.5, fill: { color: accent, transparency: 70 - i * 10 }, line: { type: 'none' } });
    }
  }
}

function addChrome(slide, P, palette, theme, pageNum, total, title) {
  const style = theme.deco;
  addDecoration(slide, P, palette, theme, style);
  // 左侧强调条
  slide.addShape(P.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: SLIDE_H, fill: { color: palette.accent }, line: { type: 'none' } });
  // 页脚
  if (title) {
    slide.addText(title, { x: 0.55, y: SLIDE_H - 0.52, w: 8.5, h: 0.34, fontSize: 9, color: palette.muted, fontFace: FONT_FAMILY, align: 'left', valign: 'middle', breakLine: false });
  }
  slide.addText(String(pageNum).padStart(2, '0') + ' / ' + String(total).padStart(2, '0'), {
    x: SLIDE_W - 1.55, y: SLIDE_H - 0.52, w: 1.1, h: 0.34, fontSize: 9, color: palette.muted,
    fontFace: FONT_FAMILY, align: 'right', valign: 'middle', breakLine: false
  });
}

function addCover(s, d, P, palette, theme, pageNum, total, docMeta) {
  const accent = palette.accent;
  const hasImage = d.images && d.images.length;
  // 装饰
  s.addShape(P.ShapeType.ellipse, { x: 8.3, y: -2.2, w: 6.5, h: 6.5, fill: { color: accent, transparency: 12 }, line: { type: 'none' } });
  s.addShape(P.ShapeType.ellipse, { x: 11.3, y: 3.4, w: 3.2, h: 3.2, fill: { color: theme.secondary, transparency: 30 }, line: { type: 'none' } });
  s.addShape(P.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: SLIDE_H, fill: { color: accent }, line: { type: 'none' } });

  if (hasImage) {
    s.addImage({
      path: d.images[0], x: 7.6, y: 1.15, w: 4.9, h: 5.2,
      sizing: { type: 'cover', w: 4.9, h: 5.2 }, rounding: true
    });
    s.addShape(P.ShapeType.roundRect, { x: 7.35, y: 0.9, w: 5.4, h: 5.7, fill: { type: 'none' }, line: { color: accent, width: 2 }, rectRadius: 0.35 });
  }

  s.addText('PRESENTATION', { x: 0.75, y: 1.15, w: 6, h: 0.35, fontSize: 13, color: accent, bold: true, charSpacing: 5, fontFace: FONT_FAMILY });
  s.addText(d.title || '未命名演示文稿', { x: 0.72, y: 1.55, w: hasImage ? 6.5 : 11.9, h: 2.2, fontSize: 42, bold: true, color: palette.text, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
  if (d.subtitle) {
    s.addText(d.subtitle, { x: 0.75, y: 3.9, w: hasImage ? 6.4 : 11.6, h: 0.9, fontSize: 17, color: palette.muted, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
  }
  s.addShape(P.ShapeType.rect, { x: 0.77, y: 5.05, w: 0.62, h: 0.07, fill: { color: accent }, line: { type: 'none' } });
  const metaText = [docMeta.author && `作者 ${docMeta.author}`, docMeta.date].filter(Boolean).join('   ·   ');
  s.addText(metaText, { x: 0.75, y: 5.35, w: 8, h: 0.4, fontSize: 11, color: palette.muted, fontFace: FONT_FAMILY });
  addChrome(s, P, palette, theme, pageNum, total, '');
}

function addAgenda(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '目录', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const items = d.items || [];
  const startY = 1.85;
  const rowH = Math.min(0.86, (5.0 - items.length * 0.12) / Math.max(items.length, 1));
  items.forEach((text, i) => {
    const y = startY + i * (rowH + 0.18);
    const w = Math.min(11.7, 4.1 + text.length * 0.16);
    s.addShape(P.ShapeType.roundRect, { x: 0.75, y, w: Math.max(5.4, w), h: rowH, fill: { color: palette.surface }, line: { color: palette.line, width: 1 }, rectRadius: 0.16 });
    s.addShape(P.ShapeType.ellipse, { x: 1.0, y: y + rowH / 2 - 0.24, w: 0.48, h: 0.48, fill: { color: palette.accent }, line: { type: 'none' } });
    s.addText(String(i + 1).padStart(2, '0'), { x: 1.0, y: y + rowH / 2 - 0.24, w: 0.48, h: 0.48, align: 'center', valign: 'middle', fontSize: 13, bold: true, color: palette.accentContrast, fontFace: FONT_FAMILY });
    s.addText(text, { x: 1.72, y, w: Math.max(5.4, w) - 1.2, h: rowH, fontSize: 15, color: palette.text, fontFace: FONT_FAMILY, valign: 'middle', breakLine: true });
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addSection(s, d, P, palette, theme, pageNum, total) {
  s.background = { color: palette.accent };
  s.addShape(P.ShapeType.ellipse, { x: 8.4, y: -3.2, w: 8.5, h: 8.5, fill: { color: theme.secondary, transparency: 42 }, line: { type: 'none' } });
  s.addShape(P.ShapeType.ellipse, { x: -2.2, y: 4.4, w: 6, h: 6, fill: { color: palette.accentContrast, transparency: 88 }, line: { type: 'none' } });
  s.addText('SECTION', { x: 0.9, y: 1.55, w: 4, h: 0.4, fontSize: 13, color: palette.accentContrast, bold: true, charSpacing: 5, fontFace: FONT_FAMILY });
  s.addText(d.title || '章节', { x: 0.86, y: 2.0, w: 11.6, h: 1.6, fontSize: 46, bold: true, color: palette.accentContrast, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
  if (d.subtitle) {
    s.addText(d.subtitle, { x: 0.9, y: 4.05, w: 10.5, h: 0.8, fontSize: 17, color: mixHex(palette.accentContrast, palette.accent, 0.18), fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
  }
  s.addText(String(pageNum).padStart(2, '0'), { x: SLIDE_W - 2.4, y: SLIDE_H - 2.2, w: 1.8, h: 1.5, fontSize: 52, bold: true, color: mixHex(palette.accentContrast, palette.accent, 0.45), align: 'right', fontFace: FONT_FAMILY });
}

function bulletCards(slide, P, palette, bullets, x, y, w, h, startIdx = 0) {
  const n = bullets.length;
  if (!n) return;
  const rowH = Math.min(0.78, (h - (n - 1) * 0.16) / n);
  bullets.forEach((text, i) => {
    const by = y + i * (rowH + 0.16);
    slide.addShape(P.ShapeType.roundRect, { x, y: by, w, h: rowH, fill: { color: palette.surface }, line: { color: palette.line, width: 0.75 }, rectRadius: 0.13 });
    slide.addShape(P.ShapeType.ellipse, { x: x + 0.18, y: by + rowH / 2 - 0.105, w: 0.21, h: 0.21, fill: { color: palette.accent }, line: { type: 'none' } });
    slide.addText(text, { x: x + 0.55, y: by, w: w - 0.75, h: rowH, fontSize: 14.5, color: palette.text, fontFace: FONT_FAMILY, valign: 'middle', breakLine: false });
  });
}

function addContent(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '内容', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  s.addShape(P.ShapeType.rect, { x: 0.77, y: 1.5, w: 0.62, h: 0.07, fill: { color: palette.accent }, line: { type: 'none' } });
  const bullets = d.bullets || [];
  if (d.layout === 'split' && d.images && d.images.length) {
    const imgW = 4.7;
    s.addImage({ path: d.images[0], x: 0.78, y: 1.95, w: imgW, h: 4.55, sizing: { type: 'cover', w: imgW, h: 4.55 }, rounding: true });
    s.addShape(P.ShapeType.roundRect, { x: 0.62, y: 1.79, w: imgW + 0.32, h: 4.87, fill: { type: 'none' }, line: { color: palette.accent, width: 1.5 }, rectRadius: 0.22 });
    bulletCards(s, P, palette, bullets, 5.95, 2.05, 6.55, 4.3);
  } else {
    bulletCards(s, P, palette, bullets, 0.78, 1.95, 11.75, 4.55);
  }
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addTwoColumn(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const cols = d.columns || [];
  const colW = 5.72;
  cols.forEach((col, ci) => {
    const x = 0.78 + ci * (colW + 0.42);
    const headY = 1.72;
    s.addShape(P.ShapeType.roundRect, { x, y: headY, w: colW, h: 4.78, fill: { color: palette.surface }, line: { color: palette.line, width: 1 }, rectRadius: 0.18 });
    if (col.heading) {
      s.addShape(P.ShapeType.roundRect, { x, y: headY, w: colW, h: 0.72, fill: { color: palette.accent }, line: { type: 'none' }, rectRadius: 0.18 });
      s.addShape(P.ShapeType.rect, { x, y: headY + 0.36, w: colW, h: 0.36, fill: { color: palette.accent }, line: { type: 'none' } });
      s.addText(col.heading, { x: x + 0.18, y: headY, w: colW - 0.36, h: 0.72, fontSize: 16, bold: true, color: palette.accentContrast, fontFace: FONT_FAMILY, valign: 'middle', breakLine: false });
    }
    col.items.forEach((text, i) => {
      const by = headY + 0.95 + i * 0.62;
      s.addShape(P.ShapeType.ellipse, { x: x + 0.25, y: by + 0.13, w: 0.14, h: 0.14, fill: { color: palette.accent }, line: { type: 'none' } });
      s.addText(text, { x: x + 0.55, y: by - 0.02, w: colW - 0.8, h: 0.5, fontSize: 12.5, color: palette.text, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
    });
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addTableSlide(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '数据表', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const { headers, rows } = d.table;
  const colCount = Math.max(headers.length, ...rows.map(r => r.length), 1);
  const colW = 11.75 / colCount;
  const tableRows = [];
  if (headers.length) {
    tableRows.push(headers.map(h => ({ text: h, options: { fill: { color: palette.accent }, color: palette.accentContrast, bold: true, align: 'center', valign: 'middle', fontSize: 12.5, fontFace: FONT_FAMILY } })));
  }
  rows.forEach((r, ri) => {
    tableRows.push(r.map(c => ({
      text: c || ' ',
      options: {
        fill: { color: ri % 2 ? palette.surfaceAlt : palette.surface },
        color: palette.text, valign: 'middle', fontSize: 11.5, fontFace: FONT_FAMILY,
        align: colCount <= 4 ? 'center' : 'left'
      }
    })));
  });
  s.addTable(tableRows, {
    x: 0.78, y: 1.85, w: 11.75, colW: Array(colCount).fill(colW),
    rowH: headers.length ? 0.48 : 0.42,
    border: { type: 'solid', color: palette.line, pt: 0.75 },
    fill: { color: palette.surface },
    autoPage: false
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function chartTypeMap(P, type) {
  return {
    bar: [P.ChartType.bar, 'col'],
    column: [P.ChartType.bar, 'col'],
    line: [P.ChartType.line, null],
    area: [P.ChartType.area, null],
    pie: [P.ChartType.pie, null],
    doughnut: [P.ChartType.doughnut, null]
  }[type];
}

function addChartSlide(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '图表', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const c = d.chart;
  const [chartType, barDir] = chartTypeMap(P, c.type);
  const isPie = c.type === 'pie' || c.type === 'doughnut';
  const data = c.series.map(s => {
    const item = { name: s.name || '系列', values: s.values };
    if (!isPie && c.labels.length) item.labels = c.labels;
    return item;
  });
  const opts = {
    x: 0.75, y: 1.75, w: 11.75, h: 4.9,
    chartColors: [palette.accent, theme.secondary, lighten(palette.accent, 0.35), palette.ok, palette.bad, palette.muted],
    showLegend: !isPie && c.series.length > 1,
    legendPos: 'b',
    legendColor: palette.muted,
    legendFontSize: 10,
    catAxisLabelColor: palette.muted,
    valAxisLabelColor: palette.muted,
    catAxisLabelFontSize: 10,
    valAxisLabelFontSize: 10,
    valGridLine: { style: 'solid', color: palette.line },
    dataLabelColor: palette.text,
    dataLabelFontSize: 10,
    showValue: !isPie,
    showPercent: isPie,
    showTitle: false,
    chartArea: { fill: { color: palette.bg } },
    plotArea: { fill: { color: palette.bg } },
    barGapWidthPct: 45,
    catAxisLineShow: true,
    catAxisLineColor: palette.line,
    valAxisLineShow: false,
    lineSize: 2.5,
    lineSmooth: true,
    holeSize: c.type === 'doughnut' ? 55 : undefined
  };
  if (barDir) opts.barDir = barDir;
  s.addChart(chartType, data, opts);
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addStats(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '关键数据', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const stats = d.stats || [];
  const gap = 0.38;
  const w = (11.75 - gap * (stats.length - 1)) / stats.length;
  stats.forEach((stat, i) => {
    const x = 0.78 + i * (w + gap);
    s.addShape(P.ShapeType.roundRect, { x, y: 2.0, w, h: 3.6, fill: { color: palette.surface }, line: { color: palette.line, width: 1 }, rectRadius: 0.2 });
    s.addShape(P.ShapeType.rect, { x, y: 2.0, w, h: 0.16, fill: { color: palette.accent }, line: { type: 'none' } });
    s.addText(stat.value, { x: x + 0.2, y: 2.6, w: w - 0.4, h: 1.2, fontSize: 38, bold: true, color: palette.accent, align: 'center', fontFace: FONT_FAMILY, breakLine: false });
    s.addText(stat.label, { x: x + 0.25, y: 4.05, w: w - 0.5, h: 1.05, fontSize: 12.5, color: palette.muted, align: 'center', valign: 'top', fontFace: FONT_FAMILY, breakLine: true });
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addQuote(s, d, P, palette, theme, pageNum, total) {
  s.addShape(P.ShapeType.ellipse, { x: 8.6, y: -2.4, w: 7.2, h: 7.2, fill: { color: palette.accent, transparency: 14 }, line: { type: 'none' } });
  s.addText('“', { x: 0.7, y: 1.0, w: 2, h: 2.2, fontSize: 120, bold: true, color: palette.accent, fontFace: FONT_FAMILY });
  s.addText(d.quote, { x: 1.5, y: 2.35, w: 10.4, h: 2.6, fontSize: 27, bold: true, color: palette.text, align: 'center', valign: 'middle', fontFace: FONT_FAMILY, breakLine: true });
  s.addShape(P.ShapeType.rect, { x: 6.27, y: 5.35, w: 0.8, h: 0.06, fill: { color: palette.accent }, line: { type: 'none' } });
  if (d.author) {
    s.addText('— ' + d.author, { x: 2.5, y: 5.6, w: 8.4, h: 0.5, fontSize: 15, color: palette.muted, align: 'center', fontFace: FONT_FAMILY });
  }
  addChrome(s, P, palette, theme, pageNum, total, '');
}

function addComparison(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '对比', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const colW = 5.55;
  const sides = [
    { side: d.left, x: 0.78, accent: palette.accent },
    { side: d.right, x: 6.98, accent: theme.secondary }
  ];
  sides.forEach(({ side, x, accent }) => {
    s.addShape(P.ShapeType.roundRect, { x, y: 1.72, w: colW, h: 4.9, fill: { color: palette.surface }, line: { color: palette.line, width: 1 }, rectRadius: 0.18 });
    s.addShape(P.ShapeType.roundRect, { x, y: 1.72, w: colW, h: 0.68, fill: { color: accent }, line: { type: 'none' }, rectRadius: 0.18 });
    s.addShape(P.ShapeType.rect, { x, y: 2.06, w: colW, h: 0.34, fill: { color: accent }, line: { type: 'none' } });
    s.addText(side.title || ' ', { x: x + 0.18, y: 1.72, w: colW - 0.36, h: 0.68, fontSize: 16, bold: true, color: palette.accentContrast, fontFace: FONT_FAMILY, valign: 'middle', breakLine: false });
    side.items.forEach((text, i) => {
      const by = 2.68 + i * 0.6;
      s.addShape(P.ShapeType.ellipse, { x: x + 0.25, y: by + 0.1, w: 0.16, h: 0.16, fill: { color: accent }, line: { type: 'none' } });
      s.addText(text, { x: x + 0.55, y: by - 0.04, w: colW - 0.8, h: 0.5, fontSize: 12.5, color: palette.text, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
    });
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addTimeline(s, d, P, palette, theme, pageNum, total) {
  s.addText(d.title || '时间线', { x: 0.75, y: 0.72, w: 11.8, h: 0.72, fontSize: 30, bold: true, color: palette.text, fontFace: FONT_FAMILY });
  const events = d.events || [];
  const lineY = 3.6;
  s.addShape(P.ShapeType.rect, { x: 0.9, y: lineY - 0.025, w: 11.5, h: 0.05, fill: { color: palette.accent }, line: { type: 'none' } });
  const w = 11.5 / events.length;
  events.forEach((e, i) => {
    const cx = 0.9 + w * i + w / 2;
    s.addShape(P.ShapeType.ellipse, { x: cx - 0.18, y: lineY - 0.18, w: 0.36, h: 0.36, fill: { color: i % 2 ? theme.secondary : palette.accent }, line: { color: palette.bg, width: 2 } });
    const up = i % 2 === 0;
    const cardY = up ? lineY - 1.85 : lineY + 0.55;
    s.addShape(P.ShapeType.roundRect, { x: cx - w / 2 + 0.14, y: cardY, w: w - 0.28, h: 1.25, fill: { color: palette.surface }, line: { color: palette.line, width: 0.75 }, rectRadius: 0.14 });
    if (e.date) {
      s.addText(e.date, { x: cx - w / 2 + 0.24, y: cardY + 0.12, w: w - 0.48, h: 0.3, fontSize: 10.5, bold: true, color: palette.accent, fontFace: FONT_FAMILY, breakLine: false });
    }
    s.addText(e.title, { x: cx - w / 2 + 0.24, y: cardY + (e.date ? 0.4 : 0.16), w: w - 0.48, h: 0.78, fontSize: 12, bold: true, color: palette.text, fontFace: FONT_FAMILY, valign: 'top', breakLine: true });
  });
  addChrome(s, P, palette, theme, pageNum, total, d.title);
}

function addEnd(s, d, P, palette, theme, pageNum, total) {
  s.background = { color: palette.bgDeep };
  s.addShape(P.ShapeType.ellipse, { x: 8.7, y: -2.5, w: 7, h: 7, fill: { color: palette.accent, transparency: 18 }, line: { type: 'none' } });
  s.addShape(P.ShapeType.ellipse, { x: -1.8, y: 4.7, w: 5.2, h: 5.2, fill: { color: theme.secondary, transparency: 35 }, line: { type: 'none' } });
  s.addText(d.title || '谢谢观看', { x: 1, y: 2.15, w: 11.3, h: 1.6, fontSize: 46, bold: true, color: palette.text, align: 'center', fontFace: FONT_FAMILY, breakLine: true });
  if (d.subtitle) {
    s.addText(d.subtitle, { x: 2, y: 3.9, w: 9.3, h: 0.8, fontSize: 17, color: palette.muted, align: 'center', fontFace: FONT_FAMILY, breakLine: true });
  }
  s.addShape(P.ShapeType.rect, { x: 6.27, y: 4.95, w: 0.8, h: 0.07, fill: { color: palette.accent }, line: { type: 'none' } });
  addChrome(s, P, palette, theme, pageNum, total, '');
}

function uniqueOutputPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return filePath;
}

/**
 * 生成 PPTX。
 * @param {object} spec { title, subtitle, author, theme, filename, slides }
 * @param {object} options { workspacePath, appTheme, nativeDark }
 */
async function createPresentation(spec = {}, options = {}) {
  const Pptx = requirePptx();
  if (!Pptx) return { ok: false, error: '缺少 pptxgenjs 依赖' };

  const workspacePath = options.workspacePath;
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    return { ok: false, error: '工作区不存在，无法保存演示文稿' };
  }

  const slidesInput = Array.isArray(spec.slides) ? spec.slides : [];
  if (!slidesInput.length) return { ok: false, error: 'slides 不能为空' };
  if (slidesInput.length > MAX_SLIDES) return { ok: false, error: `单次最多生成 ${MAX_SLIDES} 张幻灯片` };

  const themeKey = cleanText(spec.theme, 24).toLowerCase();
  const theme = THEMES[themeKey] || THEMES.modern;
  const palette = buildPalette(options.appTheme || {}, !!options.nativeDark);
  const docMeta = {
    title: cleanText(spec.title, 200) || '演示文稿',
    author: cleanText(spec.author, 120),
    date: new Date().toISOString().slice(0, 10)
  };

  const slides = [];
  try {
    for (let i = 0; i < slidesInput.length; i++) {
      const v = validateSlide(slidesInput[i], i, workspacePath);
      if (v) slides.push(v);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!slides.length) return { ok: false, error: '没有有效的幻灯片' };

  const pptx = new Pptx();
  pptx.defineLayout({ name: 'WIDE', width: SLIDE_W, height: SLIDE_H });
  pptx.layout = 'WIDE';
  pptx.author = docMeta.author || 'CIBYP PPT Maker';
  pptx.title = docMeta.title;

  try {
    slides.forEach((slide, i) => {
      const s = pptx.addSlide();
      s.background = { color: palette.bg };
      const pageNum = i + 1;
      const total = slides.length;
      switch (slide.type) {
        case 'cover': addCover(s, slide, pptx, palette, theme, pageNum, total, docMeta); break;
        case 'agenda': addAgenda(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'section': addSection(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'content': addContent(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'twocolumn': addTwoColumn(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'table': addTableSlide(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'chart': addChartSlide(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'stats': addStats(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'quote': addQuote(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'comparison': addComparison(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'timeline': addTimeline(s, slide, pptx, palette, theme, pageNum, total); break;
        case 'end': addEnd(s, slide, pptx, palette, theme, pageNum, total); break;
      }
      if (slide.notes) s.addNotes(slide.notes);
    });

    const targetName = sanitizeFileName(spec.filename || (docMeta.title + '.pptx'));
    const targetPath = uniqueOutputPath(path.join(workspacePath, targetName));
    await pptx.writeFile({ fileName: targetPath });
    return {
      ok: true,
      path: targetPath,
      fileName: path.basename(targetPath),
      slideCount: slides.length,
      theme: themeKey,
      dark: palette.dark,
      accentColor: '#' + palette.accent
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  createPresentation,
  buildPalette,
  resolveImagePath,
  sanitizeFileName
};
