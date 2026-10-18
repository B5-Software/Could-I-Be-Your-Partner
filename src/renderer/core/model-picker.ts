/* SPDX-License-Identifier: GPL-3.0-or-later */
export type ModelChoice = {
  id: string;
  label: string;
  model: string;
  provider: string;
  default?: boolean;
};
export type ModelChoices = {
  busy: boolean;
  selected: string;
  model: string;
  entries: ModelChoice[];
  effort?: string;
  variants?: { id: string; label?: string }[];
  defaultEffort?: string;
};
type Actions = {
  list: () => Promise<ModelChoices>;
  select: (id: string) => Promise<unknown>;
  manage: () => unknown;
  text: (key: string, fallback: string) => string;
};
let active: (() => void) | undefined;

/** Real session selection, with no API keys or provider URLs in the menu DOM. */
export function openModelPicker(anchor: HTMLButtonElement, actions: Actions): void {
  active?.();
  const panel = document.createElement('div');
  panel.className = 'model-picker';
  panel.setAttribute('role', 'dialog');
  const text = (key: string, fallback: string) => actions.text('ui.models.' + key, fallback);
  panel.setAttribute('aria-label', text('title', '选择会话模型'));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = text('search', '搜索模型或提供方…');
  input.setAttribute('aria-label', input.placeholder);
  const list = document.createElement('div');
  list.className = 'model-picker-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', text('title', '选择会话模型'));
  const status = document.createElement('p');
  status.className = 'model-picker-status';
  status.setAttribute('role', 'status');
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'model-picker-manage';
  manage.textContent = text('manage', '管理模型池');
  panel.append(input, list, status, manage);
  let data: ModelChoices | undefined,
    choosing = false;
  function close() {
    panel.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('cibyp:page-changed', close);
    window.removeEventListener('cibyp:appearance-changed', close);
    anchor.setAttribute('aria-expanded', 'false');
    if (active === close) active = undefined;
  }
  function position() {
    const r = anchor.getBoundingClientRect(),
      width = Math.min(400, innerWidth - 24);
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(innerWidth - width - 12, r.left)) + 'px';
    const above = r.top > innerHeight / 2;
    panel.style.maxHeight = Math.max(160, (above ? r.top : innerHeight - r.bottom) - 20) + 'px';
    panel.style.top = above ? 'auto' : r.bottom + 8 + 'px';
    panel.style.bottom = above ? innerHeight - r.top + 8 + 'px' : 'auto';
  }
  function outside(event: PointerEvent) {
    if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      anchor.focus();
      return;
    }
    if (
      !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key) ||
      !panel.contains(document.activeElement)
    )
      return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Enter') {
      (rows[index] || rows[0])?.click();
      return;
    }
    (event.key === 'Home'
      ? rows[0]
      : event.key === 'End'
        ? rows.at(-1)
        : rows[(index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length]
    )?.focus();
  }
  function render() {
    if (!data) return;
    list.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    for (const entry of data.entries.filter((e) =>
      [e.label, e.model, e.provider].some((v) => v.toLocaleLowerCase().includes(query)),
    )) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-picker-option';
      row.dataset.entryId = entry.id;
      const selected = data.selected ? entry.id === data.selected : entry.model === data.model;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected));
      row.disabled = data.busy || choosing;
      const copy = document.createElement('span'),
        title = document.createElement('strong'),
        detail = document.createElement('small'),
        badge = document.createElement('span');
      title.textContent = entry.label;
      detail.textContent = entry.provider;
      row.title = entry.model;
      copy.append(title, detail);
      badge.className = 'model-picker-badge';
      badge.textContent = selected ? '✓' : entry.default ? text('default', '默认') : '';
      row.append(copy, badge);
      row.onclick = async () => {
        if (choosing) return;
        choosing = true;
        delete status.dataset.error;
        render();
        status.textContent = text('switching', '正在切换…');
        try {
          await actions.select(entry.id);
          close();
          anchor.focus();
        } catch (error) {
          if (panel.isConnected) {
            status.dataset.error = 'true';
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        } finally {
          choosing = false;
          if (panel.isConnected) render();
        }
      };
      list.append(row);
    }
    if (!choosing && !status.dataset.error)
      status.textContent = data.busy
        ? text('busy', '任务进行中，结束后可切换模型。')
        : !data.entries.length
          ? text('empty', '模型池为空，请先添加模型。')
          : !list.children.length
            ? text('noMatches', '没有匹配的模型')
            : text('sessionOnly', '仅切换当前会话；全局默认模型保持不变。');
  }
  input.oninput = () => {
    delete status.dataset.error;
    render();
  };
  manage.onclick = () => {
    close();
    actions.manage();
  };
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'true');
  document.body.append(panel);
  active = close;
  position();
  input.focus();
  status.textContent = text('loading', '正在加载模型池…');
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard, true);
  window.addEventListener('resize', position);
  window.addEventListener('cibyp:page-changed', close);
  window.addEventListener('cibyp:appearance-changed', close);
  void actions
    .list()
    .then((value) => {
      if (!panel.isConnected) return;
      data = value;
      render();
      position();
    })
    .catch((error) => {
      status.textContent = error.message;
    });
}
