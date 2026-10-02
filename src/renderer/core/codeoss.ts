/* SPDX-License-Identifier: GPL-3.0-or-later */
type State = { state: string; error?: string; location?: string; version?: string };
type Workspace = {
  ok: boolean;
  path?: string;
  uri?: string;
  location?: string;
  error?: string;
  cancelled?: boolean;
};
type Bounds = { x: number; y: number; width: number; height: number };
type HoverCard = {
  html: string;
  bounds: Bounds;
  offset: { x: number; y: number };
  size: { width: number; height: number };
  theme: string;
  variables: Record<string, string>;
  font: string;
};
type API = {
  codeOSSOpen(directory?: string | null): Promise<Workspace>;
  codeOSSLayout(layout: {
    visible: boolean;
    bounds: Bounds;
    overlay?: HoverCard | null;
    interactionRevision?: number;
  }): Promise<unknown>;
  codeOSSCommand(command: string): Promise<unknown>;
  onCodeOSSState(callback: (state: State) => void): () => void;
  onCodeOSSInteraction(callback: (event: { revision: number }) => void): () => void;
};

export class CodeOSSController {
  private frame = 0;
  private ready = false;
  private opening: Promise<Workspace> | null = null;
  private lastLayout = '';
  private interactionRevision = 0;
  constructor(
    private api: API,
    private viewport: HTMLElement,
    private status: HTMLElement,
  ) {
    api.onCodeOSSInteraction((event) => {
      this.interactionRevision = event.revision;
      document.body.classList.add('codeoss-interacting');
      this.scheduleLayout();
    });
    document.addEventListener(
      'pointermove',
      () => {
        if (document.body.classList.contains('codeoss-interacting')) {
          document.body.classList.remove('codeoss-interacting');
          this.scheduleLayout();
        }
      },
      true,
    );
    api.onCodeOSSState((state) => {
      this.ready = state.state === 'ready';
      this.status.textContent =
        state.error ||
        (this.ready
          ? `${state.location === 'vm' ? 'VM' : '本机'} · Code-OSS ${state.version || ''}`
          : state.state === 'closed'
            ? '工作台已关闭'
            : '正在启动桌面工作台…');
      this.viewport.dataset.state = state.state;
      this.scheduleLayout();
    });
    new ResizeObserver(() => this.scheduleLayout()).observe(viewport);
    new MutationObserver(() => this.scheduleLayout()).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style', 'aria-hidden', 'data-theme'],
      childList: true,
      characterData: true,
    });
    window.addEventListener('resize', () => this.scheduleLayout());
    // CSS :hover tooltips change visibility without a DOM mutation.
    for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout', 'scroll']) {
      document.addEventListener(event, () => this.scheduleLayout(), true);
    }
    document.addEventListener('visibilitychange', () => this.scheduleLayout());
    window.addEventListener('beforeunload', () => {
      void api.codeOSSLayout({ visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    });
  }
  async open(directory?: string | null): Promise<Workspace> {
    if (this.opening) await this.opening;
    this.status.textContent = '正在打开工作区…';
    const operation = this.api.codeOSSOpen(directory);
    this.opening = operation;
    try {
      const result = await operation;
      if (!result.ok && !result.cancelled) {
        this.status.textContent = result.error || '工作台启动失败';
        this.viewport.dataset.state = 'error';
      }
      return result;
    } finally {
      if (this.opening === operation) this.opening = null;
      this.scheduleLayout();
    }
  }
  scheduleLayout(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  }
  private layout(): void {
    const bounds = this.viewport.getBoundingClientRect();
    const visibleModal = [
      ...document.querySelectorAll<HTMLElement>(
        '.modal-overlay, .modal, [role="dialog"], .dock-panel',
      ),
    ].some(
      (element) =>
        !element.classList.contains('hidden') &&
        element.getAttribute('aria-hidden') !== 'true' &&
        element.getClientRects().length > 0,
    );
    const visible =
      this.ready && this.viewport.getClientRects().length > 0 && !document.hidden && !visibleModal;
    const layout = {
      visible,
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      overlay: visible ? this.hoverCard(bounds) : null,
      interactionRevision: this.interactionRevision,
    };
    const key = JSON.stringify(layout);
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    void this.api.codeOSSLayout(layout).catch((error) => {
      if (this.lastLayout === key) this.lastLayout = '';
      console.warn('[Code-OSS layout]', error);
    });
  }
  private hoverCard(viewport: DOMRect): HoverCard | null {
    if (document.body.classList.contains('codeoss-interacting')) return null;
    const card = [
      ...document.querySelectorAll<HTMLElement>('.session-tab-popover, .context-tooltip'),
    ].find((element) => {
      if (!element.getClientRects().length) return false;
      const rect = element.getBoundingClientRect();
      return (
        rect.right > viewport.left &&
        rect.left < viewport.right &&
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom
      );
    });
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    // Keep the native overlay inside the IDE: covering the hovered tab itself
    // would trigger mouseleave and cause the card to flicker open and closed.
    const x = Math.max(Math.ceil(viewport.left), Math.floor(rect.x - 24));
    const y = Math.max(Math.ceil(viewport.top), Math.floor(rect.y - 24));
    const root = getComputedStyle(document.documentElement);
    const variables: Record<string, string> = {};
    for (const name of root) {
      if (name.startsWith('--')) variables[name] = root.getPropertyValue(name);
    }
    return {
      html: card.outerHTML,
      bounds: {
        x,
        y,
        width: Math.min(viewport.right - x, rect.right - x + 24),
        height: Math.min(viewport.bottom - y, rect.bottom - y + 24),
      },
      offset: { x: rect.x - x, y: rect.y - y },
      size: { width: rect.width, height: rect.height },
      theme: document.documentElement.dataset.theme || 'light',
      variables,
      font: getComputedStyle(document.body).font,
    };
  }
  command(command: string): Promise<unknown> {
    return this.api.codeOSSCommand(command);
  }
}
