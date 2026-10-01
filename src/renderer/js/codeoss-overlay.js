/* SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  const tags = new Set([
    'div',
    'span',
    'b',
    'strong',
    'em',
    'i',
    'small',
    'p',
    'br',
    'svg',
    'circle',
    'text',
  ]);
  const attributes = new Set([
    'id',
    'class',
    'viewBox',
    'width',
    'height',
    'cx',
    'cy',
    'r',
    'x',
    'y',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-dashoffset',
    'transform',
    'opacity',
    'text-anchor',
    'font-size',
  ]);
  window.renderCodeOSSOverlay = (snapshot) => {
    const parsed = new DOMParser().parseFromString(snapshot.html, 'text/html');
    for (const element of [...parsed.body.querySelectorAll('*')]) {
      if (!tags.has(element.localName)) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        if (attribute.name === 'style') {
          const width = element.style.width;
          element.removeAttribute('style');
          if (/^\d+(\.\d+)?%$/.test(width)) element.style.width = width;
        } else if (!attributes.has(attribute.name)) element.removeAttribute(attribute.name);
      }
    }
    const root = document.documentElement;
    root.style.cssText = '';
    root.dataset.theme = snapshot.theme === 'dark' ? 'dark' : 'light';
    for (const [name, value] of Object.entries(snapshot.variables || {})) {
      if (name.startsWith('--') && typeof value === 'string') root.style.setProperty(name, value);
    }
    document.body.style.font = snapshot.font;
    const card = parsed.body.firstElementChild;
    const host = document.getElementById('overlay-root');
    host.replaceChildren();
    if (!card) return;
    card.style.left = `${snapshot.offset.x}px`;
    card.style.top = `${snapshot.offset.y}px`;
    card.style.right = 'auto';
    card.style.width = `${snapshot.size.width}px`;
    card.style.height = `${snapshot.size.height}px`;
    host.appendChild(document.importNode(card, true));
  };
})();
