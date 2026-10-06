/* SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const enabled = () => document.documentElement.dataset.animations !== 'off' && !reduced.matches;
  const settle = () => {
    if (enabled()) return;
    for (const animation of document.getAnimations()) {
      try { animation.finish(); } catch { animation.cancel(); }
    }
  };
  const animate = Element.prototype.animate;
  if (animate) Element.prototype.animate = function (frames, options) {
    return animate.call(this, frames, enabled() ? options : { ...(typeof options === 'object' ? options : {}), duration: 0, delay: 0, iterations: 1 });
  };
  // Explicit smooth scrolling also obeys the switch, including editor/helper libraries.
  for (const prototype of [Element.prototype, Window.prototype]) {
    for (const method of ['scrollTo', 'scrollBy', 'scrollIntoView']) {
      const original = prototype[method];
      if (!original) continue;
      prototype[method] = function (...args) {
        if (!enabled() && args[0] && typeof args[0] === 'object') args[0] = { ...args[0], behavior: 'instant' };
        return original.apply(this, args);
      };
    }
  }
  new MutationObserver(settle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations'] });
  reduced.addEventListener('change', settle);
  const apply = settings => { if (typeof settings?.animations === 'boolean') document.documentElement.dataset.animations = settings.animations ? 'on' : 'off'; };
  window.CibypMotion = { enabled, settle };
  window.api?.getSettings?.().then(apply).catch(() => {});
  window.api?.onSettingsChanged?.(apply);
})();
