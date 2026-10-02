/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * WebUI 的无头驱动：把 WebUI 的命令（发消息 / 停止 / 审批 / 新会话 / 加载历史）
 * 直接接到 Agent 运行时，并把运行时事件回流成 WebUI 既有 push 协议
 * （message / status / toolCall / approval / title / messagesSync ...）。
 *
 * 这样 WebUI 不再依赖"某个开着的 GUI 窗口"，可以独立支撑整个对话闭环；
 * GUI 在线时仍走原来的遥控路径（见 ipc/web-control.js 的驱动选择）。
 *
 * 模式（chat/babe/code）与历史通道由运行时统一分流，驱动只做协议映射。
 */

'use strict';

const { MODES } = require('./agent-runtime.js');

/** 运行时事件 → WebUI push 协议的映射。 */
function attachWebUiAgentDriver({ webControlService, agentRuntime, log = console }) {
  if (!webControlService)
    throw new TypeError('attachWebUiAgentDriver: webControlService is required');
  if (!agentRuntime) throw new TypeError('attachWebUiAgentDriver: agentRuntime is required');

  let activeKey = null;
  let currentMode = 'chat';

  function ensureSession(mode) {
    const wanted = MODES.includes(mode) ? mode : currentMode;
    if (activeKey && agentRuntime.getSession(activeKey) && wanted === currentMode) return activeKey;
    currentMode = wanted;
    activeKey = `webui:${currentMode}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    agentRuntime.createSession({ key: activeKey, mode: currentMode });
    webControlService.pushConversationSwitch(activeKey);
    return activeKey;
  }

  function handleRuntimeEvent(event) {
    try {
      switch (event.type) {
        case 'message':
          webControlService.pushMessage(event.role, event.content);
          break;
        case 'status':
          webControlService.pushStatus(event.status);
          break;
        case 'tool-call':
          webControlService.pushToolCall(event.name, event.args, event.status, event.result);
          break;
        case 'interaction':
          if (event.kind === 'approval') {
            webControlService.pushApproval(event.payload.toolName, event.payload.args);
          } else if (event.kind === 'tool-auth') {
            webControlService.pushMessage(
              'system',
              `工具 ${event.payload.toolName}（${event.payload.category}）请求首次使用授权，可在弹窗中选择允许/拒绝`,
            );
            webControlService.pushApproval(event.payload.toolName, {
              category: event.payload.category,
              toolAuth: true,
            });
          } else if (event.kind === 'questions') {
            webControlService.pushMessage(
              'system',
              `AI 向你提问：${JSON.stringify(event.payload.questions)}`,
            );
          }
          break;
        case 'interaction-resolved':
          webControlService.clearApproval();
          break;
        case 'title':
          webControlService.pushTitle(event.title);
          break;
        case 'affection-change':
          webControlService.pushMessage(
            'system',
            `好感度 ${event.data && event.data.delta > 0 ? '+' : ''}${(event.data && event.data.delta) || 0} → ${(event.data && event.data.value) || 0}`,
          );
          break;
        case 'tarot':
          if (event.data) webControlService.pushTarot(event.data);
          break;
        case 'present-file':
          webControlService.pushMessage(
            'assistant',
            `已呈现文件：${(event.data && (event.data.title || event.data.path)) || ''}`,
          );
          break;
        case 'stream-start':
        case 'stream-chunk':
        case 'stream-end':
          // 流式过程由 message/toolCall 事件聚合展示（WebUI 无逐 token 渲染区）
          break;
        default:
          break;
      }
    } catch (error) {
      log.warn?.(`[webui-driver] push failed: ${error.message}`);
    }
  }

  const offEvents = agentRuntime.onEvent(handleRuntimeEvent);

  // ---- 命令侧：WebUI → Agent 运行时 ----
  const previous = {
    onNewChat: webControlService.onNewChat,
    onSendMessage: webControlService.onSendMessage,
    onStopAgent: webControlService.onStopAgent,
    onApprovalResponse: webControlService.onApprovalResponse,
    onGetHistory: webControlService.onGetHistory,
    onGetConversation: webControlService.onGetConversation,
    onDeleteConversation: webControlService.onDeleteConversation,
    onLoadConversation: webControlService.onLoadConversation,
    onGetStatus: webControlService.onGetStatus,
    onSwitchMode: webControlService.onSwitchMode,
    onReoptimizeTools: webControlService.onReoptimizeTools,
    onGetSettings: webControlService.onGetSettings,
  };

  webControlService.onNewChat = async () => {
    activeKey = null;
    return ensureSession(currentMode);
  };

  webControlService.onSendMessage = (message) => {
    const key = ensureSession(currentMode);
    // 不阻塞 HTTP/WS 响应：整轮 Agent 循环在后台跑，事件流实时推送
    agentRuntime.sendMessage(key, message).catch((error) => {
      log.warn?.(`[webui-driver] sendMessage failed: ${error.message}`);
      webControlService.pushMessage('system', `[错误] ${error.message}`);
    });
    return key;
  };

  webControlService.onStopAgent = () => {
    if (activeKey) agentRuntime.stop(activeKey);
  };

  webControlService.onApprovalResponse = (approved) => {
    if (activeKey) agentRuntime.respond(activeKey, !!approved);
  };

  webControlService.onGetHistory = async () => {
    try {
      return (await agentRuntime.listHistory(currentMode)) || [];
    } catch (error) {
      log.warn?.(`[webui-driver] listHistory failed: ${error.message}`);
      return [];
    }
  };

  webControlService.onGetConversation = async (id) => {
    try {
      return await agentRuntime.getHistory(currentMode, id);
    } catch (error) {
      log.warn?.(`[webui-driver] getHistory failed: ${error.message}`);
      return null;
    }
  };

  webControlService.onDeleteConversation = async (id) => {
    await agentRuntime.deleteHistory(currentMode, id);
  };

  webControlService.onLoadConversation = async (id) => {
    try {
      const key = ensureSession(currentMode);
      const loaded = await agentRuntime.openHistory(key, id);
      if (!loaded || loaded.ok === false) return;
      webControlService.pushConversationSwitch(id);
      webControlService.pushHistoryMessages(loaded.messages || []);
      webControlService.pushTitle(loaded.title || '');
    } catch (error) {
      log.warn?.(`[webui-driver] loadConversation failed: ${error.message}`);
    }
  };

  webControlService.onGetStatus = () => {
    const session = activeKey ? agentRuntime.getSession(activeKey) : null;
    return {
      agentStatus: session ? session.status : 'idle',
      running: session ? session.busy : false,
      conversationId: activeKey,
      title: session ? session.title : '',
      workspacePath: session ? session.workspacePath : null,
      mode: currentMode,
    };
  };

  // 无头环境没有 GUI 可遥控：模式切换在运行时侧生效（新建该模式的会话）
  webControlService.onSwitchMode = (mode) => {
    const wanted = MODES.includes(mode) ? mode : 'chat';
    if (activeKey && agentRuntime.getSession(activeKey)) {
      agentRuntime.close(activeKey);
    }
    activeKey = null;
    ensureSession(wanted);
    webControlService.pushModeSwitch(wanted);
  };

  webControlService.onReoptimizeTools = () => {
    webControlService.pushMessage('system', '无头运行环境：工具选择优化由会话内自动进行');
  };

  return {
    get activeSessionKey() {
      return activeKey;
    },
    get mode() {
      return currentMode;
    },
    detach() {
      offEvents();
      for (const [name, fn] of Object.entries(previous)) {
        webControlService[name] = fn;
      }
    },
  };
}

module.exports = { attachWebUiAgentDriver };
