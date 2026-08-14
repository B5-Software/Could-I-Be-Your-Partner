# 工具页两级重构

## 主界面（表格布局）

每行一个分组：组名 | 组描述 | 工具数量 | 整组三态开关（关/半开/开，`input.indeterminate`）。

- `CATEGORY_META`：现有 25 个 category + MCP 动态组的 名称/描述/图标。
- DeepSeek 导入工具：每插件一行，集中"DeepSeek 插件"分区，带兼容档位徽标。
- 主界面只渲染组行（懒渲染，工具不进 DOM）。

## 模态框（点组打开）

每工具一行：名称 | 描述 | 开关；顶栏显示组名 + 全部开/全部关。

- 复用 `updateToolSetting` / `setToolCategoryEnabled` 逻辑，仅换渲染层。
- 三态规则：全开=checked、全关=unchecked、否则 indeterminate；组开关点击按"非全开则全开"。

## 保留

模式过滤按钮（chat/code/babe）、自动优化开关、`renderToolsStats`、工具授权列表。
