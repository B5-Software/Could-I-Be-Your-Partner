export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Principal {
  id: string;
  scopes: string[];
}
export interface Cursor {
  streamId: string;
  sequence: number;
}
export interface Request {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: { [key: string]: Json };
}
export interface RpcError {
  code: number;
  message: string;
  data: { reason: string; retryable: boolean; [key: string]: Json };
}
export type Response<T = Json> = { jsonrpc: '2.0'; id: string | null } & (
  { result: T } | { error: RpcError }
);
export interface RemoteEvent {
  type: 'event';
  streamId: string;
  sequence: number;
  channel: string;
  payload: Json;
}
export interface ToolManifest {
  name: string;
  description?: string;
  version?: string;
  inputSchema: { [key: string]: Json };
  target?: 'host' | 'device';
  execution?: { requiresLease?: boolean; timeoutMs?: number; maxResultBytes?: number };
}
export class RemoteError extends Error {
  code: number;
  data: RpcError['data'];
  constructor(reason: string, message?: string, data?: object);
}
export class RemoteClient {
  subscribe(channels: string[]): void;
  constructor(options: {
    url: string;
    token?: string;
    fetchImpl?: typeof fetch;
    socketFactory?: (url: string, token: string) => WebSocket;
    onEvent?: (event: RemoteEvent | { type: string; [key: string]: unknown }) => void;
    channels?: string[];
  });
  call<T = Json>(
    method: string,
    params?: { [key: string]: Json },
    options?: { id?: string; signal?: AbortSignal },
  ): Promise<T>;
  connect(): Promise<{
    protocol: { major: number; minor: number };
    instanceId: string;
    bootId: string;
    cursor: Cursor;
    capabilities: string[];
  }>;
  upload(
    sessionId: string,
    name: string,
    bytes: Uint8Array,
    options?: { type?: string; operationId?: string },
  ): Promise<Json>;
  download(attachmentId: string): Promise<Uint8Array>;
  close(): void;
}
export class RemoteService {
  constructor(options?: object);
  register(
    name: string,
    scope: string,
    handler: (params: any, principal: Principal) => any,
    options?: { write?: boolean; raw?: boolean },
  ): this;
  handle(request: Request, principal: Principal): Promise<Response>;
  events: EventLog;
  operations: Operations;
  bootId: string;
  instanceId: string;
}
export class EventLog {
  constructor(options?: { maximum?: number; maxBytes?: number });
  cursor(): Cursor;
  publish(channel: string, payload: Json): RemoteEvent;
  replay(cursor?: Cursor): RemoteEvent[];
  subscribe(fn: (event: RemoteEvent) => void): () => void;
}
export class Operations {
  constructor(file?: string);
  run<T>(
    principal: string,
    id: string,
    method: string,
    params: object,
    execute: () => Promise<T> | T,
  ): Promise<T>;
  get(principal: string, id: string): object | null;
}
export class ToolRegistry {
  describe(name: string): ToolManifest;
  result(
    params: { resultId: string; offset?: number; limit?: number },
    principal: Principal,
  ): {
    encoding: 'json';
    resultId: string;
    sha256: string;
    offset: number;
    totalChars: number;
    text: string;
    nextOffset: number | null;
  };
  cancel(
    params: { targetOperationId: string },
    principal: Principal,
  ): { cancelRequested: boolean; state?: string };
  constructor(options?: { events?: EventLog });
  register(
    manifest: ToolManifest,
    execute: (
      input: any,
      context: {
        principal: Principal;
        operationId: string;
        signal: AbortSignal;
        remainingMs: number;
        lease?: { id: string; generation: number; until: number };
      },
    ) => any,
    policy?: { allow?: (input: any, principal: Principal) => boolean },
  ): () => void;
  list(params?: { offset?: number; limit?: number }): {
    items: ToolManifest[];
    revision: number;
    total: number;
    nextOffset: number | null;
  };
  acquire(
    resource: string,
    principal: Principal,
    durationMs?: number,
  ): { leaseId: string; generation: number; durationMs: number };
  release(resource: string, leaseId: string, principal: Principal): { released: true };
  invoke(params: object, principal: Principal): Promise<Json>;
  attach(service: RemoteService): void;
}
export class DeviceGateway {
  constructor(options: {
    tools: ToolRegistry;
    file?: string;
    events?: EventLog;
    bootId: string;
    instanceId?: string;
  });
  provision(params: { deviceId: string; label?: string; policy: object }): {
    deviceId: string;
    deviceToken: string;
  };
  list(): object[];
  setPolicy(id: string, policy: object): object;
  revoke(id: string): object;
  close(): void;
  attach(service: RemoteService): void;
}
export interface DeviceSummary {
  id: string;
  label: string;
  online: boolean;
  bootId: string | null;
  toolCount: number;
}
export interface DevicePage {
  items: DeviceSummary[];
  total: number;
  nextOffset: number | null;
}
export class Credentials {
  constructor(file?: string);
  issue(params: { scopes?: string[]; label?: string; durationMs?: number }): {
    id: string;
    accessToken: string;
    scopes: string[];
    expires: number;
  };
  authenticate(token: string): Principal | null;
  revoke(id: string): object;
}
export function publicValue<T>(value: T): Partial<T>;
