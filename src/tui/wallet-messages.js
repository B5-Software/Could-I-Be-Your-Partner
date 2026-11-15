/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
class TuiWalletMessages {
  constructor(wallet) {
    this.w = wallet;
  }
  async open(offset = 0) {
    const page = await this.w.call('message.list', { offset, limit: 20 });
    return this.w.menu(
      this.w.text('msgTitle'),
      [
        { label: this.w.text('msgBack'), value: 'back' },
        { label: this.w.text('msgRefresh'), value: 'refresh' },
        ...page.items.map((r) => ({
          label: [r.message.origin, r.sourceBrowser?.clientName, this.w.status(r.status)]
            .filter(Boolean)
            .join(' · '),
          value: r.id,
        })),
        ...(offset ? [{ label: this.w.text('msgPrevious'), value: 'previous' }] : []),
        ...(page.next !== null ? [{ label: this.w.text('msgNext'), value: 'next' }] : []),
      ],
      (v) => {
        if (v === 'back') return this.w.open();
        if (v === 'refresh') return this.open(offset);
        if (v === 'previous') return this.open(Math.max(0, offset - 20));
        if (v === 'next') return this.open(page.next);
        return this.inspect(v, 0, () => this.open(offset));
      },
      this.w.text('msgPrivacy'),
      () => this.w.open(),
    );
  }
  async inspect(id, offset = 0, back = () => this.open()) {
    const r = await this.w.call('message.get', { id });
    const text = JSON.stringify(
      {
        source: r.message.origin,
        browser: r.sourceBrowser?.clientName,
        account: r.address,
        chainId: r.message.chainId,
        kind: r.message.kind,
        login: r.login,
        preview: r.preview,
        payload: r.message.payload,
        digest: r.digest,
        expiresAt: new Date(r.expiresAt).toISOString(),
        status: this.w.status(r.status),
        signatureHash: r.signatureHash,
      },
      null,
      2,
    ).replace(/[\u202a-\u202e\u2066-\u2069]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));
    return this.w.menu(
      this.w.text('msgReview'),
      [
        { label: this.w.text('msgBack'), value: 'back' },
        ...(offset ? [{ label: this.w.text('msgPrevious'), value: 'previous' }] : []),
        ...(offset + 1600 < text.length ? [{ label: this.w.text('msgNext'), value: 'next' }] : []),
        ...(r.status === 'approval-required'
          ? [
              { label: this.w.text('msgDeny'), value: 'deny' },
              { label: this.w.text('msgContinue'), value: 'approve' },
            ]
          : []),
        ...(['signing-unknown', 'signed-withheld'].includes(r.status)
          ? [{ label: this.w.text('msgReconcile'), value: 'reconcile' }]
          : []),
      ],
      async (v) => {
        if (v === 'back') return back();
        if (v === 'previous') return this.inspect(id, Math.max(0, offset - 1600), back);
        if (v === 'next') return this.inspect(id, offset + 1600, back);
        if (v === 'reconcile') {
          await this.w.call('message.reconcile', { id });
          return this.inspect(id, offset, back);
        }
        const frozen = Object.freeze({ id: r.id, digest: r.reviewDigest });
        if (v === 'deny') {
          await this.w.call('message.deny', frozen);
          return back();
        }
        return this.w.menu(
          this.w.text('msgReview'),
          [
            { label: this.w.text('msgDeny'), value: false },
            { label: this.w.text('msgSign'), value: true },
          ],
          async (allow) => {
            await this.w.call(allow ? 'message.approve' : 'message.deny', {
              ...frozen,
              ...(allow ? { confirmed: true } : {}),
            });
            return back();
          },
          r.message.origin +
            (r.sourceBrowser?.clientName ? '\n' + r.sourceBrowser.clientName : '') +
            '\n' +
            r.address +
            '\n' +
            r.digest +
            '\n\n' +
            this.w.text('msgWarning'),
          () => this.inspect(id, offset, back),
        );
      },
      this.w.text('msgWarning') +
        '\n\n' +
        text.slice(offset, offset + 1600) +
        `\n${offset}–${Math.min(offset + 1600, text.length)} / ${text.length}`,
      back,
    );
  }
}
module.exports = { TuiWalletMessages };
