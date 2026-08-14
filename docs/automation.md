# 自动化任务（触发）

设置 → 聊天侧栏「触发」页：定义自动化任务。任务被触发时，用 DSL 构造提示词，
**新建一个 Chat 会话并发送**。三种触发器可并存，同一任务只选一种：

| 触发器 | 说明 | 配置 |
| --- | --- | --- |
| `schedule` | 定时（cron，分钟粒度） | `cron`：5 段 `分 时 日 月 周`，如 `*/5 * * * *`、`0 9 * * 1-5`、`0 0 * * *` |
| `notification` | 系统通知事件 | `kind`（any / sessionDone / sessionError / approval / other）+ 可选 `titleRegex` / `bodyRegex` |
| `http` | 专用信号服务器 | 见下文；任意 JSON 请求体进入 DSL 的 `args` |

## 专用信号服务器

启用任一 `http` 触发任务后自动启动，默认监听 `127.0.0.1:8765`。可在
`settings.json` 的 `automation` 段调整：

```json
{
  "automation": {
    "serverPort": 8765,
    "serverToken": "your-shared-secret"
  }
}
```

### 端点

- `GET /health` → `{ ok: true, service: "cibyp-automation", time: <ms> }`
- `POST /trigger/{taskId}` → 触发指定任务。请求体为任意 JSON，成为 DSL 的
  `args`。成功返回 `{ ok: true, accepted: true, taskId, sessionKey }`。

### 鉴权与示例

设置了 `serverToken` 时，必须携带 `Authorization: Bearer <token>` 或
`?token=<token>`，否则返回 `401`。

```bash
curl -X POST http://127.0.0.1:8765/trigger/task-x \
  -H "Authorization: Bearer your-shared-secret" \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/app","ref":"main"}'
```

仅监听回环地址，不对外暴露；如需远程接入请自行加反向代理与 TLS。

## 提示词构造 DSL

图灵完备、全沙箱（AST 解释器，无 `require/process/fs`）。最终**返回一个字符串**
即提示词；无返回值时取最后一条表达式的值。执行保护：最多 20 万步 / 10 秒。

### 语法（JS 子集）

- 变量与控制流：`let`、赋值、`+=`/`-=`、`if/else`、`while`、`for`、
  `break`/`continue`、`return`
- 函数：`fn name(a, b) { ... }`（支持递归）
- 数据：数字、字符串（`"${expr}"` 插值）、布尔、`null`、数组、对象
- 运算符：`+ - * / %`、`== != < <= > >=`、`&& || ??`、`?:`、`!`
- 异步：`let r = await fetch(url);`

### 全局入参

- `trigger`：`{ kind, params, time, taskId }`
- `args`：触发器携带的参数（HTTP 请求体 / 手动运行的参数）

### 标准库

| 命名空间 | 函数 |
| --- | --- |
| `str` | `len upper lower trim replace split join substr slice contains startsWith endsWith repeat` |
| `arr` | `len push pop shift unshift join slice reverse sort includes indexOf` |
| `num` | `abs round floor ceil min max toFixed` |
| `math` | `pow sqrt log exp random floor ceil round` |
| `time` | `now`（毫秒）、`format(ts, "YYYY-MM-DD HH:mm:ss")` |
| `json` | `parse stringify` |
| `text` | `base64Encode base64Decode urlEncode urlDecode capitalize` |
| `uuid` | `v4()` |
| `env` | `get(name) has(name)`（只读环境变量） |
| 全局 | `fetch(url, {timeout})` → `{ status, ok, text, json() }`、`keys values typeOf toNumber toString` |

### 示例

```js
// HTTP 触发：POST /trigger/build-watch {"repo":"owner/app","event":"push"}
let title = "CI 事件：" + str.upper(args.event ?? "unknown");
let items = arr.join(keys(args), ", ");
return title + "\n仓库=" + args.repo + "\n参数键=" + items;
```

```js
// 定时触发：每 30 分钟生成一份日报骨架
let t = time.format(time.now(), "YYYY-MM-DD HH:mm:ss");
let dice = 1 + math.floor(math.random() * 6);
return "现在是 " + t + "，掷骰子=" + dice + "。请给我今天的开发简报。";
```

```js
// 通知触发：会话完成后自动复盘
if (trigger.kind == "notification") {
  return "会话刚结束，通知标题：" + args.notification.title + "。请做简短复盘。";
}
return "";
```
