/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
import { setSurfaceOpen } from './surfaces';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}
interface TodoAgent {
  todoItems: Todo[];
  sessionKey?: string;
  conversationTitle?: string;
  handleTodo(args: Record<string, unknown>): { ok: boolean; error?: string };
}
interface Options {
  getAgent(): TodoAgent | null;
  mirror(element: HTMLElement, contents?: boolean): void;
  reportError(message: string): void;
}

export class TodoSidebar {
  private input: HTMLInputElement;
  private list: HTMLElement;
  private filter = 'all';
  private drafts = new WeakMap<TodoAgent, string>();
  private owner: TodoAgent | null = null;
  private editing: number | null = null;
  private returnFocus: HTMLElement | null = null;
  private open = false;
  constructor(
    private root: HTMLElement,
    private options: Options,
  ) {
    this.input = root.querySelector<HTMLInputElement>('#todo-input')!;
    this.list = root.querySelector<HTMLElement>('#todo-list')!;
    root.querySelector('#btn-close-todo')!.addEventListener('click', () => this.setOpen(false));
    root.querySelector('#todo-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text || !this.owner) return;
      if (this.apply({ action: 'add', text })) {
        this.input.value = '';
        this.drafts.delete(this.owner);
        this.input.focus();
      }
    });
    // Some input methods emit Enter before their composition commits.
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.isComposing) event.preventDefault();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-todo-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        this.filter = button.dataset.todoFilter!;
        this.editing = null;
        this.render();
      });
    });
    root.querySelector('#btn-clear-completed')!.addEventListener('click', () => {
      const operations = this.owner?.todoItems
        .filter((item) => item.done)
        .map((item) => ({ action: 'remove', id: item.id }));
      if (operations?.length) this.apply({ operations });
    });
    this.list.addEventListener('click', (event) => {
      const target = event.target as Element;
      const button = target.closest<HTMLButtonElement>('[data-todo-action]');
      const row = target.closest<HTMLElement>('[data-id]');
      if (!button || !row) return;
      const id = Number(row.dataset.id);
      if (!Number.isSafeInteger(id)) return;
      if (button.dataset.todoAction === 'edit') {
        this.editing = id;
        this.render();
        this.list.querySelector<HTMLInputElement>('.todo-edit-input')?.focus();
      } else {
        this.editing = null;
        this.apply({ action: button.dataset.todoAction, id });
      }
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (this.editing !== null) {
          this.editing = null;
          this.render();
        } else this.setOpen(false);
      }
    });
    this.render();
  }
  toggle(): void {
    this.setOpen(!this.open);
  }
  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    if (open) this.returnFocus = document.activeElement as HTMLElement;
    else if (this.root.contains(document.activeElement)) this.returnFocus?.focus();
    setSurfaceOpen(this.root, open, (element) => this.options.mirror(element));
    document.querySelectorAll<HTMLElement>('[data-todo-toggle]').forEach((button) => {
      button.setAttribute('aria-expanded', String(open));
      this.options.mirror(button);
    });
    if (open) {
      this.render();
      this.input.focus();
    }
  }
  refresh(): void {
    this.render();
  }
  private apply(args: Record<string, unknown>): boolean {
    // A session may change while a DOM event is queued. Never mutate its former owner.
    const agent = this.options.getAgent();
    if (!agent || agent !== this.owner) {
      this.render();
      return false;
    }
    const result = agent.handleTodo(args);
    if (!result.ok) this.options.reportError(result.error || '待办操作失败');
    this.render();
    return result.ok;
  }
  private render(): void {
    const owner = this.options.getAgent();
    if (owner !== this.owner) {
      if (this.owner) this.drafts.set(this.owner, this.input.value);
      this.owner = owner;
      this.input.value = owner ? this.drafts.get(owner) || '' : '';
      this.editing = null;
    }
    const items = owner?.todoItems || [];
    const done = items.filter((item) => item.done).length;
    this.root.querySelector('#todo-session-label')!.textContent =
      owner?.conversationTitle || '当前会话';
    this.root.querySelector('#todo-progress-text')!.textContent =
      `${done} / ${items.length} 已完成`;
    const progress = this.root.querySelector<HTMLProgressElement>('#todo-progress')!;
    progress.max = Math.max(1, items.length);
    progress.value = done;
    this.input.disabled = !owner;
    this.root.querySelector<HTMLButtonElement>('#btn-add-todo')!.disabled = !owner;
    this.root.querySelector<HTMLButtonElement>('#btn-clear-completed')!.disabled = !done;
    this.root.querySelectorAll<HTMLButtonElement>('[data-todo-filter]').forEach((button) => {
      const selected = button.dataset.todoFilter === this.filter;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const focused = document.activeElement as HTMLElement | null;
    const focusId = focused?.closest<HTMLElement>('[data-id]')?.dataset.id;
    const focusAction = focused?.dataset.todoAction;
    const editingInput = this.list.querySelector<HTMLInputElement>('.todo-edit-input');
    const editingDraft = editingInput?.value;
    this.list.replaceChildren();
    const visible = items.filter(
      (item) => this.filter === 'all' || item.done === (this.filter === 'done'),
    );
    for (const item of visible) {
      const row = document.createElement('div');
      row.className = `todo-item${item.done ? ' done' : ''}`;
      row.dataset.id = String(item.id);
      const button = (action: string, title: string, icon: string) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = `btn-icon todo-${action}`;
        element.dataset.todoAction = action;
        element.title = title;
        element.setAttribute('aria-label', title);
        const glyph = document.createElement('i');
        glyph.className = `fa-solid ${icon}`;
        glyph.setAttribute('aria-hidden', 'true');
        element.appendChild(glyph);
        return element;
      };
      const toggle = button('toggle', item.done ? '标记为未完成' : '标记为完成', 'fa-check');
      toggle.classList.add('todo-checkbox');
      toggle.setAttribute('aria-pressed', String(item.done));
      row.appendChild(toggle);
      if (this.editing === item.id) {
        const form = document.createElement('form');
        form.className = 'todo-edit-form';
        const input = document.createElement('input');
        input.className = 'todo-edit-input';
        input.value = editingDraft ?? item.text;
        input.maxLength = 4000;
        input.setAttribute('aria-label', '编辑待办内容');
        const save = document.createElement('button');
        save.className = 'btn-icon';
        save.textContent = '保存';
        form.append(input, save);
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          if (!input.value.trim()) return;
          this.editing = null;
          this.apply({ action: 'update', id: item.id, text: input.value });
        });
        row.appendChild(form);
      } else {
        const text = document.createElement('span');
        text.className = 'todo-text';
        text.textContent = item.text;
        row.append(text, button('edit', '编辑待办', 'fa-pen'));
      }
      row.appendChild(button('remove', '删除待办', 'fa-trash-can'));
      this.list.appendChild(row);
    }
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'todo-empty';
      empty.textContent = !owner
        ? '打开一个会话后即可管理待办'
        : items.length
          ? '这个分类下暂无待办'
          : '把大目标拆成小步骤，从这里开始';
      this.list.appendChild(empty);
    }
    // Mirror only the changing regions so input drafts and keyboard focus remain intact.
    for (const id of ['todo-list', 'todo-summary', 'todo-filters']) {
      this.options.mirror(this.root.querySelector<HTMLElement>(`#${id}`)!, true);
    }
    if (focusId && focusAction)
      (
        this.list.querySelector<HTMLElement>(
          `[data-id="${Number(focusId)}"] [data-todo-action="${focusAction}"]`,
        ) || this.input
      ).focus();
    else if (focused?.classList.contains('todo-edit-input'))
      this.list.querySelector<HTMLInputElement>('.todo-edit-input')?.focus();
  }
}
