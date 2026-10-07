/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const pages = require('../shared/browser-pages');
function createBrowserSurfaces(publish) {
  const surfaces = new Map();
  const surfaceType = Object.keys(pages).find(key => window.location.pathname.endsWith('/' + pages[key] + '.html'));
  function close(id) { const dialog = surfaces.get(id); if (!dialog) return; dialog.close(); dialog.remove(); surfaces.delete(id); }
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.data?.type !== 'cibyp:close-surface') return;
    for (const [id, dialog] of surfaces) if (dialog.querySelector('iframe').contentWindow === event.source) close(id);
  });
  function open(type, payload) {
    if (!pages[type]) return null;
    close(type);
    const query = new URLSearchParams();
    if (payload?.id) query.set('id', payload.id);
    if (payload?.readonly) query.set('readonly', '1');
    if (typeof payload === 'number') query.set('aiCount', String(payload));
    if (payload?.aiCount) query.set('aiCount', String(payload.aiCount));
    if (payload?.category) query.set('category', payload.category);
    const dialog = document.createElement('dialog');
    dialog.className = 'cibyp-browser-surface';
    dialog.style.cssText = 'padding:0;border:1px solid var(--border-color,#80808044);border-radius:16px;width:min(1280px,calc(100vw - 32px));max-width:none;height:calc(100dvh - 32px);max-height:none;background:var(--bg-primary,#fff);box-shadow:0 24px 80px #0004;overflow:hidden';
    const frame = document.createElement('iframe'); frame.title = type;
    frame.src = '/src/renderer/pages/' + pages[type] + '.html?' + query;
    frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    dialog.append(frame); document.body.append(dialog); surfaces.set(type, dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); frame.contentWindow?.postMessage({ type: 'cibyp:request-close', surface: type }, window.location.origin); });
    dialog.showModal(); return { ok: true };
  }
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== 'cibyp:request-close') return;
    if (surfaceType === 'cipypcad' || surfaceType === 'pcbeda') publish(surfaceType + ':close-requested');
    else { const button = document.querySelector('#btn-close, #btn-close-window, [data-action="close"]'); if (button) button.click(); else window.parent.postMessage({ type: 'cibyp:close-surface' }, window.location.origin); }
  });
  return {
    handles(channel) { return !!(channel.endsWith(':open') && pages[channel.slice(0,-5)]) || /^(skill-editor|automation-editor|sanguosha|flyingflower|undercover|idiom|guesscharacter|cipypcad|pcbeda):(close|confirmClose|minimize|maximizeToggle|isMaximized)$/.test(channel) || channel === 'vm-files:window'; },
    invoke(channel, payload) {
      const type = channel.split(':')[0], action = channel.split(':')[1];
      if (action === 'open') return open(type, payload);
      if (action === 'isMaximized') return { ok: true, maximized: true };
      if (action === 'minimize' || action === 'maximizeToggle') return { ok: true };
      const closeAction = channel === 'vm-files:window' ? payload?.action === 'close' : action !== 'confirmClose' || payload === 'close';
      if (closeAction) {
        if (window.parent !== window) window.parent.postMessage({ type: 'cibyp:close-surface' }, window.location.origin);
        else close(type);
      }
      return { ok: true };
    }
  };
}
module.exports = { createBrowserSurfaces };
