/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { superText } = require('../shared/super-agent-text');
const { getLanguage } = require('./text');
class SuperAgentBrowser {
  constructor(app) {
    this.app = app;
    this.ui = app.walletBrowser;
  }
  t(key) {
    return superText(getLanguage(), key);
  }
  async call(action, input = {}) {
    try {
      return await this.app.runtime.api.backendRequest('superagent:request', action, input);
    } catch (error) {
      throw Error(this.t(error.message));
    }
  }
  async open(offset = 0) {
    const [status, page] = await Promise.all([
      this.call('status'),
      this.call('list', { offset, limit: 15 }),
    ]);
    this.ui.menu(
      this.t('title'),
      [
        { label: this.t('close'), value: 'close' },
        { label: this.t('new'), value: 'new' },
        { label: this.t(status.paused ? 'resume' : 'pause'), value: 'pause' },
        { label: this.t('settings'), value: 'settings' },
        { label: this.t('pending') + ' · ' + status.pending, value: 'events' },
        ...page.items.map((t) => ({ label: this.t(t.status) + ' · ' + t.title, value: t.id })),
        ...(offset ? [{ label: this.t('previous'), value: 'prev' }] : []),
        ...(page.next !== null ? [{ label: this.t('next'), value: 'next' }] : []),
      ],
      async (value) => {
        if (value === 'close') return;
        if (value === 'new') return this.create();
        if (value === 'settings') return this.preferences(status.config);
        if (value === 'events') return this.events();
        if (value === 'prev' || value === 'next')
          return this.open(value === 'prev' ? Math.max(0, offset - 15) : page.next);
        if (value === 'pause') {
          await this.call(status.paused ? 'resume' : 'pause');
          return this.open(offset);
        }
        return this.detail(value);
      },
      this.t('subtitle') + '\n\n' + this.t('notice') + (status.error ? '\n\n' + status.error : ''),
      () => {},
    );
  }
  create() {
    this.ui.menu(
      this.t('new'),
      [
        { label: 'Chat', value: 'chat' },
        { label: 'Code', value: 'code' },
      ],
      (mode) =>
        this.ui.input(
          this.t('placeholder'),
          async (value) => {
            await this.call('submit', { text: value, mode, operationId: randomUUID() });
            return this.open();
          },
          { back: () => this.open() },
        ),
      '',
      () => this.open(),
    );
  }
  async detail(id) {
    const { task: t, events, view } = await this.call('get', { id });
    this.ui.menu(
      t.title,
      [
        { label: this.t('back'), value: 'back' },
        { label: this.t('refresh'), value: 'refresh' },
        ...(view?.pendingInteraction
          ? [{ label: this.t('interaction'), value: 'interaction' }]
          : []),
        ...(t.status !== 'stopped'
          ? [
              { label: this.t('add'), value: 'followup' },
              { label: this.t('stop'), value: 'stop' },
            ]
          : []),
        ...(!['running', 'queued'].includes(t.status)
          ? [{ label: this.t('retry'), value: 'retry' }]
          : []),
        { label: this.t('activity'), value: 'history' },
      ],
      async (value) => {
        if (value === 'back') return this.open();
        if (value === 'refresh') return this.detail(id);
        if (value === 'interaction') {
          this.app.state.modal = null;
          await this.app._switchSession(t.workerKey, { reload: true });
          return;
        }
        if (value === 'followup')
          return this.ui.input(
            this.t('followup'),
            async (text) => {
              await this.call('submit', {
                taskId: id,
                mode: t.mode,
                text,
                operationId: randomUUID(),
              });
              return this.detail(id);
            },
            { back: () => this.detail(id) },
          );
        if (value === 'history')
          return this.ui.menu(
            this.t('activity'),
            [{ label: this.t('back'), value: 'back' }],
            () => this.detail(id),
            events
              .map((e) => new Date(e.at).toLocaleString() + '\n' + e.text)
              .join('\n\n')
              .slice(-12000),
            () => this.detail(id),
          );
        await this.call(value, { id, generation: t.generation });
        return this.detail(id);
      },
      this.t(t.status) +
        '\n' +
        (t.summary || t.reason || '') +
        '\n\n' +
        this.t('attempts') +
        ' · ' +
        t.attempts +
        '\n' +
        this.t('tokenUsage') +
        ' · ' +
        t.tokens +
        '\n\n' +
        t.evidence.join('\n'),
      () => this.open(),
    );
  }
  async events() {
    const page = await this.call('events', { limit: 100 }),
      rows = page.items.filter((e) => ['pending', 'routing', 'needs_attention'].includes(e.status));
    this.ui.menu(
      this.t('pending'),
      [
        { label: this.t('back'), value: 'back' },
        ...rows
          .filter((e) => e.status === 'needs_attention')
          .map((e) => ({ label: this.t('retryEvent') + ' · ' + e.text.slice(0, 60), value: e.id })),
      ],
      async (id) => {
        if (id === 'back') return this.open();
        await this.call('retry-event', { id });
        return this.events();
      },
      rows.map((e) => e.text.slice(0, 200)).join('\n\n'),
      () => this.open(),
    );
  }
  async preferences(config) {
    const settings = await this.app.runtime.getSettings();
    const models = new Map((settings.llm?.pool || []).map((r) => [r.id, r.label || r.model]));
    const keys = [
      'enabled',
      'maxWorkers',
      'maxAttempts',
      'maxTokens',
      'routerModel',
      'workerModel',
      'watchdog',
      'proactive',
      'rules',
      'sources',
    ];
    this.ui.menu(
      this.t('settings'),
      [
        { label: this.t('back'), value: 'back' },
        ...keys.map((k) => ({
          label:
            this.t(k) +
            ' · ' +
            (typeof config[k] === 'boolean'
              ? config[k]
                ? '●'
                : '○'
              : Array.isArray(config[k])
                ? config[k].join(', ')
                : k.endsWith('Model')
                  ? models.get(config[k]) || config[k] || this.t('defaultModel')
                  : config[k] || '—'),
          value: k,
        })),
      ],
      async (key) => {
        if (key === 'back') return this.open();
        const save = async (value) => {
          const status = await this.call('configure', { [key]: value });
          return this.preferences(status.config);
        };
        if (typeof config[key] === 'boolean') return save(!config[key]);
        if (key === 'sources')
          return this.ui.menu(
            this.t('sources'),
            [
              { label: this.t('back'), value: 'back' },
              ...['github', 'automation', 'notification'].map((v) => ({
                label: (config.sources.includes(v) ? '● ' : '○ ') + v,
                value: v,
              })),
            ],
            (value) =>
              value === 'back'
                ? this.preferences(config)
                : save(
                    config.sources.includes(value)
                      ? config.sources.filter((v) => v !== value)
                      : [...config.sources, value],
                  ),
            '',
            () => this.preferences(config),
          );
        if (key.endsWith('Model')) {
          const s = await this.app.runtime.getSettings();
          return this.ui.menu(
            this.t(key),
            [
              { label: this.t('defaultModel'), value: '' },
              ...(s.llm?.pool || [])
                .filter((r) => r.enabled !== false)
                .map((r) => ({ label: r.label || r.model, value: r.id })),
            ],
            save,
            '',
            () => this.preferences(config),
          );
        }
        return this.ui.input(
          this.t(key),
          (value) => save(key.startsWith('max') ? Number(value) : value),
          { value: String(config[key]), back: () => this.preferences(config) },
        );
      },
      '',
      () => this.open(),
    );
  }
}
module.exports = { SuperAgentBrowser };
