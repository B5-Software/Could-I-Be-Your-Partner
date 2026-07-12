/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * i18n core module — supports zh-CN (source), en, de.
 * Design principle: zh-CN is the identity/fallback; existing Chinese strings
 * are NEVER deleted or modified. Non-zh languages override via translation
 * maps keyed by string identifiers.
 */

const I18N_SUPPORTED_LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en',    label: 'English' },
  { value: 'de',    label: 'Deutsch' }
];

let _i18nLang = 'zh-CN';
let _i18nDict = {}; // active dictionary (empty for zh-CN → falls back to caller-provided default)

/**
 * Initialise i18n from saved settings. Called once at app startup.
 * @param {string} lang  Language code: 'zh-CN' | 'en' | 'de'
 */
function i18nInit(lang) {
  i18nSetLanguage(lang || 'zh-CN');
}

/**
 * Switch active language at runtime.
 * Dispatches a 'languagechange' CustomEvent on window so listeners can react.
 */
function i18nSetLanguage(lang) {
  if (!I18N_SUPPORTED_LANGUAGES.some(l => l.value === lang)) lang = 'zh-CN';
  _i18nLang = lang;
  _i18nDict = (lang === 'zh-CN') ? {} : (I18N_TRANSLATIONS[lang] || {});
  document.documentElement.lang = lang;
  window.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
}

function i18nGetLanguage() {
  return _i18nLang;
}

/**
 * Translate a key.
 * @param {string} key  Translation key (dotted path, e.g. 'ui.sidebar.chat')
 * @param {string} fallback  Original Chinese string to use when no translation found.
 * @param {object} [params]  { placeholder: value } for {placeholder} substitution.
 * @returns {string}  Translated string, or fallback if not found.
 */
function t(key, fallback, params) {
  if (!key || _i18nLang === 'zh-CN') {
    return params ? _i18nFill(fallback, params) : fallback;
  }
  let str = _i18nDict[key];
  if (str === undefined) {
    // Try nested lookup (dot notation)
    str = _i18nLookup(key);
  }
  if (str === undefined || str === null) {
    str = fallback;
  }
  return params ? _i18nFill(str, params) : str;
}

function _i18nLookup(key) {
  const parts = key.split('.');
  let obj = _i18nDict;
  for (const p of parts) {
    if (obj && typeof obj === 'object' && p in obj) {
      obj = obj[p];
    } else {
      return undefined;
    }
  }
  return typeof obj === 'string' ? obj : undefined;
}

function _i18nFill(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
}

/**
 * Apply translations to all [data-i18n] elements in the DOM.
 * Call this after language change and after dynamic content insertion.
 * - data-i18n="key" → textContent
 * - data-i18n-placeholder="key" → placeholder
 * - data-i18n-title="key" → title attribute
 */
function i18nApplyToDOM(root) {
  const scope = root || document;
  // textContent via data-i18n
  scope.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key, el.textContent);
    if (val) el.textContent = val;
  });
  // placeholder
  scope.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key, el.getAttribute('placeholder'));
    if (val) el.setAttribute('placeholder', val);
  });
  // title
  scope.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key, el.getAttribute('title'));
    if (val) el.setAttribute('title', val);
  });
  // Selector-based translation (no data-i18n attributes needed)
  i18nApplySelectors(scope);
  i18nApplyTextMap(scope);
}

/**
 * Selector → i18n key mapping for static HTML elements.
 * Each entry: { sel: CSS selector, key: i18n key, attr: 'text'|'placeholder'|'title' }
 */
const I18N_SELECTOR_MAP = [
  // ── Titlebar ──
  { sel: '#mode-btn-chat span', key: 'ui.titlebar.chatMode' },
  { sel: '#mode-btn-code span', key: 'ui.titlebar.codeMode' },
  { sel: '#mode-btn-babe span', key: 'ui.titlebar.babeMode' },
  { sel: '#mode-btn-chat', key: 'ui.titlebar.chatMode', attr: 'title' },
  { sel: '#mode-btn-code', key: 'ui.titlebar.codeMode', attr: 'title' },
  { sel: '#mode-btn-babe', key: 'ui.titlebar.babeMode', attr: 'title' },
  { sel: '#titlebar-title', key: 'ui.titlebar.untitledConversation' },
  { sel: '#btn-minimize', key: 'ui.titlebar.minimize', attr: 'title' },
  { sel: '#btn-maximize', key: 'ui.titlebar.maximize', attr: 'title' },
  { sel: '#btn-close', key: 'ui.titlebar.close', attr: 'title' },
  { sel: '#titlebar-title', key: 'ui.titlebar.clickToEdit', attr: 'title' },
  { sel: '#conn-btn-local', key: 'ui.titlebar.localMode', attr: 'title' },
  { sel: '#conn-btn-remote', key: 'ui.titlebar.remoteMode', attr: 'title' },

  // ── Sidebar ──
  { sel: '.nav-item[data-page="chat"] span', key: 'ui.sidebar.chat' },
  { sel: '.nav-item[data-page="code"] span', key: 'ui.sidebar.code' },
  { sel: '.nav-item[data-page="babe"] span', key: 'ui.sidebar.babe' },
  { sel: '.nav-item[data-page="history"] span', key: 'ui.sidebar.history' },
  { sel: '.nav-item[data-page="code-history"] span', key: 'ui.sidebar.codeHistory' },
  { sel: '.nav-item[data-page="babe-history"] span', key: 'ui.sidebar.babeHistory' },
  { sel: '.nav-item[data-page="tools"] span', key: 'ui.sidebar.tools' },
  { sel: '.nav-item[data-page="skills"] span', key: 'ui.sidebar.skills' },
  { sel: '.nav-item[data-page="knowledge"] span', key: 'ui.sidebar.knowledge' },
  { sel: '.nav-item[data-page="memory"] span', key: 'ui.sidebar.memory' },
  { sel: '.nav-item[data-page="settings"] span', key: 'ui.sidebar.settings' },
  { sel: '.nav-item[data-page="about"] span', key: 'ui.sidebar.about' },
  // sidebar tooltips
  { sel: '.nav-item[data-page="chat"]', key: 'ui.sidebar.chat', attr: 'title' },
  { sel: '.nav-item[data-page="code"]', key: 'ui.sidebar.code', attr: 'title' },
  { sel: '.nav-item[data-page="babe"]', key: 'ui.sidebar.babe', attr: 'title' },
  { sel: '.nav-item[data-page="history"]', key: 'ui.sidebar.history', attr: 'title' },
  { sel: '.nav-item[data-page="code-history"]', key: 'ui.sidebar.codeHistory', attr: 'title' },
  { sel: '.nav-item[data-page="babe-history"]', key: 'ui.sidebar.babeHistory', attr: 'title' },
  { sel: '.nav-item[data-page="tools"]', key: 'ui.sidebar.tools', attr: 'title' },
  { sel: '.nav-item[data-page="skills"]', key: 'ui.sidebar.skills', attr: 'title' },
  { sel: '.nav-item[data-page="knowledge"]', key: 'ui.sidebar.knowledge', attr: 'title' },
  { sel: '.nav-item[data-page="memory"]', key: 'ui.sidebar.memory', attr: 'title' },
  { sel: '.nav-item[data-page="settings"]', key: 'ui.sidebar.settings', attr: 'title' },
  { sel: '.nav-item[data-page="about"]', key: 'ui.sidebar.about', attr: 'title' },

  // ── Chat page ──
  { sel: '#agent-status', key: 'ui.chat.standby' },
  { sel: '#agent-tarot', key: 'ui.chat.tarotNotDrawn' },
  { sel: '#btn-reoptimize-tools', key: 'ui.chat.reoptimizeTools', attr: 'title' },
  { sel: '#btn-open-workspace', key: 'ui.chat.openWorkspace', attr: 'title' },
  { sel: '#btn-new-chat', key: 'ui.chat.newChat', attr: 'title' },
  { sel: '#btn-clear-chat', key: 'ui.chat.clearChat', attr: 'title' },
  { sel: '.welcome-message h2', key: 'ui.chat.greeting' },
  { sel: '.welcome-message p', key: 'ui.chat.greetingDesc' },
  { sel: '.quick-action-btn[data-prompt*="新闻"]', key: 'ui.chat.searchNews' },
  { sel: '.quick-action-btn[data-prompt*="图片"]', key: 'ui.chat.generateImage' },
  { sel: '.quick-action-btn[data-prompt*="待办"]', key: 'ui.chat.todoList' },
  { sel: '.quick-action-btn[data-prompt*="代码"]', key: 'ui.chat.writeCode' },
  { sel: '#chat-input', key: 'ui.chat.inputPlaceholder', attr: 'placeholder' },
  { sel: '#btn-attach', key: 'ui.chat.attachFile', attr: 'title' },
  { sel: '#btn-camera', key: 'ui.chat.takePhoto', attr: 'title' },
  { sel: '#btn-send', key: 'ui.chat.send', attr: 'title' },
  { sel: '#btn-stop', key: 'ui.chat.stop', attr: 'title' },
  { sel: '#todo-input', key: 'ui.chat.addTodoPlaceholder', attr: 'placeholder' },
  { sel: '#approval-title', key: 'ui.chat.sensitiveConfirmTitle' },
  { sel: '#btn-approve', key: 'ui.chat.approveExecution' },
  { sel: '#btn-deny', key: 'ui.chat.deny' },

  // ── Code page ──
  { sel: '#btn-code-open-workspace', key: 'ui.code.openWorkspace', attr: 'title' },
  { sel: '#code-workspace-path', key: 'ui.code.noWorkspaceSelected' },
  { sel: '#btn-code-new-chat', key: 'ui.code.newChat', attr: 'title' },
  { sel: '#btn-code-attach-file', key: 'ui.code.addFileToContext', attr: 'title' },
  { sel: '#code-chat-input', key: 'ui.code.inputPlaceholder', attr: 'placeholder' },

  // ── Babe page ──
  { sel: '#babe-welcome h2', key: 'ui.babe.welcome' },
  { sel: '#babe-welcome p', key: 'ui.babe.featureDesc' },
  { sel: '#btn-babe-proactive', key: 'ui.babe.proactiveMessage', attr: 'title' },
  { sel: '#btn-babe-new-chat', key: 'ui.chat.newChat', attr: 'title' },
  { sel: '#babe-chat-input', key: 'ui.babe.inputPlaceholder', attr: 'placeholder' },

  // ── Settings tabs ──
  { sel: '.settings-tab[data-tab="ai"]', key: 'ui.settings.aiPersona' },
  { sel: '.settings-tab[data-tab="babe"]', key: 'ui.settings.babeMode' },
  { sel: '.settings-tab[data-tab="user"]', key: 'ui.settings.profile' },
  { sel: '.settings-tab[data-tab="llm"]', key: 'ui.settings.llm' },
  { sel: '.settings-tab[data-tab="usage"]', key: 'ui.settings.usage' },
  { sel: '.settings-tab[data-tab="image"]', key: 'ui.settings.imageGen' },
  { sel: '.settings-tab[data-tab="theme"]', key: 'ui.settings.theme' },
  { sel: '.settings-tab[data-tab="language"]', key: 'ui.settings.language' },
  { sel: '.settings-tab[data-tab="network"]', key: 'ui.settings.network' },
  { sel: '.settings-tab[data-tab="entropy"]', key: 'ui.settings.entropy' },
  { sel: '.settings-tab[data-tab="firmware"]', key: 'ui.settings.trngFirmware' },
  { sel: '.settings-tab[data-tab="security"]', key: 'ui.settings.security' },
  { sel: '.settings-tab[data-tab="mcp"]', key: 'ui.settings.mcp' },
  { sel: '.settings-tab[data-tab="email"]', key: 'ui.settings.email' },
  { sel: '.settings-tab[data-tab="webcontrol"]', key: 'ui.settings.webControl' },

  // ── Language settings panel ──
  { sel: '#setting-language option[value="zh-CN"]', key: 'ui.settings.zhCN' },
  { sel: '#setting-language option[value="en"]', key: 'ui.settings.en' },
  { sel: '#setting-language option[value="de"]', key: 'ui.settings.de' },
  { sel: '#btn-save-language', key: 'ui.settings.saveSettings' },

  // ── Tools page ──
  { sel: '#page-tools h2, #tools-page h2', key: 'ui.tools.management' },
  { sel: '#page-tools .page-desc, #tools-page .page-desc', key: 'ui.tools.enableDisableDesc' },

  // ── History pages ──
  { sel: '#page-history .empty-state', key: 'ui.history.noChatHistory' },
  { sel: '#page-code-history .empty-state', key: 'ui.history.noCodeHistory' },
  { sel: '#page-babe-history .empty-state', key: 'ui.history.noBabeHistory' },

  // ── About page ──
  { sel: '#page-about h2, #about-page h2', key: 'ui.about.title' },

  // ── Modal dialogs ──
  { sel: '#confirm-modal h3, #confirm-modal .modal-title', key: 'ui.modal.confirmAction' },
  { sel: '#confirm-modal #btn-confirm, #btn-confirm', key: 'ui.modal.confirm' },
  { sel: '#confirm-modal #btn-cancel, #btn-cancel', key: 'ui.modal.cancel' },
  { sel: '#message-modal h3, #message-modal .modal-title', key: 'ui.modal.notice' },
  { sel: '#message-modal #btn-msg-close, #btn-msg-close', key: 'ui.modal.close' },
  { sel: '#image-preview-modal h3', key: 'ui.modal.imagePreview' },
  { sel: '#image-preview-modal #btn-preview-close', key: 'ui.modal.close' },
  { sel: '#camera-modal h3', key: 'ui.modal.capture' },
  { sel: '#camera-modal #btn-camera-cancel', key: 'ui.modal.cancel' },
  { sel: '#camera-modal #btn-camera-capture', key: 'ui.modal.capture' },
  { sel: '#skill-modal #skill-modal-title', key: 'ui.modal.addSkill' },
  { sel: '#skill-modal #btn-skill-cancel', key: 'ui.modal.cancel' },
  { sel: '#skill-modal #btn-skill-save', key: 'ui.modal.save' },
  { sel: '#memory-edit-modal h3', key: 'ui.modal.editMemory' },
  { sel: '#memory-edit-modal #btn-memory-cancel', key: 'ui.modal.cancel' },
  { sel: '#memory-edit-modal #btn-memory-save', key: 'ui.modal.save' },

  // ── Remote banner ──
  { sel: '#remote-conn-banner .remote-conn-text', key: 'ui.remote.notConnected' },
  { sel: '.remote-conn-reconnect', key: 'ui.remote.reconnect' },
];

/**
 * Apply translations via the selector map.
 * @param {Element|Document} scope
 */
function i18nApplySelectors(scope) {
  if (!I18N_SELECTOR_MAP || _i18nLang === 'zh-CN') return;
  for (const entry of I18N_SELECTOR_MAP) {
    let els;
    try {
      els = scope.querySelectorAll(entry.sel);
    } catch (e) { continue; }
    if (!els || els.length === 0) continue;
    els.forEach(el => {
      // Skip if element is inside a code block or has data-i18n-nooverride
      if (el.closest('[data-i18n-nooverride]')) return;
      // Get fallback from current element text/attribute
      let fallback = '';
      const attr = entry.attr || 'text';
      if (attr === 'text') {
        fallback = el.textContent;
      } else {
        fallback = el.getAttribute(attr) || '';
      }
      if (!fallback) return;
      const translated = t(entry.key, fallback);
      if (!translated || translated === fallback) return;
      if (attr === 'text') {
        // Preserve child elements (like <i> icons) — only replace text nodes
        _i18nReplaceText(el, translated);
      } else {
        el.setAttribute(attr, translated);
      }
    });
  }
}

/**
 * Replace text content of an element while preserving child elements.
 */
function _i18nReplaceText(el, newText) {
  // If element has no children, just set textContent
  if (el.children.length === 0) {
    el.textContent = newText;
    return;
  }
  // If element has children, try to replace only the first text node
  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      node.textContent = ' ' + newText + ' ';
      return;
    }
  }
  // Fallback: set textContent (may lose child elements)
  el.textContent = newText;
}

// ── Translation dictionaries (populated by language files) ──
const I18N_TRANSLATIONS = {};

/**
 * Register a translation dictionary for a language.
 * Called by en.js / de.js at load time.
 */
function i18nRegister(lang, dict) {
  I18N_TRANSLATIONS[lang] = dict;
  // If this is the active language, refresh the dict reference
  if (_i18nLang === lang) {
    _i18nDict = dict || {};
    i18nApplyToDOM();
  }
}

// ── System prompt & tool description translation helpers ──

/**
 * Returns the localized system prompt for the given mode.
 * Falls back to the caller's original (Chinese) prompt if no translation exists.
 * @param {string} mode  'chat' | 'code' | 'babe'
 * @param {string} fallbackPrompt  The original Chinese prompt generated by the caller.
 * @param {object} [params]  Parameters for prompt template interpolation.
 * @returns {string}
 */
function i18nGetSystemPrompt(mode, fallbackPrompt, params) {
  if (_i18nLang === 'zh-CN') return fallbackPrompt;
  const prompts = _i18nDict._systemPrompts;
  if (prompts && prompts[mode]) {
    const val = prompts[mode];
    return typeof val === 'function' ? val(params || {}) : val;
  }
  return fallbackPrompt;
}

/**
 * Returns the localized description for a tool.
 * Falls back to the original Chinese desc if no translation exists.
 * @param {string} toolName  Tool identifier (e.g. 'readFile')
 * @param {string} fallbackDesc  Original Chinese description
 * @returns {string}
 */
function i18nGetToolDesc(toolName, fallbackDesc) {
  if (_i18nLang === 'zh-CN') return fallbackDesc;
  const tools = _i18nDict._tools;
  if (tools && tools[toolName]) return tools[toolName];
  return fallbackDesc;
}

/**
 * Returns the localized tool schema description.
 * Falls back to the original Chinese description if no translation exists.
 * @param {string} toolName
 * @param {string} fallbackDesc  Original Chinese schema description
 * @returns {string}
 */
function i18nGetToolSchemaDesc(toolName, fallbackDesc) {
  if (_i18nLang === 'zh-CN') return fallbackDesc;
  const schemas = _i18nDict._toolSchemas;
  if (schemas && schemas[toolName]) return schemas[toolName];
  return fallbackDesc;
}

/**
 * Returns the localized category label.
 * @param {string} category  Original Chinese category (e.g. '娱乐')
 * @param {string} fallback
 * @returns {string}
 */
function i18nGetCategory(category, fallback) {
  if (_i18nLang === 'zh-CN') return fallback || category;
  const cats = _i18nDict._categories;
  if (cats && cats[category]) return cats[category];
  return fallback || category;
}

/**
 * Returns a localized tool return / error message.
 * @param {string} key  Key in _toolReturns (e.g. 'file_not_exists')
 * @param {string} fallback  Original Chinese message
 * @param {object} [params]  Placeholder values
 * @returns {string}
 */
function i18nToolReturn(key, fallback, params) {
  if (_i18nLang === 'zh-CN' || !key) {
    return params ? _i18nFill(fallback, params) : fallback;
  }
  const returns = _i18nDict._toolReturns;
  let str = returns && returns[key];
  if (str === undefined) str = fallback;
  return params ? _i18nFill(str, params) : str;
}

/**
 * Walk all text nodes under `scope` and replace matching Chinese strings.
 * Also scans placeholder, title, and value attributes.
 * @param {Element|Document} scope
 */
function i18nApplyTextMap(scope) {
  if (_i18nLang === 'zh-CN') return;
  const textMap = _i18nDict._textMap;
  if (!textMap) return;
  const root = scope || document;

  // 1. Walk text nodes
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node) {
      // Skip script/style/textarea content
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  let current;
  while (current = walker.nextNode()) {
    textNodes.push(current);
  }

  textNodes.forEach(node => {
    const original = node.textContent;
    if (!original) return;
    // Try exact match first
    const trimmed = original.trim();
    if (textMap[trimmed]) {
      node.textContent = node.textContent.replace(trimmed, textMap[trimmed]);
      return;
    }
    // Try partial replacement (for strings embedded in larger text)
    let replaced = original;
    let changed = false;
    for (const [zh, tr] of Object.entries(textMap)) {
      if (zh.length < 2) continue; // Skip very short strings
      if (replaced.includes(zh)) {
        replaced = replaced.split(zh).join(tr);
        changed = true;
      }
    }
    if (changed) node.textContent = replaced;
  });

  // 2. Scan attributes (placeholder, title, value)
  root.querySelectorAll('[placeholder], [title]').forEach(el => {
    ['placeholder', 'title'].forEach(attr => {
      const val = el.getAttribute(attr);
      if (!val) return;
      const trimmed = val.trim();
      if (textMap[trimmed]) {
        el.setAttribute(attr, val.replace(trimmed, textMap[trimmed]));
        return;
      }
      // Partial replacement
      let replaced = val;
      let changed = false;
      for (const [zh, tr] of Object.entries(textMap)) {
        if (zh.length < 2) continue;
        if (replaced.includes(zh)) {
          replaced = replaced.split(zh).join(tr);
          changed = true;
        }
      }
      if (changed) el.setAttribute(attr, replaced);
    });
  });
}

// Expose globally
window.i18nInit = i18nInit;
window.i18nSetLanguage = i18nSetLanguage;
window.i18nGetLanguage = i18nGetLanguage;
window.t = t;
window.i18nApplyToDOM = i18nApplyToDOM;
window.i18nRegister = i18nRegister;
window.i18nGetSystemPrompt = i18nGetSystemPrompt;
window.i18nGetToolDesc = i18nGetToolDesc;
window.i18nGetToolSchemaDesc = i18nGetToolSchemaDesc;
window.i18nGetCategory = i18nGetCategory;
window.i18nToolReturn = i18nToolReturn;
window.i18nApplyTextMap = i18nApplyTextMap;
window.I18N_SUPPORTED_LANGUAGES = I18N_SUPPORTED_LANGUAGES;
