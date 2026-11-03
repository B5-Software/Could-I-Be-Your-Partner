/* SPDX-License-Identifier: GPL-3.0-or-later */
import translations from '../../shared/firmware-labels.json';
type Ticket = {
  token: string;
  port: string;
  chip: string;
  mac: string;
  experimental: boolean;
  firmwareVersion: string;
  sha256: string[];
};
type Job = { id: string; stage: string; progress: number; error?: string; chip: string };
type Listing = {
  ports: { path: string; manufacturer?: string }[];
  firmware: { images: { id: string }[] };
  job: Job | null;
};
type Network = {
  url: string;
  ssid: string;
  password: string;
  adminToken: string;
  restartRequired: boolean;
  setupRequired: boolean;
};
type Actions = {
  language: () => string;
  request: <T>(action: string, input?: unknown) => Promise<T>;
  confirm: (message: string) => Promise<boolean>;
};
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class FirmwarePanel {
  private root: HTMLElement | null = null;
  private listing: Listing | null = null;
  private ticket: Ticket | null = null;
  private selected = '';
  private busy = false;
  private active = false;
  private error = '';
  private network: Network | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private actions: Actions) {
    window.addEventListener('cibyp:settings-tab', (event) => {
      this.active = (event as CustomEvent<{ tab: string }>).detail.tab === 'firmware';
      clearTimeout(this.timer);
      if (this.active) void this.refresh();
      else {
        this.network = null;
        this.render();
      }
    });
    window.addEventListener('languagechange', () => this.render());
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.timer);
      if (document.hidden) {
        this.network = null;
        this.render();
      } else if (this.active) void this.refresh();
    });
    if (document.querySelector('.settings-tab.active')?.getAttribute('data-tab') === 'firmware') {
      this.active = true;
      void this.refresh();
    }
  }
  private text(key: string): string {
    const lang = this.actions.language();
    const labels =
      translations[lang.startsWith('de') ? 'de' : lang.startsWith('en') ? 'en' : 'zh-CN'];
    return (labels as Record<string, string>)[key] || key;
  }
  private async refresh(): Promise<void> {
    try {
      this.listing = await this.actions.request<Listing>('list');
      this.render();
      this.schedule();
    } catch (error) {
      this.showError(error);
    }
  }
  private running(): boolean {
    return !!this.listing?.job && !['completed', 'failed'].includes(this.listing.job.stage);
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.active && !document.hidden && this.running())
      this.timer = setTimeout(() => void this.refresh(), 1000);
  }
  private showError(error: unknown): void {
    const code = error instanceof Error ? error.message : '';
    this.error = Object.hasOwn(translations.en, code) ? this.text(code) : this.text('genericError');
    this.render();
  }
  private render(): void {
    this.root ||= document.getElementById('firmware-panel-root');
    if (!this.root) return;
    const disabled = this.busy || this.running(),
      ticket = this.ticket,
      job = this.listing?.job,
      ports = this.listing?.ports || [];
    this.root.innerHTML = `<header class="fw-heading"><span class="fw-chip"><i class="fa-solid fa-microchip" aria-hidden="true"></i></span><div><h3>${esc(this.text('title'))}</h3><p>${esc(this.text('subtitle'))}</p></div></header><p class="setting-hint">${esc(this.text('intro'))}</p>
    <section class="fw-device-card"><label for="fw-port">${esc(this.text('device'))}</label><div class="fw-controls"><select id="fw-port" ${disabled ? 'disabled' : ''}><option value="">${esc(this.text('choose'))}</option>${ports.map((port) => `<option value="${esc(port.path)}" ${port.path === this.selected ? 'selected' : ''}>${esc(port.path)}${port.manufacturer ? ' · ' + esc(port.manufacturer) : ''}</option>`).join('')}</select><button type="button" class="btn-secondary" data-fw="refresh" ${disabled ? 'disabled' : ''}>${esc(this.text('refresh'))}</button><button type="button" class="btn-secondary" data-fw="inspect" ${disabled || !this.selected ? 'disabled' : ''}>${esc(this.text(this.busy ? 'working' : 'inspect'))}</button></div><p class="setting-hint">${esc(this.text('transport'))}</p>${this.listing && !ports.length ? `<p class="fw-notice">${esc(this.text('empty'))}</p>` : ''}${this.listing && !this.listing.firmware.images.length ? `<p class="fw-notice">${esc(this.text('missing'))}</p>` : ''}
    ${ticket ? `<div class="fw-identified"><span class="fw-ready">${esc(this.text('ready'))}</span><strong>${esc(ticket.chip.toUpperCase())}</strong><code>${esc(ticket.mac)}</code><span>v${esc(ticket.firmwareVersion)} · ${esc(this.text('development'))}</span>${ticket.experimental ? `<p class="fw-notice">${esc(this.text('experimental'))}</p>` : ''}<details><summary>${esc(this.text('hashes'))}</summary>${ticket.sha256.map((hash) => `<code class="fw-hash">${esc(hash)}</code>`).join('')}</details><button type="button" class="btn-primary" data-fw="flash" ${disabled ? 'disabled' : ''}>${esc(this.text('flash'))}</button></div>` : ''}
    ${job ? `<div class="fw-progress ${job.stage === 'failed' ? 'fw-error' : ''}" role="status" aria-live="polite"><div><strong>${esc(this.text(job.stage))}</strong><span>${job.progress}%</span></div><progress max="100" value="${job.progress}" aria-label="${esc(this.text(job.stage))}"></progress>${job.error ? `<p>${esc(this.text(job.error) === job.error ? this.text('genericError') : this.text(job.error))}</p><small>${esc(this.text('retry'))}</small>` : ''}</div>` : ''}${this.error ? `<p class="fw-error" role="alert">${esc(this.error)}</p>` : ''}</section>
    <section class="fw-device-card"><h3>${esc(this.text('networkTitle'))}</h3><p class="setting-hint">${esc(this.text('networkHelp'))}</p><button type="button" class="btn-secondary" data-fw="${this.network ? 'hide-network' : 'network'}" ${disabled || !this.selected ? 'disabled' : ''}>${esc(this.text(this.network ? 'hideNetwork' : 'readNetwork'))}</button>${this.network ? `<dl class="fw-network"><div><dt>${esc(this.text('ssid'))}</dt><dd>${esc(this.network.ssid)}</dd></div><div><dt>${esc(this.text('password'))}</dt><dd><code>${esc(this.network.setupRequired ? this.text('openSetup') : this.network.password)}</code></dd></div><div><dt>${esc(this.text('admin'))}</dt><dd><code>${esc(this.network.adminToken)}</code></dd></div></dl><p><a href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">http://192.168.4.1 ↗</a></p>${this.network.restartRequired ? `<p class="setting-hint">${esc(this.text('restartNetwork'))}</p>` : ''}` : ''}</section>
    <aside class="fw-security"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i><div><strong>${esc(this.text('security'))}</strong><p>${esc(this.text('securityText'))}</p><p>${esc(this.text('notHardened'))}</p></div></aside><button type="button" class="btn-secondary" data-fw="export">${esc(this.text('export'))}</button>`;
    this.root.querySelector<HTMLSelectElement>('#fw-port')?.addEventListener('change', (event) => {
      this.selected = (event.target as HTMLSelectElement).value;
      this.ticket = null;
      this.network = null;
      this.error = '';
      this.render();
    });
    this.root
      .querySelectorAll<HTMLButtonElement>('[data-fw]')
      .forEach((button) =>
        button.addEventListener('click', () => void this.act(button.dataset.fw!)),
      );
  }
  private async act(action: string): Promise<void> {
    if (this.busy || this.running()) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      if (action === 'refresh') {
        this.ticket = null;
        await this.refresh();
      }
      if (action === 'hide-network') this.network = null;
      if (action === 'network') {
        this.ticket = null;
        this.network = await this.actions.request<Network>('network', { port: this.selected });
      }
      if (action === 'inspect') {
        this.ticket = null;
        this.ticket = await this.actions.request<Ticket>('inspect', { port: this.selected });
      }
      if (action === 'flash' && this.ticket) {
        const ticket = this.ticket;
        if (
          await this.actions.confirm(
            this.text('confirm') +
              '\n\n' +
              ticket.chip.toUpperCase() +
              ' · ' +
              ticket.port +
              '\n' +
              ticket.mac,
          )
        ) {
          const job = await this.actions.request<Job>('flash', {
            token: ticket.token,
            confirmed: true,
          });
          this.ticket = null;
          if (this.listing) this.listing.job = job;
          this.schedule();
        }
      }
      if (action === 'export') {
        const file = await this.actions.request<{ name: string; base64: string }>('sources');
        const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
          link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      this.ticket = null;
      this.showError(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
