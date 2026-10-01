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
type API = {
  codeOSSOpen(directory?: string | null): Promise<Workspace>;
  codeOSSLayout(layout: {
    visible: boolean;
    bounds: { x: number; y: number; width: number; height: number };
  }): Promise<unknown>;
  codeOSSCommand(command: string): Promise<unknown>;
  onCodeOSSState(callback: (state: State) => void): () => void;
};

export class CodeOSSController {
  private frame = 0;
  private ready = false;
  private opening: Promise<Workspace> | null = null;
  private lastLayout = '';
  constructor(
    private api: API,
    private viewport: HTMLElement,
    private status: HTMLElement,
  ) {
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
    new MutationObserver(() => this.scheduleLayout()).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style', 'aria-hidden'],
      childList: true,
    });
    window.addEventListener('resize', () => this.scheduleLayout());
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
    };
    const key = JSON.stringify(layout);
    if (key === this.lastLayout) return;
    this.lastLayout = key;
    void this.api.codeOSSLayout(layout).catch((error) => console.warn('[Code-OSS layout]', error));
  }
  command(command: string): Promise<unknown> {
    return this.api.codeOSSCommand(command);
  }
}
