/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */

type Mirror = (element: HTMLElement) => void;
const transitions = new WeakMap<HTMLElement, Animation>();

export function installMotionPreferences(): void {
  const settle = () => {
    if (motionEnabled()) return;
    document.getAnimations().forEach((animation) => {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    });
  };
  new MutationObserver(settle).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-animations'],
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', settle);
}

export function motionEnabled(): boolean {
  return (
    document.documentElement.dataset.animations !== 'off' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** A cancelled exit must never hide a surface that has already reopened. */
export function setSurfaceOpen(element: HTMLElement, open: boolean, mirror?: Mirror): void {
  const previous = transitions.get(element);
  const transform = getComputedStyle(element).transform;
  previous?.cancel();
  transitions.delete(element);
  element.dataset.surfaceOpen = String(open);
  element.inert = !open;
  element.setAttribute('aria-hidden', String(!open));
  if (open) element.classList.remove('hidden');
  const finish = () => {
    if (element.dataset.surfaceOpen !== String(open)) return;
    element.classList.toggle('hidden', !open);
    mirror?.(element);
  };
  mirror?.(element);
  if (!motionEnabled() || (!open && element.classList.contains('hidden'))) {
    finish();
    return;
  }
  const animation = element.animate(
    [
      {
        transform: previous ? transform : open ? 'translateX(18px)' : 'translateX(0)',
      },
      { transform: open ? 'translateX(0)' : 'translateX(18px)' },
    ],
    { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  transitions.set(element, animation);
  animation.finished
    .then(() => {
      if (transitions.get(element) !== animation) return;
      transitions.delete(element);
      finish();
    })
    .catch(() => {
      /* superseded by a newer transition */
    });
}

export class DockPanels {
  private active: string | null = null;
  private minimized = new Set<string>();
  constructor(
    private panels: HTMLElement[],
    private tabs: HTMLElement,
    private mirror: Mirror,
  ) {
    for (const panel of panels) {
      panel.inert = panel.classList.contains('hidden');
      panel.setAttribute('aria-hidden', String(panel.inert));
    }
  }
  setOpen(id: string, open: boolean): void {
    const panel = this.panels.find((item) => item.id === id);
    if (!panel) return;
    if (open && this.active === id && panel.dataset.surfaceOpen === 'true') return;
    if (open) {
      if (this.active && this.active !== id) this.minimize(this.active);
      this.active = id;
      this.minimized.delete(id);
    } else {
      if (this.active === id) this.active = null;
      this.minimized.delete(id);
    }
    setSurfaceOpen(panel, open, this.mirror);
    this.render();
  }
  minimize(id: string): void {
    const panel = this.panels.find((item) => item.id === id);
    if (!panel || this.active !== id) return;
    this.active = null;
    this.minimized.add(id);
    setSurfaceOpen(panel, false, this.mirror);
    this.render();
  }
  private render(): void {
    document.body.classList.toggle('geogebra-open', !!this.active);
    this.tabs.replaceChildren();
    for (const id of this.minimized) {
      const panel = this.panels.find((item) => item.id === id)!;
      const title = panel.querySelector('h3')?.textContent?.trim() || id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'panel-tab';
      button.dataset.panelId = id;
      button.title = `恢复 ${title}`;
      button.setAttribute('aria-controls', id);
      const icon = panel.querySelector('h3 i');
      if (icon) button.appendChild(icon.cloneNode(true));
      const label = document.createElement('span');
      label.textContent = title;
      button.appendChild(label);
      button.addEventListener('click', () => this.setOpen(id, true));
      this.tabs.appendChild(button);
    }
    this.mirror(this.tabs);
  }
}

/** Fade disclosure contents without vertical movement or a stale collapse after reopening. */
export function setDisclosureOpen(element: HTMLElement, open: boolean, mirror?: Mirror): void {
  const previous = transitions.get(element);
  const opacity = getComputedStyle(element).opacity;
  previous?.cancel();
  transitions.delete(element);
  element.dataset.disclosureOpen = String(open);
  element.inert = !open;
  element.setAttribute('aria-hidden', String(!open));
  element.classList.remove('hidden');
  const finish = () => {
    if (element.dataset.disclosureOpen !== String(open)) return;
    element.classList.toggle('hidden', !open);
    mirror?.(element);
  };
  if (!motionEnabled()) {
    finish();
    return;
  }
  const animation = element.animate(
    [{ opacity: previous ? opacity : open ? 0 : 1 }, { opacity: open ? 1 : 0 }],
    { duration: 160, easing: 'ease-out' },
  );
  transitions.set(element, animation);
  animation.finished
    .then(() => {
      if (transitions.get(element) !== animation) return;
      transitions.delete(element);
      finish();
    })
    .catch(() => {});
  mirror?.(element);
}

/** Keep focus and the accessibility tree in sync with the single active page. */
export function activatePage(page: HTMLElement, pages: HTMLElement[]): void {
  for (const item of pages) {
    transitions.get(item)?.cancel();
    transitions.delete(item);
    item.classList.toggle('active', item === page);
    item.inert = item !== page;
    item.setAttribute('aria-hidden', String(item !== page));
  }
  if (motionEnabled())
    transitions.set(
      page,
      page.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' }),
    );
}
