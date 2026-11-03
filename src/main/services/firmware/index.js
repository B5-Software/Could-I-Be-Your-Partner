/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { HostSerialPort } = require('./serial-port');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw Error(message);
};
const chipNames = { 'ESP32-C3': 'esp32c3', 'ESP32-C6': 'esp32c6', 'ESP32-S31': 'esp32s31' };
const chipIds = { esp32c3: 5, esp32c6: 13, esp32s31: 32 };
function readImage(directory, image) {
  if (
    !image ||
    image.profile !== 'development' ||
    image.walletEntropy !== false ||
    !chipIds[image.chip]
  )
    fail('FIRMWARE_IMAGE_UNSUPPORTED');
  if (!Array.isArray(image.segments) || image.segments.length < 3 || image.segments.length > 5)
    fail('FIRMWARE_MANIFEST_INVALID');
  let previous = 0;
  return [...image.segments]
    .sort((a, b) => a.address - b.address)
    .map((segment) => {
      if (
        !new RegExp('^' + image.id + '/[a-zA-Z0-9_.-]+\\.bin$').test(segment.file) ||
        !Number.isSafeInteger(segment.address) ||
        segment.address < previous ||
        !Number.isSafeInteger(segment.size) ||
        segment.size <= 0 ||
        segment.size > 2 * 1024 * 1024 ||
        segment.address + segment.size > 4 * 1024 * 1024
      )
        fail('FIRMWARE_MANIFEST_INVALID');
      const file = path.join(directory, segment.file),
        base = fs.realpathSync(directory),
        real = fs.realpathSync(file);
      if (
        !real.startsWith(base + path.sep) ||
        !fs.lstatSync(file).isFile() ||
        fs.lstatSync(file).isSymbolicLink()
      )
        fail('FIRMWARE_PATH_INVALID');
      const data = fs.readFileSync(file);
      if (data.length !== segment.size || hash(data) !== segment.sha256)
        fail('FIRMWARE_HASH_MISMATCH');
      if (data[0] === 0xe9 && data.readUInt16LE(12) !== chipIds[image.chip])
        fail('FIRMWARE_CHIP_MISMATCH');
      previous = segment.address + segment.size;
      return { address: segment.address, data: new Uint8Array(data) };
    });
}
function checkSecurity(info) {
  if (!info || !Number.isSafeInteger(info.flags) || !Number.isSafeInteger(info.flashCryptCnt))
    fail('FIRMWARE_SECURITY_UNKNOWN');
  // Never offer a "force" bypass. Ordinary bundled updates cannot provision,
  // decrypt, replace owner-signed firmware or overwrite a protected bootloader.
  if (info.flags & 5 || info.flashCryptCnt !== 0) fail('FIRMWARE_PROTECTED_DEVICE');
}
function readArtArchive(directory, manifest) {
  const segment = manifest?.images?.[0]?.segments.find((item) =>
    item.file.endsWith('/tarot-art.bin'),
  );
  const file = path.join(directory, 'tarot-art.bin');
  if (
    !segment ||
    segment.size !== 0x1e0000 ||
    !fs.existsSync(file) ||
    !fs.lstatSync(file).isFile() ||
    fs.lstatSync(file).isSymbolicLink()
  )
    fail('FIRMWARE_SOURCE_INVALID');
  const bytes = fs.readFileSync(file);
  if (
    bytes.length !== segment.size ||
    hash(bytes) !== segment.sha256 ||
    bytes.toString('ascii', 0, 8) !== 'CIBYPTA1' ||
    bytes.readUInt32LE(8) !== 78
  )
    fail('FIRMWARE_HASH_MISMATCH');
  return bytes;
}
class FirmwareService {
  constructor({ directory, publish = () => {}, ports, loaderFactory } = {}) {
    const resources = process.resourcesPath || process.env.CIBYP_PACKAGED_RESOURCES;
    const root =
      path.basename(__dirname) === 'node-core'
        ? path.resolve(__dirname, '../..')
        : path.resolve(__dirname, '../../../..');
    const candidates = [
      ...(resources
        ? [
            path.join(resources, 'app.asar/assets/trng-firmware'),
            path.join(resources, 'assets/trng-firmware'),
          ]
        : []),
      path.join(root, 'assets/trng-firmware'),
    ];
    this.directory =
      directory ||
      candidates.find((item) => fs.existsSync(path.join(item, 'manifest.json'))) ||
      candidates.at(-1);
    this.publish = publish;
    this.ports = ports;
    this.loaderFactory = loaderFactory;
    this.tickets = new Map();
    this.job = null;
    this.busy = false;
  }
  manifest() {
    const file = path.join(this.directory, 'manifest.json');
    if (!fs.existsSync(file)) return { version: 1, protocol: 2, images: [] };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      value.version !== 1 ||
      value.protocol !== 2 ||
      !Array.isArray(value.images) ||
      value.images.some((image) => !/^esp32(?:c3|c6|s31)-(?:uart|usb)$/.test(image.id))
    )
      fail('FIRMWARE_MANIFEST_INVALID');
    return value;
  }
  async listPorts() {
    return (await (this.ports ? this.ports() : require('serialport').SerialPort.list())).filter(
      (info) => info.vendorId && info.productId,
    );
  }
  status() {
    return this.job ? structuredClone(this.job) : null;
  }
  update(fields) {
    Object.assign(this.job, fields, { updatedAt: Date.now() });
    try {
      this.publish({ type: 'firmware-progress', job: this.status() });
    } catch {}
  }
  async connect(info) {
    if (this.loaderFactory) return this.loaderFactory(info);
    const { ESPLoader, Transport } = await import('esptool-js');
    const device = new HostSerialPort(info, require('serialport').SerialPort),
      transport = new Transport(device, false);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: { clean() {}, write() {}, writeLine() {} },
      debugLogging: false,
    });
    return {
      loader,
      close: async () => {
        try {
          await transport.disconnect();
        } catch {
          await device.close();
        }
      },
    };
  }
  async inspect(port) {
    if (this.disposed) fail('FIRMWARE_STOPPED');
    if (this.busy) fail('FIRMWARE_BUSY');
    this.busy = true;
    let connection;
    try {
      const info =
        (await this.listPorts()).find((item) => item.path === port) ||
        fail('FIRMWARE_PORT_NOT_FOUND');
      connection = await this.connect(info);
      this.connection = connection;
      if (this.disposed) fail('FIRMWARE_STOPPED');
      const loader = connection.loader;
      await loader.detectChip();
      const chip = chipNames[loader.chip.CHIP_NAME] || fail('FIRMWARE_CHIP_UNSUPPORTED');
      const security = await loader.getSecurityInfo(false);
      checkSecurity(security);
      const mac = await loader.chip.readMac(loader);
      // Espressif's USB OTG/CDC devices are not Serial/JTAG consoles. Refuse
      // an unbundled interface instead of installing an image that loses USB.
      const native = parseInt(info.vendorId, 16) === 0x303a;
      if (native && parseInt(info.productId, 16) !== 0x1001) fail('FIRMWARE_USB_UNSUPPORTED');
      const consoleMode = native ? 'usb' : 'uart';
      const image = this.manifest().images.find((item) => item.id === chip + '-' + consoleMode);
      if (!image) fail('FIRMWARE_IMAGE_MISSING');
      readImage(this.directory, image);
      const token = randomUUID(),
        ticket = {
          token,
          port,
          chip,
          mac,
          securityHash: hash(JSON.stringify(security)),
          imageId: image.id,
          expiresAt: Date.now() + 120000,
        };
      for (const [id, entry] of this.tickets)
        if (entry.expiresAt < Date.now()) this.tickets.delete(id);
      if (this.tickets.size >= 16) this.tickets.clear();
      this.tickets.set(token, ticket);
      await loader.after('hard_reset');
      return {
        ...ticket,
        experimental: !!image.experimental,
        profile: image.profile,
        firmwareVersion: this.manifest().firmwareVersion,
        sha256: image.segments.map((item) => item.sha256),
      };
    } finally {
      await connection?.close();
      this.connection = null;
      this.busy = false;
    }
  }
  async flash(input) {
    if (this.disposed) fail('FIRMWARE_STOPPED');
    if (this.busy) fail('FIRMWARE_BUSY');
    const ticket = this.tickets.get(input.token);
    this.tickets.delete(input.token);
    if (!ticket || ticket.expiresAt < Date.now() || input.confirmed !== true)
      fail('FIRMWARE_CONFIRMATION_REQUIRED');
    const image =
      this.manifest().images.find((item) => item.id === ticket.imageId) ||
      fail('FIRMWARE_IMAGE_MISSING');
    const files = readImage(this.directory, image);
    this.busy = true;
    this.job = {
      id: randomUUID(),
      port: ticket.port,
      chip: ticket.chip,
      imageId: image.id,
      stage: 'connecting',
      progress: 0,
      error: null,
      createdAt: Date.now(),
    };
    this.update({});
    this.task = this.perform(ticket, files)
      .catch((error) =>
        this.update({
          stage: 'failed',
          error: /^FIRMWARE_[A-Z_]+$/.test(error.message) ? error.message : 'FIRMWARE_WRITE_FAILED',
        }),
      )
      .finally(() => {
        this.busy = false;
        this.connection = null;
      });
    return this.status();
  }
  async perform(ticket, files) {
    const info =
      (await this.listPorts()).find((item) => item.path === ticket.port) ||
      fail('FIRMWARE_PORT_NOT_FOUND');
    const connection = await this.connect(info);
    this.connection = connection;
    try {
      if (this.disposed) fail('FIRMWARE_STOPPED');
      const loader = connection.loader;
      await loader.detectChip();
      const security = await loader.getSecurityInfo(false);
      checkSecurity(security);
      if (
        chipNames[loader.chip.CHIP_NAME] !== ticket.chip ||
        (await loader.chip.readMac(loader)) !== ticket.mac ||
        hash(JSON.stringify(security)) !== ticket.securityHash
      )
        fail('FIRMWARE_DEVICE_CHANGED');
      this.update({ stage: 'writing' });
      await loader.chip.postConnect?.(loader);
      await loader.runStub();
      if (this.disposed) fail('FIRMWARE_STOPPED');
      if (loader.flashSizeBytes(await loader.detectFlashSize()) < 4 * 1024 * 1024)
        fail('FIRMWARE_FLASH_TOO_SMALL');
      const total = files.reduce((sum, file) => sum + file.data.length, 0);
      await loader.writeFlash({
        fileArray: files,
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'detect',
        eraseAll: false,
        compress: true,
        reportProgress: (index, written, size) => {
          const before = files.slice(0, index).reduce((sum, file) => sum + file.data.length, 0);
          this.update({
            progress: Math.min(
              99,
              Math.floor(
                ((before + files[index].data.length * Math.min(1, written / size)) / total) * 100,
              ),
            ),
          });
        },
        calculateMD5Hash: (bytes) => createHash('md5').update(bytes).digest('hex'),
      });
      this.update({ stage: 'resetting', progress: 99 });
      await loader.after('hard_reset');
      this.update({ stage: 'completed', progress: 100, verified: true });
    } finally {
      await connection.close();
    }
  }
  async request(action, input = {}) {
    if (this.disposed) fail('FIRMWARE_STOPPED');
    if (action === 'sources') {
      const source = path.resolve(this.directory, '../../IoT-Firmware/CIBYP-TRNG'),
        zip = new (require('adm-zip'))();
      const base = fs.realpathSync(source);
      for (const file of require('./source-files.json')) {
        const target = path.join(base, file),
          real = fs.realpathSync(target);
        if (
          !real.startsWith(base + path.sep) ||
          fs.lstatSync(target).isSymbolicLink() ||
          !fs.lstatSync(target).isFile() ||
          fs.statSync(target).size > 1024 * 1024
        )
          fail('FIRMWARE_SOURCE_INVALID');
        zip.addFile('CIBYP-TRNG/' + file, fs.readFileSync(target));
      }
      zip.addFile(
        'CIBYP-TRNG/resources/tarot-art.bin',
        readArtArchive(this.directory, this.manifest()),
      );
      return { name: 'CIBYP-TRNG-Rust-IDF.zip', base64: zip.toBuffer().toString('base64') };
    }
    if (action === 'list')
      return { ports: await this.listPorts(), firmware: this.manifest(), job: this.status() };
    if (action === 'status') return this.status();
    if (action === 'network') {
      if (this.busy) fail('FIRMWARE_BUSY');
      this.busy = true;
      try {
        if (!(await this.listPorts()).some((info) => info.path === input.port))
          fail('FIRMWARE_PORT_NOT_FOUND');
        const value = await require('./device-protocol').readDeviceCommand({
          path: input.port,
          command: 'NETWORK',
          accept: (reply) =>
            reply.network === true &&
            /^(?:[a-f0-9]{2}){1,32}$/.test(reply.ssidHex) &&
            /^(?:[a-f0-9]{2}){0,63}$/.test(reply.passwordHex) &&
            (reply.passwordHex.length >= 16 || reply.setupRequired === true) &&
            /^[a-f0-9]{32}$/.test(reply.adminToken),
        });
        return {
          url: 'http://192.168.4.1',
          ssid: Buffer.from(value.ssidHex, 'hex').toString('utf8'),
          password: Buffer.from(value.passwordHex, 'hex').toString('ascii'),
          adminToken: value.adminToken,
          restartRequired: !!value.restartRequired,
          setupRequired: !!value.setupRequired,
        };
      } finally {
        this.busy = false;
      }
    }
    if (action === 'inspect') return this.inspect(input.port);
    if (action === 'flash') return this.flash(input);
    fail('FIRMWARE_ACTION_UNSUPPORTED');
  }
  dispose() {
    this.disposed = true;
    void this.connection?.close();
  }
}
module.exports = { FirmwareService, readImage, checkSecurity, readArtArchive };
