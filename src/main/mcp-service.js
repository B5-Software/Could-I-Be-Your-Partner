/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * MCP（Model Context Protocol）stdio JSONRPC 客户端与 IPC 服务。
 * 通过工厂函数注入 settings 访问器、持久化函数与版本号。
 */

'use strict';

module.exports = function registerMcpIpc({ ipcMain, getSettings, persist, appVersion }) {
const mcpServers = new Map(); // name -> { process, transport, status }

function getMcpSettings() {
  const mcp = getSettings().mcp || {};
  if (!Array.isArray(mcp.servers)) mcp.servers = [];
  return mcp;
}

function saveMcpSettings(mcpSettings) {
  getSettings().mcp = mcpSettings;
  persist();
}

async function startMcpServer(serverConfig) {
  const { name, command, args, env, cwd } = serverConfig;
  try {
    const { spawn } = require('child_process');
    const childProcess = spawn(command, args || [], {
      env: { ...process.env, ...(env || {}) },
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    const serverEntry = {
      process: childProcess,
      config: serverConfig,
      status: 'connecting',
      tools: [],
      pendingRequests: new Map(),
      requestId: 1,
      buffer: '',
    };

    // JSONRPC over stdio
    childProcess.stdout.on('data', (data) => {
      serverEntry.buffer += data.toString();
      processJsonRpcBuffer(name, serverEntry);
    });

    childProcess.stderr.on('data', (data) => {
      console.error(`[MCP:${name}] stderr: ${data.toString()}`);
    });

    childProcess.on('close', (code) => {
      console.log(`[MCP:${name}] process exited with code ${code}`);
      serverEntry.status = 'disconnected';
      mcpServers.delete(name);
    });

    childProcess.on('error', (err) => {
      console.error(`[MCP:${name}] process error: ${err.message}`);
      serverEntry.status = 'error';
    });

    mcpServers.set(name, serverEntry);

    // Send initialize request
    await sendMcpRequest(name, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Could-I-Be-Your-Partner', version: appVersion }
    });

    // Send initialized notification
    sendMcpNotification(name, 'notifications/initialized', {});

    // List tools
    const toolsResult = await sendMcpRequest(name, 'tools/list', {});
    if (toolsResult && toolsResult.tools) {
      serverEntry.tools = toolsResult.tools;
    }
    serverEntry.status = 'connected';

    return { ok: true, tools: serverEntry.tools };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sendMcpRequest(serverName, method, params) {
  const server = mcpServers.get(serverName);
  if (!server || !server.process || server.process.killed) {
    return Promise.reject(new Error(`MCP server "${serverName}" is not running`));
  }

  return new Promise((resolve, reject) => {
    const id = server.requestId++;
    const request = { jsonrpc: '2.0', id, method, params };

    server.pendingRequests.set(id, { resolve, reject, timeout: setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`Request ${method} timed out`));
    }, 30000) });

    try {
      const msg = JSON.stringify(request);
      server.process.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
    } catch (e) {
      server.pendingRequests.delete(id);
      reject(e);
    }
  });
}

function sendMcpNotification(serverName, method, params) {
  const server = mcpServers.get(serverName);
  if (!server || !server.process || server.process.killed) return;
  try {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
    server.process.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
  } catch (e) {
    console.error(`[MCP:${serverName}] notification error: ${e.message}`);
  }
}

function processJsonRpcBuffer(serverName, serverEntry) {
  while (true) {
    const headerEnd = serverEntry.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = serverEntry.buffer.substring(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Try to find JSON directly (some servers don't send headers)
      try {
        const jsonStart = serverEntry.buffer.indexOf('{');
        if (jsonStart === -1) break;
        const jsonEnd = findJsonEnd(serverEntry.buffer, jsonStart);
        if (jsonEnd === -1) break;
        const jsonStr = serverEntry.buffer.substring(jsonStart, jsonEnd + 1);
        serverEntry.buffer = serverEntry.buffer.substring(jsonEnd + 1);
        handleMcpResponse(serverName, JSON.parse(jsonStr));
        continue;
      } catch {
        break;
      }
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (serverEntry.buffer.length < bodyStart + contentLength) break;

    const body = serverEntry.buffer.substring(bodyStart, bodyStart + contentLength);
    serverEntry.buffer = serverEntry.buffer.substring(bodyStart + contentLength);

    try {
      handleMcpResponse(serverName, JSON.parse(body));
    } catch (e) {
      console.error(`[MCP:${serverName}] parse error: ${e.message}`);
    }
  }
}

function findJsonEnd(str, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function handleMcpResponse(serverName, msg) {
  const server = mcpServers.get(serverName);
  if (!server) return;

  if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
    const pending = server.pendingRequests.get(msg.id);
    server.pendingRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
}

async function stopMcpServer(serverName) {
  const server = mcpServers.get(serverName);
  if (!server) return;
  try {
    if (server.process && !server.process.killed) {
      server.process.kill();
    }
  } catch (e) {
    console.error(`[MCP:${serverName}] stop error: ${e.message}`);
  }
  mcpServers.delete(serverName);
}

// 退出前批量停止所有 MCP 服务器
async function stopAllMcpServers() {
  const names = [...mcpServers.keys()];
  for (const name of names) {
    await stopMcpServer(name);
  }
}

// MCP IPC handlers
ipcMain.handle('mcp:listServers', () => {
  const mcpSettings = getMcpSettings();
  return mcpSettings.servers.map(s => ({
    ...s,
    status: mcpServers.has(s.name) ? mcpServers.get(s.name).status : 'disconnected',
    toolCount: mcpServers.has(s.name) ? mcpServers.get(s.name).tools.length : 0,
  }));
});

ipcMain.handle('mcp:addServer', async (_, serverConfig) => {
  const mcpSettings = getMcpSettings();
  // Validate
  if (!serverConfig.name || !serverConfig.command) {
    return { ok: false, error: '名称和命令不能为空' };
  }
  if (mcpSettings.servers.find(s => s.name === serverConfig.name)) {
    return { ok: false, error: '同名服务器已存在' };
  }
  mcpSettings.servers.push(serverConfig);
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:removeServer', async (_, name) => {
  await stopMcpServer(name);
  const mcpSettings = getMcpSettings();
  mcpSettings.servers = mcpSettings.servers.filter(s => s.name !== name);
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:updateServer', async (_, name, updates) => {
  const mcpSettings = getMcpSettings();
  const idx = mcpSettings.servers.findIndex(s => s.name === name);
  if (idx === -1) return { ok: false, error: '服务器不存在' };
  mcpSettings.servers[idx] = { ...mcpSettings.servers[idx], ...updates };
  saveMcpSettings(mcpSettings);
  return { ok: true };
});

ipcMain.handle('mcp:connect', async (_, name) => {
  const mcpSettings = getMcpSettings();
  const config = mcpSettings.servers.find(s => s.name === name);
  if (!config) return { ok: false, error: '服务器不存在' };
  if (mcpServers.has(name)) await stopMcpServer(name);
  return await startMcpServer(config);
});

ipcMain.handle('mcp:disconnect', async (_, name) => {
  await stopMcpServer(name);
  return { ok: true };
});

ipcMain.handle('mcp:listTools', async (_, serverName) => {
  if (serverName) {
    const server = mcpServers.get(serverName);
    if (!server) return { ok: false, error: '服务器未连接' };
    return { ok: true, tools: server.tools, serverName };
  }
  // List all tools across all servers
  const allTools = [];
  for (const [name, server] of mcpServers) {
    if (server.status === 'connected') {
      for (const tool of server.tools) {
        allTools.push({ ...tool, serverName: name });
      }
    }
  }
  return { ok: true, tools: allTools };
});

ipcMain.handle('mcp:callTool', async (_, serverName, toolName, args) => {
  const server = mcpServers.get(serverName);
  if (!server || server.status !== 'connected') {
    return { ok: false, error: `MCP 服务器 "${serverName}" 未连接` };
  }
  try {
    const result = await sendMcpRequest(serverName, 'tools/call', { name: toolName, arguments: args || {} });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('mcp:getStatus', () => {
  const statuses = {};
  for (const [name, server] of mcpServers) {
    statuses[name] = { status: server.status, tools: server.tools.length };
  }
  return statuses;
});

  return { getMcpSettings, startMcpServer, stopMcpServer, stopAllMcpServers };
};
