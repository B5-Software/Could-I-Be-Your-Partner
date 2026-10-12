/* SPDX-License-Identifier: GPL-3.0-or-later */
"use strict";
const {
  PROTOCOL,
  RemoteError,
  errorResponse,
  requireScope,
} = require("./contract");
const { decodeFrame } = require("./frame");
function mountRemote(
  app,
  { service, authenticate, validOrigin = () => true, devices, parseBinary },
) {
  app.get("/.well-known/cibyp-remote", (_req, res) =>
    res.json({
      service: "cibyp-remote",
      protocols: [1, PROTOCOL.major],
      authentication: ["bearer", "cookie"],
    }),
  );
  app.post("/remote/v2/rpc", async (req, res) => {
    const principal = authenticate(req);
    if (!principal)
      return res
        .status(401)
        .json(errorResponse(req.body?.id, new RemoteError("AUTH_REQUIRED")));
    if (!validOrigin(req))
      return res
        .status(403)
        .json(errorResponse(req.body?.id, new RemoteError("FORBIDDEN")));
    res.json(await service.handle(req.body, principal));
  });
  if (service.blobs && parseBinary) {
    const guard = (scope) => (req, res, next) => {
      try {
        req.remotePrincipal = authenticate(req);
        requireScope(req.remotePrincipal, scope);
        if (!validOrigin(req)) throw new RemoteError("FORBIDDEN");
        next();
      } catch (error) {
        res
          .status(error.data?.reason === "AUTH_REQUIRED" ? 401 : 403)
          .json(errorResponse(null, error));
      }
    };
    app.post(
      "/remote/v2/blobs",
      guard("files.write"),
      parseBinary,
      async (req, res) => {
        try {
          res.json(
            await service.blobs.upload(
              req.query,
              req.remotePrincipal,
              req.body,
            ),
          );
        } catch (error) {
          res.status(400).json(errorResponse(null, error));
        }
      },
    );
    app.get(
      "/remote/v2/blobs/:attachmentId",
      guard("files.read"),
      async (req, res) => {
        try {
          const value = await service.blobs.download(
            req.params,
            req.remotePrincipal,
          );
          res.setHeader(
            "Content-Disposition",
            "attachment; filename*=UTF-8''" +
              encodeURIComponent(value.name).replace(
                /['()*]/g,
                (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
              ),
          );
          res.setHeader("Cache-Control", "private, no-store");
          res.setHeader("X-CIBYP-SHA256", value.sha256);
          res.type("application/octet-stream").send(value.bytes);
        } catch (error) {
          res.status(400).json(errorResponse(null, error));
        }
      },
    );
  }
  app.ws("/remote/v2/events", (socket, req) => {
    const principal = authenticate(req);
    try {
      requireScope(principal, "events.read");
      if (!validOrigin(req)) throw new RemoteError("FORBIDDEN");
    } catch {
      socket.close(1008, "Authentication required");
      return;
    }
    let subscriptions = null;
    try {
      if (req.query.channels !== undefined) {
        subscriptions = JSON.parse(String(req.query.channels));
        if (
          !Array.isArray(subscriptions) ||
          subscriptions.length > 32 ||
          subscriptions.some((v) => typeof v !== "string" || v.length > 100)
        )
          throw new Error();
      }
    } catch {
      socket.close(1008, "Invalid subscription");
      return;
    }
    const send = (value) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 1048576)
        return socket.close(1013, "Resynchronize");
      socket.send(JSON.stringify(value));
    };
    const permitted = (e) => {
      const scope = /^(agent:|todo:)/.test(e.channel)
        ? "sessions.read"
        : /^settings:/.test(e.channel)
          ? "settings.read"
          : /^devices?\./.test(e.channel)
            ? "devices.read"
            : /^tools\./.test(e.channel)
              ? "tools.read"
              : "system.read";
      try {
        requireScope(principal, scope);
        return true;
      } catch {
        return false;
      }
    };
    const matches = (e) =>
      permitted(e) && (!subscriptions || subscriptions.includes(e.channel));
    const unsubscribe = service.events.subscribe((e) => {
      if (matches(e)) send(e);
    });
    try {
      const cursor = req.query.streamId
        ? {
            streamId: String(req.query.streamId),
            sequence: Number(req.query.after),
          }
        : null;
      for (const event of service.events.replay(cursor))
        if (matches(event)) send(event);
    } catch {
      send({
        type: "reset",
        reason: "RESYNC_REQUIRED",
        cursor: service.events.cursor(),
      });
    }
    send({ type: "connected", cursor: service.events.cursor() });
    socket.on("message", (data) => {
      try {
        const value = decodeFrame(data, 2048);
        if (
          value.type !== "subscribe" ||
          !Array.isArray(value.channels) ||
          value.channels.length > 32 ||
          value.channels.some((v) => typeof v !== "string" || v.length > 100)
        )
          throw new Error();
        subscriptions = value.channels;
      } catch {
        socket.close(1008, "Invalid subscription");
      }
    });
    const timer = setInterval(() => {
      const current = authenticate(req);
      if (
        !current ||
        current.id !== principal.id ||
        JSON.stringify(current.scopes) !== JSON.stringify(principal.scopes)
      )
        socket.close(1008, "Session expired");
    }, 15000);
    timer.unref?.();
    socket.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
    socket.on("error", () => {});
  });
  if (devices)
    app.ws("/remote/v2/devices", (socket, req) => {
      if (!validOrigin(req)) return socket.close(1008, "Untrusted origin");
      devices.accept(
        socket,
        String(req.headers.authorization || "").replace(/^Bearer /, ""),
      );
    });
}
module.exports = { mountRemote };
