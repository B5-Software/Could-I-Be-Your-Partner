/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

const released = new WeakSet();

function releaseExitedPty(terminal) {
  if (process.platform !== 'win32' || released.has(terminal)) return;
  released.add(terminal);
  // node-pty 1.1 leaves ConPTY's input pipe open, and its DLL backend can
  // leave the output worker alive after onExit. Only clean up AFTER exit,
  // so its existing drain interval still preserves the final output.
  // https://github.com/microsoft/node-pty/issues/947
  // https://github.com/microsoft/node-pty/issues/887
  const agent = terminal._agent;
  agent?.inSocket?.destroy();
  agent?._conoutSocketWorker?.dispose();
}

module.exports = { releaseExitedPty };
