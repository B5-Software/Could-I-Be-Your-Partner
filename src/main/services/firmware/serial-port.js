/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
// Web Serial adapter for Espressif's esptool-js. Runs in the shared host
// backend; no Python installation, shell command or browser permission needed.
class HostSerialPort {
  constructor(info, SerialPort) {
    this.info = info;
    this.SerialPort = SerialPort;
  }
  getInfo() {
    return {
      usbVendorId: parseInt(this.info.vendorId, 16) || undefined,
      usbProductId: parseInt(this.info.productId, 16) || undefined,
    };
  }
  async open(options) {
    if (this.port?.isOpen) throw Error('SERIAL_ALREADY_OPEN');
    const port = new this.SerialPort({
      path: this.info.path,
      baudRate: options.baudRate,
      autoOpen: false,
      lock: true,
      highWaterMark: 65536,
    });
    this.port = port;
    await new Promise((resolve, reject) =>
      port.open((error) => (error ? reject(error) : resolve())),
    );
    this.readable = new ReadableStream(
      {
        start: (controller) => {
          const fail = (error) => {
            try {
              controller.error(error);
            } catch {}
          };
          port.on('data', (bytes) => {
            if (controller.desiredSize === null) return;
            if (controller.desiredSize < -1048576) {
              fail(Error('SERIAL_BUFFER_LIMIT'));
              void this.close();
              return;
            }
            try {
              controller.enqueue(new Uint8Array(bytes));
            } catch {}
          });
          port.on('error', fail);
          port.once('close', () => {
            try {
              controller.close();
            } catch {}
          });
        },
      },
      { highWaterMark: 65536, size: (bytes) => bytes.byteLength },
    );
    this.writable = new WritableStream({
      write: (bytes) =>
        new Promise((resolve, reject) =>
          port.write(Buffer.from(bytes), (error) =>
            error ? reject(error) : port.drain((error) => (error ? reject(error) : resolve())),
          ),
        ),
    });
  }
  setSignals(signals) {
    const flags = {};
    for (const [web, native] of [
      ['dataTerminalReady', 'dtr'],
      ['requestToSend', 'rts'],
      ['break', 'brk'],
    ])
      if (typeof signals[web] === 'boolean') flags[native] = signals[web];
    return new Promise((resolve, reject) =>
      this.port.set(flags, (error) => (error ? reject(error) : resolve())),
    );
  }
  setBaudRate(baudRate) {
    return new Promise((resolve, reject) =>
      this.port.update({ baudRate }, (error) => (error ? reject(error) : resolve())),
    );
  }
  async close() {
    if (this.port?.isOpen) await new Promise((resolve) => this.port.close(() => resolve()));
  }
}
module.exports = { HostSerialPort };
