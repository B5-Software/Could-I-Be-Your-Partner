/* SPDX-License-Identifier: GPL-3.0-or-later */
import limits from '../../shared/quant-layout-preferences.json';
import type { QuantWorkspace } from '../../shared/quant-types';

type Preferences = QuantWorkspace['preferences'];
type Size = keyof typeof limits;
type Split = 'projects' | 'chart' | 'assistant';
const properties: Record<Size, string> = {
  projectWidth: '--quant-project-width',
  chatWidth: '--quant-chat-width',
  chartShare: '--quant-chart-share',
  focusMarketShare: '--quant-focus-market-share',
  stackMarketHeight: '--quant-stack-market-height',
  focusStackMarketHeight: '--quant-focus-stack-market-height',
};

type Measurement = {
  size: Size;
  value: number;
  vertical: boolean;
  direction: number;
  scale: number;
};

export class QuantLayout {
  private project = '';
  private preferences?: Preferences;
  private gesture?: {
    split: Split;
    bar: HTMLElement;
    pointer: number;
    start: number;
    initial: Measurement;
    value?: number;
  };
  private preview?: { size: Size; value: number };
  private readonly bars = new Map<Split, HTMLElement>();
  private readonly center: HTMLElement;
  private readonly conversation: HTMLElement;
  private readonly projects: HTMLElement;
  private readonly chart: HTMLElement;

  constructor(
    private readonly pane: HTMLElement,
    private readonly save: (values: Partial<Preferences>) => Promise<void>,
    private readonly error: (error: unknown) => void,
  ) {
    this.center = pane.querySelector('.quant-center')!;
    this.chart = pane.querySelector('[data-chart-home]')!;
    this.projects = pane.querySelector('.quant-projects')!;
    this.conversation = pane.querySelector('.quant-conversation')!;
    this.pane.querySelectorAll<HTMLElement>('[data-quant-split]').forEach((bar) => {
      const split = bar.dataset.quantSplit as Split;
      this.bars.set(split, bar);
      bar.addEventListener('pointerdown', (event) => this.start(split, bar, event));
      bar.addEventListener('pointermove', (event) => this.move(event));
      bar.addEventListener('pointerup', (event) => this.finish(event.pointerId, true));
      bar.addEventListener('pointercancel', (event) => this.finish(event.pointerId));
      bar.addEventListener('lostpointercapture', (event) => this.finish(event.pointerId));
      bar.addEventListener('keydown', (event) => this.key(split, event));
      bar.addEventListener('dblclick', () => {
        const { size } = this.measure(split);
        this.commit(size, limits[size].default);
      });
    });
    const observer = new ResizeObserver(() => this.syncAccessibility());
    for (const panel of [this.pane, this.projects, this.chart, this.conversation])
      observer.observe(panel);
  }

  render(project: string, preferences: Preferences): void {
    if (this.project !== project || this.preferences?.layout !== preferences.layout) {
      this.cancel();
      this.preview = undefined;
    }
    this.project = project;
    this.preferences = preferences;
    this.pane.dataset.layout = preferences.layout;
    this.pane.dataset.focusDetails = String(preferences.focusDetails === true);
    this.apply();
  }

  cancel(): void {
    if (this.gesture) this.finish(this.gesture.pointer);
  }

  private apply(): void {
    const active = this.gesture;
    for (const size of Object.keys(limits) as Size[]) {
      const saved = this.preview?.size === size ? this.preview.value : this.preferences?.[size];
      const value = active?.initial.size === size ? (active.value ?? saved) : saved;
      this.pane.style.setProperty(
        properties[size],
        `${value ?? limits[size].default}${limits[size].unit}`,
      );
    }
    this.syncAccessibility();
  }

  private measure(split: Split): Measurement {
    if (split === 'projects')
      return {
        size: 'projectWidth',
        value: this.projects.offsetWidth,
        vertical: false,
        direction: 1,
        scale: 1,
      };
    if (split === 'chart') {
      const scale = 100 / Math.max(this.center.clientHeight, 1);
      return {
        size: 'chartShare',
        value: this.chart.offsetHeight * scale,
        vertical: true,
        direction: 1,
        scale,
      };
    }
    const focus = this.pane.dataset.layout === 'immersive';
    const stacked = getComputedStyle(this.pane).getPropertyValue('--quant-stacked').trim() === '1';
    if (stacked)
      return {
        size: focus ? 'focusStackMarketHeight' : 'stackMarketHeight',
        value: this.center.offsetHeight,
        vertical: true,
        direction: 1,
        scale: 1,
      };
    if (focus) {
      const scale = 100 / Math.max(this.pane.clientWidth, 1);
      return {
        size: 'focusMarketShare',
        value: this.center.offsetWidth * scale,
        vertical: false,
        direction: 1,
        scale,
      };
    }
    return {
      size: 'chatWidth',
      value: this.conversation.offsetWidth,
      vertical: false,
      direction: -1,
      scale: 1,
    };
  }

  private syncAccessibility(): void {
    for (const [split, bar] of this.bars) {
      if (!bar.getClientRects().length) continue;
      const { size, value, vertical } = this.measure(split);
      bar.setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical');
      if (split === 'assistant')
        bar.setAttribute(
          'aria-controls',
          (size === 'chatWidth' ? this.conversation : this.center).id,
        );
      bar.setAttribute('aria-valuemin', String(limits[size].min));
      bar.setAttribute('aria-valuemax', String(limits[size].max));
      bar.setAttribute('aria-valuenow', String(this.bound(size, value)));
      bar.setAttribute('aria-valuetext', `${Math.round(value)} ${limits[size].unit}`);
    }
  }

  private bound(size: Size, value: number): number {
    return Math.round(Math.max(limits[size].min, Math.min(limits[size].max, value)));
  }

  private coordinate(event: PointerEvent, { vertical }: Measurement): number {
    return vertical ? event.clientY : event.clientX;
  }

  private start(split: Split, bar: HTMLElement, event: PointerEvent): void {
    if (event.button !== 0 || this.gesture || !this.project) return;
    const initial = this.measure(split);
    this.gesture = {
      split,
      bar,
      pointer: event.pointerId,
      start: this.coordinate(event, initial),
      initial,
    };
    this.pane.classList.add('is-resizing');
    bar.classList.add('is-dragging');
    bar.focus({ preventScroll: true });
    bar.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  private move(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    const { size, direction, scale, value } = gesture.initial;
    if (this.measure(gesture.split).size !== size) {
      this.cancel();
      return;
    }
    const delta = this.coordinate(event, gesture.initial) - gesture.start;
    gesture.value = this.bound(size, value + delta * direction * scale);
    this.apply();
  }

  private finish(pointer: number, commit = false): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointer !== pointer) return;
    this.gesture = undefined;
    this.pane.classList.remove('is-resizing');
    gesture.bar.classList.remove('is-dragging');
    if (gesture.bar.hasPointerCapture(pointer)) gesture.bar.releasePointerCapture(pointer);
    if (commit && gesture.value !== undefined) this.commit(gesture.initial.size, gesture.value);
    else this.apply();
  }

  private key(split: Split, event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.gesture) {
      event.preventDefault();
      this.cancel();
      return;
    }
    const measure = this.measure(split);
    const { size, value, vertical, direction } = measure;
    const [negative, positive] = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const delta = event.key === negative ? -1 : event.key === positive ? 1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const step = (limits[size].unit === 'px' ? 16 : 2) * (event.shiftKey ? 3 : 1);
    this.commit(
      size,
      event.key === 'Home'
        ? limits[size].min
        : event.key === 'End'
          ? limits[size].max
          : this.bound(size, value + delta * direction * step),
    );
  }

  private commit(size: Size, value: number): void {
    if (!this.project || value === (this.preferences?.[size] ?? limits[size].default)) {
      this.apply();
      return;
    }
    const preview = { size, value };
    this.preview = preview;
    this.apply();
    void this.save({ [size]: value })
      .catch(this.error)
      .finally(() => {
        if (this.preview === preview) {
          this.preview = undefined;
          this.apply();
        }
      });
  }
}
