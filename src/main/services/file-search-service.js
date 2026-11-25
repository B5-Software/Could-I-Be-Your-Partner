/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const { isBroadScanPath, RESTRICT_SCAN_ERROR } = require('./file-search-worker');

const WORKER_SCRIPT = path.join(__dirname, 'file-search-worker.js');

/**
 * Isolated child-process runner for fs:localSearch and fs:searchInFiles so heavy
 * directory traversals and content scans never stall Electron's main process or renderer.
 */
class FileSearchService {
  constructor(workerEntry = WORKER_SCRIPT) {
    this.workerEntry = workerEntry;
    this.pending = new Map();
    this.seq = 0;
    this.disposed = false;
  }

  _runInWorker(action, args, timeoutMs) {
    if (this.disposed) return Promise.resolve({ ok: false, error: '文件搜索服务已关闭' });
    if (this.pending.size >= 4)
      return Promise.resolve({ ok: false, code: 'FILE_SEARCH_BUSY', error: '文件搜索并发已满' });
    return new Promise((resolve) => {
      const worker = fork(this.workerEntry, ['--cibyp-file-search-worker'], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        env: process.versions.electron
          ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
          : process.env,
      });
      const id = ++this.seq;
      const hardTimeout = Math.max(2000, Math.min(65000, Number(timeoutMs) || 20000)) + 2000;
      const finish = (result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
        resolve(result);
      };
      const fail = (error) => finish({ ok: false, code: 'FILE_SEARCH_WORKER', error });
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            code: 'FILE_SEARCH_TIMEOUT',
            error:
              '文件搜索超时，请缩小目标目录（先用 listDirectory 定位子目录）或使用更精确的模式。',
          }),
        hardTimeout,
      );
      timer.unref?.();
      this.pending.set(id, finish);
      worker.once('exit', (code, signal) =>
        fail(`文件搜索工作进程退出 (${signal || code || 'closed'})`),
      );
      worker.on('error', (error) => fail(`文件搜索工作进程错误: ${error.message}`));
      worker.on('message', (msg) => {
        if (msg?.id === id) finish(msg.result);
      });
      try {
        worker.send({ id, action, args }, (error) => {
          if (error) fail(error.message);
        });
      } catch (err) {
        fail(err.message);
      }
    });
  }

  localSearch(dirPath, pattern, options = {}) {
    const restrictDiskScan = options.restrictDiskScan !== false;
    if (restrictDiskScan && isBroadScanPath(dirPath)) {
      return Promise.resolve({ ok: false, blocked: true, error: RESTRICT_SCAN_ERROR });
    }
    return this._runInWorker(
      'localSearch',
      { dirPath, pattern, options: { ...options, restrictDiskScan } },
      options.timeoutMs || 15000,
    );
  }

  searchInFiles(paths, pattern, options = {}) {
    const restrictDiskScan = options.restrictDiskScan !== false;
    if (restrictDiskScan && Array.isArray(paths)) {
      for (const p of paths) {
        if (typeof p === 'string' && isBroadScanPath(p)) {
          return Promise.resolve({ ok: false, blocked: true, error: RESTRICT_SCAN_ERROR });
        }
      }
    }
    return this._runInWorker(
      'searchInFiles',
      { paths, pattern, options: { ...options, restrictDiskScan } },
      options.timeoutMs || 25000,
    );
  }

  dispose() {
    this.disposed = true;
    for (const finish of this.pending.values()) finish({ ok: false, error: '文件搜索服务已关闭' });
  }
}

module.exports = { FileSearchService, isBroadScanPath, RESTRICT_SCAN_ERROR };
