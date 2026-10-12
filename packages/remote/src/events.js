/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
const { randomUUID } = require('node:crypto');
const { publicValue, RemoteError } = require('./contract');
class EventLog {
  constructor({ maximum = 512, maxBytes = 1048576 } = {}) {
    this.streamId = randomUUID();
    this.sequence = 0;
    this.events = [];
    this.bytes = 0;
    this.maximum = maximum;
    this.maxBytes = maxBytes;
    this.listeners = new Set();
  }
  cursor() {
    return { streamId: this.streamId, sequence: this.sequence };
  }
  publish(channel, payload) {
    const event = {
      type: 'event',
      ...this.cursor(),
      sequence: ++this.sequence,
      channel,
      payload: publicValue(payload),
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes <= this.maxBytes) {
      this.events.push({ event, bytes });
      this.bytes += bytes;
    }
    while (this.events.length > this.maximum || this.bytes > this.maxBytes)
      this.bytes -= this.events.shift().bytes;
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* Listener cannot break the owner. */
      }
    }
    return event;
  }
  replay(cursor) {
    if (!cursor) return [];
    if (
      cursor.streamId !== this.streamId ||
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence > this.sequence ||
      cursor.sequence < 0 ||
      (this.events.length && cursor.sequence < this.events[0].event.sequence - 1) ||
      (!this.events.length && cursor.sequence !== this.sequence)
    )
      throw new RemoteError('RESYNC_REQUIRED');
    const events = this.events
      .filter(({ event }) => event.sequence > cursor.sequence)
      .map(({ event }) => event);
    // A non-retained oversized event creates a gap even inside the replay window.
    if (
      events.some((v, i) => v.sequence !== cursor.sequence + i + 1) ||
      events.length !== this.sequence - cursor.sequence
    )
      throw new RemoteError('RESYNC_REQUIRED');
    return events;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
module.exports = { EventLog };
