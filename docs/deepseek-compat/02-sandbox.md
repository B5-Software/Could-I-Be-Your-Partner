# 沙箱设计

## 语义（照搬 dsh，自研实现）

- 模式：`read-only` / `workspace-write` / `danger-full-access`（只约束文件效果）。
- `workspaceRoot`：会话 `workspacePath`。
- **fail-closed**：后端不可用时拒绝受限模式，绝不无沙箱放行（除非用户显式同意降级）。

## 后端矩阵

| 平台 | 后端 | 状态 |
|---|---|---|
| macOS | `sandbox-exec` + 生成的 Seatbelt profile | 本阶段实现 |
| Linux | `bwrap`（缺失时 Landlock） | 骨架 + fail-closed |
| Windows | 受限令牌 ACL（`cibyp-sandbox.exe`，native 预编译） | 本阶段实现 |

## Windows 后端（受限令牌 + 低完整性 ACL）

实现：`assets/sandbox/win/cibyp-sandbox.c`（MinGW-w64 编译，预编译 `cibyp-sandbox.exe` 随仓库提供）。
打包：`win.extraResources` 仅 Windows 包带出到 `process.resourcesPath/sandbox/`（macOS/Linux 包不含该文件）；开发模式读 `assets/sandbox/win/`。

机制（只约束文件效果）：

1. `CreateRestrictedToken`（`DISABLE_MAX_PRIVILEGE` + `SANDBOX_INERT`）派生受限令牌；
2. 强制完整性级别（MIC）降为 Low（`S-1-16-4096`）：
   - **读**：低完整性可以"向下读" Medium 对象 → 系统/工作区文件可读；
   - **写**：MIC 拒绝向 Medium 对象写入 → `read-only` 语义（无需改动既有 ACL）；
3. `workspace-write`：把工作区目录树递归打上 Low 强制标签（`LABEL_SECURITY_INFORMATION`，
   与 `icacls /setintegritylevel` 等价，无需 `SeSecurityPrivilege`），区内任意读写；
   同时把子进程 `TMP/TEMP` 指到一个低标签临时目录（`--temp`，包装器负责创建/清理）。
   注意：事后由普通进程新建的文件是 Medium 的，沙箱内再次写入会被拒（语义为"部分可写"）；
4. `CreateProcessAsUserW`（`bInheritHandles=TRUE` 透传 stdio）+ Job 对象
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`：包装器退出（含超时/被杀）时整棵子进程树终止；
5. fail-closed：任何前置失败（自检不过、标签失败）stderr 输出 `cibyp-sandbox: ...` 并不启动子进程。

CLI：`cibyp-sandbox.exe --mode <read-only|workspace-write> [--workspace <dir>] [--temp <dir>] -- <cmd...>`
与 `cibyp-sandbox.exe --self-test`（真实受限子进程自检，供 `detectBackend` 探测）。

已知限制与对策：

- **node 的 fork IPC 通道无法穿越中间进程**（cmd.exe / C 启动器实测均不投递消息）：
  Windows 受限模式下 `code:runJS` / `code:runNodeJS` 改用"代码文件 + stdout JSON"方案
  （`src/tools/js-runner*.js` 支持文件模式，`main.js` 的 `runJSConfinedWin32`）；
- **终端（node-pty/ConPTY）无法穿越包装器**：Windows 受限模式下 `terminal:make` fail-closed，
  明确提示改用完整访问模式；
- zh-CN 控制台子进程输出为 GBK（OEM 代码页），解码为 UTF-8 时出现乱码属既有行为；
  沙箱拒绝识别基于 wrapper 自身 UTF-8 输出（`cibyp-sandbox: `）与常见拒绝短语。

## 统一接口 `src/main/sandbox-runner.js`

```js
confine(argv, { mode, workspaceRoot, sessionId })
  → { argv, enforcement: 'full'|'partial', denialSignatures, runnerFailureRules, backend, confined }
```

`danger-full-access` 直接透传 argv（不包装）。受限模式返回包装后 argv（`sandbox-exec -p <profile> <cmd...>` / `cibyp-sandbox.exe --mode ... -- <cmd...>`）。

## 接入点

`code:runShell`、`code:runPython`、`code:runNodeJS`（fork）、终端 `pty.spawn`、ffmpeg、aria2、mcp 本地 stdio server。统一走 `sandboxedSpawn/sandboxedExecFile/sandboxedFork` 辅助。

## 升级审批流

执行结果 stderr 命中 `denialSignatures` → 渲染进程弹"被沙箱拦截，是否以更高权限重试"（复用现有敏感确认 UI）→ 同意后以更宽 policy 重跑。

## 设置「沙箱」页

默认模式、按 chat/code/babe 覆盖、升级需确认开关、后端自检按钮（显示当前后端与 enforcement）。
