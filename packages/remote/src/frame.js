/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const { RemoteError, bounded } = require("./contract");
// ws 7 delivers text as strings; ws 8 delivers Buffer. Check bytes before decoding.
function decodeFrame(data, maximum) {
  let bytes;
  if (typeof data === "string") {
    if (Buffer.byteLength(data, "utf8") > maximum)
      throw new RemoteError("PAYLOAD_TOO_LARGE");
    bytes = Buffer.from(data, "utf8");
  } else if (Array.isArray(data)) {
    let length = 0;
    for (const part of data) {
      if (!Buffer.isBuffer(part)) throw new RemoteError("INVALID_REQUEST");
      length += part.length;
      if (length > maximum) throw new RemoteError("PAYLOAD_TOO_LARGE");
    }
    bytes = Buffer.concat(data, length);
  } else if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maximum) throw new RemoteError("PAYLOAD_TOO_LARGE");
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    if (data.byteLength > maximum) throw new RemoteError("PAYLOAD_TOO_LARGE");
    bytes = new Uint8Array(data);
  } else throw new RemoteError("INVALID_REQUEST");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  bounded(value);
  return value;
}
module.exports = { decodeFrame };
