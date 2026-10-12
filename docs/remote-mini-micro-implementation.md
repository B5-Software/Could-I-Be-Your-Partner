# Remote v2 / Mini / Micro 实施记录

2026-10-13。桌面版本保持 `1.9.0-alpha.25`；新产品从 `0.1.0-alpha.1` 开始。

## 交付结构

| 仓库 | 实现 |
| --- | --- |
| [CIBYP-Remote](https://github.com/B5-Software/CIBYP-Remote) | JSON-RPC 2.0、服务权限、持久动作日志、事件游标 / 重放、JS SDK、设备网关、资源租约和结果分页 |
| [CIBYP-Mini](https://github.com/B5-Software/CIBYP-Mini) | Node 24 无头后台、同源 Agent 内核、服务 CLI、Linux GPIO 助手、SHA-256 更新 / 回退、x64 / ARM64 CI |
| [CIBYP-Micro](https://github.com/B5-Software/CIBYP-Micro) | 可移植 C11 Device profile、持久防重放、定制工具注册、模拟器、ESP-IDF / ESP32-S3 网络与存储适配 |

Mini 的 `core/` 是桌面源码构建的固定产物，带依赖审计、来源提交、dirty 标记、源码映射、第三方许可证和 SHA-256。修改业务应回到桌面源码，重新导入产物；不得另养一套 Agent 实现。开发快照的 dirty 标记如实保留。Remote 源码通过 `scripts/sync-remote.cjs` 锁定并校验，不需要发布 npm 包。

## 桌面接入

GUI / WebUI 的设置增加“远程设备”，可授权、修改和撤销设备与资源，凭据只在创建时显示。TUI 的 `/devices` / `/hardware` 查看同一后台目录，`/devices ID` 查看一台设备的资源权限。列表分页，完整策略与工具 schema 按需读取。Agent 通过 `listHardwareTools` / `describeHardwareTool` 发现并加载硬件工具，每次最多保留 16 个定义；设备上线、离线和权限变化会热更新目录。写入走已有审批，子 Agent 只能使用父任务委派的工具。现有 v1 客户端继续走兼容入口。

控制端 v2 提供会话、历史、工作区、交互、设置、待办、附件、更新、工具和设备接口。附件走有大小上限的二进制传输，下载校验 SHA-256。普通设置读取隐藏密钥、命令参数和 URL 凭据；私密配置为独立写入权限。设置写入和审批均校验 revision，拒绝过期回答。大消息与工具结果有可继续读取的偏移接口。

## 验证和边界

- 本机 Node-only 测试覆盖 Chat / Code / Babe 初始化、真实 HTTP provider 工具回合、原生子 Agent、附件、WS 事件、权限与设置冲突；测试不导入 Electron。
- Mini → 真实 WebSocket → C Micro 模拟器覆盖读取、写入和重复动作仅执行一次。C 测试覆盖日志回收后拒绝旧动作、重启未知状态、存储错误、分片、畸形 JSON、整型溢出、定制工具和随机输入；Linux CI 增加 ASan / UBSan。
- GPIO 助手持有 Linux GPIO v2 line request，输出到期回到 LOW；输入 / 输出显式分配。板级电路仍需验证，释放引脚不等于物理低电平。
- ESP-IDF 端网络回调仅组帧 / 入队，工具和 NVS 在 worker 执行，断连及本地定时器将输出置 LOW。TLS 校验证书并先同步时间；日志损坏不自动擦除。
- 不承诺物理 exactly-once。执行结果未知时不自动再次执行；紧急停止与时序限制留在设备本地。

独立 CI 已通过 Remote 的 Node 22 / 24、Linux / Windows，Mini 的 Linux x64 / ARM64 / Windows，以及 Micro 的 Linux / Windows、ASan / UBSan 和 ESP32-S3 固件构建。尚未进行 SBC / MCU 参考板接线验收、24 小时运行与实际 TLS 峰值测量；软件检查不能替代实机验证。其他 MCU / Zephyr、OTA 与独立 Micro Agent 仍是规划中的后续配置档。

Android / Wear OS / IDE 现有主流程通过 v1 兼容层继续连接；硬件入口使用 v2。手机显示设备与按需加载的资源策略，手表经手机读取最多 16 个摘要，不订阅高频遥测。VS Code 用原生 QuickPick / 文本预览，JetBrains 用原生选择器 / 权限说明。四个客户端的新版审批带 ID 和 revision，由服务端原子校验；旧后台仍使用兼容回答。原生构建、测试与 lint 通过，UI 尚待实机体验验收。Mini 不携带桌面浏览器、VM 或 WebUI 页面；需要图形能力时连接 Desktop，浏览器前端继续使用同一份桌面 WebUI 产物。

## 本次验证记录

桌面 `npm run check` 通过 lint、格式和类型检查；单元测试 506 通过、3 跳过、0 失败，旧回归集 388 通过。跳过项不算完成验收。共享协议完整性和 IPC 能力表生成检查通过。

Mini 的 6 项本机测试全部通过，包含真实 HTTP fixture provider 的工具回合、父会话并发上限为 1 时的子 Agent、关闭后台后重新打开 Code 历史、C Micro 模拟器联调，以及更新内容被篡改时拒绝安装。CLI 与客户端共用更新通道选择，显式参数优先于实例配置，预发布包默认使用 preview。

| 仓库 / 提交 | CI |
| --- | --- |
| Remote `a7b4bd4` | [Node 22 / 24 · Linux / Windows](https://github.com/B5-Software/CIBYP-Remote/actions/runs/38304318120) |
| Mini `8840526` | [Node 24 · Linux x64 / ARM64 / Windows](https://github.com/B5-Software/CIBYP-Mini/actions/runs/38305248082) |
| Micro `cc5483b` | [C host / Sanitizer / ESP32-S3](https://github.com/B5-Software/CIBYP-Micro/actions/runs/38253439115) |
| Mobile `8a5bc04` | [Android / Wear OS 构建、测试、lint](https://github.com/B5-Software/CIBYP-Mobile/actions/runs/38304351578) |
| IDE `fc85ed0` | [VS Code / JetBrains / Desktop 契约](https://github.com/B5-Software/CIBYP-IDE/actions/runs/38304366769) |

新仓库、原生客户端与本轮桌面源码改动一并提交上传，桌面版本不变。Mini 内核由对应桌面提交重新构建并记录来源信息。未创建新的产品 Release 或 npm 发布。

## 常用检查

```sh
npm run build:node-core
node scripts/generate-api-capabilities.cjs --check
node --test tests/unit/node-host.test.cjs
npm run test:mini-micro
```

Micro 模拟器默认位于相邻 `CIBYP-Micro/build/`；可用 `CIBYP_MICRO_SIMULATOR` 指定实际构建路径。
