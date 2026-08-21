# 自动化任务（触发）

设置 → 聊天侧栏「触发」页：定义自动化任务。任务被触发时，用 DSL 构造提示词，
按任务的**投递模式**送到 Chat 会话（编辑器左侧「投递」区配置）。三种触发器可并存，同一任务只选一种：

| 触发器 | 说明 | 配置 |
| --- | --- | --- |
| `schedule` | 定时（cron，分钟粒度） | `cron`：5 段 `分 时 日 月 周`，如 `*/5 * * * *`、`0 9 * * 1-5`、`0 0 * * *` |
| `notification` | 系统通知事件 | `kind`（any / sessionDone / sessionError / approval / other）+ 可选 `titleRegex` / `bodyRegex` |
| `http` | 专用信号服务器 | 见下文；任意 JSON 请求体进入 DSL 的 `args` |

## 投递模式

编辑器「投递 → 提示词送到哪里」二选一，持久化在任务的 `delivery.mode` 字段：

| 模式 | 行为 |
| --- | --- |
| `new`（默认） | 每次触发新建一个 Chat 会话并发送提示词 |
| `continue` | 注入已有的热对话：优先**当前激活**的 Chat 会话，其次最近一个**空闲且有内容**的会话；都没有则自动新建 |

`continue` 补充说明：

- "有内容"指该会话的上下文中已有消息（空会话直接复用没有意义）。
- 目标会话正在运行时，提示词**自动排队**作为 followup 发出，不会打断当前工作。
- HTTP 触发的响应中 `sessionKey` 字段指示实际落入的会话。

## 专用信号服务器

**默认禁用（fail-closed）**。需在 设置 → 自动化 中开启「HTTP 信号服务器」开关并配置
至少一个 Token 后，服务器才会启动（仅当存在启用中的 `http` 触发任务时）。默认监听
`127.0.0.1:8765`。对应 `settings.json` 的 `automation` 段：

```json
{
  "automation": {
    "enabled": true,
    "allowNoToken": false,
    "serverPort": 8765,
    "tokens": [
      {
        "id": "t1ab2cd3ef4",
        "name": "CI 脚本",
        "value": "random-base64url-value",
        "scope": "all",
        "allowParams": true,
        "expiresAt": 0
      }
    ]
  }
}
```

- `enabled`：总开关，默认 `false`。开启但没有任何 Token 且 `allowNoToken=false` 时
  服务器**不会启动**。
- `allowNoToken`：默认 `false`。设为 `true` 后，即使没有任何 Token 服务器也会启动，
  所有请求免鉴权放行 —— **不安全**（任何本机程序可触发），仅应急使用。
- `tokens`：Token 列表（旧版单值 `serverToken` 字符串会自动迁移为一条「默认」Token）。
  - `name`：备注名（≤64 字符）
  - `value`：鉴权值（1–128 字符；在设置页添加时自动生成强随机值，也可自定义）
  - `scope`：`"all"` 或任务 id 数组。指定列表时，该 Token 只能触发列表内任务，
    越权返回 `403`
  - `allowParams`：默认 `true`。设为 `false` 时请求体被忽略，DSL 的 `args` 恒为空
  - `expiresAt`：过期时间（毫秒时间戳）。`0` 或缺失 = 永不过期；过期后请求返回 `401`

### 端点

- `GET /health` → `{ ok: true, service: "cibyp-automation", time: <ms> }`
- `POST /trigger/{taskId}` → 触发指定任务。请求体为任意 JSON，成为 DSL 的
  `args`（受 Token 的 `allowParams` 约束）。成功返回 `{ ok: true, accepted: true, taskId, sessionKey }`。

### 鉴权与示例

必须携带 `Authorization: Bearer <token>`（timing-safe 比较）；**不支持**
`?token=` 查询参数（避免 Token 泄入 URL 日志）。无 Token、Token 错误或已过期返回 `401`；
Token 无权限触发该任务返回 `403`。

```bash
curl -X POST http://127.0.0.1:8765/trigger/task-x \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"repo":"owner/app","ref":"main"}'
```

仅监听回环地址，不对外暴露；如需远程接入请自行加反向代理与 TLS。
安全提示：外部可访问本机的程序（如浏览器中的恶意网页）可向该端口发送请求，
请在未使用期间保持开关关闭；「允许无 Token 启动」仅限应急，长期使用请配置 Token。

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
