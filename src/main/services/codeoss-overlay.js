/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const path = require('node:path');
const { WebContentsView } = require('electron');

// Host DOM cannot paint above an embedded native view. Mirror only the small,
// non-interactive hover card in a sandboxed view above the live workbench.
class CodeOSSOverlay {
  constructor(getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.revision = 0;
  }

  async ensureView(bounds) {
    if (this.loading) return this.loading;
    const parent = this.getMainWindow();
    if (!parent || parent.isDestroyed()) throw new Error('CIBYP window is unavailable');
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: 'cibyp-codeoss-overlay',
      },
    });
    this.view = view;
    this.parent = parent;
    view.setBackgroundColor('#00000000');
    view.setBounds(bounds);
    // Attach the transparent surface before loading. Loading a hidden native
    // view can leave Chromium without a display surface for its first card.
    // A dismissed snapshot hides it immediately, including during loading.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    parent.contentView.addChildView(view);
    parent.once('closed', (this.onParentClosed = () => this.destroy()));
    this.loading = view.webContents
      .loadFile(path.join(__dirname, '../../renderer/pages/codeoss-overlay.html'))
      .then(() => view);
    return this.loading;
  }

  update(snapshot) {
    const revision = ++this.revision;
    const parent = this.getMainWindow();
    if (!snapshot || !parent || parent.isDestroyed()) {
      this.view?.setVisible(false);
      return;
    }
    if (typeof snapshot.html !== 'string' || JSON.stringify(snapshot).length > 128 * 1024) {
      this.view?.setVisible(false);
      return;
    }
    const [width, height] = parent.getContentSize();
    const bounds = snapshot.bounds || {};
    const x = Math.max(0, Math.min(width, Math.round(Number(bounds.x) || 0)));
    const y = Math.max(0, Math.min(height, Math.round(Number(bounds.y) || 0)));
    const rect = {
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.ceil(Number(bounds.width) || 0))),
      height: Math.max(0, Math.min(height - y, Math.ceil(Number(bounds.height) || 0))),
    };
    if (!rect.width || !rect.height) {
      this.view?.setVisible(false);
      return;
    }
    void this.ensureView(rect)
      .then(async (view) => {
        if (revision !== this.revision || view.webContents.isDestroyed()) return;
        await view.webContents.executeJavaScript(
          `window.renderCodeOSSOverlay(${JSON.stringify(snapshot)})`,
        );
        // A pending paint must never resurrect a dismissed card or a closed IDE.
        if (revision !== this.revision || parent.isDestroyed()) return;
        view.setBounds(rect);
        // Reattaching an already topmost view can detach its Chromium surface.
        if (parent.contentView.children.at(-1) !== view) parent.contentView.addChildView(view);
        view.setVisible(true);
      })
      .catch((error) => {
        if (revision !== this.revision) return;
        this.destroy();
        console.warn('[Code-OSS overlay]', error.message);
      });
  }

  destroy() {
    ++this.revision;
    if (this.parent && !this.parent.isDestroyed()) {
      this.parent.removeListener('closed', this.onParentClosed);
      if (this.view) this.parent.contentView.removeChildView(this.view);
    }
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.parent = null;
    this.loading = null;
  }
}

module.exports = { CodeOSSOverlay };
