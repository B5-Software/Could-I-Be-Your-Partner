/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function registerSerialIpc({ ipcMain }) {
  // ---- Serial Port Agent Tools ----
  const agentSerialPorts = new Map(); // path → { port, buffer }

  ipcMain.handle('serial:listPorts', async () => {
    try {
      const { SerialPort } = require('serialport');
      const ports = await SerialPort.list();
      return { ok: true, ports };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:openPort', async (_, portPath, options) => {
    try {
      if (agentSerialPorts.has(portPath)) {
        return { ok: false, error: `串口 ${portPath} 已打开` };
      }
      const { SerialPort } = require('serialport');
      const opts = {
        path: portPath,
        baudRate: options?.baudRate || 9600,
        dataBits: options?.dataBits || 8,
        stopBits: options?.stopBits || 1,
        parity: options?.parity || 'none',
      };
      const port = new SerialPort(opts);
      const entry = { port, buffer: '' };
      port.on('data', (chunk) => {
        entry.buffer += chunk.toString('utf8');
      });
      port.on('error', (e) => {
        console.error(`[Serial ${portPath}] error:`, e.message);
      });
      agentSerialPorts.set(portPath, entry);
      return new Promise((resolve) => {
        port.once('open', () =>
          resolve({
            ok: true,
            message: `串口 ${portPath} 已打开 (${opts.baudRate}bps)`,
          }),
        );
        port.once('error', (e) => {
          agentSerialPorts.delete(portPath);
          resolve({ ok: false, error: e.message });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:writePort', async (_, portPath, data, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const enc = encoding || 'utf8';
      const buf = Buffer.from(data, enc);
      return new Promise((resolve) => {
        entry.port.write(buf, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          entry.port.drain((e2) => {
            if (e2) return resolve({ ok: false, error: e2.message });
            resolve({ ok: true, bytesWritten: buf.length });
          });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:readPort', async (_, portPath, timeout, encoding) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      const ms = timeout || 1000;
      // Wait for data up to timeout
      if (!entry.buffer) {
        await new Promise((r) => setTimeout(r, ms));
      }
      const data = entry.buffer;
      entry.buffer = '';
      if (encoding === 'hex') {
        return {
          ok: true,
          data: Buffer.from(data, 'utf8').toString('hex'),
          length: data.length,
        };
      }
      if (encoding === 'base64') {
        return {
          ok: true,
          data: Buffer.from(data, 'utf8').toString('base64'),
          length: data.length,
        };
      }
      return { ok: true, data, length: data.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:closePort', async (_, portPath) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.close((err) => {
          agentSerialPorts.delete(portPath);
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, message: `串口 ${portPath} 已关闭` });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('serial:setSignals', async (_, portPath, signals) => {
    try {
      const entry = agentSerialPorts.get(portPath);
      if (!entry) return { ok: false, error: `串口 ${portPath} 未打开` };
      return new Promise((resolve) => {
        entry.port.set(signals, (err) => {
          if (err) return resolve({ ok: false, error: err.message });
          resolve({ ok: true, signals });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
};
