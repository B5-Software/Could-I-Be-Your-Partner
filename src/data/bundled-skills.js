/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * Bundled skills — built-in skill definitions shipped with the app.
 * Each bundled skill is a JSON object with the same shape as a user skill:
 *   { id, name, description, prompt, scripts?, bundled: true }
 *
 * The `prompt` field is injected into the system context when the skill is
 * activated via the `activateSkill` tool. Most bundled skills are
 * prompt-only (no scripts) — they guide the agent's behavior rather than
 * execute code directly.
 *
 * Inspired by claude-code-ref/src/skills/bundled/*.
 */

'use strict';

const BUNDLED_SKILLS = [
  {
    id: 'bundled-dream',
    name: 'dream',
    description: '记忆整理（Dream）：审查、组织、修剪持久化记忆文件，确保未来会话能快速获得准确上下文。手动触发 4 阶段流程：定位→采集→整合→修剪。',
    bundled: true,
    prompt: `# Dream — 记忆整理流程

你现在进入"记忆整理"模式。你的任务是审查、组织和修剪持久化记忆文件，确保未来会话能快速获得准确上下文。

## 记忆目录结构

记忆文件存储在 userData/data/memory/ 目录下：
- topics.md — 主题索引（每行一个主题摘要，~150 字符）
- session_*.jsonl — 会话记录（按日期分文件）

请通过 listDirectory 工具查看该目录，并通过 readFile 读取 topics.md（若存在）。

## 四阶段流程

### Phase 1 — 定位（Orient）
1. 调用 listDirectory 查看 memory 目录
2. 若 topics.md 存在，调用 readFile 读取它，了解现有主题结构
3. 浏览现有的主题文件，理解当前记忆组织方式

### Phase 2 — 采集信号（Gather）
按优先级收集需要整理的信号：
1. 读取最近的 session_*.jsonl 文件（最后 1-2 个即可）
2. 检查 topics.md 中明显过时的条目（相对日期如"昨天"、"刚刚"应转为绝对日期）
3. 找出重复或近似重复的主题条目
4. 找出被后续事实推翻的旧条目

### Phase 3 — 整合（Consolidate）
1. 将新信号合并到现有主题文件中，而不是创建近似重复的新文件
2. 把相对日期（"昨天"、"上周"）转为绝对日期（"2026-07-05"）
3. 删除被新事实推翻的旧条目
4. 合并冗余条目，保持每条简洁

### Phase 4 — 修剪与索引（Prune）
1. 确保 topics.md 保持在 200 行以内
2. 每条索引项一行，~150 字符
3. 删除纯过程性记录（"用户问了X"、"调用了Y工具"），只保留结论性事实
4. 验证所有引用的文件路径仍然有效

## 输出要求

完成整理后，调用 manageContext 工具清理你的工作上下文，然后向用户报告：
- 整理了哪些主题文件
- 删除/合并了多少条目
- topics.md 当前的行数与字数
- 下次建议整理的时机

## 重要约束
- 不要删除用户显式标记为"永久保留"的条目
- 不要修改 session_*.jsonl 原始会话记录（只读）
- 整理过程中若发现矛盾事实，保留较新的并标注来源日期
- 控制整理时间，避免过度优化`
  },

  {
    id: 'bundled-debug',
    name: 'debug',
    description: '调试日志诊断：启用应用调试日志，读取最近事件，引导定位问题。适用于应用卡顿、报错、行为异常等场景。',
    bundled: true,
    allowedTools: ['readFile', 'listDirectory', 'localSearch', 'runTerminalCommand', 'getSystemInfo'],
    prompt: `# Debug — 调试日志诊断

你现在进入"调试诊断"模式。你的任务是协助用户定位应用问题。

## 诊断步骤

### Step 1 — 收集症状
询问用户（或从对话上下文提取）：
- 问题现象是什么？（报错信息、异常行为、卡顿）
- 何时开始出现？（具体时间或操作）
- 是否可复现？（每次都发生还是偶发）
- 最近做了什么变更？（安装、更新、配置修改）

### Step 2 — 检查应用日志
1. 调用 getSystemInfo 获取系统状态
2. 检查工作目录下是否有 .log 文件（通过 listDirectory）
3. 若有日志文件，调用 readFile 读取最近 100 行
4. 用 localSearch 在日志中查找 [ERROR]、[WARN]、Exception、Failed 等关键词

### Step 3 — 检查环境
1. 调用 getNetworkStatus 检查网络连通性（若问题与网络相关）
2. 通过 runTerminalCommand 检查相关进程状态（如适用）
3. 检查磁盘空间、内存使用（通过 getSystemInfo）

### Step 4 — 定位根因
基于收集的信息：
1. 列出最可能的 3 个根因（按可能性排序）
2. 对每个根因给出验证方法
3. 提供修复建议（优先级：立即可执行 > 需要配置 > 需要重启）

### Step 5 — 验证修复
1. 让用户尝试最可能的修复
2. 若未解决，回到 Step 2 收集更多信息
3. 记录已尝试的方案，避免重复

## 输出格式

诊断报告应包含：
- **症状摘要**：一句话描述问题
- **根因分析**：3 个候选根因及验证方法
- **建议修复**：分优先级列出
- **后续跟踪**：若问题复现应收集什么信息

## 约束
- 不要假设根因，必须基于日志/证据
- 若日志不足以下结论，明确告知用户需要更多信息
- 危险操作（修改系统文件、强制结束进程）必须先征得用户同意`
  },

  {
    id: 'bundled-loop',
    name: 'loop',
    description: '周期任务调度：把当前任务注册为 cron 周期执行。支持 Ns/Nm/Nh/Nd 间隔格式。',
    bundled: true,
    prompt: `# Loop — 周期任务调度

你的任务是把用户描述的周期性任务注册为 cron 调度。

## 解析规则

用户输入可能包含间隔信息，按以下规则解析：
1. **前导 token**：若用户输入以数字+单位开头（如 "30m 检查邮件"），提取间隔
2. **尾部从句**：若输入包含 "every N<unit>"（如 "检查邮件 every 30m"），提取间隔
3. **默认值**：若未指定间隔，使用 10m（10 分钟）

支持的单位：
- Ns — 秒（最小 600s，即 10 分钟）
- Nm — 分钟（最小 10m）
- Nh — 小时
- Nd — 天

## 调度流程

1. 从用户输入中解析任务描述与间隔
2. 将间隔转为 cron 表达式：
   - "10m" → "*/10 * * * *"
   - "1h" → "0 * * * *"
   - "1d" → "0 0 * * *"
3. 调用 Schedule 工具（action: "create"）创建周期任务
4. 立即触发一次执行（action: "trigger"）让用户看到首次输出

## 输出要求

- 创建后报告：任务名称、cron 表达式、下次执行时间（用北京时间表达）
- 提醒用户可用 action: "list" 查看所有周期任务
- 提醒用户可用 action: "pause"/"resume"/"delete" 管理

## 约束
- 周期任务的最小间隔为 10 分钟（系统限制）
- 任务 message 字段必须包含完整上下文（执行时无用户在场）
- 不要把一次性任务注册为周期任务`
  },

  {
    id: 'bundled-batch',
    name: 'batch',
    description: '并行子代理编排：把大规模迁移/重构任务分解为多个独立单元，spawn 子代理并行工作。',
    bundled: true,
    prompt: `# Batch — 并行子代理编排

你的任务是把大规模迁移/重构任务分解为多个独立单元，使用 runSubAgent 工具并行执行。

## 分解原则

1. **独立性**：每个单元应能独立完成，不依赖其他单元的中间产物
2. **粒度**：5-30 个单元为宜；过少失去并行价值，过多难以管理
3. **可验证**：每个单元应有明确的完成标准（测试通过、文件生成等）

## 执行流程

### Phase 1 — 任务分析
1. 与用户确认任务范围与目标
2. 识别可并行化的维度（按文件、按模块、按功能）
3. 估算每个单元的工作量

### Phase 2 — 分解
1. 把任务切分为 N 个独立单元
2. 为每个单元编写清晰的指令（包含目标、约束、验收标准）
3. 向用户展示分解方案，征得同意

### Phase 3 — 并行执行
1. 对每个单元调用 runSubAgent，传入：
   - task：单元的完整指令
   - tools：该单元允许使用的工具白名单
2. 收集所有子代理的结果
3. 汇总成功/失败统计

### Phase 4 — 验收与汇总
1. 检查每个子代理的输出是否符合验收标准
2. 对失败的单元分析原因，决定重试或人工介入
3. 向用户提交汇总报告

## 输出要求

- 分解方案：单元列表 + 各单元指令
- 执行进度：实时报告每个子代理的启动/完成
- 汇总报告：成功数/失败数/总耗时/关键产物

## 约束
- 子代理之间不能共享运行时状态（独立上下文）
- 危险操作（删除、覆盖）必须由主代理审批，不能下放给子代理
- 单个单元失败不应阻塞其他单元`
  }
];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BUNDLED_SKILLS };
}
