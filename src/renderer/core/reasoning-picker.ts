/* SPDX-License-Identifier: GPL-3.0-or-later */
import { openModelPicker, type ModelChoices } from './model-picker';

const effortLabels: Record<string, string> = {
  off: '关闭',
  none: '关闭',
  auto: '自动',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
};
export function effortLabel(
  value: string,
  text: (key: string, fallback: string) => string,
): string {
  return text('ui.models.effort.' + value, effortLabels[value] || value);
}
type Actions = {
  list: () => Promise<ModelChoices>;
  select: (id: string) => Promise<unknown>;
  setEffort: (value: string | null) => Promise<unknown>;
  manage: () => unknown;
  text: (key: string, fallback: string) => string;
};
let active: (() => void) | undefined;
export function openReasoningPicker(anchor: HTMLButtonElement, actions: Actions): void {
  if (anchor.getAttribute('aria-expanded') === 'true') {
    active?.();
    return;
  }
  active?.();
  const text = (key: string, fallback: string) => actions.text('ui.models.' + key, fallback);
  const panel = document.createElement('div');
  panel.className = 'reasoning-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', text('reasoning', '推理强度'));
  const header = document.createElement('div');
  header.className = 'reasoning-picker-header';
  const bolt = document.createElement('span');
  bolt.className = 'reasoning-picker-bolt';
  bolt.setAttribute('aria-hidden', 'true');
  bolt.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m13 3-8 10h6l-1 8 9-12h-6Z"/></svg>';
  const copy = document.createElement('div'),
    level = document.createElement('strong'),
    model = document.createElement('button'),
    reset = document.createElement('button');
  model.type = reset.type = 'button';
  model.className = 'reasoning-picker-model';
  reset.className = 'reasoning-picker-reset';
  reset.title = text('reset', '恢复默认强度');
  reset.setAttribute('aria-label', reset.title);
  reset.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/></svg>';
  copy.append(level, model);
  header.append(bolt, copy, reset);
  const track = document.createElement('div');
  track.className = 'reasoning-picker-track';
  const ticks = document.createElement('div');
  ticks.className = 'reasoning-picker-ticks';
  ticks.setAttribute('aria-hidden', 'true');
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.step = 'any';
  range.disabled = reset.disabled = true;
  range.setAttribute('aria-label', text('reasoning', '推理强度'));
  const fill = document.createElement('div');
  fill.className = 'reasoning-picker-fill';
  const fillRail = document.createElement('div');
  fillRail.className = 'reasoning-picker-fill-rail';
  fillRail.append(fill);
  const rail = document.createElement('div');
  rail.className = 'reasoning-picker-rail';
  const thumb = document.createElement('span');
  thumb.className = 'reasoning-picker-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  rail.append(thumb);
  track.append(fillRail, ticks, rail, range);
  const status = document.createElement('p');
  status.className = 'reasoning-picker-status';
  status.setAttribute('role', 'status');
  status.textContent = text('loading', '正在加载模型池…');
  panel.append(header, track, status);
  document.body.append(panel);
  anchor.setAttribute('aria-expanded', 'true');
  let state: ModelChoices | undefined,
    saving = false,
    queued: string | null | undefined;
  const frontend = document.documentElement.dataset.frontend;
  function position() {
    const rect = anchor.getBoundingClientRect(),
      width = Math.min(320, innerWidth - 24),
      above = rect.top > panel.offsetHeight + 20;
    panel.style.width = width + 'px';
    panel.style.left = Math.max(12, Math.min(innerWidth - width - 12, rect.left)) + 'px';
    panel.style.top = above
      ? 'auto'
      : Math.min(innerHeight - panel.offsetHeight - 12, rect.bottom + 8) + 'px';
    panel.style.bottom = above ? innerHeight - rect.top + 8 + 'px' : 'auto';
  }
  function close() {
    panel.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (active === close) active = undefined;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('cibyp:page-changed', close);
    window.removeEventListener('cibyp:appearance-changed', appearance);
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
    }
  }
  function appearance() {
    if (frontend !== document.documentElement.dataset.frontend || !anchor.isConnected) close();
    else position();
  }
  function render(syncValue = true) {
    if (!state) return;
    const variants = state.variants || [],
      index = Math.max(
        0,
        variants.findIndex((row) => row.id === state!.effort),
      );
    range.max = String(Math.max(0, variants.length - 1));
    if (syncValue && !track.dataset.dragging) range.value = String(index);
    range.disabled = state.busy || variants.length < 2;
    reset.disabled = state.busy || saving || !variants.length;
    model.disabled = saving;
    if (ticks.childElementCount !== variants.length)
      ticks.replaceChildren(...variants.map(() => document.createElement('span')));
    model.textContent =
      state.entries.find((row) => row.id === state!.selected)?.label || state.model;
    model.textContent += ' ›';
    model.title = text('title', '选择会话模型');
    updateLevel();
    if (!status.dataset.error)
      status.textContent = state.busy
        ? text('busy', '任务进行中，结束后可切换模型。')
        : variants.length < 2
          ? text('fixedReasoning', '该模型不提供可调节的推理强度。')
          : text('sessionEffort', '仅用于当前会话');
    position();
  }
  function updateLevel() {
    const variant = state?.variants?.[Math.round(Number(range.value))];
    const label = variant
      ? effortLabel(variant.id, actions.text)
      : text('modelDefault', '模型默认');
    level.textContent = label;
    range.setAttribute('aria-valuetext', label);
    track.style.setProperty(
      '--effort-progress',
      `${Number(range.max) ? (Number(range.value) / Number(range.max)) * 100 : 0}%`,
    );
  }
  async function save(value: string | null) {
    if (!state) return;
    queued = value;
    if (saving) return;
    saving = true;
    delete status.dataset.error;
    render(false);
    panel.setAttribute('aria-busy', 'true');
    status.textContent = text('savingEffort', '正在保存…');
    try {
      while (queued !== undefined && panel.isConnected) {
        const next = queued;
        queued = undefined;
        await actions.setEffort(next);
        const refreshed = await actions.list();
        if (!panel.isConnected) return;
        state = refreshed;
      }
    } catch (error) {
      status.dataset.error = 'true';
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
      panel.removeAttribute('aria-busy');
      if (panel.isConnected) render(!track.dataset.dragging);
    }
  }
  range.oninput = updateLevel;
  range.onpointerdown = () => {
    track.dataset.dragging = 'true';
  };
  const endDrag = () => {
    delete track.dataset.dragging;
  };
  range.onpointerup = endDrag;
  range.onpointercancel = endDrag;
  range.onchange = () => {
    endDrag();
    range.value = String(Math.round(Number(range.value)));
    updateLevel();
    const value = state?.variants?.[Number(range.value)]?.id;
    if (value) void save(value);
  };
  range.onkeydown = (event) => {
    if (
      !state ||
      range.disabled ||
      !['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    const current = Math.round(Number(range.value)),
      maximum = Number(range.max);
    range.value = String(
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? maximum
          : Math.max(
              0,
              Math.min(maximum, current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1)),
            ),
    );
    updateLevel();
    const value = state.variants?.[Number(range.value)]?.id;
    if (value) void save(value);
  };
  reset.onclick = () => {
    const index = state?.variants?.findIndex((variant) => variant.id === state?.defaultEffort);
    if (index !== undefined && index >= 0) {
      range.value = String(index);
      updateLevel();
    }
    void save(null);
  };
  model.onclick = () => {
    close();
    openModelPicker(anchor, actions);
  };
  active = close;
  position();
  model.focus();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keyboard, true);
  window.addEventListener('resize', position);
  window.addEventListener('cibyp:page-changed', close);
  window.addEventListener('cibyp:appearance-changed', appearance);
  void actions
    .list()
    .then((value) => {
      if (panel.isConnected) {
        state = value;
        render();
      }
    })
    .catch((error) => {
      status.textContent = error.message;
    });
}
