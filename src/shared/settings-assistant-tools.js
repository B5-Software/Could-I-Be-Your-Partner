/* SPDX-License-Identifier: GPL-3.0-or-later */
(function(root) {
  const tools = [
    { type: 'function', function: { name: 'settings_read', description: 'Read or search the safe settings catalog. Values of sensitive settings are never returned; manualCategories lists navigation-only settings.', parameters: { type: 'object', properties: { query: { type: 'string' } } } } },
    { type: 'function', function: { name: 'settings_patch', description: 'Apply only changes explicitly requested by the user to catalog-listed safe settings. Use exact paths and types; report the applied values. Sensitive fields require manual editing.', parameters: { type: 'object', properties: { changes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] } }, required: ['path', 'value'] }, maxItems: 20 } }, required: ['changes'] } } },
    { type: 'function', function: { name: 'settings_navigate', description: 'Open and highlight an exact settings path or a manual category. Never ask the user to send credentials in chat.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
  ];
  if(typeof module !== 'undefined') module.exports=tools;
  else root.SettingsAssistantTools=tools;
})(globalThis);
