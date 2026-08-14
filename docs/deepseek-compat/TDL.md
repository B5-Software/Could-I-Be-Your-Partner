# TDL（任务清单）

打勾规则：实现 + `npm test` 通过才打勾。顺序即实施顺序。

## Phase A：上下文压缩重构（先做，价值最大且自包含）

- [x] A1 `context-manager.js`：真实 token 计量（含 tools schema 预算 + 启发式估算 + usage 校准）
- [x] A2 水位线触发（Tier0 剪枝 / Tier1 摘要 / Tier2 溢出恢复）替换 70/85/95 三档
- [x] A3 配对切点（assistant.tool_calls 与 tool 结果不可拆）+ 字节冻结
- [x] A4 结构化摘要模板（八段式）+ checkpoint 替换 + shrink 验证 + 重试
- [x] A5 `llm:summarize` 会话回放模式（复用暖前缀）
- [x] A6 `_manageContext` 重写 + provider 溢出恢复钩子
- [x] A7 设置「上下文压缩」组 + 手动压缩按钮 + UI 圆环口径
- [x] A8 压缩相关单测/集成

## Phase B：工具页重构

- [x] B1 `CATEGORY_META`（组名/描述/图标）覆盖全部分组
- [x] B2 主界面组表格（组名/描述/数量/三态开关）
- [x] B3 组模态框（单工具 名称/描述/开关 + 全开/全关）
- [x] B4 DeepSeek 插件工具独立分组 + 兼容档位徽标
- [x] B5 模式过滤（chat/code/babe）与 MCP 动态组兼容
- [x] B6 DOM 测试

## Phase C：缓存纪律（会话冻结 + 追加式重优化）

- [x] C1 会话级工具 schema 快照（冻结）
- [x] C2 `__reoptimizeToolSelection` 改为追加式（不删不重排）
- [x] C3 `__disableAutoOptimize` 改为追加补全
- [x] C4 提示词工程：重优化成本说明 + 一次列全缺失工具
- [x] C5 缓存字节一致性断言

## Phase D：沙箱

- [x] D1 `sandbox-runner.js` 统一接口 `confine(argv, policy)`
- [x] D2 macOS Seatbelt profile 生成 + `sandbox-exec` 包装（实测三种模式）
- [x] D3 Linux bwrap/Landlock、Windows ACL 骨架 + fail-closed
- [x] D4 替换 main 进程 spawn 接入点（runShell/runPython/runNodeJS/终端/ffmpeg）
- [x] D5 升级审批流（拒绝签名识别 + 更高权限重试）
- [x] D6 设置「沙箱」页（默认模式/按模式覆盖/自检）
- [x] D7 沙箱单测（argv 包装、profile 生成、fail-closed、实测）

## Phase E：插件兼容层 + 插件管理页

- [ ] E1 `translator.js`（名称表 + 参数/结果适配器 + 别名注册表）
- [ ] E2 Cordis 内核 lib 接入 + `ctx.tools` Provider 桥接（先试 npm 安装，失败回退自研最小 Context）
- [ ] E3 插件安装器（本地目录 / npm 名 / GitHub / tgz）+ 依赖 alias
- [ ] E4 插件清单存储 `plugins.json`（安装/启停/卸载/更新/兼容档位）
- [ ] E5 设置「插件」页 + Schemastery→JSON Schema 表单
- [ ] E6 DeepSeek 工具注册到冻结工具集 + executeTool 路由
- [ ] E7 插件单测/集成（fixture 插件端到端）

## Phase F：收口

- [ ] F1 i18n（中文默认 + en/de）
- [ ] F2 `tests/run-tests.js` 全量回归
- [ ] F3 mac arm64 + win x64 打包冒烟
- [ ] F4 版本号递增 + 提交 + 推送
