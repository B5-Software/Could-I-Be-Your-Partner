# 推理显示、保留与验证范围

适用版本：桌面 1.9.0-alpha.24、移动端 0.1.0-alpha.2。

## 推理内容与摘要

GUI 的 Chat / Code / Babe、WebUI 和 TUI 使用同一个后端的推理字段。可读全文标为「推理内容」，服务商摘要标为「推理摘要」。OpenAI Responses 的 summary_text、兼容 API 的 reasoning_content / reasoning.text / reasoning.summary、Claude 的 thinking 块均有适配。只有加密块、没有可读文本时，不显示乱码或空的推理气泡。

「完整显示」指完整显示 API 实际返回的可读内容。OpenAI 不公开原始推理，现代 Claude 的 thinking 文本也是摘要。手机展示完整可读内容；手表只接收最多 160 个 Unicode 码点的摘要预览，完整内容在手机或电脑查看。

设置 → Token 与上下文包含两个独立开关，也出现在共享设置目录和 TUI /config 中：

- **请求推理摘要**：默认开启。支持的 OpenAI Responses / Codex 请求使用 reasoning.summary=auto；Claude 使用 thinking.display=summarized，关闭后为 omitted。不额外调用另一个模型，也不强制开启原本关闭的旧版 Claude 思考。
- **保留加密推理**：默认关闭。开启后，聊天记录与工作上下文保留原始加密块和签名，JSON / Markdown 导出包含它们。关闭后，新写入与导出副本删除这些字段，已有文件不会立即批量重写。当前工具轮次仍在内存保留协议状态，以便续接。

加密状态只向原模型、端点和账号续传。切换模型、API Key 或 Codex 账号不会把旧状态发给新来源。关闭保留后，重启不能恢复被删除的加密状态；旧版 Claude 的未完成工具轮次会用普通工具协议继续，不能恢复原内部思考。

## 费用与解密研究

[Claude 官方计费说明](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)明确说明摘要生成不另外收费，但完整内部思考 token 仍计费，隐藏摘要不会减少这部分费用。[OpenAI 推理说明](https://developers.openai.com/api/docs/guides/reasoning)说明内部 reasoning token 按输出计费，没有提供适用于所有模型和渠道的摘要独立收费承诺。兼容服务以自身条款为准。

[Stealing Reasoning Traces from Proprietary LLM APIs](https://arxiv.org/abs/2608.09867)研究把加密状态重放给兼容服务端模型，再诱导其复述内部内容。它依赖服务端、模型兼容性和额外 API 调用，是服务端重放后的内容恢复，不是获得密钥的离线解密。不能保证当前服务仍接受该方法，也不能保证恢复文字忠实于原始推理。本版本**没有实现或运行自动解密**。

## 验证范围

| 项目 | 证据与范围 |
| --- | --- |
| 推理协议 | 测试覆盖摘要/密文分离、签名分片、强制 SSE 聚合、工具续接、跨来源隔离、保留与导出副本 |
| GUI / WebUI | 真实 Electron 集成测试：共享会话、可见摘要、重连回放、密文不进入消息、共享压缩/更新及居中文件选择器 |
| TUI | 推理视图测试与共享后端客户端检查，新增设置来自同一目录 |
| Android | 原生模拟器连接真实后台的本地测试实例，运行中切换主题，显示头像框、附件和摘要 |
| Wear OS | 生产 UI 的仪器测试，测试传输仅在测试 APK：主题热切换、会话选择及聊天。截图不代表真实配对或 Tor 验证 |
| 性能 | R8、资源裁剪、ProfileInstaller、有限载荷、串行刷新、前台轮询及无变化刷新；尚无 TicWatch Pro 3 / Watch 5 / Watch 7 实机帧率数据 |
| meek | 桌面 Lyrebird 0.8.1 和手机 IPtProxy 5.5.1 原生 SOCKS 握手通过；实际桌面 Tor 连接完成网桥握手，90 秒检查到 50% 描述符阶段，未确认全部引导完成。仍需跨设备及受限网络实测 |
| 配对 | Wear Data Layer 仍需真实手机与手表配对验证，模拟器截图不能替代 |

涉及所有操作系统、真实 VM、网络及硬件的历史需求，不能仅凭本轮检查宣称全部完成或没有 bug。各功能文档保留具体限制。
