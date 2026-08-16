/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 */

'use strict';

function parseFrontmatter(text) {
  const data = {};
  if (!text || !text.startsWith('---\n')) return { data, body: text || '' };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { data, body: text };
  const fm = text.slice(4, end).split(/\r?\n/);
  let currentArrayKey = '';
  const parseScalar = value => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  fm.forEach(line => {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (!value) {
        data[key] = [];
        currentArrayKey = key;
      } else {
        data[key] = parseScalar(value);
        currentArrayKey = '';
      }
      return;
    }
    const nested = line.match(/^(\s+)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (nested && currentArrayKey) {
      const parent = data[currentArrayKey];
      if (!parent || Array.isArray(parent)) data[currentArrayKey] = {};
      data[currentArrayKey][nested[2].trim()] = parseScalar(nested[3]);
      return;
    }
    const arr = line.match(/^\s*-\s*(.+)$/);
    if (arr && currentArrayKey) {
      if (!Array.isArray(data[currentArrayKey])) data[currentArrayKey] = [];
      data[currentArrayKey].push(parseScalar(arr[1]));
    }
  });
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  return { data, body };
}

function parseMarkdownSections(markdownBody) {
  const sections = {};
  let current = '__intro';
  sections[current] = [];
  String(markdownBody || '').split(/\r?\n/).forEach(line => {
    // 仅二级标题(##)作为章节分隔；三级及以下(### 等)属于当前章节的内容，
    // 否则含子标题的章节(如 Instructions 下的 ### 小节)会被截断。
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      current = h[1].trim().toLowerCase();
      if (!sections[current]) sections[current] = [];
    } else {
      sections[current].push(line);
    }
  });
  Object.keys(sections).forEach(key => {
    sections[key] = sections[key].join('\n').trim();
  });
  return sections;
}

function pickSection(sections, aliases) {
  for (const alias of aliases) {
    const k = alias.toLowerCase();
    if (sections[k]) return sections[k];
  }
  return '';
}

function buildStandardSkillFromMarkdown(skillMdPath, markdownContent, scripts = []) {
  const { data: meta, body } = parseFrontmatter(markdownContent);
  const sections = parseMarkdownSections(body);
  const titleFromHeading = (body.match(/^#\s+(.+)$/m) || [])[1] || '';
  const fallbackName = getPathBasename(getPathDirname(skillMdPath)) || 'Imported Skill';
  const name = String(meta.name || meta.title || titleFromHeading || fallbackName).trim();
  const description = String(
    meta.description
    || pickSection(sections, ['description', '简介', '概述'])
    || sections.__intro
    || '标准 Skill 导入'
  ).trim();
  const whenToUse = pickSection(sections, ['when to use', 'when-to-use', '使用场景']);
  const instructions = pickSection(sections, ['instructions', '步骤', 'usage', '使用方法']);
  const guidelines = pickSection(sections, ['guidelines', '规则', '注意事项']);
  // 除 frontmatter 元数据外，整段正文（含所有 ## 章节、### 子标题、intro）全部进 prompt。
  // 不能按已知章节名过滤：Context/Examples/Output Format/自定义章节等会被静默截断。
  // 仅在正文为空时回退到已知章节拼接。
  const fullBodyPrompt = String(body || '').trim();
  const prompt = fullBodyPrompt || [
    whenToUse ? `【适用场景】\n${whenToUse}` : '',
    instructions ? `【执行说明】\n${instructions}` : '',
    guidelines ? `【约束】\n${guidelines}` : ''
  ].filter(Boolean).join('\n\n').trim() || description;

  return {
    name,
    description,
    prompt,
    license: String(meta.license || ''),
    compatibility: String(meta.compatibility || ''),
    allowedTools: String(meta['allowed-tools'] || meta.allowedTools || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
    metadata: meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata) ? meta.metadata : {},
    type: 'standard',
    sourceType: 'imported-skill-md',
    sourcePath: skillMdPath,
    runtime: String(meta.runtime || 'javascript'),
    scripts,
    standard: {
      whenToUse,
      instructions,
      guidelines,
      metadata: meta
    }
  };
}

async function collectSkillScripts(skillRootDir) {
  if (!skillRootDir) return [];
  const scriptsDir = joinPath(skillRootDir, 'scripts');
  const listResult = await window.api.listDirectory(scriptsDir);
  if (!listResult?.ok || !Array.isArray(listResult.entries)) return [];
  const shellExts = new Set(['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd']);
  return listResult.entries
    .filter(entry => entry?.isFile && /\.(js|mjs|cjs|py|sh|bash|zsh|ps1|bat|cmd)$/i.test(entry.name || ''))
    .map(entry => {
      const ext = (entry.name.split('.').pop() || '').toLowerCase();
      const runtime = ext === 'py' ? 'python'
        : shellExts.has(ext) ? 'shell'
          : (ext === 'mjs' || ext === 'cjs') ? 'node'
            : 'javascript';
      return { name: entry.name, path: joinPath(scriptsDir, entry.name), runtime };
    });
}

function getSkillSummaryMeta(skill) {
  const scriptCount = Array.isArray(skill?.scripts) ? skill.scripts.filter(s => /\.(js|mjs|cjs|py|sh|bash|zsh|ps1|bat|cmd)$/i.test(String(s?.name || s || ''))).length : 0;
  let typeLabel;
  if (skill?.bundled) typeLabel = '内置技能';
  else if (skill?.type === 'standard') typeLabel = '标准 Skill';
  else typeLabel = '自定义';
  return `${typeLabel}${scriptCount > 0 ? ` · 脚本 ${scriptCount}` : ''}`;
}
