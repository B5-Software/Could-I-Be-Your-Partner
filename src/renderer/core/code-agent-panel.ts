/* SPDX-License-Identifier: GPL-3.0-or-later */
type EditorState = {
  path?: string;
  dirty?: boolean;
  selection?: { start: number; end: number; selected: boolean };
};
type EditorContext = EditorState & { workspace?: { path: string }[]; content?: string };
type Change = { id: string; path: string; label: string; created: boolean };
type API = {
  codeOSSContext(): Promise<EditorContext>;
  codeOSSChanges(action?: string, id?: string): Promise<{ changes: Change[]; conflict?: boolean }>;
  onCodeOSSIDEState(callback: (state: EditorState) => void): () => void;
  onCodeOSSChanges(callback: (changes: Change[]) => void): () => void;
  onCodeOSSState(callback: (state: { state: string }) => void): () => void;
};

/** CIBYP owns the AI surface; the IDE bridge only supplies editor data and edits. */
export class CodeAgentPanel {
  private panel = document.getElementById('code-agent-panel')!;
  private input = document.getElementById('code-chat-input') as HTMLTextAreaElement;
  private toggle = document.getElementById('btn-code-agent')!;
  private resizer = document.getElementById('code-agent-resizer')!;
  private requestedWidth = 420;
  private open = true;
  private changeRevision = 0;
  constructor(
    private api: API,
    private notify: (message: string) => void,
  ) {
    try {
      this.requestedWidth = Number(localStorage.getItem('cibyp.code.ai.width')) || 420;
      this.open = localStorage.getItem('cibyp.code.ai.open') !== 'false';
    } catch {
      /* Preferences are optional. */
    }
    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    this.setOpen(this.open, false);
    new ResizeObserver(() => this.size()).observe(this.panel.parentElement!);
    this.resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      this.resizer.setPointerCapture(event.pointerId);
      this.panel.classList.add('resizing');
    });
    this.resizer.addEventListener('pointermove', (event) => {
      if (!this.resizer.hasPointerCapture(event.pointerId)) return;
      this.requestedWidth = this.panel.getBoundingClientRect().right - event.clientX;
      this.size();
    });
    this.resizer.addEventListener('lostpointercapture', () => {
      this.panel.classList.remove('resizing');
      this.persist();
    });
    this.resizer.addEventListener('pointerup', (event) => {
      if (this.resizer.hasPointerCapture(event.pointerId))
        this.resizer.releasePointerCapture(event.pointerId);
    });
    this.resizer.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      this.requestedWidth =
        event.key === 'Home' ? 420 : this.requestedWidth + (event.key === 'ArrowLeft' ? 24 : -24);
      this.size();
      this.persist();
    });
    api.onCodeOSSIDEState((state) => this.editorState(state));
    api.onCodeOSSChanges((changes) => this.changes(changes));
    api.onCodeOSSState((state) => {
      if (state.state === 'ready') void this.refresh();
      else {
        this.changeRevision++;
        this.renderChanges([]);
        this.editorState({});
      }
    });
  }
  private persist(): void {
    try {
      localStorage.setItem('cibyp.code.ai.width', String(this.requestedWidth));
      localStorage.setItem('cibyp.code.ai.open', String(this.open));
    } catch {
      /* Preferences are optional. */
    }
  }
  private size(): void {
    const available = this.panel.parentElement!.clientWidth;
    if (!available) return;
    const max = Math.max(220, Math.min(760, available - 260));
    const width = Math.round(Math.max(Math.min(300, max), Math.min(max, this.requestedWidth)));
    this.panel.style.setProperty('--code-agent-width', `${width}px`);
    this.resizer.setAttribute('aria-valuenow', String(width));
    this.resizer.setAttribute('aria-valuemax', String(max));
    this.resizer.setAttribute('aria-valuemin', String(Math.min(300, max)));
  }
  setOpen(open: boolean, focus = true): void {
    this.open = open;
    this.panel.classList.toggle('collapsed', !open);
    this.panel.inert = !open;
    this.panel.setAttribute('aria-hidden', String(!open));
    this.toggle.setAttribute('aria-expanded', String(open));
    if (open && focus) this.input.focus({ preventScroll: true });
    else if (!open && this.panel.contains(document.activeElement))
      this.toggle.focus({ preventScroll: true });
    this.persist();
    this.size();
  }
  focus(draft?: string): void {
    this.setOpen(true);
    if (draft) {
      this.input.value = draft;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  private editorState(state: EditorState): void {
    const label = document.getElementById('code-editor-context-label')!;
    label.textContent = state.path
      ? `${state.path.split(/[\\/]/).pop()}${state.selection?.selected ? ` · 第 ${state.selection.start}–${state.selection.end} 行` : ''}${state.dirty ? ' · 未保存' : ''}`
      : '附带当前编辑器上下文';
    label.title = state.path || '发送时读取当前文件、选中代码和诊断';
  }
  async context(): Promise<EditorContext | null> {
    if (!(document.getElementById('code-include-editor') as HTMLInputElement).checked) return null;
    const context = await this.api.codeOSSContext();
    this.editorState(context);
    return context;
  }
  private async refresh(): Promise<void> {
    const revision = ++this.changeRevision;
    try {
      const [context, result] = await Promise.all([
        this.api.codeOSSContext(),
        this.api.codeOSSChanges(),
      ]);
      if (revision !== this.changeRevision) return;
      this.editorState(context);
      this.renderChanges(result.changes);
    } catch {
      /* Bridge may reconnect while opening a workspace. */
    }
  }
  private changes(changes: Change[]): void {
    this.changeRevision++;
    this.renderChanges(changes);
  }
  private renderChanges(changes: Change[]): void {
    const list = document.getElementById('code-changes-list')!;
    document.getElementById('code-changes-count')!.textContent = String(changes.length);
    list.replaceChildren();
    if (!changes.length) {
      const empty = document.createElement('p');
      empty.className = 'code-changes-empty';
      empty.textContent = '暂无待审阅的修改';
      list.append(empty);
    }
    for (const item of changes) {
      const row = document.createElement('div');
      row.className = 'code-change-row';
      const file = document.createElement('button');
      file.className = 'code-change-file';
      file.textContent = `${item.created ? '+ ' : ''}${item.label}`;
      file.title = item.path;
      const actions = document.createElement('div');
      for (const [action, label, icon] of [
        ['open', '查看差异', 'code-compare'],
        ['accept', '接受修改', 'check'],
        ['revert', '撤销修改', 'rotate-left'],
      ]) {
        const button = action === 'open' ? file : document.createElement('button');
        if (action !== 'open') {
          button.className = 'btn-icon';
          button.title = label!;
          button.setAttribute('aria-label', label!);
          const image = document.createElement('i');
          image.className = `fa-solid fa-${icon}`;
          button.append(image);
          actions.append(button);
        }
        button.addEventListener('click', async () => {
          button.disabled = true;
          const revision = this.changeRevision;
          try {
            const result = await this.api.codeOSSChanges(action, item.id);
            if (result.conflict)
              this.notify('文件在 AI 修改后发生了变化，请打开差异视图手动合并。');
            if (revision === this.changeRevision) this.changes(result.changes);
          } catch (error) {
            this.notify((error as Error).message);
          } finally {
            button.disabled = false;
          }
        });
      }
      row.append(file, actions);
      list.append(row);
    }
  }
}
