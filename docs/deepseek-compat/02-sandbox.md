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
| Windows | 受限令牌 ACL | 骨架 + fail-closed |

## 统一接口 `src/main/sandbox-runner.js`

```js
confine(argv, { mode, workspaceRoot, sessionId })
  → { argv, enforcement: 'full'|'partial', denialSignatures, runnerFailureRules, backend }
```

`danger-full-access` 直接透传 argv（不包装）。受限模式返回包装后 argv（`sandbox-exec -p <profile> <cmd...>`）。

## 接入点

`code:runShell`、`code:runPython`、`code:runNodeJS`（fork）、终端 `pty.spawn`、ffmpeg、aria2、mcp 本地 stdio server。统一走 `sandboxedSpawn/sandboxedExecFile/sandboxedFork` 辅助。

## 升级审批流

执行结果 stderr 命中 `denialSignatures` → 渲染进程弹"被沙箱拦截，是否以更高权限重试"（复用现有敏感确认 UI）→ 同意后以更宽 policy 重跑。

## 设置「沙箱」页

默认模式、按 chat/code/babe 覆盖、升级需确认开关、后端自检按钮（显示当前后端与 enforcement）。
