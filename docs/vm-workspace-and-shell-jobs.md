# VM 工作区同步与长期命令

共享工作区的同步清单使用 SHA-256 内容摘要。宿主和 VM 各自保留原始文件元数据，仅在本侧 size/mtime/ctime 改变时重新读取内容；跨端比较不依赖时间戳接近。依赖、构建和缓存目录在进入目录前排除，`.cibyp-ready` 不参与文件同步。扫描、文件读写和基线保存使用异步 I/O，tar 按批传输。

基线 v2 保存两端已经确认的内容。单向同步保留等待另一方向处理的旧共识，不会把一次尚未拉回的 VM 编辑误判为双方新增文件。push 只向 VM 删除，pull 只向宿主删除。扫描失败停止同步，不能把失败当成空目录；dryRun 不传输、不删除、不更新基线。两端真正修改同一文件时，仍保留败方完整副本。拉回过程中出现新宿主编辑时停止覆盖，下一次同步重新比较两端。

`code:runShell` 和 `runShellScriptCode`（包括免费池的 `bash` 别名）支持托管命令：

```json
{"script":"npm run dev","yieldMs":1000}
```

短命令返回完成结果。持续运行的命令返回 `running: true`、`jobId` 和当前输出，Agent 可以继续编辑文件或调用浏览器。等待窗口到期不会停止进程。服务器直接以前台命令启动，不需要自行拼接 `nohup` 和重定向。

```json
{"jobId":"返回的任务 ID","yieldMs":1000}
{"jobId":"返回的任务 ID","action":"stop"}
{"action":"list"}
```

任务归属当前会话；查询和停止保留启动时的宿主/VM 位置，切换运行模式不会把旧任务操作发到另一端。每次最多等待 10 秒，默认新任务等待 1 秒、查询立即读取。stdout/stderr 分别返回最后 64 KiB；VM 的监督进程也限制磁盘日志大小。显式停止按进程树/进程组清理，应用退出清理自己的托管任务。需要输入或操作 TUI 的程序继续使用交互终端工具。

VM 使用已有 Node、bash、nohup、setsid，通过独立 SSH 启动请求创建受控进程组。所有启动通道描述符都重定向，因此脚本自行后台启动服务器、后代进程保留管道时，也不会把工具请求拖到硬超时。App 不安装 OS 组件。

验证：

- `npm run test:unit`：异步扫描、时钟差、同长度连续修改、方向基线、真实冲突备份、扫描/拉取竞争，以及宿主真实服务器、任务归属和显式停止。
- `npm run test:desktop`：工具卡片位置和间距、侧栏动画中间帧的主容器宽度、边缘对齐、取消/重开、减少动态效果。
- `node tests/integration/vm-workspace-jobs.cjs <已安装镜像资源目录> <版本> full`：临时 QEMU 磁盘上的真实 SSH/tar 和前台/后台服务器，不改变安装的基础镜像或用户实例。

# 上下文热更新与缓存观测

热更新继续只追加变更来源，保持已接纳的系统消息和历史消息前缀。相同观察值不会增加上下文。工具发现、权限变化、模型切换、压缩检查点会改变请求结构或基线；服务端实际命中还取决于提供方的缓存规则，不能承诺固定比例。

上下文详情和标签悬浮卡片显示接口报告的缓存命中。详情还显示最近请求的命中比例。缺少缓存字段显示“接口未返回缓存数据”，与明确返回 0 分开；估算输入不进入已报告缓存输入的分母。会话历史保存这些观测值。

统一用量兼容 OpenAI/Responses 的 cached_tokens、DeepSeek 的 prompt_cache_hit_tokens，以及 Anthropic 的缓存读写字段。Anthropic 的原生 `input_tokens` 只包含未缓存部分，因此统一输入是 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，该修正同时用于上下文占用、会话统计和预算计费，避免重复归一化。

提供方规则参考 [Anthropic 官方缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。Anthropic 请求需要提供方支持并启用 `cache_control`；保留前缀本身不等于已启用缓存。OpenAI 兼容网关是否返回缓存数据，应以实际响应为准。
