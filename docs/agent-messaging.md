# 主 / 子 Agent 消息机制

本次主要研究 [DeepSeek Harness 的 Subagent 合约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)、[Agent / Inbox 合约](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)及项目已安装的 `@deepseek-ai/dsh-subagent` 实现。

## 值得沿用的机制

- **一个 Agent，一个收件箱。** `next-turn` 排队开启独立回合；`next-step` 在安全模型步骤边界接收。不要在正在进行的工具批次中直接改上下文，也不要另建一条与 Agent 循环竞争的任务队列。
- **发信成功表示收件箱接受。** 返回稳定的 `messageId`，不表示已经推理或任务完成。分别观察 inserted、claimed、discarded 和回合结束事件。
- **运行中引导，空闲时唤醒。** Agent 发出的消息使用 steer；纯上下文 inject 不应单独唤醒。保留收件箱的 interrupt 停止当前工作，未领取的消息等待下一次显式唤醒。
- **子会话身份长期稳定。** 可继续子 Agent 的会话、描述和父子关系持久化，运行实例可以释放。后续发信从已有会话恢复，不重新建立一个无上下文的 Agent。
- **发送者由宿主判定。** 双向通信限定直接父子关系；不能靠参数伪造发送者，也不能任意接管其他聊天。Agent 消息不是用户授权，仍须经过 CIBYP 原有的工具权限与审批。
- **交流是有选择地传递发现。** 独立上下文不自动复制完整思考、工具输出和所有对话；发送阶段性发现与结果，结束通知保留完成、失败、中断等区别。

这些是公开合约的归纳。CIBYP 继续拥有模型请求、设置、聊天记录、前端与权限；SDK 在兼容层中提供通信和生命周期能力。

## 本次检查与修复

现有 DS 兼容层已经挂载 SDK 的 continuation manager，但补测发现了以下桥接问题，现已修复：

1. `cancel({keepInbox:true})` 之后，旧 pump 会立即执行下一条消息。增加中断代次与暂停门控；只有显式 waking send 恢复，状态观察和纯 inject 不触发续跑。
2. 可继续子 Agent 创建时，factory setup 未获得 `systemPrompt` / `tools` 的作用域依赖。创建专属依赖 fiber，并去除服务调用 shadow，使子 Agent 的组合注册属于正确生命周期。
3. CIBYP 初始化重置聊天 ID，导致 SDK 子会话 ID 和聊天记录 ID 分离。插件创建采用稳定 ID，初始化保留该 ID；冷恢复使用同一个后台 key。
4. 插件消息经过共享后台时会走人类 sendMessage 入口。现在携带内部 origin，仍可驱动 Agent，但不会触发人类自动记忆提取；普通人类输入保持原行为。

## 统一原生 `runSubAgent`

DS 插件和原生工具现在共用 `ctx.subagents.startContinuable`、`sendMessage`、interrupt、持久化收件箱与同一个 CIBYP 后台 Agent 循环。GUI、TUI、WebUI 不再各自运行一次性子循环。

- `runSubAgent({task,context,tools,wait,maxIterations})`：默认同步返回报告；`wait:false` 返回持久子会话 ID 与已接受的消息 ID。
- `sendAgentMessage({targetId,message})`：直接父子双向通信。工作时在安全步骤边界接收；空闲时唤醒；实例释放后从同一会话恢复。
- `listSubAgents()`：返回自身、直接父 Agent 和子 Agent 的 ID、状态和用量摘要。
- `interruptSubAgent({targetId})`：停止直接子 Agent，保留待处理收件箱；再次发消息继续。停止父 Agent 同时停止其正在运行的原生子 Agent；迟到的完成通知不会撤销用户的停止操作。

子 Agent 继承父 Agent 的模型路由与工作区，使用隔离上下文及经过父工具白名单交集的授权范围，审批回到父视图。完成报告、进度和用量继续走原来的前端事件。委派目录不重复保存完整聊天或 API 密钥；完整上下文仍由聊天存储和 SDK journal 各司其职。恢复时必须打开原父会话，缺失委派策略则拒绝执行。Agent 消息带来源提示，不成为人类自动记忆或关系成长的证据。

步骤 steering 会按消息 ID 去重投影到 CIBYP 长期上下文和聊天记录，后续请求继续保留。VM 模式先在宿主处理共享收件箱，再交给 VM 插件增强请求。两端分别处理各自收件箱，VM 插件的请求和停止钩子继续生效。模型请求仍在宿主。

当前回归测试没有证明所有 Provider、断电恢复、所有插件和长时间并发场景都兼容；没有自动恢复正在进行的外部工具副作用。

## 验证

```sh
node --test tests/unit/native-subagents.test.cjs tests/unit/deepseek-messaging.test.cjs tests/unit/deepseek-services.test.cjs tests/unit/backend-transport.test.cjs tests/unit/agent-headless.test.cjs
```

测试使用隔离目录和确定性的模型 / 后台替身，不读取用户账号、不请求付费模型。包含双向回执、运行中 steering、未知目标拒绝、跨父子关系拒绝、中断与唤醒、释放后恢复、上下文保留、共享后台稳定身份及自动记忆输入来源。
