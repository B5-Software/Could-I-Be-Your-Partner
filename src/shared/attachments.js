/* SPDX-License-Identifier: GPL-3.0-or-later */
(function (root) {
  'use strict';
  function normalize(items) {
    return (Array.isArray(items) ? items : []).filter(Boolean).map((item) => ({
      name: String(item.name || item.path || 'attachment')
        .split(/[\\/]/)
        .pop(),
      path: typeof item.path === 'string' ? item.path : '',
      type: typeof item.type === 'string' ? item.type : '',
      size: Number.isFinite(item.size) && item.size >= 0 ? item.size : null,
      isImage: !!item.isImage,
      ...(item.hostPath ? { hostPath: item.hostPath } : {}),
    }));
  }
  function text(content) {
    return Array.isArray(content)
      ? content
          .map((part) => part.text || '')
          .filter(Boolean)
          .join('\n')
      : String(content || '');
  }
  function presentation(message) {
    const metadata = message?.metadata || {};
    if (Object.hasOwn(metadata, 'displayContent'))
      return {
        content: String(metadata.displayContent),
        attachments: normalize(metadata.attachments),
      };
    const content = text(message?.content);
    if (message?.role !== 'user') return { content, attachments: normalize(message?.attachments) };
    // Recognize only the exact generated legacy suffix, never arbitrary user paths.
    const marker = content.search(
      /\n\n\[(?:文件附件|图片附件|附件): [^\n]+\]\n(?:⚠️ 精确文件路径|已转换文本路径)/,
    );
    if (marker < 0) return { content, attachments: normalize(message?.attachments) };
    const suffix = content.slice(marker);
    const attachments = [
      ...suffix.matchAll(
        /\[(?:文件附件|图片附件|附件): ([^\n]+)\]\n(?:⚠️ 精确文件路径（必须逐字使用，禁止修改任何字符）|已转换文本路径): ([^\n]+)/g,
      ),
    ].map((match) => ({
      name: match[1],
      path: match[2],
      isImage: match[0].startsWith('[图片附件:'),
    }));
    return attachments.length
      ? { content: content.slice(0, marker), attachments: normalize(attachments) }
      : { content, attachments: [] };
  }
  const api = { normalize, text, presentation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AttachmentData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
