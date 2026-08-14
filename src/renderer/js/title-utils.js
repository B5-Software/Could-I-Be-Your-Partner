/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * 会话标题生成辅助（纯函数，浏览器 + Node 测试共用）：
 * 提示词构造、输出清洗、元描述识别、照抄原话识别、思考内容提取、启发式兜底。
 * 目标：各模式会话标题真正提炼主题，而不是复述/截取用户消息的第一句话。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CIBYPTitleUtils = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TITLE_LEN = 24;

  // 高精度元描述特征：只匹配"复述任务/输出指令"这类明确信号，避免误伤正常标题
  const META_PATTERNS = [
    /^我们?被(要求|问到)/,
    /^(任务|标题|title)([:：\s]|$)/i,
    /^(task|title|topic|subject|heading|answer|final answer|summary|identify task)([\s:：]|$)/i,
    /请(为|给)[^。！？\n]{0,20}(生成|起|拟定|输出|总结)[^。！？\n]{0,8}标题/,
    /(生成|起|拟定|输出|总结)[^。！？\n]{0,8}(标题|一句话)/,
    /只(输出|返回)[^。！？\n]{0,8}(标题|文字)/,
    /(不超过|最多|限制)[^。！？\n]{0,10}(个字|字符)/,
    /(复述|元描述|照抄)/,
    /^["「『]?\s*标题\s*[:：]/i,
  ];

  // 输出清洗：去引号/常见前缀/列表符号，多行时取首行（模型常在标题后加解释）
  function cleanTitle(text) {
    if (!text || typeof text !== 'string') return '';
    let t = text
      .replace(/["「」『』《》""''`]/g, '')
      .replace(/\*\*|__|~~/g, '')
      .replace(/^(标题|title)[:：]\s*/i, '')
      .replace(/^[-*•\d.)>\s#]+/, '')
      .replace(/[\s:：]+$/, '')
      .replace(/[。！？!?，,；;.…]+$/, '')
      .trim();
    const firstLine = t.split(/\n/)[0] || '';
    if (firstLine.trim() && firstLine.trim().length <= MAX_TITLE_LEN) t = firstLine;
    return t.replace(/\s+/g, ' ').trim();
  }

  function isMetaDescription(text) {
    if (!text || typeof text !== 'string') return true;
    // 与 cleanTitle 同规格做防御性归一化，保证无论调用方是否先清洗都能识别
    const t = text.trim()
      .replace(/\*\*|__|~~/g, '')
      .replace(/[\s:：]+$/, '')
      .replace(/[。！？!?，,；;.…]+$/, '')
      .trim();
    if (!t) return true;
    if (t.length > MAX_TITLE_LEN) return true;
    return META_PATTERNS.some((p) => p.test(t));
  }

  // 识别"把思考过程写进 content"的模型输出（如 nemotron lightning 系列）
  function isThinkingDump(text) {
    if (!text || typeof text !== 'string') return false;
    return /here'?s a thinking process|thinking process|analyze (user )?input|identify (the )?(core )?task|apply rules|determine output/i.test(text);
  }

  function stripPolitePrefix(s) {
    return String(s || '')
      .replace(/^(请帮我|请帮忙|请给我|帮我|帮忙|给我|请|麻烦|帮助|能否|可以|如何|怎么|需要|我要|我想|想要|能不能|可不可以)+/g, '')
      .trim();
  }

  function firstSentenceOf(text) {
    const t = String(text || '').replace(/[\s\r\n]+/g, ' ').trim();
    const m = t.split(/[。！？!?；;]+/).find(Boolean);
    return (m || t).trim();
  }

  // 照抄识别：标题等于（或只是）用户消息首句去掉礼貌词后的前缀，视为复述
  function looksLikeEcho(title, userMessage) {
    const t = stripPolitePrefix(cleanTitle(title)).toLowerCase();
    if (!t) return true;
    const text = String(userMessage || '');
    // 首句（句号分段）与首分句（逗号/冒号分段）都纳入比较，覆盖"帮我写X，用来Y"这类输入
    const first = stripPolitePrefix(firstSentenceOf(text)).toLowerCase().replace(/[\s，,。]+/g, '');
    const firstClause = stripPolitePrefix(text.split(/[。！？!?；;，,:：\n]+/).find(Boolean) || '')
      .toLowerCase().replace(/[\s，,。]+/g, '');
    const tCompact = t.replace(/[\s，,。]+/g, '');
    if (first.length < 4) return false; // 原话太短，不做回显判定
    return (tCompact === first || first.startsWith(tCompact))
      || (firstClause.length >= 4 && (tCompact === firstClause || firstClause.startsWith(tCompact)));
  }

  // 从思考内容提取结论：倒序取最后一行，剥常见引导词，再按正常标题校验
  function extractTitleFromReasoning(reasoning) {
    if (!reasoning || typeof reasoning !== 'string') return '';
    const lines = reasoning.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let l = lines[i]
        .replace(/^[-*•\d.)>\s]+/, '')
        .replace(/^(所以|因此|综上|答案是|答案为|最终标题|拟定标题|标题是|标题为)\s*[:：]?\s*/i, '')
        .trim();
      const cand = cleanTitle(l);
      if (cand && cand.length >= 2 && cand.length <= MAX_TITLE_LEN && !isMetaDescription(cand)) {
        return cand;
      }
    }
    return '';
  }

  // 从 CoT 全文中提取最终结论。只在"强结论标记"之后提取，避免把模型复述的
  // 提示词示例（"查询天气/闭包原理/相对论入门"等）误当结论；
  // 无强结论标记时返回空（由调用方走确定性启发式兜底），绝不猜测。
  // 结论区内：优先最后一个 2-24 字引号短语，其次尾部"像标题"的短行；可选跳过回显原话。
  function extractTitleFromCoT(text, userMessage) {
    if (!text || typeof text !== 'string') return '';
    const DECISION_MARKERS = [
      /final decision/ig, /final output/ig, /final answer/ig,
      /最终输出/g, /最终标题/g, /最终决定/g, /最终答案/g, /答案是/g, /答案为/g,
      /标题是/g, /标题为/g, /结论是/g, /the title (is|should be)/ig,
    ];
    // 取最后一个决策标记之后的内容（结论区）
    let tailStart = -1;
    for (const re of DECISION_MARKERS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) tailStart = Math.max(tailStart, m.index);
    }
    if (tailStart < 0) return '';
    const tail = text.slice(tailStart);

    const ok = (c) => c.length >= 2 && c.length <= MAX_TITLE_LEN && !isMetaDescription(c)
      && !(userMessage && looksLikeEcho(c, userMessage));

    // 1) 结论标记后第一个有效引号短语（决策通常紧跟标记；截断产生的散落引号会被跳过）
    const quoteRe = /["「『]([^"」』\n]{2,24})["」』]/g;
    let q;
    const candidates = [];
    while ((q = quoteRe.exec(tail))) candidates.push(q[1]);
    for (const cand of candidates) {
      const c = cleanTitle(cand);
      if (ok(c)) return c;
    }

    // 2) 标记行直接结论：如 "最终标题：Python爬虫" / "Final decision: Output Python爬虫"
    let direct = tail.split(/\n/)[0] || '';
    direct = direct
      .replace(/^(final decision|final output|final answer|最终输出|最终标题|最终决定|最终答案|答案是|答案为|标题是|标题为|结论是|the title is|the title should be)[^:：\n]{0,30}[:：]?\s*/i, '')
      .replace(/^(output|输出)\s*/i, '')
      .split(/[。！？!?；;.]/)[0];
    const dc = cleanTitle(direct);
    if (ok(dc)) return dc;

    // 3) 尾部向上找第一行"像标题"的短行
    const lines = tail.split(/\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].replace(/\*\*/g, '').trim();
      if (/^[-*•\d.)>\s]+/.test(s)) continue;
      if (/["「『]/.test(s)) continue;
      if (/[:：]\s*$/.test(s) || s.includes('：') || s.includes(': ')) continue;
      if (/^(analyze|identify|apply|determine|task|step|rule|user|the|this|here|so|i|final|answer|答案是|答案为|标题|最终|输出|结论|theme|topic)\b/i.test(s)) continue;
      const c = cleanTitle(s);
      if (ok(c)) return c;
    }
    return '';
  }

  function heuristicFallback(userMessage) {
    let t = String(userMessage || '').replace(/[\s\r\n]+/g, ' ').trim();
    t = stripPolitePrefix(t);
    t = t.split(/[。！？!?；;，,:：]+/)[0] || t;
    t = t.replace(/[「」『』《》""''（）()]/g, '').trim();
    if (t.length > 18) t = t.slice(0, 18) + '…';
    return t || '新对话';
  }

  function buildTitlePrompt(mode) {
    const modeHint = mode === 'code'
      ? '7. 标题偏向编程/代码主题，例如"实现登录接口"。'
      : mode === 'babe'
        ? '7. 标题温馨简洁，例如"今天的心情"。'
        : '';
    return `你是会话标题助手。把用户消息压缩成一个 2-12 字的中文标题。
规则：
1. 只输出标题本身，禁止任何解释、标点、引号、换行或前后缀
2. 必须提炼主题/任务，严禁照抄、截取或复述用户消息（去掉"请/帮我"再照抄也不行）
3. 名词短语或"动词+名词"，如"Python爬虫"、"查询天气"
4. 提问型消息输出主题名，如"闭包原理"
5. 禁止输出思维步骤标签或占位符，如"Identify Task"、"步骤一"、"**标题**"
6. 标题语言与用户消息一致，中文消息必须输出中文标题
${modeHint}
正确示例：
用户: 帮我写一个Python爬虫，爬取豆瓣电影Top250 → Python爬虫
用户: 今天天气怎么样？ → 查询天气
用户: 解释一下JavaScript闭包 → JS闭包解释
用户: 给我讲讲相对论 → 相对论入门
错误示例（严禁）：
用户: 帮我写一个Python爬虫 → 帮我写一个Python爬虫（照抄）
用户: 帮我写一个Python爬虫 → 写一个Python爬虫（去掉礼貌词仍是照抄）
用户: 解释一下JavaScript闭包 → 解释一下JavaScript闭包（复述）
用户: 帮我写一个Python爬虫 → **Identify Task**: Python爬虫（步骤标签，禁止）`;
  }

  return {
    MAX_TITLE_LEN,
    cleanTitle,
    isMetaDescription,
    isThinkingDump,
    stripPolitePrefix,
    firstSentenceOf,
    looksLikeEcho,
    extractTitleFromReasoning,
    extractTitleFromCoT,
    heuristicFallback,
    buildTitlePrompt,
  };
});
