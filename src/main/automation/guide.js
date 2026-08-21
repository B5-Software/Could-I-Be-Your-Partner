/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * 自动化任务的机器可读指导（按需经 automationGetGuide 工具返回，
 * 不注入系统提示）。与 docs/automation.md 对应。
 */

'use strict';

const GUIDE = {
  trigger: `
## 触发器
- schedule（定时）：config.cron 为 5 段 cron（分 时 日 月 周）。支持 *、*/n、a-b、a,b,c。
  例：*/5 * * * *（每5分钟）、0 9 * * 1-5（工作日9点）、0 0 * * *（每天0点）。
- notification（系统通知）：config = { kind, titleRegex?, bodyRegex? }。
  kind ∈ any|sessionDone|sessionError|approval|other；标题/正文用 JS 正则匹配，留空不限制。
- http（专用信号服务器）：默认**禁用**，需在 设置 → 自动化 中开启并配置至少一个 Token
  后才启动（开启「允许无 Token 启动」可免 Token 运行，不安全）；监听 127.0.0.1:8765
  （settings.automation.serverPort 可改），POST /trigger/{taskId} 的 JSON 请求体进入 DSL
  的 args；必须携带 Authorization: Bearer <token>（timing-safe 校验，不支持 ?token=）。
  Token 可配置权限：scope（全部/指定任务，越权返回 403）、allowParams（false 时忽略
  请求体）、expiresAt（过期后 401）。GET /health 探活。`,
  dsl: `
## DSL 语法（图灵完备、沙箱 AST 解释器；最终 return 一个字符串作为提示词）
- 变量与控制流：let、赋值、+=/-=、if/else、while、for、break/continue、return
- 函数：fn name(a, b) { ... }（支持递归）
- 数据：数字、字符串（"\${expr}" 插值）、true/false/null、数组 [..]、对象 {k:v}
- 运算符：+ - * / %、== != < <= > >=、&& || ??、?:、!
- 异步：let r = await fetch(url, {timeout}); // r = { status, ok, text, json() }
- 全局入参：trigger = { kind, params, time, taskId }；args = 触发器参数
- 保护：最多 20 万步 / 10 秒，超限报错

## 标准库
str: len upper lower trim replace split join substr slice contains startsWith endsWith repeat
arr: len push pop shift unshift join slice reverse sort includes indexOf
num: abs round floor ceil min max toFixed
math: pow sqrt log exp random floor ceil round
time: now()（毫秒）、format(ts, "YYYY-MM-DD HH:mm:ss")
json: parse stringify
text: base64Encode base64Decode urlEncode urlDecode capitalize
uuid: v4()
env: get(name) has(name)（只读环境变量）
全局函数: keys values typeOf toNumber toString fetch`,
  examples: `
## 示例
1) HTTP 触发：
let title = "CI 事件：" + str.upper(args.event ?? "unknown");
return title + "\\n仓库=" + args.repo + "\\n参数键=" + arr.join(keys(args), ",");

2) 定时触发：
let t = time.format(time.now(), "YYYY-MM-DD HH:mm:ss");
return "现在是 " + t + "，请给我今天的开发简报。";

3) 通知触发：
if (trigger.kind == "notification") {
  return "会话刚结束，通知标题：" + args.notification.title + "。请做简短复盘。";
}
return "";`
};

GUIDE.http = `## HTTP 信号接口

启用 http 触发任务后，本机信号服务器提供以下端点：

### 端点
- GET  /health            → 健康检查（无需鉴权）
- POST /trigger/{taskId}  → 触发指定任务；请求体为任意 JSON，进入 DSL 的 args

仅监听 127.0.0.1，不对外网暴露。

### 鉴权
- 请求头：Authorization: Bearer <Token>（?token= 查询参数已废弃，恒 401）
- Token 在 设置 → 自动化 中配置，可设置 scope（限定可触发的任务列表）与 allowParams（false 时忽略请求体）
- allowNoToken 开启时无鉴权请求也放行 —— 不安全，仅应急使用

### 状态码
- 200 触发成功（响应含 accepted 与 sessionKey）
- 401 未授权 / 403 Token 无该任务权限 / 404 任务不存在或未启用 / 400 请求体非法 JSON

### 示例
curl -X POST http://127.0.0.1:<端口>/trigger/<taskId> \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"repo":"owner/app","event":"push"}'

完整文档见仓库 docs/automation.md。`;

const GUIDE_ALL = [
  '# 自动化任务（触发）指导',
  '',
  '任务被触发后，用 DSL 构造提示词并发送到 Chat 会话。投递模式（编辑器「投递」区）二选一：',
  '- 新建 Chat 会话（默认）：每次触发开一个新会话。',
  '- 继续当前 Chat：优先注入当前激活的 Chat，其次最近一个空闲且有内容的会话；都没有则自动新建。会话正在运行时提示词自动排队，不会打断。',
  '',
  GUIDE.trigger,
  '',
  GUIDE.dsl,
  '',
  GUIDE.examples
].join('\n');

function getAutomationGuide(topic) {
  const key = String(topic || 'all').trim();
  if (key === 'all') return GUIDE_ALL;
  if (GUIDE[key]) return GUIDE[key];
  return GUIDE_ALL;
}

module.exports = { getAutomationGuide, GUIDE };
