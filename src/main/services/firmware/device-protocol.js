/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Application-mode USB reads. Never enters the ROM loader, toggles eFuses or
// accepts arbitrary commands from the frontend. Boot/INFO frames are not replies.
function readDeviceCommand({
  path,
  baudRate = 115200,
  command,
  accept,
  SerialPort,
  timeoutMs = 12000,
  settleMs = 600,
}) {
  return new Promise((resolve, reject) => {
    let port,
      finished = false,
      sent = false,
      buffer = '',
      received = 0,
      settle;
    const timeout = setTimeout(() => finish(Error('TRNG_DEVICE_TIMEOUT')), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(settle);
      if (port) {
        port.removeAllListeners('data');
        port.removeAllListeners('open');
        port.removeAllListeners('error');
        port.removeAllListeners('close');
        port.on('error', () => {});
        if (port.isOpen) port.close(() => {});
      }
      if (error) reject(error);
      else resolve(value);
    }
    try {
      const Type = SerialPort || require('serialport').SerialPort;
      port = new Type({ path, baudRate, autoOpen: false, lock: true });
      port.on('error', () => finish(Error('TRNG_DEVICE_IO')));
      port.on('close', () => finish(Error('TRNG_DEVICE_DISCONNECTED')));
      port.on('data', (chunk) => {
        received += chunk.length;
        if (received > 65536) return finish(Error('TRNG_DEVICE_FRAME_LIMIT'));
        if (!sent) return;
        buffer += chunk.toString('utf8');
        if (buffer.length > 16384) return finish(Error('TRNG_DEVICE_FRAME_LIMIT'));
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        if (buffer.length > 8192) return finish(Error('TRNG_DEVICE_FRAME_LIMIT'));
        for (const line of lines) {
          if (line.length > 8192) return finish(Error('TRNG_DEVICE_FRAME_LIMIT'));
          if (!line.trim().startsWith('{')) continue;
          let value;
          try {
            value = JSON.parse(line.trim());
          } catch {
            continue;
          }
          if (value.error) return finish(Error('TRNG_DEVICE_REJECTED'));
          if (accept(value)) return finish(null, value);
        }
      });
      port.open((error) => {
        if (error) return finish(Error('TRNG_DEVICE_IO'));
        if (finished) {
          if (port.isOpen) port.close(() => {});
          return;
        }
        settle = setTimeout(() => {
          sent = true;
          buffer = '';
          port.write(command + '\n', (error) => {
            if (error) finish(Error('TRNG_DEVICE_IO'));
          });
        }, settleMs);
      });
    } catch {
      finish(Error('TRNG_DEVICE_IO'));
    }
  });
}
const isDraw = (value) =>
  Number.isInteger(value?.cardIndex) &&
  value.cardIndex >= 0 &&
  value.cardIndex < 78 &&
  typeof value.isReversed === 'boolean';
module.exports = { readDeviceCommand, isDraw };
