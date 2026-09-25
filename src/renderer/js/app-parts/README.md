# app-parts

`src/renderer/js/app.js` 由这个目录中的文件按目录/文件名顺序拼接生成，
并以 **ESM** 输出（`export default (async function appEntry() { ... })();`），
页面通过 `<script type="module">` 加载。

- 所有 part 共享 `appEntry` 的作用域，可直接互相引用（与旧的单一 IIFE 一致）。
- part 文件内不要再自行包 `(async function(){ ... })();`，
  入口包装由 `scripts/build-app-bundle.js` 统一添加。
- 拼接顺序 = 执行顺序，按「目录数字 → 目录名 → 文件数字 → 文件名」自然排序。

## 目录一览

| 目录 | 职责 |
|------|------|
| `01-boot/` | 应用入口、字体、头像框、WebUI 镜像、窗口/标题栏、页面导航 |
| `02-modes/` | Chat/Code/Babe 模式切换、Agent 回调、会话标签栏与卡片 |
| `03a-onboarding/` | 首次使用引导（检查、向导、免费模型提示） |
| `03b-remote/` | Remote 模式（连接、DOM 镜像、事件委托、消息分发） |
| `03c-session-status/` | 上下文进度、费用估算、预算迷你条 |
| `04-web-events/` | Web 控制事件、关闭 App 时的挂起会话恢复 |
| `05-chat/` | 聊天界面（滚动、搜索、流式渲染、图片/附件、面板与弹窗） |
| `06a-tools/` | 工具页、工具组模态框、技能/知识/记忆页 |
| `06b-settings/` | 设置页各分类（LLM、生图、预算、主题、连接、维护等） |
| `07-history/` | 历史页、GeoGebra/画布/表格面板、通用模态框 |
| `08-code/` | Code 模式（Monaco、文件树、ESLint、终端、历史） |
| `09a-babe/` | Babe 模式（会话、消息、附件、历史、主动消息） |
| `09b-input/` | 屏幕软键盘/输入法、语音设置、资源下载 |
| `10-automation/` | 自动化任务页 |
| `11-command-palette/` | Slash 命令面板 |
| `12-selection-menu/` | 选中文本菜单 |

## 新增 part

1. 新建前先想清楚属于哪个功能目录；目录不存在时按顺序编号（如 `03c-xxx/`）。
2. 目录内文件命名 `NN-功能名.js`，`NN` 决定目录内顺序。
3. 运行 `npm run build-app-bundle` 重新拼接；`npm start` / `npm test` 会自动执行。
4. 测试可直接用整目录读取（`tests/run-tests.js` 的 `readAppParts('06b-settings')`）。

> 目录编号只需相对顺序正确：`sort` 先比数字前缀，再比目录/文件名。
> 同号目录用字母后缀排序（如 `06a-tools` < `06b-settings`）。
