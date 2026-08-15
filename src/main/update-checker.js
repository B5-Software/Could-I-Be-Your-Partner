/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * GitHub Releases 更新检查：
 * - compareVersions / pickLatestRelease 为纯函数，可独立单测
 * - fetchLatestRelease 用 Electron net（跟随系统代理），失败返回 { ok:false }（调用方静默处理）
 * - 自动检查调度由 main.js 驱动（updates:check IPC 与定时器）
 */

'use strict';

const { net } = require('electron');

const UPDATE_REPO = 'B5-Software/Could-I-Be-Your-Partner';
const GITHUB_API = 'https://api.github.com';
const CHECK_TIMEOUT_MS = 10000;
const RELEASE_BODY_PREVIEW_CHARS = 2000;

// 解析版本字符串为可比较结构：{ major, minor, patch, prerelease: [..] }
// 忽略 build metadata（+hash 之后），pre-release 规则符合 semver 2.0.0
function parseVersion(version) {
  const v = String(version || '').trim().replace(/^v/i, '').split('+')[0];
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?$/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ? m[4].split('.') : []
  };
}

// semver pre-release 标识符比较：数字段按数值，字母段按 ASCII，数字 < 字母
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 正式版 > pre-release
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const nx = parseInt(x, 10), ny = parseInt(y, 10);
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (xn) return -1; // 数字 < 字母
    if (yn) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    // 无法解析时按字符串兜底（保持确定性）
    const sa = String(a || ''), sb = String(b || '');
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * 从 GitHub releases 列表挑选最新版本（纯函数）。
 * 过滤 draft；pre-release 也参与比较（应用自身就是 alpha 版本号）。
 * @param {Array} releases - GitHub API 返回的 releases 数组
 * @returns {null|{tagName, version, htmlUrl, body, publishedAt, prerelease}}
 */
function pickLatestRelease(releases) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  let best = null;
  for (const r of releases) {
    if (r && r.draft) continue;
    const tag = r.tag_name || '';
    const entry = {
      tagName: tag,
      version: tag,
      htmlUrl: r.html_url || '',
      body: r.body || '',
      publishedAt: r.published_at || '',
      prerelease: !!r.prerelease
    };
    if (!best || compareVersions(entry.version, best.version) > 0) best = entry;
  }
  return best;
}

/**
 * 查询 GitHub Releases 最新版本。
 * @returns {Promise<{ok:boolean, latest?:object, error?:string}>}
 */
async function fetchLatestRelease() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    let resp;
    try {
      resp = await net.fetch(`${GITHUB_API}/repos/${UPDATE_REPO}/releases?per_page=20`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Could-I-Be-Your-Partner' }
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    const data = await resp.json();
    const latest = pickLatestRelease(data);
    if (!latest) return { ok: false, error: 'no releases found' };
    if (latest.body && latest.body.length > RELEASE_BODY_PREVIEW_CHARS) {
      latest.body = latest.body.slice(0, RELEASE_BODY_PREVIEW_CHARS) + '\n…（完整内容见 Release 页面）';
    }
    return { ok: true, latest };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: (e && e.message) || 'network error' };
  }
}

module.exports = {
  UPDATE_REPO,
  compareVersions,
  parseVersion,
  pickLatestRelease,
  fetchLatestRelease
};
