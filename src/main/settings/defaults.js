/* SPDX-License-Identifier: GPL-3.0-or-later; Copyright (c) 2026 B5-Software */
'use strict';

module.exports = function createDefaultSettings({ DEFAULT_DECISION_SETTINGS }) {
  const DEFAULT_SETTINGS = {
    llm: {
      provider: 'openai-compat',
      apiUrl: '',
      apiKey: '',
      model: '',
      temperature: 0.7,
      maxContextLength: 131072,
      maxResponseTokens: 8192,
      dailyMaxTokens: 0,
      dailyTokensUsed: 0,
      dailyTokenDate: '',
      maxRetries: 10,
      timeoutMs: 300000,
      fallbackModel: '',
      streamResponses: true,
      zenApiKey: '',
      reasoningEffort: 'off',
      // 自定义请求头（所有文本/VLM 请求生效）：[{ name, value, enabled }]
      customHeaders: [],
      // URL 命中 opencode.ai 时自动附加官方请求头（免费模型 UA 门控 / Go 会话头）
      autoOpencodeHeaders: true,
      // OpenCode UA 版本缓存（refreshOpenCodeVersion 写入 { version, fetchedAt }）
      opencodeVersion: null,
      // ---- 模型池（单层：每条自带 provider/URL/Key，可自由组合 Zen/Go/OpenAI 兼容等）----
      // entry: { id,label,provider,apiUrl,apiKey,model,effort,intelligence,priority,vision,contextLength,enabled }
      pool: [],
      // 路由策略：模型选择（priority=手动优先级 / intelligence=Jev 智慧分数）；
      // Reasoning Effort（manual=条目手动值 / jev=会话创建时由 Jev 决策一次）
      routing: { modelStrategy: 'priority', effortStrategy: 'manual' },
      // 默认条目（非 Agent 调用如游戏/标题使用的全局投影来源）
      activeEntryId: '',
    },
    agent: {
      maxIterations: 50,
      autoCompactMaxFailures: 3,
    },
    // 上下文压缩（水位线策略，借鉴 DeepSeek Harness compaction-basic）
    // - enabled           : 自动压缩总开关
    // - thresholdRatio    : 输入包络（system+tools+messages+输出预留）超过窗口该比例触发
    // - retainRatio       : 最近保留尾巴占窗口比例（token 预算制）
    // - compactionRetries : 摘要不收敛时的额外重试次数
    // - summarizeMaxTokens: 摘要请求最大输出 token
    contextCompaction: {
      enabled: true,
      thresholdRatio: 0.8,
      retainRatio: 0.16,
      compactionRetries: 1,
      summarizeMaxTokens: 2048,
    },
    // 沙箱（借鉴 DeepSeek Harness：read-only / workspace-write / danger-full-access）
    // - defaultMode    : 全局默认；受限模式后端不可用时 fail-closed（拒绝执行，不静默放行）
    // - modeOverrides  : 按 chat/code/babe 覆盖
    // - requireApproval: 被拦截/后端不可用时，是否弹窗确认后以完全权限重试
    sandbox: {
      defaultMode: 'danger-full-access',
      modeOverrides: { chat: null, code: null, babe: null },
      requireApproval: true,
    },
    // 运行位置：本机 / 虚拟机（CIBYP-VM-OS，基于 Debian 的隔离环境，资源按需下载）
    // - location     : 'host' | 'vm'；切换需重启应用（终端/工作区路径语义随之改变）
    // - workspaceMode: 'shared'（宿主为准 + 增量双向同步）| 'isolated'（VM 内为准，按需导出）
    // - vm.*         : QEMU 运行参数与资源目录（assetsDir 为空 = userData/vm）
    runtime: {
      location: 'host',
      workspaceMode: 'shared',
      vm: {
        variant: 'base',
        imageVersion: null,
        assetsDir: '',
        mirror: 'cn',
        accel: 'auto',
        allowTcg: true,
        smp: 4,
        memMB: 4096,
        netMode: 'nat',
        shutdownOnExit: true,
      },
    },
    // 自动化触发（HTTP 信号服务器）
    // - enabled     : 总开关（默认禁用，需用户在设置 → 自动化 中主动开启）
    // - allowNoToken: 无任何 token 也允许启动（不安全，UI 有警告）
    // - serverPort  : 监听端口（仅绑定 127.0.0.1）
    // - tokens      : token 列表，每项 { id, name, value, scope('all'|任务id数组), allowParams, expiresAt }
    automation: {
      enabled: false,
      allowNoToken: false,
      serverPort: 8765,
      tokens: [],
    },
    sessions: {
      maxConcurrent: 10,
    },
    // macOS 系统权限提示的一次性标记（无论允许/拒绝，之后都不再自动弹窗）
    permissions: {
      accessibilityPromptShown: false,
      localNetworkPromptShown: false,
    },
    imageGen: {
      // 厂商预设：openai / siliconflow / ark / gemini / imagen / stability / custom
      provider: 'openai',
      apiUrl: '',
      apiKey: '',
      model: '',
      imageSize: '1024x1024',
      // 高级参数（按厂商预设生效，留空用厂商默认）
      n: 1,
      quality: '',
      background: '',
      outputFormat: '',
      negativePrompt: '',
      seed: '',
      steps: '',
      guidance: '',
      style: '',
      watermark: false,
      bodyTemplate: '',
      dailyMaxImages: 0,
      dailyImagesUsed: 0,
      dailyImageDate: '',
      // 自定义请求头（生图 API 生效）：[{ name, value, enabled }]
      customHeaders: [],
    },
    // 资源下载（语音模型等大文件不随安装包分发，由用户手动下载）：
    //   mirror        : 'cn'(hf-mirror.com) | 'official'(huggingface.co)
    //   voiceModelDir : 自定义模型下载目录（空 = userData/voice-models）
    resources: {
      mirror: 'cn',
      voiceModelDir: '',
    },
    // 决策模型（System One / Jev）：OpenCode Zen 免费 Jev / TypeSafe 直连
    decision: { ...DEFAULT_DECISION_SETTINGS },
    theme: {
      mode: 'system',
      accentColor: '#4f8cff',
      backgroundColor: '#f5f7fa',
    },
    // 界面动效：关闭后主标签页切换无动画（设置页「动效」开关）
    animations: true,
    // 模态框动效：关闭后模态框打开/关闭为瞬时切换（设置页「动效」开关）
    modalAnimations: true,
    language: 'zh-CN',
    tools: {},
    autoApproveSensitive: false,
    autoOptimizeToolSelection: false,
    // 隐私信息保护：在工具调用过程中过滤隐私信息（手机号/证件号/SSN/API Key/SSH 私钥/.env/Tor/git key/配置密码）
    // - enabled           : 总开关（默认启用）
    // - filterResults     : 工具返回内容注入 AI 上下文前过滤（默认开）
    // - filterArgs        : 工具参数写入上下文时敏感键值脱敏（默认开）
    // - filterTerminal    : 终端命令/脚本文本全文隐私扫描（默认开）
    // - filterAttachments : 上传附件的 OCR/提取文本过滤（默认开）
    // - categories        : 可单独关闭的过滤类别（默认全开）
    privacyProtection: {
      enabled: true,
      filterResults: true,
      filterArgs: true,
      filterTerminal: true,
      filterAttachments: true,
      categories: {
        phone: true,
        idCard: true,
        ssn: true,
        apiKey: true,
        sshKey: true,
        env: true,
        tor: true,
        gitKey: true,
        configPassword: true,
        evasion: false,
      },
    },
    // 工具首次使用授权状态（持久化，跨会话生效）
    // - playwright: 内置浏览器工具集（browserNavigate/browserClick/browserType/...）
    // - computerUse: Computer Use 工具（computer，控制桌面鼠标键盘）
    // 用户首次调用相应工具时弹出授权模态框，同意后置为 true，拒绝则禁用工具
    toolAuthGranted: { playwright: false, computerUse: false },
    // 后台托盘模式：关闭窗口时的行为
    // - 'ask'     : 首次关闭时弹模态框询问，用户选择后记住
    // - 'always'  : 始终最小化到托盘（不退出）
    // - 'never'   : 始终直接退出（不显示托盘）
    // - 'once'    : 本次会话最小化到托盘，下次启动再次询问
    closeToTray: 'ask',
    trayEnabled: true,
    aiPersona: {
      name: 'Partner',
      avatar: '',
      avatarFrame: '',
      bio: '你的全能AI伙伴~',
      pronouns: 'Ta',
      personality: '活泼可爱、热情友善',
      customPrompt: '',
    },
    tarotVisible: true,
    userProfile: { name: '', avatar: '', avatarFrame: '', bio: '' },
    entropy: {
      source: 'csprng',
      trngMode: 'network',
      trngSerialPort: '',
      trngSerialBaud: 115200,
      trngNetworkHost: '192.168.4.1',
      trngNetworkPort: 80,
    },
    proxy: {
      mode: 'system',
      http: '',
      https: '',
      bypass: 'localhost,127.0.0.1',
    },
    mcp: { servers: [] },
    email: {
      enabled: false,
      mode: 'send-receive',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: true,
      imapHost: '',
      imapPort: 993,
      imapTls: true,
      emailUser: '',
      emailPass: '',
      ownerAddress: '',
      totpSecret: '',
      pollInterval: 30,
      approvalResendMinutes: 5,
      maxResends: 3,
      resendIntervalMinutes: 30,
      allowedSenders: [],
    },
    fedikitten: {
      active: { url: '', username: '', accessToken: '' },
      clients: {},
    },
    cibypIm: {
      active: null,
      identity: null,
      keys: [],
      sessions: [],
      groups: [],
    },
    webControl: {
      enabled: false,
      port: 3456,
      password: '',
      passwordHash: '',
      enable2FA: false,
      totpSecret: '',
    },
    // 系统桌面通知分类开关（渲染器按分类判断是否弹窗；updateAvailable 供更新检查模块消费）
    notifications: {
      enabled: true,
      approval: true,
      sessionDone: true,
      question: true,
      present: true,
      babeProactive: false,
      updateAvailable: true,
    },
    // GitHub Releases 自动更新检查
    // - autoCheckEnabled : 启动延迟 + 定时自动检查（发现新版本弹系统通知）
    // - intervalHours    : 自动检查间隔（小时）
    // - channel          : 更新通道 'stable'（仅正式版）| 'all'（含预发布版），默认仅稳定版
    // - lastCheckedAt    : 上次成功检查时间（ISO）
    // - lastResult       : 上次检查结果快照（渲染器设置页展示）
    updates: {
      autoCheckEnabled: true,
      intervalHours: 6,
      channel: 'stable',
      lastCheckedAt: '',
      lastResult: null,
    },
    // 预算控制：每模型单价表（每 1M tokens 多少美元）+ 峰谷时段 + 限额
    budget: {
      models: {}, // { [modelId]: { inputPerM, cacheReadPerM, outputPerM, cacheWritePerM, hasCacheWrite } }
      peakHours: {
        enabled: false,
        start: 9,
        end: 18,
        inputMul: 1.5,
        cacheReadMul: 1.5,
        outputMul: 1.5,
        cacheWriteMul: 1.5,
      },
      dailyLimitUSD: 0, // 0 表示不限制
      weeklyLimitUSD: 0,
      monthlyLimitUSD: 0,
      warningThreshold: 0.8,
      overLimitAction: 'warn', // 'warn' | 'fallback' | 'stop'
      fallbackModel: '',
      timezone: 'Asia/Shanghai',
      weekMode: 'natural', // 'natural' (周一起) | 'rolling' (滚动7天)
      monthMode: 'natural', // 'natural' (1日起) | 'rolling' (滚动30天)
    },
    // 终端设置：
    //   abortStrategy: Abort 聊天时对运行中终端的处理策略
    //     'kill'   - 直接掐断整个运行中的终端（默认）
    //     'clearC' - 传入 Ctrl+C（保留终端，仅中止当前进程）
    //     'none'   - 不管，让终端继续运行
    //   shell: 手动选择 Shell
    //     'auto'       - 自动检测（默认）
    //     'pwsh'       - PowerShell 7+ (pwsh)
    //     'powershell' - Windows PowerShell 5
    //     'cmd'        - CMD
    //     'bash' / 'zsh' - POSIX shell
    //     'custom'     - 使用 customShellPath 指定的自定义 Shell
    terminal: { abortStrategy: 'kill', shell: 'auto', customShellPath: '' },
    // 屏幕软键盘 / 输入法（OSK+IME）：
    //   enabled:       应用启动时是否自动打开屏幕键盘（可在输入框工具栏手动开关）
    //   mode:          默认输入模式 'zh' | 'en' | 'de'
    //   candidateCount:候选词数量
    ime: { enabled: false, mode: 'zh', candidateCount: 9 },
    // 语音子系统（完全本地化：sherpa-onnx，CPU 推理，无需任何外部配置）
    // - sttEnabled/ttsEnabled : 语音输入/输出总开关
    // - ttsAutoSpeak          : AI 流式回复时实时朗读（句级流水线，合成与输出并行）
    // - ttsLang               : 朗读语言 'auto' | 'zh' | 'en' | 'de'（auto 按句自动检测）
    // - ttsVoices             : 各语言音色（zh/en 为 Kokoro 音色名，de 为 Piper thorsten）
    // - wakeEnabled           : 后台语音唤醒（隐藏窗口常驻采集 + KWS 关键词检测）
    // - wakeWords             : 唤醒词表，action: 'voicebar'（弹置顶语音条）| 'mainwindow'（弹出主窗口）
    // - kws                   : 检测灵敏度（score 越大越易触发，threshold 越小越易触发）
    // - hotkey/pushToTalk     : 全局热键切换听写
    voice: {
      sttEnabled: true,
      ttsEnabled: true,
      ttsAutoSpeak: false,
      ttsLang: 'auto',
      ttsVoices: { zh: 'zf_xiaoxiao', en: 'af_heart', de: 'thorsten' },
      ttsSpeed: 1.0,
      ttsVolume: 1.0,
      // 长文本自动分块合成（防 OOM）：ttsAutoChunk 控制开关，ttsChunkChars=每块最大字数
      ttsAutoChunk: true,
      ttsChunkChars: 120,
      sttModel: 'base',
      // 听写结尾说这些词任一个 → 自动发送该条消息（默认关闭，空数组关闭该功能）
      sttSendKeywords: [],
      wakeEnabled: false,
      wakeWords: [
        { phrase: '伙伴伙伴', action: 'voicebar', enabled: true },
        { phrase: 'hey partner', action: 'voicebar', enabled: true },
        { phrase: '打开主页面', action: 'mainwindow', enabled: true },
      ],
      kws: { score: 1.0, threshold: 0.25 },
      hotkey: 'Control+Shift+Space',
      pushToTalk: true,
    },
  };
  // 注意：loadJSON 不与默认值合并（settings.json 存在时原样返回），必须显式以 DEFAULT_SETTINGS 为基，
  // 否则老用户的配置文件会缺新版本新增的键（曾导致读取 settings.runtime.vm 直接崩溃）

  return { DEFAULT_SETTINGS };
};
