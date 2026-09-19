/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 生图（Image Generation）多厂商适配层：
 *   - PROVIDERS 预设：主流生图 API 的请求体 / 端点 / 响应形状（2026-09 核对官方文档）
 *   - buildImageRequest()：按 settings.imageGen.provider 构建端点 / 请求头 / 请求体
 *   - extractImages()：解析各厂商响应（b64_json / url / inlineData / 原始二进制），
 *     远程 URL 会下载为 Buffer
 *
 * 支持的规范：
 *   openai      OpenAI Images API（gpt-image-1.x/2、DALL·E；同时兼容 xAI Grok、智谱
 *               CogView、火山方舟、任意 OpenAI 兼容端点）
 *   siliconflow 硅基流动 / SD 风格（image_size/batch_size/num_inference_steps…）
 *   ark         火山方舟 Doubao Seedream（/api/v3/images/generations，size 支持 2K/4K/WxH）
 *   gemini      Google Gemini 原生生图（generateContent + responseModalities IMAGE，Nano Banana）
 *   imagen      Google Imagen（:predict）
 *   stability   Stability AI Stable Image（/v2beta/stable-image/generate/{core|ultra|sd3}）
 *   custom      自定义 JSON 模板（{{prompt}}/{{model}}/{{size}}/{{n}} 占位符），响应自动探测
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 180000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

// ---- 尺寸 / 宽高比工具 ----
function parseSize(size) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(size || '').trim());
  if (!m) return null;
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

const ASPECT_TABLE = [
  [1, 1, '1:1'], [16, 9, '16:9'], [9, 16, '9:16'], [3, 2, '3:2'], [2, 3, '2:3'],
  [4, 3, '4:3'], [3, 4, '3:4'], [4, 5, '4:5'], [5, 4, '5:4'], [21, 9, '21:9'], [9, 21, '9:21'],
];
function aspectRatioFor(size) {
  const p = parseSize(size);
  if (!p || !p.width || !p.height) return '1:1';
  const ratio = p.width / p.height;
  let best = '1:1';
  let bestDiff = Infinity;
  for (const [w, h, label] of ASPECT_TABLE) {
    const diff = Math.abs(ratio - w / h);
    if (diff < bestDiff) { bestDiff = diff; best = label; }
  }
  return best;
}

function extForMime(mime, fallback = 'png') {
  return MIME_EXT[String(mime || '').toLowerCase()] || fallback;
}

// ---- 各厂商预设 ----
const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI Images / 兼容端点',
    hint: 'gpt-image-2 / gpt-image-1.x / dall-e-3；也可填 xAI Grok、智谱 CogView、火山方舟等 OpenAI 兼容 images 端点',
    defaultUrl: 'https://api.openai.com/v1/images/generations',
    auth: 'bearer',
    models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3', 'dall-e-2'],
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512', '256x256'],
  },
  siliconflow: {
    id: 'siliconflow',
    label: 'SiliconFlow / SD 风格端点',
    hint: '硅基流动及 Stable Diffusion 风格 /images/generations（image_size / batch_size / num_inference_steps）',
    defaultUrl: 'https://api.siliconflow.cn/v1/images/generations',
    auth: 'bearer',
    models: ['Qwen/Qwen-Image', 'Kwai-Kolors/Kolors', 'black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-3-5-large'],
    sizes: ['512x512', '768x1024', '1024x768', '1024x1024', '1328x1328', '1664x928', '928x1664'],
  },
  ark: {
    id: 'ark',
    label: '火山方舟 Doubao Seedream',
    hint: 'doubao-seedream-5.0/4.5/4.0；size 支持 1K/2K/4K 或 WxH',
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    auth: 'bearer',
    models: ['doubao-seedream-5-0-lite-260128', 'doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    sizes: ['1K', '2K', '4K', '1024x1024', '2048x2048', '4096x4096'],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini 原生生图 (Nano Banana)',
    hint: 'gemini-3-pro-image / gemini-3.1-flash-image / gemini-2.5-flash-image；使用 :generateContent',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'x-goog-api-key',
    models: ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'],
    sizes: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  },
  imagen: {
    id: 'imagen',
    label: 'Google Imagen (:predict)',
    hint: 'imagen-4.x 等 Imagen 模型，使用 :predict 接口',
    defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: 'x-goog-api-key',
    models: ['imagen-4.0-generate-001', 'imagen-4.0-ultra-generate-001', 'imagen-4.0-fast-generate-001'],
    sizes: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  },
  stability: {
    id: 'stability',
    label: 'Stability AI (Stable Image)',
    hint: 'model 填 core / ultra / sd3；POST /v2beta/stable-image/generate/{model}',
    defaultUrl: 'https://api.stability.ai',
    auth: 'bearer',
    models: ['core', 'ultra', 'sd3'],
    sizes: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  },
  custom: {
    id: 'custom',
    label: '自定义 (JSON 模板)',
    hint: '用 bodyTemplate 自定义请求体，支持 {{prompt}}/{{model}}/{{size}}/{{n}} 占位符；响应自动探测',
    defaultUrl: '',
    auth: 'bearer',
    models: [],
    sizes: ['512x512', '1024x1024', '1024x768', '768x1024', '1536x1024', '1024x1536'],
  },
};

/**
 * 归一化生图配置（含旧版字段迁移）。
 * 旧版无 provider：有 apiUrl 时视为 siliconflow（旧请求体是 SD 风格），否则 openai。
 */
function normalizeImageGenConfig(imageGen) {
  const g = { ...(imageGen || {}) };
  g.provider = PROVIDERS[g.provider] ? g.provider : (g.apiUrl ? 'siliconflow' : 'openai');
  const preset = PROVIDERS[g.provider];
  if (!g.apiUrl) g.apiUrl = preset.defaultUrl;
  if (g.imageSize == null || g.imageSize === '') g.imageSize = '1024x1024';
  g.n = Math.max(1, Math.min(10, parseInt(g.n, 10) || 1));
  return g;
}

function trimJoinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  return b + suffix;
}

function applyAuth(headers, g) {
  if (!g.apiKey) return;
  const preset = PROVIDERS[g.provider] || PROVIDERS.openai;
  if (preset.auth === 'x-goog-api-key') headers['x-goog-api-key'] = g.apiKey;
  else headers['Authorization'] = `Bearer ${g.apiKey}`;
}

/** 从数组里挑选正整数 */
function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildOpenAIBody(g, prompt) {
  const body = { model: g.model, prompt, n: g.n || 1, size: g.imageSize || '1024x1024' };
  const m = String(g.model || '').toLowerCase();
  if (g.quality) body.quality = g.quality;
  if (g.background && g.background !== 'auto') body.background = g.background;
  if (g.outputFormat) body.output_format = g.outputFormat;
  // dall-e 支持 response_format；gpt-image 系列固定返回 b64_json（发送会被拒）
  if (/^dall-e/.test(m) && !g.responseFormat) body.response_format = 'b64_json';
  else if (g.responseFormat) body.response_format = g.responseFormat;
  return body;
}

function buildSiliconflowBody(g, prompt) {
  const body = {
    model: g.model,
    prompt,
    image_size: g.imageSize || '1024x1024',
    batch_size: g.n || 1,
  };
  if (g.outputFormat) body.output_format = g.outputFormat;
  const steps = intOrNull(g.steps);
  if (steps) body.num_inference_steps = steps;
  if (g.guidance != null && g.guidance !== '') body.guidance_scale = Number(g.guidance);
  if (g.negativePrompt) body.negative_prompt = g.negativePrompt;
  if (g.seed != null && g.seed !== '') body.seed = Number(g.seed);
  return body;
}

function buildArkBody(g, prompt) {
  const body = {
    model: g.model,
    prompt,
    size: g.imageSize || '2K',
    response_format: g.responseFormat || 'b64_json',
    watermark: !!g.watermark,
  };
  if (g.seed != null && g.seed !== '') body.seed = Number(g.seed);
  return body;
}

function buildGeminiBody(g, prompt) {
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  const size = parseSize(g.imageSize);
  if (size) generationConfig.imageConfig = { aspectRatio: aspectRatioFor(g.imageSize) };
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig };
  return body;
}

function buildImagenBody(g, prompt) {
  const parameters = { sampleCount: g.n || 1 };
  if (g.imageSize) parameters.aspectRatio = aspectRatioFor(g.imageSize);
  if (g.negativePrompt) parameters.negativePrompt = g.negativePrompt;
  if (g.outputFormat) parameters.outputOptions = { mimeType: `image/${g.outputFormat}` };
  return { instances: [{ prompt }], parameters };
}

function buildStabilityBody(g, prompt) {
  const body = { prompt, output_format: g.outputFormat || 'png' };
  if (g.negativePrompt) body.negative_prompt = g.negativePrompt;
  if (g.imageSize) body.aspect_ratio = aspectRatioFor(g.imageSize);
  if (g.seed != null && g.seed !== '') body.seed = Number(g.seed);
  if (g.style) body.style_preset = g.style;
  return body;
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    vars[key] != null ? String(vars[key]) : '');
}

function buildCustomRequest(g, prompt) {
  const vars = { prompt, model: g.model, size: g.imageSize, n: g.n || 1, seed: g.seed, negative_prompt: g.negativePrompt };
  const template = String(g.bodyTemplate || '').trim() ||
    '{"model":"{{model}}","prompt":"{{prompt}}","size":"{{size}}","n":{{n}}}';
  const rendered = renderTemplate(template, vars);
  let body;
  try {
    body = JSON.parse(rendered);
  } catch (e) {
    throw new Error('自定义请求体模板不是合法 JSON: ' + e.message);
  }
  return body;
}

/**
 * 构建生图请求。
 * @param {object} imageGen settings.imageGen（内部会先 normalize）
 * @param {string} prompt
 * @returns {{ url:string, method:string, headers:object, body:any, kind:string }}
 */
function buildImageRequest(imageGen, prompt) {
  const g = normalizeImageGenConfig(imageGen);
  if (!g.apiUrl) throw new Error('请先在设置中配置生图 API URL');
  if (!g.model) throw new Error('请先在设置中配置生图模型名称');
  const headers = { 'Content-Type': 'application/json' };
  applyAuth(headers, g);
  const base = String(g.apiUrl).replace(/\/+$/, '');

  if (g.provider === 'gemini') {
    headers['Content-Type'] = 'application/json';
    return {
      url: `${base}/models/${encodeURIComponent(g.model)}:generateContent`,
      method: 'POST',
      headers,
      body: buildGeminiBody(g, prompt),
      kind: 'gemini',
    };
  }
  if (g.provider === 'imagen') {
    return {
      url: `${base}/models/${encodeURIComponent(g.model)}:predict`,
      method: 'POST',
      headers,
      body: buildImagenBody(g, prompt),
      kind: 'imagen',
    };
  }
  if (g.provider === 'stability') {
    const mode = /^(core|ultra|sd3)$/i.test(g.model) ? g.model.toLowerCase() : 'core';
    headers['Accept'] = 'image/*';
    return {
      url: `${base}/v2beta/stable-image/generate/${mode}`,
      method: 'POST',
      headers,
      body: buildStabilityBody(g, prompt),
      kind: 'stability',
    };
  }
  if (g.provider === 'siliconflow') {
    return { url: base, method: 'POST', headers, body: buildSiliconflowBody(g, prompt), kind: 'images' };
  }
  if (g.provider === 'ark') {
    return { url: base, method: 'POST', headers, body: buildArkBody(g, prompt), kind: 'data' };
  }
  if (g.provider === 'custom') {
    return { url: base, method: 'POST', headers, body: buildCustomRequest(g, prompt), kind: 'auto' };
  }
  // openai 及任意兼容端点
  return { url: base, method: 'POST', headers, body: buildOpenAIBody(g, prompt), kind: 'data' };
}

// ---- 响应解析 ----

async function downloadRemoteImage(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`图片下载失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片体积超过上限（32MB）');
  return { buffer: buf, mime: (resp.headers.get('content-type') || 'image/png').split(';')[0] };
}

function b64ToImage(b64, mime) {
  const clean = String(b64 || '').replace(/^data:([^;]+);base64,/, (m, m0) => { mime = mime || m0; return ''; });
  if (!clean) return null;
  return { buffer: Buffer.from(clean, 'base64'), mime: mime || 'image/png' };
}

/**
 * 从各类响应体中探测并提取图片（b64 / url / inlineData / predictions / 原始二进制）。
 * @returns {Promise<{images:Array<{buffer:Buffer,mime:string}>, error?:string}>}
 */
async function extractImages(kind, resp, imageGen) {
  const contentType = String((resp.headers && resp.headers.get && resp.headers.get('content-type')) || '').toLowerCase();
  // 原始二进制（Stability Accept: image/*，或任意端点直接返回图片）
  if (contentType.startsWith('image/')) {
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok && !buffer.length) return { images: [], error: `HTTP ${resp.status}` };
    if (buffer.length > MAX_IMAGE_BYTES) return { images: [], error: '图片体积超过上限（32MB）' };
    return { images: [{ buffer, mime: contentType.split(';')[0] }] };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { images: [], error: `响应不是 JSON（HTTP ${resp.status}）` };
  }
  if (!resp.ok) {
    const msg = data?.error?.message || data?.message || data?.error || JSON.stringify(data).slice(0, 300);
    return { images: [], error: `HTTP ${resp.status}: ${msg}` };
  }

  const out = [];
  const pushB64 = (b64, mime) => { const img = b64ToImage(b64, mime); if (img) out.push(img); };
  const pushUrl = async (url) => { if (url && out.length < 10) out.push(await downloadRemoteImage(url)); };

  // OpenAI / ark / siliconflow / 兼容
  const list = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.images) ? data.images
    : Array.isArray(data?.predictions) ? data.predictions
    : Array.isArray(data?.output) ? data.output
    : null;
  if (list) {
    for (const item of list) {
      if (!item) continue;
      const b64 = item.b64_json || item.b64 || item.base64 || item.image_base64;
      const url = item.url || item.image_url || item.imageUrl;
      if (b64) pushB64(b64, item.mime_type || item.mimeType);
      else if (url && typeof url === 'string') await pushUrl(url);
      else if (typeof item === 'string' && /^https?:/.test(item)) await pushUrl(item);
    }
  }
  // Stability JSON
  if (!out.length && data?.image) pushB64(data.image, data.output_format ? `image/${data.output_format}` : undefined);
  // Gemini / google
  if (!out.length) {
    const parts = data?.candidates?.[0]?.content?.parts || data?.candidates?.[0]?.parts || [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline?.data) pushB64(inline.data, inline.mimeType || inline.mime_type);
    }
  }
  // Imagen predictions: bytesBase64Encoded
  if (!out.length && list) {
    for (const item of list) {
      if (item?.bytesBase64Encoded) pushB64(item.bytesBase64Encoded, item.mimeType);
    }
  }
  // 单图字符串字段兜底
  if (!out.length && typeof data?.image === 'string' && /^https?:/.test(data.image)) await pushUrl(data.image);
  if (!out.length && typeof data?.url === 'string') await pushUrl(data.url);

  if (!out.length) {
    const err = data?.error?.message || data?.message || data?.finish_reason || '';
    return { images: [], error: `生图 API 未返回有效图片${err ? '（' + err + '）' : ''}` };
  }
  return { images: out };
}

module.exports = {
  PROVIDERS,
  DEFAULT_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  parseSize,
  aspectRatioFor,
  extForMime,
  normalizeImageGenConfig,
  buildImageRequest,
  extractImages,
};
