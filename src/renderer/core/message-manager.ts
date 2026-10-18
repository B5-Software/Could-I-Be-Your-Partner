/* SPDX-License-Identifier: GPL-3.0-or-later */
type Item = { id: string; role: string; content: string; excluded?: boolean };
type Plan = {
  selectedCount: number;
  affectedCount: number;
  rawContextCount: number;
  preservedPrefixCount: number;
  retainedInSummary: boolean;
};
type Actions = {
  load: () => Promise<{ items: Item[]; busy: boolean }>;
  preview: (ids: string[], scope: string) => Promise<Plan>;
  apply: (ids: string[], scope: string) => Promise<unknown>;
  text: (key: string, fallback: string) => string;
  stop?: () => Promise<void>;
};
let active: HTMLDialogElement | undefined;
export async function openMessageManager(
  actions: Actions,
  options: { ids?: string[]; all?: boolean; scope?: string } = {},
): Promise<void> {
  active?.close();
  active?.remove();
  const dialog = document.createElement('dialog');
  dialog.className = 'message-manager';
  active = dialog;
  const text = (key: string, fallback: string) => actions.text('ui.messageEdit.' + key, fallback);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', text('title', '管理消息'));
  const heading = document.createElement('header'),
    title = document.createElement('h2'),
    close = document.createElement('button');
  title.textContent = text('title', '管理消息');
  close.type = 'button';
  close.className = 'btn-icon';
  close.textContent = '×';
  close.setAttribute('aria-label', text('close', '关闭'));
  heading.append(title, close);
  const intro = document.createElement('p');
  intro.className = 'message-manager-intro';
  intro.textContent = text(
    'intro',
    '多选要移除的消息。删除用户消息会连同本轮回复处理；工具调用与结果会保持成组，避免模型请求损坏。',
  );
  const toolbar = document.createElement('div');
  toolbar.className = 'message-manager-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = text('search', '搜索消息…');
  search.setAttribute('aria-label', search.placeholder);
  const selectAll = document.createElement('button'),
    clear = document.createElement('button'),
    reload = document.createElement('button');
  for (const button of [selectAll, clear, reload]) {
    button.type = 'button';
    button.className = 'btn-secondary';
  }
  selectAll.textContent = text('selectAll', '选择筛选结果');
  clear.textContent = text('clear', '取消选择');
  reload.textContent = text('refresh', '刷新');
  toolbar.append(search, selectAll, clear, reload);
  const list = document.createElement('div');
  list.className = 'message-manager-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-multiselectable', 'true');
  list.setAttribute('aria-label', text('messages', '聊天消息'));
  const scope = document.createElement('select');
  scope.className = 'message-manager-scope';
  scope.setAttribute('aria-label', text('scope', '移除范围'));
  for (const [value, label] of [
    ['both', text('both', '同时删除聊天记录和原始上下文')],
    ['context', text('contextOnly', '移出模型上下文，保留聊天记录')],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    scope.append(option);
  }
  scope.value = options.scope === 'context' ? 'context' : 'both';
  const preview = document.createElement('div');
  preview.className = 'message-manager-preview';
  preview.setAttribute('role', 'status');
  preview.setAttribute('aria-live', 'polite');
  const footer = document.createElement('footer'),
    cancel = document.createElement('button'),
    apply = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-secondary';
  cancel.textContent = text('cancel', '取消');
  apply.type = 'button';
  apply.className = 'btn-danger';
  apply.disabled = true;
  footer.append(cancel, apply);
  dialog.append(heading, intro, toolbar, list, scope, preview, footer);
  document.body.append(dialog);
  dialog.showModal();
  search.focus();
  let items: Item[] = [],
    busy = false,
    saving = false,
    generation = 0,
    limit = 200,
    last = -1;
  const selected = new Set(options.ids || []);
  const closeDialog = () => {
    if (saving) return;
    generation++;
    dialog.close();
    dialog.remove();
    if (active === dialog) active = undefined;
  };
  close.onclick = cancel.onclick = closeDialog;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });
  const filtered = () => {
    const query = search.value.toLocaleLowerCase();
    return items.filter((m) => !query || m.content.toLocaleLowerCase().includes(query));
  };
  async function updatePreview() {
    const revision = ++generation;
    apply.disabled = true;
    apply.textContent =
      scope.value === 'context'
        ? text('removeContext', '移出模型上下文')
        : text('delete', '删除所选消息');
    if (!selected.size) {
      preview.textContent = text('choose', '选择消息后查看将受影响的上下文范围。');
      return;
    }
    if (busy) {
      preview.textContent = text('busy', '当前任务仍在运行，请结束后刷新，再操作消息。');
      return;
    }
    try {
      const plan = await actions.preview([...selected], scope.value);
      if (revision !== generation || !dialog.isConnected) return;
      const numbers = document.createElement('p');
      numbers.textContent = text(
        'counts',
        '选中 {selected} 条，包含关联消息共 {affected} 条；将移除 {raw} 条原始上下文。',
      )
        .replace('{selected}', String(plan.selectedCount))
        .replace('{affected}', String(plan.affectedCount))
        .replace('{raw}', String(plan.rawContextCount));
      const cache = document.createElement('p');
      cache.textContent = text(
        'prefix',
        '保留前 {count} 条上下文及系统提示原文，后续缓存由模型服务重新计算。',
      ).replace('{count}', String(plan.preservedPrefixCount));
      preview.replaceChildren(numbers, cache);
      if (plan.retainedInSummary) {
        const summary = document.createElement('p');
        summary.className = 'message-manager-warning';
        summary.textContent = text(
          'summary',
          '部分内容已合并进摘要，无法从摘要中精确删除。本次保留摘要；如需彻底移除，请清空上下文。',
        );
        preview.append(summary);
      }
      apply.disabled = false;
    } catch (error) {
      if (revision === generation)
        preview.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  function render() {
    list.replaceChildren();
    const rows = filtered();
    for (const [index, item] of rows.slice(0, limit).entries()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'message-manager-row';
      row.dataset.messageId = item.id;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(selected.has(item.id)));
      const mark = document.createElement('span'),
        body = document.createElement('span'),
        role = document.createElement('strong'),
        content = document.createElement('span');
      mark.className = 'message-manager-check';
      mark.textContent = selected.has(item.id) ? '✓' : '';
      role.textContent = text(
        item.role,
        item.role === 'user' ? '我' : item.role === 'assistant' ? 'AI' : '工具',
      );
      if (item.excluded) role.textContent += ' · ' + text('excluded', '已移出上下文');
      content.textContent =
        item.content.slice(0, 600) || text('emptyMessage', '（附件、推理或工具消息）');
      body.append(role, content);
      row.append(mark, body);
      row.onclick = (event) => {
        if (saving) return;
        const range =
          event.shiftKey && last >= 0
            ? rows.slice(Math.min(last, index), Math.max(last, index) + 1)
            : [item];
        const remove = !event.shiftKey && selected.has(item.id);
        for (const value of range) {
          if (remove) selected.delete(value.id);
          else if (selected.size < 5000) selected.add(value.id);
        }
        last = index;
        render();
        void updatePreview();
        list.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)?.focus();
      };
      list.append(row);
    }
    if (rows.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn-secondary';
      more.textContent = text('more', '显示更多');
      more.onclick = () => {
        limit += 200;
        render();
      };
      list.append(more);
    }
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.textContent = text('empty', '没有可管理的消息');
      list.append(empty);
    }
  }
  async function load() {
    apply.disabled = true;
    preview.textContent = text('loading', '正在加载消息…');
    try {
      const data = await actions.load();
      if (!dialog.isConnected) return;
      items = data.items;
      busy = data.busy;
      const valid = new Set(items.map((m) => m.id));
      for (const id of selected) if (!valid.has(id)) selected.delete(id);
      if (options.all) {
        items.slice(0, 5000).forEach((m) => selected.add(m.id));
        options.all = false;
      }
      render();
      await updatePreview();
    } catch (error) {
      preview.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  search.oninput = () => {
    limit = 200;
    last = -1;
    render();
  };
  selectAll.onclick = () => {
    filtered()
      .slice(0, 5000)
      .forEach((m) => selected.add(m.id));
    render();
    void updatePreview();
  };
  clear.onclick = () => {
    selected.clear();
    render();
    void updatePreview();
  };
  scope.onchange = () => void updatePreview();
  reload.onclick = () => void load();
  apply.onclick = async () => {
    if (apply.disabled || saving) return;
    saving = true;
    generation++;
    apply.disabled = true;
    for (const control of [close, cancel, search, selectAll, clear, reload, scope])
      control.disabled = true;
    try {
      await actions.apply([...selected], scope.value);
      saving = false;
      closeDialog();
    } catch (error) {
      preview.textContent = error instanceof Error ? error.message : String(error);
      saving = false;
      apply.disabled = false;
      for (const control of [close, cancel, search, selectAll, clear, reload, scope])
        control.disabled = false;
    }
  };
  await load();
}

/** A focused confirmation for one turn, a suffix or the whole transcript. */
export async function confirmMessageRemoval(
  actions: Actions,
  options: { ids?: string[]; fromHere?: boolean; all?: boolean },
): Promise<void> {
  active?.close();
  active?.remove();
  const text = (key: string, fallback: string) => actions.text('ui.messageEdit.' + key, fallback);
  const dialog = document.createElement('dialog');
  dialog.className = 'message-manager message-delete-dialog';
  active = dialog;
  const heading = document.createElement('h2');
  heading.textContent = options.all
    ? text('clearConversation', '清空聊天记录')
    : options.fromHere
      ? text('deleteFromHere', '删除此处及之后的消息')
      : text('deleteMessage', '删除消息');
  dialog.setAttribute('aria-label', heading.textContent);
  const excerpt = document.createElement('blockquote');
  excerpt.className = 'message-delete-excerpt';
  const description = document.createElement('p');
  description.className = 'message-manager-intro';
  description.textContent = text(
    'deleteScope',
    '同时删除聊天记录和对应的原始模型上下文。删除用户消息时，会一起删除这一轮回复。',
  );
  const preview = document.createElement('div');
  preview.className = 'message-manager-preview';
  preview.setAttribute('role', 'status');
  const footer = document.createElement('footer'),
    cancel = document.createElement('button'),
    stop = document.createElement('button'),
    apply = document.createElement('button');
  for (const button of [cancel, stop, apply]) button.type = 'button';
  cancel.className = stop.className = 'btn-secondary';
  cancel.textContent = text('cancel', '取消');
  stop.textContent = text('stopBeforeDelete', '停止任务以继续');
  stop.hidden = true;
  apply.className = 'btn-danger';
  apply.textContent = text('confirmDelete', '确认删除');
  apply.disabled = true;
  footer.append(cancel, stop, apply);
  dialog.append(heading, excerpt, description, preview, footer);
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
  let ids: string[] = [],
    saving = false;
  const close = () => {
    if (saving) return;
    dialog.close();
    dialog.remove();
    if (active === dialog) active = undefined;
  };
  cancel.onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  async function load() {
    apply.disabled = true;
    preview.textContent = text('loading', '正在加载消息…');
    try {
      const data = await actions.load();
      if (!dialog.isConnected) return;
      const start = options.fromHere
        ? data.items.findIndex((item) => item.id === options.ids?.[0])
        : -1;
      if (options.fromHere && start < 0)
        throw new Error(text('stale', '这条消息已不存在，请重新选择。'));
      ids = options.all
        ? data.items.map((item) => item.id)
        : options.fromHere
          ? data.items.slice(start).map((item) => item.id)
          : options.ids || [];
      if (!ids.length) throw new Error(text('empty', '没有可管理的消息'));
      const item = data.items.find((row) => row.id === ids[0]);
      excerpt.textContent =
        item?.content.slice(0, 280) || text('emptyMessage', '（附件、推理或工具消息）');
      stop.hidden = !data.busy || !actions.stop;
      if (data.busy) {
        preview.textContent = text('busyDelete', '任务仍在运行。请先停止任务，再确认删除。');
        return;
      }
      const plan = await actions.preview(ids, 'both');
      if (!dialog.isConnected) return;
      preview.textContent = text(
        'deleteCount',
        '将删除 {count} 条消息及对应的原始上下文。',
      ).replace('{count}', String(plan.affectedCount));
      if (plan.retainedInSummary) {
        const warning = document.createElement('p');
        warning.className = 'message-manager-warning';
        warning.textContent = text(
          'summary',
          '部分内容已合并进摘要，无法从摘要中精确删除。本次保留摘要；如需彻底移除，请清空上下文。',
        );
        preview.append(warning);
      }
      apply.disabled = false;
    } catch (error) {
      if (dialog.isConnected)
        preview.textContent = error instanceof Error ? error.message : String(error);
    }
  }
  stop.onclick = async () => {
    if (saving) return;
    saving = true;
    stop.disabled = cancel.disabled = true;
    try {
      await actions.stop?.();
      saving = false;
      await load();
    } catch (error) {
      preview.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
      stop.disabled = cancel.disabled = false;
    }
  };
  apply.onclick = async () => {
    if (saving || apply.disabled) return;
    saving = true;
    apply.disabled = cancel.disabled = true;
    preview.textContent = text('saving', '正在保存…');
    try {
      await actions.apply(ids, 'both');
      saving = false;
      close();
    } catch (error) {
      preview.textContent = error instanceof Error ? error.message : String(error);
      saving = false;
      apply.disabled = cancel.disabled = false;
    }
  };
  await load();
}
