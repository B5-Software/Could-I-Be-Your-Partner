/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const labels = require('../shared/quant-exchange-labels.json');
const { getLanguage } = require('./text');
const { randomUUID } = require('node:crypto');

class ExchangeBrowser {
  constructor(parent) {
    this.parent = parent;
    this.env = 'sandbox';
  }
  t(key) {
    const dictionary = labels[getLanguage()] || labels.zh;
    return Object.hasOwn(dictionary, key) ? dictionary[key] : this.parent.ui.status(key);
  }
  async open(id, offset = 0, note = '', fromModal) {
    const app = this.parent.ui.app;
    const input = { id, env: this.env };
    const call = (action, extra = {}) =>
      this.parent.call('exchange.' + action, { ...input, ...extra });
    const page = await call('list', { offset });
    if (app?._disposed || (fromModal && app?.state.modal !== fromModal)) return;
    const watch = page.watch;
    const fix = page.fix;
    const fixPhase = {
      idle: 'fixIdle',
      connecting: 'fixConnecting',
      recovering: 'fixRecovering',
      ready: 'fixReady',
      disconnected: 'fixDisconnected',
    };
    const watchText = {
      idle: 'watchIdle',
      connecting: 'watchConnecting',
      live: 'watchLive',
      fallback: 'watchFallback',
    };
    const back = () => this.open(id, offset);
    const run = async (fn, next = offset) => {
      try {
        await fn();
        return this.open(id, next);
      } catch (error) {
        return this.open(id, next, this.t(error.message));
      }
    };
    const option = (key, finish, label = this.t(key)) => ({ value: finish, label });
    const brief = (entry) =>
      [
        this.t(entry.side),
        entry.size,
        entry.product,
        '·',
        entry.stopLimitPrice ? this.t('takeProfitPrice') : null,
        entry.price,
        'USD',
      ]
        .filter(Boolean)
        .join(' ') +
      (entry.stopLimitPrice
        ? ` · ${this.t('stopPrice')} ${entry.stopPrice} USD · ${this.t('stopLimitPrice')} ${entry.stopLimitPrice} USD`
        : entry.stopPrice
          ? ` · ${this.t('stopPrice')} ${entry.stopPrice} USD · ${this.t(entry.triggerDirection === 'up' ? 'triggerUp' : 'triggerDown')}`
          : '') +
      (entry.fixConnectionId || entry.fix ? ' · FIX 5.0' : '');
    const fields = (names, data, commit, abort, masked = false) => {
      const [field, ...rest] = names;
      if (!field) return commit(data);
      return this.parent.ui.input(
        this.t(field),
        (value) => fields(rest, { ...data, [field]: value }, commit, abort, masked),
        { masked, back: abort },
      );
    };
    const menu = (title, options, body, cancel = back) =>
      this.parent.menu(title, options, (chosen) => chosen(), body, cancel);
    const credentials = () =>
      fields(
        ['key', 'secret', 'passphrase'],
        {},
        (values) => run(() => call('connect', values), 0),
        back,
        true,
      );
    const previewTerms = (terms) =>
      run(() => call('preview', { ...terms, operationId: randomUUID() }));
    const prepareTpsl = () =>
      menu(
        this.t('tpslOrder'),
        ['buy', 'sell'].map((side) =>
          option(side, () =>
            fields(
              ['size', 'takeProfitPrice', 'stopPrice', 'stopLimitPrice'],
              {},
              ({ takeProfitPrice, ...values }) =>
                previewTerms({
                  ...values,
                  side,
                  price: takeProfitPrice,
                  postOnly: false,
                  transport: 'fix',
                }),
              back,
            ),
          ),
        ),
        this.t('tpslHint'),
      );
    const makerChoices = (terms, labelSuffix = '') => [
      option(
        'postOnly',
        () => previewTerms({ ...terms, postOnly: true }),
        this.t('postOnly') + labelSuffix,
      ),
      option(
        'preview',
        () => previewTerms({ ...terms, postOnly: false }),
        this.t('preview') + labelSuffix,
      ),
    ];
    const stopPreview = (terms) =>
      fields(
        ['stopPrice'],
        { ...terms, transport: 'fix' },
        (values) =>
          menu(
            this.t('triggerDirection'),
            ['up', 'down'].map((triggerDirection) =>
              option(triggerDirection === 'up' ? 'triggerUp' : 'triggerDown', () =>
                menu(
                  this.t('stopLimitOrder'),
                  makerChoices({ ...values, triggerDirection }),
                  this.t('stopLimitHint'),
                ),
              ),
            ),
            this.t('stopLimitHint'),
          ),
        back,
      );
    const prepare = () =>
      menu(
        this.t('order'),
        ['buy', 'sell'].map((side) =>
          option(side, () =>
            fields(
              ['size', 'price'],
              {},
              (values) =>
                menu(
                  this.t('order'),
                  [
                    ...makerChoices({ ...values, side }),
                    ...(fix?.phase === 'ready'
                      ? [
                          ...makerChoices({ ...values, side, transport: 'fix' }, ' · FIX 5.0'),
                          option('stopLimitOrder', () => stopPreview({ ...values, side })),
                        ]
                      : []),
                  ],
                  [this.t(side), values.size, '·', values.price].join(' '),
                ),
              back,
            ),
          ),
        ),
        this.t(this.env),
      );
    const review = (draft) =>
      menu(
        this.t('drafts'),
        [
          option('close', back),
          option('submit', () =>
            this.parent.ui.input(
              this.t('ackSubmit'),
              (ack) =>
                run(() =>
                  call('confirm', { reviewId: draft.reviewId, specHash: draft.specHash, ack }),
                ),
              { back },
            ),
          ),
          option('discard', () => run(() => call('discard', { reviewId: draft.reviewId }))),
        ],
        [
          this.t(this.env),
          brief(draft),
          ...(draft.stopPrice ? [this.t(draft.stopLimitPrice ? 'tpslHint' : 'stopLimitHint')] : []),
          this.t(draft.stopLimitPrice ? 'maxNotional' : 'notional') +
            ' · ' +
            draft.notional +
            ' USD',
          this.t('fee') + ' · ' + draft.estimatedFee + ' USD',
        ].join('\n'),
      );
    const units = (grant) => grant.product.split('-')[grant.side === 'buy' ? 1 : 0];
    const summarize = (grant) => [
      this.t(this.env) + ' · ' + grant.product + ' · ' + this.t(grant.side),
      this.t('accountProfile') + ' · ' + grant.profileId,
      this.t('perOrder') + ' ' + grant.perOrder + ' ' + units(grant),
      this.t('total') + ' ' + grant.total + ' ' + units(grant),
      this.t(grant.allowAmend ? 'maxOperations' : 'maxOrders') + ' ' + grant.maxOrders,
      ...(grant.maxCancels ? [this.t('maxCancels') + ' ' + grant.maxCancels] : []),
      (grant.transport === 'fix' ? 'FIX 5.0' : 'REST') +
        ' · ' +
        this.t(grant.postOnly ? 'postOnly' : 'allowTaker'),
      ...(grant.allowAmend ? [this.t('allowFixAmend')] : []),
      ...(grant.allowStopLimit ? [this.t('allowStopLimit')] : []),
      ...(grant.allowTpsl ? [this.t('allowTpsl')] : []),
    ];
    const reviewAuthority = (draft) =>
      menu(
        this.t('reviewAuthority'),
        [
          option('discard', () => run(() => call('discardAuthority', { grantId: draft.grantId }))),
          option('confirmAuthority', () =>
            this.parent.ui.input(
              this.t('ackAuthority'),
              (ack) =>
                run(() =>
                  call('confirmAuthority', {
                    grantId: draft.grantId,
                    specHash: draft.specHash,
                    ack,
                  }),
                ),
              { back: () => reviewAuthority(draft) },
            ),
          ),
        ],
        [
          ...summarize(draft),
          this.t('minutes') + ' ' + draft.minutes,
          this.t('authorityHint'),
          ...(draft.maxCancels ? [this.t('cancelAuthorityHint')] : []),
          ...(draft.transport === 'fix' ? [this.t('fixAuthorityHint')] : []),
          ...(draft.allowTpsl ? [this.t('tpslHint')] : []),
        ].join('\n'),
      );
    const prepareAuthority = (side) =>
      fields(
        ['perOrder', 'total', 'maxOrders', 'maxCancels', 'minutes'],
        {},
        (data) => {
          const review = async (
            postOnly,
            transport,
            allowAmend = false,
            allowStopLimit = false,
            allowTpsl = false,
          ) => {
            try {
              return reviewAuthority(
                await call('prepareAuthority', {
                  ...data,
                  side,
                  postOnly,
                  maxOrders: Number(data.maxOrders),
                  maxCancels: Number(data.maxCancels),
                  minutes: Number(data.minutes),
                  ...(transport === 'fix' && { transport, allowAmend, allowStopLimit, allowTpsl }),
                }),
              );
            } catch (error) {
              return this.open(id, offset, this.t(error.message));
            }
          };
          const fixOptions = (postOnly, allowTpsl = false) => [
            option('fixOrdersOnly', () => review(postOnly, 'fix', false, false, allowTpsl)),
            option('allowFixAmend', () => review(postOnly, 'fix', true, false, allowTpsl)),
            option('allowStopLimit', () => review(postOnly, 'fix', false, true, allowTpsl)),
            option('allowFixAmendAndStop', () => review(postOnly, 'fix', true, true, allowTpsl)),
          ];
          return menu(
            this.t('reviewAuthority'),
            [true, false].flatMap((postOnly) => {
              const label = postOnly ? 'postOnly' : 'allowTaker';
              return [
                option(label, () => review(postOnly, 'rest')),
                option(
                  label,
                  () =>
                    menu(
                      this.t('reviewAuthority'),
                      [
                        ...fixOptions(postOnly),
                        ...(!postOnly
                          ? [
                              option('allowTpsl', () =>
                                menu(
                                  this.t('allowTpsl'),
                                  fixOptions(false, true),
                                  this.t('tpslHint'),
                                  authority,
                                ),
                              ),
                            ]
                          : []),
                      ],
                      this.t('fixAuthorityHint'),
                      authority,
                    ),
                  this.t(label) + ' · FIX 5.0',
                ),
              ];
            }),
            this.t('authorityUnits'),
          );
        },
        back,
      );
    const authority = () =>
      menu(
        this.t('authority'),
        [
          option('close', back),
          ...(page.configured
            ? ['buy', 'sell'].map((side) =>
                option(
                  side,
                  () => prepareAuthority(side),
                  this.t('reviewAuthority') + ' · ' + this.t(side),
                ),
              )
            : []),
          ...(page.grants || []).map((grant) =>
            option(
              'authority',
              () =>
                menu(
                  this.t(grant.status),
                  [
                    option('close', authority),
                    ...(grant.status !== 'authorityRevoked'
                      ? [
                          option('revokeAuthority', () =>
                            run(() => call('revokeAuthority', { grantId: grant.grantId })),
                          ),
                        ]
                      : []),
                  ],
                  [
                    ...summarize(grant),
                    this.t('remaining') + ' ' + grant.remaining + ' ' + units(grant),
                    this.t(grant.allowAmend ? 'operationsRemaining' : 'ordersRemaining') +
                      ' ' +
                      grant.ordersRemaining,
                    ...(grant.maxCancels
                      ? [this.t('cancelsRemaining') + ' ' + grant.cancelsRemaining]
                      : []),
                    this.t('expiresAt') +
                      ' ' +
                      new Date(grant.expiresAt).toLocaleString(getLanguage()),
                  ].join('\n'),
                  authority,
                ),
              this.t(grant.side) + ' · ' + this.t(grant.status),
            ),
          ),
        ],
        [page.product, this.t(this.env), this.t('authorityHint'), this.t('authorityUnits')].join(
          '\n',
        ),
      );
    const prepareReplacement = (order, amend = false) => {
      const quantity = amend ? 'amendSize' : 'replacementSize';
      return fields(
        [
          quantity,
          order.stopLimitPrice ? 'takeProfitPrice' : 'price',
          ...(amend && order.stopPrice ? ['stopPrice'] : []),
          ...(amend && order.stopLimitPrice ? ['stopLimitPrice'] : []),
        ],
        {},
        async (values) => {
          try {
            const draft = await call(amend ? 'previewAmend' : 'previewReplacement', {
              orderId: order.clientId,
              size: values[quantity],
              price: values.takeProfitPrice ?? values.price,
              ...(values.stopPrice && { stopPrice: values.stopPrice }),
              ...(values.stopLimitPrice && { stopLimitPrice: values.stopLimitPrice }),
            });
            const { reviewId, specHash } = draft;
            const discard = () =>
              run(() => call(amend ? 'discardAmend' : 'discardReplacement', { reviewId }));
            const confirmation = () =>
              menu(
                this.t(amend ? 'amend' : 'replace'),
                [
                  option(amend ? 'confirmAmend' : 'confirmReplacement', () =>
                    this.parent.ui.input(
                      this.t(amend ? 'ackAmend' : 'ackReplace'),
                      (ack) =>
                        run(
                          () =>
                            call(amend ? 'confirmAmend' : 'confirmReplacement', {
                              orderId: order.clientId,
                              reviewId,
                              specHash,
                              ack,
                            }),
                          0,
                        ),
                      { back: confirmation },
                    ),
                  ),
                  option('discard', discard),
                ],
                [
                  this.t(this.env),
                  this.t('originalOrder') +
                    ' · ' +
                    brief({
                      ...order,
                      size: draft.originalSize,
                      price: draft.originalPrice,
                      stopPrice: draft.originalStopPrice,
                      stopLimitPrice: draft.originalStopLimitPrice,
                    }),
                  this.t('filledSize') +
                    ' · ' +
                    draft.filledSize +
                    ' · ' +
                    (order.venueId || order.clientId),
                  this.t(amend ? 'amendedTerms' : 'replacementOrder') +
                    ' · ' +
                    brief(draft) +
                    ' · ' +
                    this.t(draft.postOnly ? 'postOnly' : 'allowTaker'),
                  this.t(amend ? 'remainingNotional' : 'notional') +
                    ' · ' +
                    draft.notional +
                    ' USD',
                  this.t('fee') + ' · ' + draft.estimatedFee + ' USD',
                  ...(amend
                    ? [
                        this.t('fixLeaves') + ' · ' + draft.remainingSize,
                        this.t(
                          draft.stopPrice
                            ? draft.keepsTriggerPriority
                              ? 'keepTriggerPriority'
                              : 'loseTriggerPriority'
                            : draft.keepsPriority
                              ? 'amendKeepPriority'
                              : 'amendLosePriority',
                        ),
                      ]
                    : []),
                  this.t(amend ? 'amendHint' : 'replacementHint'),
                ].join('\n'),
                discard,
              );
            return confirmation();
          } catch (error) {
            return this.open(id, offset, this.t(error.message));
          }
        },
        () => reconcile(order),
      );
    };
    const reconcile = (order) => {
      const choices = [option('close', back)];
      if (page.configured) {
        choices.push(
          option('reconcile', () => run(() => call('reconcile', { orderId: order.clientId }))),
        );
        if (fix && order.venueId)
          choices.push(
            option('fixQuery', async () => {
              try {
                const report = await call('fixQuery', { orderId: order.clientId });
                return menu(
                  this.t('fixTitle'),
                  [option('close', back)],
                  [
                    this.t(this.env),
                    this.t(report.status),
                    report.venueId,
                    this.t('filledSize') + ' · ' + (report.filledSize ?? '—'),
                    ...(report.triggered ? [this.t('stop-triggered')] : []),
                    this.t('fixLeaves') + ' · ' + (report.remainingSize ?? '—'),
                    this.t('watchChecked') +
                      ' · ' +
                      new Date(report.checkedAt).toLocaleTimeString(getLanguage()),
                  ].join('\n'),
                );
              } catch (error) {
                return this.open(id, offset, this.t(error.message));
              }
            }),
          );
        if (order.replacementAvailable)
          choices.push(
            option(order.status === 'canceled' ? 'reviewReplacementAgain' : 'replace', () =>
              prepareReplacement(order),
            ),
          );
        if (order.amendmentAvailable)
          choices.push(option('amend', () => prepareReplacement(order, true)));
        if (order.cancelAvailable)
          choices.push(
            option('cancel', () =>
              this.parent.ui.input(
                this.t('ackCancel'),
                (ack) => run(() => call('cancel', { orderId: order.clientId, ack })),
                { back },
              ),
            ),
          );
      }
      if (order.fix?.amendments.length) {
        const amendments = order.fix.amendments.slice().reverse();
        const showPage = (i) =>
          menu(
            this.t('amendHistory'),
            [
              option('close', () => reconcile(order)),
              ...(i ? [option('previous', () => showPage(i - 1))] : []),
              ...(i + 1 < amendments.length ? [option('next', () => showPage(i + 1))] : []),
            ],
            [
              amendments[i].clientId,
              this.t('amend-' + amendments[i].outcome),
              brief({ ...order, ...amendments[i] }),
              `${i + 1} / ${amendments.length}`,
            ].join('\n'),
            () => reconcile(order),
          );
        choices.push(option('amendHistory', () => showPage(0)));
      }
      if (order.cancellations?.length) {
        const showPage = (i) => {
          const rows = order.cancellations;
          const row = rows[i];
          return menu(
            this.t('cancelHistory'),
            [
              option('close', () => reconcile(order)),
              ...(i < rows.length - 1 ? [option('previous', () => showPage(i + 1))] : []),
              ...(i > 0 ? [option('next', () => showPage(i - 1))] : []),
            ],
            [
              row.clientId,
              this.t('cancel-' + (row.outcome || 'unknown')),
              row.transport === 'fix' ? 'FIX 5.0' : 'REST',
              `${rows.length - i} / ${rows.length}`,
            ].join('\n'),
            () => reconcile(order),
          );
        };
        choices.push(option('cancelHistory', () => showPage(order.cancellations.length - 1)));
      }
      return menu(
        this.t('history'),
        choices,
        [
          this.t(this.env),
          brief(order),
          this.t(order.status),
          order.stopLimitPrice && order.activeLeg
            ? this.t('tpsl-' + order.activeLeg)
            : order.stopPrice &&
              this.t(
                order.stopLimitPrice && order.stopState === 'waiting'
                  ? 'tpsl-armed'
                  : 'stop-' + (order.stopState || 'unverified'),
              ),
          order.activePrice && this.t('activePrice') + ' · ' + order.activePrice + ' USD',
          order.grantId && this.t('agentOrder'),
          order.venueId || order.clientId,
          this.t('filledSize') + ' · ' + (order.filledSize ?? '—'),
          this.t('fillFees') + ' · ' + (order.fillFees ?? '—') + ' USD',
          order.replaces && this.t('originalOrder') + ' · ' + order.replaces,
          order.replacement &&
            this.t('replacementOrder') +
              ' · ' +
              brief({ ...order, ...order.replacement }) +
              ' · ' +
              order.replacement.clientId,
          order.replacement?.error && this.t(order.replacement.error),
          order.fix?.pending && this.t('amendPending') + ' · ' + order.fix.pending.clientId,
          order.error && this.t(order.error),
        ]
          .filter(Boolean)
          .join('\n'),
      );
    };
    const items = [
      option('close', () => this.parent.project(id)),
      option(this.env, () =>
        menu(
          this.t('title'),
          ['sandbox', 'live'].map((env) =>
            option(env, () => {
              this.env = env;
              return this.open(id);
            }),
          ),
          this.t('credentialsHint'),
        ),
      ),
      option('refresh', back),
      option('connect', credentials),
      ...(page.configured
        ? [
            ...(fix
              ? [
                  option('fixTitle', () =>
                    menu(
                      this.t('fixTitle'),
                      [
                        option('close', back),
                        ...(['connecting', 'recovering', 'ready'].includes(fix.phase)
                          ? [option('fixClose', () => run(() => call('fixDisconnect')))]
                          : [option('fixConnect', () => run(() => call('fixConnect')))]),
                      ],
                      [
                        this.t(fixPhase[fix.phase]),
                        fix.lastSequence && this.t('fixSequence') + ' · ' + fix.lastSequence,
                        fix.error && this.t(fix.error),
                        this.t('fixHint'),
                      ]
                        .filter(Boolean)
                        .join('\n'),
                    ),
                  ),
                ]
              : []),
            option(watch?.enabled ? 'watchDisable' : 'watchEnable', () =>
              run(() => call('watch', { enabled: !watch?.enabled })),
            ),
            option('preview', prepare),
            ...(fix?.phase === 'ready' ? [option('tpslOrder', prepareTpsl)] : []),
            option('disconnect', () => run(() => call('disconnect'))),
          ]
        : []),
      ...(page.configured || page.grants?.length ? [option('authority', authority)] : []),
      ...page.drafts.map((draft) =>
        option('drafts', () => review(draft), this.t('drafts') + ' · ' + brief(draft)),
      ),
      ...page.items.map((order) =>
        option('history', () => reconcile(order), this.t(order.status) + ' · ' + brief(order)),
      ),
      ...(offset > 0 ? [option('previous', () => this.open(id, Math.max(0, offset - 20)))] : []),
      ...(page.next !== null ? [option('next', () => this.open(id, page.next))] : []),
    ];
    const output = menu(
      this.t('title'),
      items,
      [
        page.product,
        this.t(this.env),
        page.configured ? this.t('configured') : this.t('credentialsHint'),
        page.accountError && this.t(page.accountError),
        watch?.enabled && this.t(watchText[watch.phase]),
        watch?.enabled &&
          (watch.lastVerifiedAt
            ? this.t('watchChecked') +
              ' · ' +
              new Date(watch.lastVerifiedAt).toLocaleTimeString(getLanguage())
            : this.t('watchUnverified')),
        watch?.error && this.t(watch.error),
        note,
      ]
        .filter(Boolean)
        .join('\n'),
      () => this.parent.project(id),
    );
    if (app?.state.modal) {
      if (fromModal) app.state.modal.selected = Math.min(fromModal.selected, items.length - 1);
      const modal = app.state.modal;
      modal.exchangeEnv = this.env;
      let refreshing;
      modal.refreshExchange = () =>
        (refreshing ||= this.open(id, offset, note, modal).finally(() => {
          refreshing = null;
        }));
    }
    return output;
  }
}
module.exports = { ExchangeBrowser };
