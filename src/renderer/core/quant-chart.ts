/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { Candle } from '../../shared/quant-types';

/** Local canvas renderer: no analytics/remote chart iframe or per-tick DOM tree. */
export class QuantChart {
  readonly canvas = document.createElement('canvas');
  private bars: Candle[] = [];
  private averages: number[][] = [];
  private count = 90;
  private offset = 0;
  private cursor = -1;
  private drag?: { x: number; offset: number };
  private frame = 0;
  constructor(
    private readonly host: HTMLElement,
    private readonly readout: HTMLElement,
    expand: () => void,
  ) {
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'OHLC · ← → · + − · Home');
    host.append(this.canvas);
    new ResizeObserver(() => this.schedule()).observe(host);
    new MutationObserver(() => this.schedule()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2);
      },
      { passive: false },
    );
    this.canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.drag = { x: event.offsetX, offset: this.offset };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      const width = Math.max(1, this.host.clientWidth - 92),
        step = width / this.count;
      if (this.drag)
        this.offset = this.clamp(
          this.drag.offset + Math.round((event.offsetX - this.drag.x) / step),
        );
      this.cursor = Math.max(
        0,
        Math.min(
          this.bars.length - 1,
          Math.max(0, this.bars.length - this.offset - this.count) +
            Math.floor((event.offsetX - 12) / step),
        ),
      );
      this.schedule();
    });
    const release = () => {
      this.drag = undefined;
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.cursor = -1;
        this.schedule();
      }
    });
    this.canvas.addEventListener('dblclick', expand);
    this.canvas.addEventListener('keydown', (event) => {
      if (['+', '=', '-'].includes(event.key)) this.zoom(event.key === '-' ? 1.2 : 1 / 1.2);
      else if (event.key === 'Home') this.fit();
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const index = this.cursor < 0 ? this.bars.length - 1 : this.cursor;
        this.cursor = Math.max(
          0,
          Math.min(this.bars.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)),
        );
        this.offset = this.clamp(this.bars.length - 1 - this.cursor);
        this.schedule();
      } else return;
      event.preventDefault();
    });
  }
  private clamp(offset: number): number {
    return Math.max(0, Math.min(Math.max(0, this.bars.length - 10), offset));
  }
  setData(bars: Candle[]): void {
    this.bars = bars;
    this.offset = this.clamp(this.offset);
    this.averages = [9, 21].map((period) => {
      let sum = 0;
      return bars.map((bar, i) => {
        sum += bar.close;
        if (i >= period) sum -= bars[i - period]!.close;
        return i >= period - 1 ? sum / period : NaN;
      });
    });
    this.schedule();
  }
  zoom(factor: number): void {
    this.count = Math.max(15, Math.min(500, Math.round(this.count * factor)));
    this.schedule();
  }
  fit(): void {
    this.count = Math.min(300, Math.max(30, this.bars.length));
    this.offset = 0;
    this.cursor = -1;
    this.schedule();
  }
  schedule(): void {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
  }
  private draw(): void {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio || 1, 2),
      canvas = this.canvas;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const styles = getComputedStyle(this.host),
      color = (key: string) => styles.getPropertyValue(key).trim();
    const muted = color('--text-tertiary'),
      border = color('--border-light'),
      up = color('--quant-up'),
      down = color('--quant-down');
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    const end = this.bars.length - this.offset,
      start = Math.max(0, end - this.count);
    const visible = this.bars.slice(start, end);
    if (!visible.length) {
      this.readout.textContent = '';
      return;
    }
    let min = Math.min(...visible.map((bar) => bar.low)),
      max = Math.max(...visible.map((bar) => bar.high));
    const spread = Math.max(max - min, max * 0.001);
    min -= spread * 0.12;
    max += spread * 0.12;
    const volumeVisible = height >= 220 && visible.some((bar) => bar.volume > 0);
    const left = 12,
      right = width - 78,
      top = 18,
      bottom = height - (volumeVisible ? 92 : 34);
    if (bottom <= top || right <= left) return;
    const step = (right - left) / this.count,
      x = (i: number) => left + (i + 0.5) * step;
    const y = (price: number) => top + ((max - price) / (max - min)) * (bottom - top);
    ctx.lineWidth = 1;
    const gridLines = Math.max(2, Math.min(4, Math.floor((bottom - top) / 35)));
    for (let i = 0; i <= gridLines; i++) {
      const py = top + ((bottom - top) * i) / gridLines;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(left, py + 0.5);
      ctx.lineTo(right, py + 0.5);
      ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(this.format(max - ((max - min) * i) / gridLines), right + 9, py);
    }
    const maxVolume = Math.max(1, ...visible.map((bar) => bar.volume));
    visible.forEach((bar, i) => {
      const cx = x(i),
        body = Math.max(1, Math.min(12, step * 0.6));
      ctx.fillStyle = ctx.strokeStyle = bar.close >= bar.open ? up : down;
      ctx.beginPath();
      ctx.moveTo(cx, y(bar.high));
      ctx.lineTo(cx, y(bar.low));
      ctx.stroke();
      ctx.fillRect(
        cx - body / 2,
        Math.min(y(bar.open), y(bar.close)),
        body,
        Math.max(1.5, Math.abs(y(bar.open) - y(bar.close))),
      );
      ctx.globalAlpha = 0.3;
      if (volumeVisible)
        ctx.fillRect(
          cx - body / 2,
          height - 30 - (bar.volume / maxVolume) * 43,
          body,
          (bar.volume / maxVolume) * 43,
        );
      ctx.globalAlpha = 1;
    });
    ['#d7a449', '#7f89cf'].forEach((line, series) => {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false;
      visible.forEach((_bar, i) => {
        const value = this.averages[series]![start + i];
        if (!Number.isFinite(value)) return;
        if (!started) {
          ctx.moveTo(x(i), y(value!));
          started = true;
        } else ctx.lineTo(x(i), y(value!));
      });
      ctx.stroke();
    });
    ctx.lineWidth = 1;
    ctx.fillStyle = muted;
    for (let i = 0; i < 4; i++) {
      const index = Math.floor(((visible.length - 1) * i) / 3),
        bar = visible[index]!;
      ctx.fillText(
        new Date(bar.time * 1000).toLocaleString(document.documentElement.lang, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        Math.min(right - 82, x(index)),
        height - 13,
      );
    }
    const last = visible.at(-1)!;
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = last.close >= last.open ? up : down;
    ctx.beginPath();
    ctx.moveTo(left, y(last.close));
    ctx.lineTo(right, y(last.close));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillText(this.format(last.close), right + 9, y(last.close));
    const active = this.bars[this.cursor] || last;
    this.readout.textContent = `${new Date(active.time * 1000).toLocaleString()}   O ${this.format(active.open)}   H ${this.format(active.high)}   L ${this.format(active.low)}   C ${this.format(active.close)}   MA 9 / 21`;
    if (this.cursor >= start && this.cursor < end) {
      ctx.strokeStyle = muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x(this.cursor - start), top);
      ctx.lineTo(x(this.cursor - start), height - 27);
      ctx.moveTo(left, y(active.close));
      ctx.lineTo(right, y(active.close));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    canvas.setAttribute(
      'aria-label',
      `${new Date(active.time * 1000).toLocaleString()} O ${active.open} H ${active.high} L ${active.low} C ${active.close}`,
    );
  }
  private format(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 6 : 2 });
  }
}
