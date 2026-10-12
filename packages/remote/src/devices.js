/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { RemoteError, identifier, record, publicValue } = require("./contract");
const { decodeFrame } = require("./frame");
const { atomic, read } = require("./store");
const digest = (token) => createHash("sha256").update(token).digest("hex");
class DeviceGateway {
  constructor({
    file,
    tools,
    events,
    bootId = randomUUID(),
    instanceId = bootId,
  } = {}) {
    this.file = file;
    this.tools = tools;
    this.events = events;
    this.bootId = bootId;
    this.instanceId = instanceId;
    this.devices = new Map(read(file, []));
    this.connections = new Map();
  }
  save() {
    atomic(this.file, [...this.devices]);
  }
  validatePolicy(policy) {
    if (
      !record(policy) ||
      !record(policy.tools) ||
      Object.keys(policy.tools).length > 16 ||
      JSON.stringify(policy).length > 8192
    )
      throw new RemoteError("INVALID_PARAMS");
    for (const [name, grant] of Object.entries(policy.tools)) {
      identifier(name);
      if (
        !record(grant) ||
        !Array.isArray(grant.resources) ||
        !grant.resources.length ||
        grant.resources.length > 64 ||
        (grant.write !== undefined && typeof grant.write !== "boolean") ||
        (grant.timeoutMs !== undefined &&
          (!Number.isSafeInteger(grant.timeoutMs) ||
            grant.timeoutMs < 1 ||
            grant.timeoutMs > 30000))
      )
        throw new RemoteError("INVALID_PARAMS");
      grant.resources.forEach((value) => identifier(value));
    }
  }
  list() {
    return [...this.devices]
      .filter(([, d]) => !d.revoked)
      .map(([id, d]) => ({
        id,
        label: d.label,
        policy: d.policy,
        online: this.connections.has(id),
        bootId: this.connections.get(id)?.bootId || null,
      }));
  }
  provision({ deviceId, label = deviceId, policy = {} }) {
    identifier(deviceId, "deviceId");
    if (this.devices.has(deviceId) && !this.devices.get(deviceId).revoked)
      throw new RemoteError(
        "REVISION_CONFLICT",
        "Device already paired; revoke it before provisioning again",
      );
    this.validatePolicy(policy);
    if (this.devices.size >= 128 && !this.devices.has(deviceId))
      throw new RemoteError("RESOURCE_BUSY");
    const deviceToken = randomBytes(32).toString("hex");
    this.devices.set(deviceId, {
      label: String(label).slice(0, 80),
      tokenHash: digest(deviceToken),
      policy,
      sequence: this.devices.get(deviceId)?.sequence || 0,
    });
    this.save();
    return { deviceId, deviceToken }; // Returned only to an authenticated device administrator.
  }
  revoke(deviceId) {
    identifier(deviceId);
    const device = this.devices.get(deviceId);
    if (device) {
      device.revoked = true;
      device.tokenHash = null;
    }
    this.save();
    this.connections.get(deviceId)?.socket.close(1008, "Device revoked");
    return { revoked: true };
  }
  setPolicy(deviceId, policy) {
    identifier(deviceId);
    this.validatePolicy(policy);
    const device = this.devices.get(deviceId);
    if (!device || device.revoked)
      throw new RemoteError("INVALID_PARAMS", "Unknown device");
    device.policy = policy;
    this.save();
    const connection = this.connections.get(deviceId);
    if (connection) {
      connection.ready = false;
      for (const dispose of connection.dispose.splice(0)) dispose();
      connection.socket.close(1012, "Device permissions changed");
    }
    this.events?.publish("devices.changed", {
      deviceId,
      permissionsChanged: true,
    });
    return { updated: true };
  }
  authenticate(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = digest(token);
    for (const [id, value] of this.devices)
      if (value.tokenHash === hash) return { id, device: value };
    return null;
  }
  attach(service) {
    service.register("device.list", "devices.read", () => this.list());
    service.register("device.page", "devices.read", (p) => {
      const offset = p.offset ?? 0,
        limit = p.limit ?? 20;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 32
      )
        throw new RemoteError("INVALID_PARAMS");
      const all = this.list(),
        items = all
          .slice(offset, offset + limit)
          .map(({ policy, ...value }) => ({
            ...value,
            toolCount: Object.keys(policy.tools || {}).length,
          }));
      return {
        items,
        total: all.length,
        nextOffset:
          offset + items.length < all.length ? offset + items.length : null,
      };
    });
    service.register("device.get", "devices.read", (p) => {
      const id = identifier(p.deviceId),
        value = this.list().find((device) => device.id === id);
      if (!value) throw new RemoteError("INVALID_PARAMS", "Unknown device");
      return value;
    });
    service.register(
      "device.provision",
      "devices.manage",
      (p) => this.provision(p),
      {
        write: true,
        raw: true,
      },
    );
    service.register(
      "device.revoke",
      "devices.manage",
      (p) => this.revoke(p.deviceId),
      {
        write: true,
      },
    );
    service.register(
      "device.setPolicy",
      "devices.manage",
      (p) => this.setPolicy(p.deviceId, p.policy),
      { write: true },
    );
  }
  accept(socket, token) {
    const identity = this.authenticate(token);
    if (!identity) {
      socket.close(1008, "Device authentication required");
      return;
    }
    const connection = {
      socket,
      pending: new Map(),
      dispose: [],
      identity,
      ready: false,
      bootId: null,
      lastSeen: performance.now(),
    };
    const helloTimer = setTimeout(
      () => socket.close(1008, "Device hello required"),
      5000,
    );
    const timer = setInterval(() => {
      if (performance.now() - connection.lastSeen > 45000) socket.terminate();
      else socket.ping();
    }, 15000);
    timer.unref?.();
    socket.on("pong", () => {
      connection.lastSeen = performance.now();
    });
    socket.on("message", (data) => {
      connection.lastSeen = performance.now();
      try {
        const value = decodeFrame(data, 4096);
        if (!connection.ready) {
          if (
            value.jsonrpc !== "2.0" ||
            value.method !== "device.hello" ||
            value.params?.deviceId !== identity.id ||
            !Array.isArray(value.params.tools) ||
            value.params.tools.length > 16
          )
            throw new RemoteError("INVALID_PARAMS", "Invalid device hello");
          identifier(value.id);
          identifier(value.params.bootId);
          const previous = this.connections.get(identity.id);
          if (previous) {
            previous.ready = false;
            for (const dispose of previous.dispose.splice(0)) dispose();
            previous.socket.close(1008, "Device reconnected");
          }
          connection.bootId = value.params.bootId;
          const registrations = [];
          try {
            for (const supplied of value.params.tools) {
              identifier(supplied.name, "tool name");
              const grant = identity.device.policy.tools?.[supplied.name];
              if (
                !grant ||
                !Array.isArray(grant.resources) ||
                !grant.resources.length
              )
                continue;
              const name = `micro__${identity.id}__${supplied.name}`;
              const manifest = {
                name,
                description: String(
                  supplied.description || supplied.name,
                ).slice(0, 500),
                version: String(supplied.version || "1").slice(0, 30),
                inputSchema: supplied.inputSchema,
                target: "device",
                deviceId: identity.id,
                execution: {
                  requiresLease: grant.write === true,
                  timeoutMs: Math.min(30000, grant.timeoutMs || 5000),
                  maxResultBytes: 2048,
                },
              };
              registrations.push(
                this.tools.register(
                  manifest,
                  (input, context) =>
                    this.call(connection, supplied.name, input, context),
                  {
                    allow: (input) =>
                      !identity.device.revoked &&
                      this.connections.get(identity.id) === connection &&
                      grant.resources.includes(input.resource),
                  },
                ),
              );
            }
          } catch (error) {
            for (const dispose of registrations) dispose();
            throw error;
          }
          connection.dispose = registrations;
          connection.ready = true;
          this.connections.set(identity.id, connection);
          clearTimeout(helloTimer);
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: value.id,
              result: {
                gatewayBootId: this.bootId,
                maxMessageBytes: 4096,
                heartbeatMs: 15000,
              },
            }),
          );
          this.events?.publish("devices.changed", {
            deviceId: identity.id,
            online: true,
            bootId: connection.bootId,
          });
          return;
        }
        if (
          value.jsonrpc === "2.0" &&
          typeof value.id === "string" &&
          (Object.hasOwn(value, "result") || value.error)
        ) {
          const item = connection.pending.get(value.id);
          if (!item) return;
          connection.pending.delete(value.id);
          item.cleanup();
          if (value.error)
            item.reject(
              new RemoteError(
                value.error.data?.reason || "DEVICE_ERROR",
                "Device rejected the operation",
                value.error.data,
              ),
            );
          else item.resolve(publicValue(value.result));
        } else if (value.type === "telemetry" && record(value.payload)) {
          // Unsolicited telemetry is coalesced and never treated as a tool completion.
          if (
            !connection.telemetryAt ||
            performance.now() - connection.telemetryAt >= 1000
          ) {
            connection.telemetryAt = performance.now();
            this.events?.publish("device.telemetry", {
              deviceId: identity.id,
              payload: value.payload,
            });
          }
        } else throw new RemoteError("INVALID_REQUEST");
      } catch {
        socket.close(1008, "Invalid device message");
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(timer);
      for (const dispose of connection.dispose) dispose();
      for (const pending of connection.pending.values()) {
        pending.cleanup();
        pending.reject(
          new RemoteError(
            "RESULT_UNKNOWN",
            "Device disconnected before acknowledging the action",
          ),
        );
      }
      connection.pending.clear();
      if (this.connections.get(identity.id) === connection) {
        this.connections.delete(identity.id);
        this.events?.publish("devices.changed", {
          deviceId: identity.id,
          online: false,
        });
      }
    });
  }
  call(connection, name, input, context) {
    if (!connection.ready || connection.socket.readyState !== 1)
      throw new RemoteError("DEVICE_OFFLINE");
    if (connection.pending.size)
      throw new RemoteError("RESOURCE_BUSY", "Device has an in-flight action");
    context.signal.throwIfAborted();
    const device = connection.identity.device;
    if ((device.sequence || 0) >= 2147483646)
      throw new RemoteError(
        "RESOURCE_BUSY",
        "Device sequence exhausted; manual re-provisioning required",
      );
    device.sequence = (device.sequence || 0) + 1;
    this.save();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        connection.pending.delete(id);
        reject(
          new RemoteError(
            "RESULT_UNKNOWN",
            "Action acknowledgement deadline exceeded",
            {
              operationId: context.operationId,
            },
          ),
        );
      };
      context.signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => context.signal.removeEventListener("abort", abort);
      connection.pending.set(id, { resolve, reject, cleanup });
      const operationId = digest(
        context.principal.id + "\0" + context.operationId,
      );
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tool.invoke",
        params: {
          name,
          input,
          operationId,
          deviceSequence: device.sequence,
          gatewayId: this.instanceId,
          remainingMs: context.remainingMs,
          gatewayBootId: this.bootId,
          generation: context.lease?.generation || 0,
          leaseId: context.lease?.id || "",
        },
      });
      if (Buffer.byteLength(body) > 4096) {
        connection.pending.delete(id);
        cleanup();
        reject(new RemoteError("PAYLOAD_TOO_LARGE"));
        return;
      }
      connection.socket.send(body, (error) => {
        if (error) {
          connection.pending.delete(id);
          cleanup();
          reject(new RemoteError("RESULT_UNKNOWN", "Device transport failed"));
        }
      });
    });
  }
  close() {
    for (const c of this.connections.values())
      c.socket.close(1001, "Gateway stopping");
  }
}
module.exports = { DeviceGateway };
