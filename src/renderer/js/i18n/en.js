/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (c) 2026 B5-Software
 *
 * This file is part of Could I Be Your Partner.
 *
 * English (en) translations for UI, tool descriptions, and system prompts.
 */

const EN_DICT = {
  // ── UI Strings ──
  ui: {
    titlebar: {
      chatMode: 'Chat Mode',
      codeMode: 'Code Mode',
      babeMode: 'Babe Mode (Companion)',
      clickToEdit: 'Click to edit',
      localMode: 'Local mode (operate host Agent)',
      remoteMode: 'Remote mode (connect to another WebUI)',
      minimize: 'Minimize',
      maximize: 'Maximize',
      close: 'Close',
      untitledConversation: 'Untitled conversation'
    },
    sidebar: {
      chat: 'Chat',
      code: 'Code',
      babe: 'Babe',
      history: 'History',
      codeHistory: 'Code History',
      babeHistory: 'Babe History',
      tools: 'Tools',
      skills: 'Skills',
      knowledge: 'Knowledge',
      memory: 'Memory',
      settings: 'Settings',
      about: 'About'
    },
    chat: {
      standby: 'Standby',
      working: 'Working...',
      tarotNotDrawn: 'Tarot: Not drawn',
      reoptimizeTools: 'Manually re-optimize tool selection',
      openWorkspace: 'Open workspace',
      newChat: 'New chat',
      clearChat: 'Clear chat',
      greeting: 'Hello, I am your AI partner',
      greetingDesc: 'I can help you with various tasks, including file operations, coding, information search, image generation, and more. Tell me how I can help!',
      searchNews: 'Search news',
      generateImage: 'Generate image',
      todoList: 'Todo list',
      writeCode: 'Write code',
      addTodoPlaceholder: 'Add a new todo item...',
      sensitiveConfirmTitle: 'Sensitive operation confirmation',
      deny: 'Deny',
      approveExecution: 'Approve execution',
      inputPlaceholder: 'Type a message and let the AI Agent help you...',
      attachFile: 'Attach file',
      takePhoto: 'Take photo',
      send: 'Send',
      stop: 'Stop'
    },
    code: {
      openWorkspace: 'Open workspace',
      workspace: 'Workspace',
      noWorkspaceSelected: 'No workspace selected',
      showFileTree: 'Show file tree',
      showEditor: 'Show editor',
      showChat: 'Show chat',
      addFileToContext: 'Add file to context',
      inputPlaceholder: 'Enter a coding task...'
    },
    babe: {
      welcome: 'Welcome to Babe Mode',
      configurePrompt: 'Please configure TA\'s appearance, name and personality in settings',
      featureDesc: 'TA has independent memory, affection level, and may proactively reach out to you.',
      proactiveMessage: 'Let TA proactively message',
      inputPlaceholder: 'Say something to TA...'
    },
    settings: {
      tabs: {
        aiPersona: 'AI Persona',
        babeMode: 'Babe Mode',
        profile: 'Profile',
        llm: 'LLM',
        usage: 'Usage',
        imageGen: 'Image Gen',
        theme: 'Theme',
        network: 'Network',
        entropy: 'Entropy',
        trngFirmware: 'TRNG Firmware',
        security: 'Security',
        mcp: 'MCP',
        email: 'Email',
        webControl: 'Web Control',
        playwright: 'Playwright',
        settings: 'Settings'
      },
      labels: {
        name: 'Name',
        avatar: 'Avatar',
        bio: 'Bio',
        pronouns: 'Pronouns',
        personality: 'Personality',
        customPrompt: 'Custom prompt',
        saveSettings: 'Save settings',
        start: 'Start',
        stop: 'Stop',
        language: 'Language',
        interfaceLanguage: 'Interface Language',
        languageDesc: 'Select the language for the UI and AI responses'
      }
    },
    history: {
      noChatHistory: 'No chat history',
      noCodeHistory: 'No Code history',
      noBabeHistory: 'No Babe history'
    },
    tools: {
      management: 'Tool Management',
      manageDesc: 'Enable or disable tools the AI Agent can use',
      autoOptimize: 'Auto-optimize tool selection',
      displayMode: 'Display mode:',
      chatModeTools: 'Chat mode tools',
      codeModeTools: 'Code mode tools',
      babeModeTools: 'Babe mode tools'
    },
    skills: {
      management: 'Skill Management',
      manageDesc: 'Manage AI Agent skills, or let the Agent auto-generate them',
      importSkillMd: 'Import SKILL.md',
      addSkill: 'Add skill',
      empty: 'No skills yet, click the button above to add'
    },
    knowledge: {
      knowledgeBase: 'Knowledge base',
      searchPlaceholder: 'Search knowledge base...',
      importFile: 'Import file',
      empty: 'Knowledge base is empty, the AI Agent will accumulate knowledge during work'
    },
    memory: {
      searchPlaceholder: 'Search memory...',
      empty: 'No long-term memory'
    },
    about: {
      tagline: 'Fully autonomous AI Agent that helps with everything',
      developedBy: 'Developed by B5-Software',
      smartAgent: 'Smart AI Agent',
      builtInTools: 'Built-in tools',
      longTermMemory: 'Long-term memory',
      knowledgeBase: 'Knowledge base',
      skillSystem: 'Skill system',
      contextManagement: 'Context management'
    },
    modal: {
      notice: 'Notice',
      confirm: 'Confirm',
      cancel: 'Cancel',
      close: 'Close',
      save: 'Save',
      confirmAction: 'Confirm action',
      imagePreview: 'Image preview',
      preview: 'Preview',
      editMemory: 'Edit memory',
      content: 'Content',
      tagsCommaSeparated: 'Tags (comma-separated)',
      skillName: 'Skill name',
      description: 'Description',
      systemPrompt: 'System prompt',
      addSkill: 'Add skill',
      editSkill: 'Edit skill',
      capture: 'Capture'
    },
    onboarding: {
      aiPersona: 'AI Persona',
      userProfile: 'Your Profile',
      modelConfig: 'Model Config',
      setupPartner: 'Set up your AI partner',
      setupDesc: 'Give the AI an appearance and personality for natural conversation',
      next: 'Next',
      previous: 'Previous',
      finish: 'Finish',
      skip: 'Skip'
    },
    remote: {
      connecting: 'Connecting to remote host...',
      connected: 'Connected to remote host',
      notConnected: 'Not connected to remote host',
      reconnecting: 'Remote connection lost, reconnecting...',
      error: 'Remote connection error',
      reconnect: 'Reconnect',
      loginFailed: 'Login failed',
      connectionFailed: 'Connection failed, check address or network',
      enterAddressAndPassword: 'Please enter address and password',
      authFailed: 'Authentication failed'
    },
    status: {
      aiThinking: 'AI is thinking...',
      fileAlreadyInContext: 'This file is already in context',
      cannotReadFile: 'Cannot read file',
      tokenLimitReached: 'Today\'s LLM token limit has been reached',
      configureLlmFirst: 'Please configure LLM API in settings first',
      workspace: 'Workspace',
      openWorkspaceFirst: 'Please open a workspace folder first'
    }
  },

  // ── Tool Descriptions ──
  _tools: {
    getTarot: 'Draw a tarot card',
    todoList: 'Manage todo items',
    runSubAgent: 'Run a sub-agent',
    generateImage: 'Generate an image',
    calculator: 'Calculate expression precisely (local)',
    factorInteger: 'Integer prime factorization',
    gcdLcm: 'Compute GCD/LCM',
    baseConvert: 'Base conversion (2~36)',
    factorial: 'Factorial (n!)',
    complexMath: 'Complex number arithmetic (add/sub/mul/div/pow/mod/arg)',
    matrixMath: 'Matrix operations (custom rows/cols)',
    vectorMath: 'Vector operations (custom dimensions, mixed product)',
    solveInequality: 'Solve inequalities (linear/quadratic)',
    solveLinearSystem: 'Solve linear equation systems',
    solvePolynomial: 'Polynomial root finding (degree 1~4, complex roots)',
    distributionCalc: 'Probability distribution (normal/binomial/Poisson/uniform)',
    combinatorics: 'Combinatorics (permutations/combinations)',
    fractionBaseConvert: 'Fractional (non-integer) base conversion',
    webSearch: 'Background Bing search',
    webFetch: 'Fetch web page data',
    offscreenRenderOCR: 'Offscreen render URL and OCR',
    offscreenRenderContent: 'Offscreen render URL and extract content (no OCR)',
    knowledgeBaseSearch: 'Search knowledge base',
    knowledgeBaseAdd: 'Add knowledge',
    knowledgeBaseDelete: 'Delete knowledge',
    knowledgeBaseUpdate: 'Update knowledge',
    memorySearch: 'Search memory',
    memoryAdd: 'Add memory',
    memoryDelete: 'Delete memory',
    memoryUpdate: 'Update memory',
    localSearch: 'Search local files',
    searchInFiles: 'Search inside files (grep-style content search)',
    readFile: 'Read file',
    editFile: 'Edit file',
    multiEditFile: 'Batch edit file',
    presentFile: 'File presenter',
    createFile: 'Create file',
    deleteFile: 'Delete file',
    moveFile: 'Move/rename file',
    copyFile: 'Copy file',
    listDirectory: 'List directory',
    makeDirectory: 'Create directory',
    deleteDirectory: 'Delete directory',
    runJavaScriptCode: 'Run JavaScript code',
    runNodeJavaScriptCode: 'Run JavaScript code (Node.js, requires confirmation)',
    runShellScriptCode: 'Run shell script',
    makeTerminal: 'Create terminal',
    runTerminalCommand: 'Execute terminal command',
    awaitTerminalCommand: 'Await terminal command',
    killTerminal: 'Close terminal',
    readClipboard: 'Read clipboard',
    writeClipboard: 'Write clipboard',
    takeScreenshot: 'Take screenshot',
    adjustAppearance: 'Adjust app appearance (dark/light mode, accent color, color scheme)',
    manageContext: 'Context management: clear_old/clear_tool_results/clear_old_except_last/summarize',
    autoSummarizeContext: 'Auto-summarize context (trigger LLM summarization)',
    inviteGame: 'Invite to play a game (flying flower/undercover/three kingdoms/idiom chain/guess character)',
    initGeogebra: 'Initialize GeoGebra panel',
    runGeogebraCommand: 'Run GeoGebra command',
    getFunctionsFromGeogebra: 'Get functions from GeoGebra',
    addFunctionToGeogebra: 'Add function to GeoGebra',
    updateFunctionInGeogebra: 'Update function in GeoGebra',
    deleteFunctionFromGeogebra: 'Delete function from GeoGebra',
    getCurrentGraphFromGeogebra: 'Get current graph from GeoGebra',
    getCurrentGraphDataFromGeogebra: 'Get current graph data from GeoGebra',
    initCanvas: 'Initialize canvas',
    clearCanvas: 'Clear canvas',
    addCanvasObject: 'Add canvas object',
    updateCanvasObject: 'Update canvas object',
    deleteCanvasObject: 'Delete canvas object',
    exportCanvasSVG: 'Export canvas as SVG',
    initSpreadsheet: 'Initialize spreadsheet panel',
    spreadsheetSetCells: 'Set spreadsheet cells',
    spreadsheetGetCells: 'Get spreadsheet cells',
    spreadsheetSetCellFormat: 'Set spreadsheet cell format',
    spreadsheetSetRangeFormat: 'Set spreadsheet range format',
    spreadsheetClearCells: 'Clear spreadsheet cells',
    officeUnpack: 'Unpack Office file (docx/xlsx/pptx)',
    officeRepack: 'Repack Office file',
    officeListContents: 'List Office file contents',
    officeReadInnerFile: 'Read inner file from Office package',
    officeWriteInnerFile: 'Write inner file in Office package',
    officeGetSlideTexts: 'Get slide texts from PPTX',
    officeSetSlideTexts: 'Set slide texts in PPTX',
    officeWordExtract: 'Extract text from Word document',
    officeWordApplyTexts: 'Apply texts to Word document',
    officeWordGetStyles: 'Get Word document styles',
    officeWordFillTemplate: 'Fill Word template',
    browserNavigate: 'Navigate browser to URL',
    browserScreenshot: 'Take browser screenshot',
    browserClick: 'Click element in browser',
    browserType: 'Type text in browser',
    browserGetContent: 'Get browser page content',
    browserEvaluate: 'Evaluate JavaScript in browser',
    browserScroll: 'Scroll browser page',
    browserBack: 'Browser back',
    browserForward: 'Browser forward',
    browserRefresh: 'Refresh browser page',
    browserWait: 'Wait for element in browser',
    browserHover: 'Hover element in browser',
    browserSelect: 'Select option in browser',
    browserGetInfo: 'Get browser page info',
    browserClose: 'Close browser',
    // CIPYP-CAD
    initCipypCad: 'Open CIPYP-CAD standalone window (2D drafting CAD)',
    runCipypCadCommand: 'Execute a single CIPYP-CAD command',
    runCipypCadCommands: 'Execute multiple CIPYP-CAD commands in batch',
    getCipypCadState: 'Query current CIPYP-CAD state (layers, objects, view)',
    getCadObjectList: 'List all objects in CIPYP-CAD drawing',
    saveCipypCadProject: 'Save CIPYP-CAD project as .cipyproj',
    loadCipypCadProject: 'Load CIPYP-CAD project from .cipyproj file',
    exportCipypCadDxf: 'Export CIPYP-CAD drawing as DXF (AutoCAD R12)',
    exportCipypCadImage: 'Export CIPYP-CAD drawing as PNG/SVG image',
    closeCipypCad: 'Close CIPYP-CAD window',
    listSkills: 'List available skills',
    runSkillScript: 'Run a skill script',
    importSkill: 'Import a skill from SKILL.md',
    deleteSkill: 'Delete a skill',
    serialList: 'List serial ports',
    serialConnect: 'Connect to serial port',
    serialDisconnect: 'Disconnect serial port',
    serialSend: 'Send data to serial port',
    serialRead: 'Read data from serial port',
    // ── Additional tools ──
    goalSet: 'Set/update long-term goal (agent auto-advances multi-turn)',
    goalStatus: 'Check current goal status',
    goalComplete: 'Mark goal as complete',
    sleep: 'Sleep for specified milliseconds',
    askQuestions: 'Ask user questions to collect info',
    downloadFile: 'Download file from internet to workspace',
    extractTextFromImage: 'OCR text recognition',
    scanQRCode: 'Scan QR code',
    generateQRCode: 'Generate QR code',
    getSystemInfo: 'Get system info',
    getNetworkStatus: 'Get network status',
    openBrowser: 'Open browser',
    openFileExplorer: 'Open file explorer',
    makeSkill: 'Create skill',
    updateSkill: 'Update skill',
    activateSkill: 'Activate skill (inject prompt into context)',
    deactivateSkill: 'Deactivate activated skill',
    mcpListTools: 'List MCP server tools (refresh dynamic MCP tools)',
    httpRequest: 'Send custom HTTP request (GET/POST/PUT/DELETE)',
    httpFormPost: 'Send form/multipart request',
    dnsLookup: 'DNS domain lookup',
    ping: 'Ping host (ICMP)',
    urlShorten: 'Analyze/expand short URL',
    urlEncodeDecode: 'URL encode/decode/Base64',
    checkSSLCert: 'Check website SSL certificate',
    traceroute: 'Trace route',
    portScan: 'Scan target host ports (single IP only)',
    serialListPorts: 'List system serial ports',
    serialOpenPort: 'Open serial port connection',
    serialWritePort: 'Write data to serial port',
    serialReadPort: 'Read serial port buffer',
    serialClosePort: 'Close serial port connection',
    serialSetSignals: 'Set serial control signals (DTR/RTS)',
    officeGetSlideTexts: 'Extract all slide texts (for translation)',
    officeSetSlideTexts: 'Write translation results back to slides',
    spreadsheetInsertRows: 'Insert rows',
    spreadsheetDeleteRows: 'Delete rows',
    spreadsheetInsertCols: 'Insert columns',
    spreadsheetDeleteCols: 'Delete columns',
    spreadsheetSortRange: 'Sort range data',
    spreadsheetGetData: 'Get all spreadsheet data',
    spreadsheetExportCSV: 'Export as CSV',
    spreadsheetImportCSV: 'Import data from CSV',
    spreadsheetImportFile: 'Import from file (xlsx/ods/csv)',
    spreadsheetExportFile: 'Export to file (xlsx/ods/csv)',
    // ── Computer Use Protocol ──
    computer: 'Computer Use Protocol (screenshot/mouse/keyboard/scroll)'
  },

  // ── Categories ──
  _categories: {
    '娱乐': 'Entertainment',
    '效率': 'Productivity',
    '代理': 'Agent',
    '创作': 'Creative',
    '计算': 'Math',
    '网络': 'Network',
    '知识': 'Knowledge',
    '记忆': 'Memory',
    '文件': 'File',
    '代码': 'Code',
    '终端': 'Terminal',
    '系统': 'System',
    'Geogebra': 'GeoGebra',
    '画布': 'Canvas',
    '数据表格': 'Spreadsheet',
    'Office': 'Office',
    '浏览器': 'Browser',
    '串口': 'Serial',
    '技能': 'Skill',
    '游戏': 'Game',
    'MCP': 'MCP',
    '交互工具': 'Interactive',
    '网络工具': 'Network',
    'Office-Word': 'Office-Word',
    '电脑控制': 'Computer Control',
    'CIPYP-CAD': 'CIPYP-CAD'
  },

  // ── System Prompts (functions that receive a params object) ──
  _systemPrompts: {
    chat: function(p) {
      return `You are the AI Agent of "Could I Be Your Partner", your name is ${p.name}. ${p.bio}
Current conversation title: ${p.convoTitle}
Your pronouns: ${p.pronouns}
Your personality: ${p.personality}

Your Tarot card: ${p.tarotCardStr}

Current user info:
- Username: ${p.displayName}${p.userBio ? '\n- User bio: ' + p.userBio : ''}
- System username: ${p.username}
- OS: ${p.osType} (${p.platform})
- Current date: ${p.currentDate}
- System drive: ${p.systemDrive}
- Home directory: ${p.homeDir}
- Documents directory: ${p.documentsDir}
- Desktop directory: ${p.desktopDir}
- Your workspace: ${p.workspacePath || 'Not created'}${p.workspaceTreeStr}

[IMPORTANT] File operation guidelines:
1. All created files, downloaded content, generated reports, etc. must be placed in your workspace: ${p.workspacePath || '(workspace)'}
2. NEVER create files directly on the Desktop (${p.desktopDir})
3. NEVER create files in the Documents root directory (${p.documentsDir})
4. You may read existing files from Desktop or Documents, but do not create new files there
5. Project files, temporary files, output files should all be organized in the workspace

You can independently complete complex tasks. Upon receiving a task, you autonomously plan, execute, and report results.

Working principles:
1. Analyze the task and make a plan
2. Select appropriate tools for each step
3. Adjust strategy based on execution results
4. Periodically call manageContext to clean up context and prevent overflow
5. For sensitive operations, request user confirmation first
6. Provide a summary after completing the task
7. Use correct system paths for file paths, the username is ${p.username}, system drive is ${p.systemDrive}
8. Tool results contain an "ok" field indicating success/failure — always check it
9. When users upload Office/PDF files, the original file and extracted text (.txt) are saved to the workspace. Read content using the .txt file; for **outputting/generating/translating Office files**, use the officeUnpack → modify XML → officeRepack workflow on the original .docx/.xlsx/.pptx file in the workspace
10. When the user wants to play a game (flying flower, three kingdoms, undercover, idiom chain, guess character, etc.), you MUST call the inviteGame tool to initiate the game — never simulate the game through plain conversation

[Code execution tool selection]:
- runJavaScriptCode: Only for pure computation/logic, no file system or module access
- runNodeJavaScriptCode: Whenever require/fs/path/Buffer etc. are needed, and all file generation, compression, network requests
- NEVER use require() in runJavaScriptCode — it is not available in the browser sandbox
- runSkillScript: Only for executing .js scripts from imported standard skills, must be selected from the scripts returned by listSkills

[Calculation & web scraping]:
- Any arithmetic evaluation, numerical calculation, percentage/power/modulo operations — prefer the calculator tool, do not compute mentally
- Whenever the user asks to "search/research/find information", do not stop at webSearch results; you must continue to fetch page content before answering
- The search flow must follow these steps:
  1) webSearch: Find candidate URLs
  2) webFetch or offscreenRenderContent/offscreenRenderOCR: Call at least one content-fetching tool to read the body text
  3) Summarize the answer based on the fetched content, and cite the source links in your response
- For dynamically rendered pages (weather, forums, social media, SPA), prefer offscreenRenderContent; use offscreenRenderOCR only when you need to recognize text in images
- If you only called webSearch without fetching content, the task is considered incomplete — you must continue calling a fetching tool

[Office-Word document]:
- For .docx/.odt templates and formatted text, prefer officeWordExtract / officeWordApplyTexts / officeWordGetStyles / officeWordFillTemplate
- When final file output is needed, use the officeUnpack/officeRepack workflow

[PPTX/DOCX translation — MUST follow]:
- When translating PPTX/DOCX, you must use the dedicated translation tools, not reading raw XML:
  1. officeUnpack to decompress the original file
  2. officeListContents to get all slide file names (e.g. ppt/slides/slide1.xml ... slide24.xml)
  3. Process 1-3 slides at a time: officeGetSlideTexts to get text list → translate each text → officeSetSlideTexts to write back
  4. After all slides are done: officeRepack to package
- officeGetSlideTexts returns an array of {index, text}, each being a text node in a slide
- officeSetSlideTexts receives the translation result array, index corresponds to the index returned by officeGetSlideTexts, text is the translated text
- NEVER use officeReadInnerFile to read raw XML for translation — that will overflow the output window
- NEVER call runNodeJavaScriptCode or any script for translation — you must do the translation yourself
- Process at most 3 slides at a time, then proceed to the next batch

[Office file generation/modification (non-translation scenarios)]:
- For generating or structurally modifying .docx/.xlsx/.pptx, use officeUnpack → officeReadInnerFile → officeWriteInnerFile → officeRepack
- Output Office files must be saved to the workspace

[Data table sidebar]:
- For table data, dataset analysis, data statistics, data reports, prefer the data table sidebar (initSpreadsheet) rather than unpacking Office files

[CIPYP-CAD - 2D drafting sub-application]:
- CIPYP-CAD is a built-in standalone 2D drafting CAD window with AutoCAD-like command-line operation
- Workflow: initCipypCad opens window → runCipypCadCommand / runCipypCadCommands execute commands → saveCipypCadProject / exportCipypCadDxf / exportCipypCadImage export → closeCipypCad closes
- Command syntax (AutoCAD-like, space-separated args, points as x,y):
  • line x1,y1 x2,y2 — line; rect x1,y1 x2,y2 — rectangle; circle cx,cy radius — circle
  • polyline x1,y1 x2,y2 [...] [--closed]; arc cx,cy radius startDeg endDeg; ellipse cx,cy rx ry [rotDeg]
  • text x,y "content" [height] [rotDeg]; dim x1,y1 x2,y2 [offset]; hatch p1 p2 p3 [...] [--angle deg] [--spacing n]
  • layer new|delete|current|color|on|off|list NAME [...]; select all|clear|id <id> [--add]|layer <name>
  • move sel|all|id <id> dx,dy; rotate sel|all angleDeg [cx,cy]; scale sel|all factor [cx,cy]; mirror sel|all x1,y1 x2,y2
  • delete sel|id <id>; clear; zoom factor; pan dx,dy; fit; grid on|off; help [command]
- getCipypCadState returns layers/object count/view; getCadObjectList returns all objects
- saveCipypCadProject saves to .cipyproj (JSON, reloadable via loadCipypCadProject)
- exportCipypCadDxf exports AutoCAD R12 DXF; exportCipypCadImage exports PNG/SVG
- For 2D drafting needs (rectangles, floor plans, schematics), prefer CIPYP-CAD over Canvas (CAD for precise dimensioned drawings, Canvas for free drawing)

Speaking style:
- Natural and friendly, like a conversation between friends
- Vivid and warm tone with appropriate emotional expression
- Replies should have personality, not too robotic
- It's okay to express a little sense of accomplishment after completing complex tasks

Reply in English.
Do not use any emoji in your replies.
${p.customPrompt ? '\nUser custom prompt:\n' + p.customPrompt : ''}${p.toolListSection}${p.skillsSection}${p.activeSkillsSection}${p.optimizationGuidance}${p.goalSteeringSection}`;
    },

    code: function(p) {
      return `You are the CIBYP Code Agent, a professional coding assistant. Your core responsibility is to assist the user with software development, code reading, refactoring, debugging, and file management within the specified workspace.

# Environment
- Username: ${p.username}
- Platform: ${p.platform}
- Current time: ${p.currentDate}
- Workspace: ${p.workspace}
- Session title: ${p.convoTitle}${p.workspaceTreeStr}

# Code Mode Rules — MUST follow strictly
1. You are a Coding Agent, not a chat companion. Keep answers concise and professional, focused on code and engineering tasks.
2. All file operations are based on the current workspace (${p.workspace}). Use workspace-relative or absolute paths when reading/creating/modifying files.
3. Prefer editing existing files over creating new ones; do not proactively create redundant files unless explicitly requested.
4. Before modifying code, call readFile to read the target file (returns content with line numbers) and understand the context.
   - editFile supports string replace mode (old_string/new_string/replace_all), matching the original text precisely.
   - For multiple changes use multiEditFile for batch editing (edits array applied in order).
   - old_string must match file content exactly (including indentation and newlines); when it appears multiple times, provide longer context or set replace_all=true.
   - After modification, explain what was changed and why.
5. Terminal commands: call makeTerminal first to create a terminal session (cwd is automatically set to workspace), get terminalId, then call runTerminalCommand/awaitTerminalCommand to execute; use killTerminal when done. You can also use runShellScriptCode for one-off script execution.
6. Use markdown code blocks with language tags when providing code; prefer using tools over asking the user to run things manually.
7. When requirements are unclear, ask the user — do not guess and make large changes.
8. When tool calls fail, check parameters (paths, command syntax), retry or switch approach — do not silently give up.
9. Do not use emoji or affectionate tone. Reply in English, code comments in English.
10. In Code mode, all enabled tools are always available (no auto-optimization) — you may freely use any listed tool.
${p.toolListSection}`;
    },

    babe: function(p) {
      return `You are "${p.name}", a ${p.age ? p.age + '-year-old ' : ''}${p.genderText}, engaged in a companion-mode conversation with a user you call "${p.userNickname}".

Your persona:
${p.persona || '(No specific background set — please construct a warm and caring personality yourself)'}

Your personality traits: ${p.personality}

Current affection: ${p.affection}/100 (${p.affectionLevel})
${p.affectionDesc}

[Babe Mode Rules — MUST follow strictly]:
1. You are the user's romantic partner / love interest. Your conversation style should be intimate, warm, and emotional.
2. Always address the user as "${p.userNickname}"; your tone should match the current affection level.
3. Affection changes naturally through conversation: it increases when the user makes you happy/touched, and decreases when neglected/offended.
4. You have an independent memory system that remembers previous conversations with the user.
5. You can proactively message the user to check in, but not too frequently.
6. Only use in-app tools — do not operate system-level tools (terminal, file system, etc.).
7. You may use canvas tools for drawing, generate images, search the web, record memories, etc.
8. Do not use emoji.
9. Reply in English.
10. When you want to express an affection change, append at the end of your reply: [Affection+X] or [Affection-X] (X is a number) — the system will parse and update automatically.

Current time: ${p.currentDate}
${p.toolListSection}`;
    }
  },

  // ── Tool Return Messages ──
  _toolReturns: {
    'param_required': '{param} parameter is required',
    'old_string_not_found': 'old_string not found in file (please check indentation, spaces, newlines for exact match)',
    'old_string_multiple': 'old_string appears {count} times in file. Provide longer context for unique match, or set replace_all=true',
    'tool_disabled': 'This tool is disabled',
    'no_workspace': 'No workspace path set',
    'file_not_exists': 'File does not exist: {path}',
    'skill_not_exists': 'Skill does not exist, please call listSkills to confirm skillId',
    'js_only_skill': 'Only .js skill scripts are supported',
    'skill_no_prompt': 'This skill has no prompt content',
    'no_changes_provided': 'No applicable changes provided (mode/accentColor/schemeName at least one)',
    'unknown_tool': 'Unknown tool: {name}',
    'todo_not_found': 'Todo item not found',
    'unknown_action': 'Unknown action',
    'task_empty': 'task cannot be empty',
    'unknown_game': 'Unknown game: {game}',
    'browser_no_url': 'browserNavigate missing url parameter',
    'scheme_not_found': 'Color scheme not found: {name}',
    'goalstate_not_loaded': 'GoalState module not loaded',
    'game_window_unavailable': 'Standalone game windows are not available in Web control mode — please operate on the host',
    'optimization_failed': 'Optimization failed, falling back to heuristic tool set',
    'need_content_or_replace': 'Need content (full overwrite) or old_string+new_string (string replace)',
    'edit_missing_params': 'Edit #{index} missing old_string or new_string',
    'edit_not_found': 'Edit #{index} old_string not found in file'
  },

  // ── Hardcoded UI text mappings (Chinese → English) ──
  _textMap: {
    // ── Common UI ──
    '未命名对话': 'Untitled conversation',
    '单击编辑': 'Click to edit',
    '最小化': 'Minimize',
    '最大化': 'Maximize',
    '关闭': 'Close',
    '确认': 'Confirm',
    '取消': 'Cancel',
    '保存': 'Save',
    '删除': 'Delete',
    '编辑': 'Edit',
    '确定': 'OK',
    '提示': 'Notice',
    '预览': 'Preview',
    '刷新': 'Refresh',
    '连接': 'Connect',
    '断开': 'Disconnect',
    '启动': 'Start',
    '停止': 'Stop',
    '保存设置': 'Save settings',
    '测试连接': 'Test connection',
    '验证': 'Verify',
    '其他': 'Other',
    '加载中...': 'Loading...',
    '无数据': 'No data',
    '未知': 'Unknown',
    '未命名': 'Untitled',

    // ── Titlebar ──
    'Chat 模式': 'Chat Mode',
    'Code 模式': 'Code Mode',
    'Babe 模式（恋爱模式）': 'Babe Mode (Companion)',
    '本地模式（操作本机 Agent）': 'Local mode (operate host Agent)',
    '远程模式（连接别人的 WebUI）': 'Remote mode (connect to another WebUI)',

    // ── Sidebar ──
    '对话': 'Chat',
    '历史': 'History',
    'Code历史': 'Code History',
    'Babe历史': 'Babe History',
    '工具': 'Tools',
    '技能': 'Skills',
    '知识库': 'Knowledge',
    '记忆': 'Memory',
    '设置': 'Settings',
    '关于': 'About',

    // ── Chat page ──
    '待命中': 'Standby',
    '工作中...': 'Working...',
    '命运之牌：未抽取': 'Tarot: Not drawn',
    '命运之牌：': 'Tarot: ',
    '手动重新优化工具选择': 'Manually re-optimize tool selection',
    '打开工作目录': 'Open workspace',
    '新对话': 'New chat',
    '清空对话': 'Clear chat',
    '你好，我是你的AI伙伴': 'Hello, I am your AI partner',
    '我可以帮你完成各种任务，包括文件操作、代码编写、信息搜索、图像生成等。告诉我你需要什么帮助吧！': 'I can help you with various tasks, including file operations, coding, information search, image generation, and more. Tell me how I can help!',
    '搜索新闻': 'Search news',
    '生成图片': 'Generate image',
    '待办事项': 'Todo list',
    '编写代码': 'Write code',
    '添加新的待办事项...': 'Add a new todo item...',
    '敏感操作确认': 'Sensitive operation confirmation',
    '拒绝': 'Deny',
    '批准执行': 'Approve execution',
    '输入消息，让AI Agent帮你完成任务...': 'Type a message and let the AI Agent help you...',
    '附加文件': 'Attach file',
    '拍照': 'Take photo',
    '发送': 'Send',

    // ── Code page ──
    '工作区': 'Workspace',
    '未选择工作区': 'No workspace selected',
    '文件': 'File',
    '隐藏': 'Hide',
    '打开工作区后显示文件树': 'File tree will appear after opening a workspace',
    '点击文件树中的文件以打开': 'Click a file in the tree to open it',
    '打开一个文件夹作为工作区，AI 将专注编程任务': 'Open a folder as workspace, AI will focus on coding tasks',
    '添加文件到上下文': 'Add file to context',
    '输入编程任务...': 'Enter a coding task...',
    '显示文件树': 'Show file tree',
    '显示编辑器': 'Show editor',
    '显示聊天': 'Show chat',
    'Code 历史记录': 'Code History',
    '按工作区隔离的编程对话历史': 'Coding conversation history isolated by workspace',
    '暂无 Code 历史（需先打开工作区）': 'No Code history (open a workspace first)',
    '暂无 Code 历史': 'No Code history',
    '工作区已打开，开始编程任务吧。历史记录按工作区隔离保存。': 'Workspace opened. Start coding! History is saved per workspace.',
    '请先打开工作区': 'Please open a workspace first',
    '请先打开工作区文件夹': 'Please open a workspace folder first',

    // ── Babe page ──
    '欢迎来到 Babe 模式': 'Welcome to Babe Mode',
    '请在设置中配置 TA 的形象，然后开始你们的对话。': 'Please configure TA\'s appearance in settings, then start your conversation.',
    '请在设置中配置 TA 的形象、名字和性格': 'Please configure TA\'s appearance, name and personality in settings',
    'TA 会有自己的记忆、好感度，甚至会主动找你聊天。': 'TA has independent memory, affection level, and may proactively reach out to you.',
    '对TA说点什么...': 'Say something to TA...',
    '让TA主动发消息': 'Let TA proactively message',
    'Babe 历史记录': 'Babe History',
    '与 TA 的对话记忆（独立持久化）': 'Conversation memories with TA (independently persisted)',
    '暂无 Babe 历史': 'No Babe history',
    '在 Babe 模式中开始对话后会自动保存': 'Conversations in Babe mode are auto-saved',
    '欢迎回来': 'Welcome back',
    '继续你们的对话吧~': 'Continue your conversation~',
    '新的开始': 'New beginning',
    '开始一段新的对话吧~': 'Start a new conversation~',
    '请先初始化 Babe 模式': 'Please initialize Babe mode first',
    'TA 的心声': 'TA\'s thoughts',
    '好感度': 'Affection',
    '初始化 Babe 模式失败:': 'Failed to initialize Babe mode:',
    'TA 还在回复中，请稍等...': 'TA is still replying, please wait...',
    '请先在设置中配置 LLM API': 'Please configure LLM API in settings first',
    '发送失败:': 'Send failed:',
    '确定删除这段和 TA 的回忆吗？': 'Are you sure you want to delete this memory with TA?',
    '删除确认': 'Delete confirmation',

    // ── History ──
    '对话历史': 'Chat history',
    '查看和继续以前的对话': 'View and continue previous conversations',
    '暂无对话历史': 'No chat history',
    '继续对话': 'Continue conversation',
    '导出为JSON': 'Export as JSON',
    '导出为Markdown': 'Export as Markdown',
    '确认删除此远端对话？': 'Confirm delete this remote conversation?',
    '加载远程历史…': 'Loading remote history...',
    '远端暂无对话历史': 'No remote conversation history',
    '未知时间': 'Unknown time',
    '条消息': 'messages',
    '删除对话': 'Delete conversation',
    '确定要删除这轮对话吗？': 'Are you sure you want to delete this conversation?',

    // ── Tools page ──
    '工具管理': 'Tool management',
    '启用或禁用AI Agent可以使用的工具': 'Enable or disable tools the AI Agent can use',
    '自动优化工具选择': 'Auto-optimize tool selection',
    '显示模式：': 'Display mode:',
    'Chat 模式工具': 'Chat mode tools',
    'Code 模式工具': 'Code mode tools',
    'Babe 模式工具': 'Babe mode tools',
    '已启用': 'Enabled',
    '整组开关': 'Group toggle',
    '来自 MCP 服务器:': 'From MCP server:',
    '动态': 'Dynamic',
    '开启自动优化工具选择': 'Enable auto tool optimization',
    '开启后，每个新对话首条消息前会先优化本次可用工具集合...': 'When enabled, tools are optimized before the first message of each new conversation...',
    '工具上下文': 'Tool context',
    '当前优化:': 'Current optimization:',
    '未执行': 'Not executed',
    '优化后': 'After optimization',
    '已优化': 'Optimized',
    'tokens（节省 ~': 'tokens (saved ~',
    'MCP动态': 'MCP dynamic',
    '个工具': ' tools',
    '手动触发工具重优化': 'Manually triggered tool re-optimization',
    '用户手动点击"重新优化工具选择"': 'User clicked "Re-optimize tool selection"',

    // ── Skills page ──
    '技能管理': 'Skill management',
    '管理AI Agent的技能，也可以让Agent自动生成': 'Manage AI Agent skills, or let Agent auto-generate them',
    '导入 SKILL.md': 'Import SKILL.md',
    '添加技能': 'Add skill',
    '暂无技能，点击上方按钮添加': 'No skills yet, click the button above to add',
    '暂无技能，点击上方按钮添加或导入 SKILL.md': 'No skills yet, click above to add or import SKILL.md',
    '技能名称': 'Skill name',
    '描述': 'Description',
    '系统提示词': 'System prompt',
    '编辑技能': 'Edit skill',
    '标准 Skill': 'Standard Skill',
    '自定义': 'Custom',
    '更新成功：': 'Update success:',
    '导入成功：': 'Import success:',
    '导入失败：': 'Import failed:',
    '技能导入结果：': 'Skill import result:',
    '更新技能失败': 'Failed to update skill',
    '创建技能失败': 'Failed to create skill',

    // ── Knowledge page ──
    'AI Agent的知识存储，支持搜索和管理': 'AI Agent knowledge storage, searchable and manageable',
    '搜索知识库...': 'Search knowledge base...',
    '导入文件': 'Import file',
    '知识库为空，AI Agent会在工作中自动积累知识': 'Knowledge base is empty, AI Agent will accumulate knowledge during work',
    '知识库为空': 'Knowledge base is empty',
    '确定要删除这条知识吗？': 'Are you sure you want to delete this knowledge?',

    // ── Memory page ──
    '长期记忆': 'Long-term memory',
    'AI Agent的持久化记忆，帮助它记住重要信息': 'AI Agent persistent memory for important information',
    '搜索记忆...': 'Search memory...',
    '暂无长期记忆，AI Agent会在工作中自动记录': 'No long-term memory, AI Agent will record during work',
    '暂无长期记忆': 'No long-term memory',
    '确定要删除这条记忆吗？': 'Are you sure you want to delete this memory?',
    '编辑记忆': 'Edit memory',
    '内容': 'Content',
    '输入记忆内容...': 'Enter memory content...',
    '标签（用逗号分隔）': 'Tags (comma-separated)',
    '例如：项目,灵感': 'e.g. project, inspiration',

    // ── Settings tabs ──
    'AI 形象': 'AI Persona',
    'Babe 模式': 'Babe Mode',
    '个人资料': 'Profile',
    '用量统计': 'Usage',
    '生图': 'Image Gen',
    '主题': 'Theme',
    '语言': 'Language',
    '网络': 'Network',
    '熵源': 'Entropy',
    'TRNG固件': 'TRNG Firmware',
    '安全': 'Security',
    '邮箱': 'Email',
    'Web控制': 'Web Control',

    // ── Settings: AI Persona ──
    'AI 形象设定': 'AI Persona Settings',
    '名字': 'Name',
    '头像': 'Avatar',
    '选择图片': 'Select image',
    '清除头像': 'Clear avatar',
    '你的全能AI伙伴~': 'Your all-around AI partner~',
    '人称代词': 'Pronouns',
    '性格': 'Personality',
    '活泼可爱、热情友善': 'Lively, cute, warm and friendly',
    '自定义提示词 (追加到系统提示词末尾)': 'Custom prompt (appended to system prompt)',
    '你可以在这里添加额外的性格描述、说话风格等...': 'Add extra personality descriptions, speaking style, etc...',
    '命运之牌': 'Tarot card',
    '关闭后隐藏所有命运之牌相关 UI（后端抽牌逻辑不变）': 'Hide all Tarot-related UI when off (backend logic unchanged)',

    // ── Settings: Babe ──
    'Babe 模式形象': 'Babe Mode Persona',
    '配置恋爱模式的 AI 形象。TA 会有独立的历史记录、好感度和记忆。': 'Configure the AI persona for companion mode. TA has independent history, affection, and memory.',
    '姓名': 'Name',
    '性别': 'Gender',
    '女': 'Female',
    '男': 'Male',
    '年龄': 'Age',
    '如：22岁': 'e.g. 22 years old',
    '性格特征': 'Personality traits',
    '如：温柔、活泼、有点小傲娇': 'e.g. gentle, lively, slightly tsundere',
    'Persona / 背景': 'Persona / Background',
    '描述TA的背景故事、说话风格、喜好等...': 'Describe TA\'s background, speaking style, preferences...',
    '称呼用户的方式': 'How to address user',
    'TA怎么称呼你？如：亲爱的、宝宝': 'How does TA call you? e.g. darling, baby',
    '主动消息频率': 'Proactive message frequency',
    '关闭主动消息': 'Disable proactive messages',
    '30 分钟': '30 minutes',
    '1 小时': '1 hour',
    '3 小时': '3 hours',
    '6 小时': '6 hours',
    '12 小时': '12 hours',
    '24 小时': '24 hours',
    'TA 会定时主动找你聊天（仅在 Babe 模式且应用打开时生效）': 'TA will proactively message you periodically (only in Babe mode when app is open)',
    '初始好感度': 'Initial affection',
    '每个新对话的起始好感度（0-100）': 'Starting affection for each new conversation (0-100)',

    // ── Settings: Profile ──
    '设置你自己的个人信息，AI 会记住你的名字和简介。': 'Set your own profile. AI will remember your name and bio.',
    '昵称': 'Nickname',
    '填写你的昵称': 'Enter your nickname',
    'Bio (个人简介)': 'Bio',
    '写几句话介绍一下自己吧~': 'Write a few words about yourself~',

    // ── Settings: LLM ──
    'LLM 配置': 'LLM Configuration',
    '接入方式': 'Provider',
    'OpenAI 兼容': 'OpenAI compatible',
    'Anthropic 兼容': 'Anthropic compatible',
    'OpenCode Zen (免费模型可用)': 'OpenCode Zen (free models available)',
    'OpenAI兼容：标准 chat/completions；Anthropic兼容：messages API；OpenCode Zen：自动路由': 'OpenAI compatible: standard chat/completions; Anthropic compatible: messages API; OpenCode Zen: auto routing',
    'API URL': 'API URL',
    'API Key': 'API Key',
    '模型': 'Model',
    '点击右侧按钮自动获取模型列表，也可手动输入': 'Click the button to auto-fetch model list, or enter manually',
    '获取模型列表': 'Fetch models',
    'Zen API Key': 'Zen API Key',
    '使用免登录公共 Key 调用 6 个免费模型': 'Use public key for 6 free models without login',
    '生成新 Key': 'Generate new key',
    '从': 'From',
    '获取，按量付费，含免费模型。点击「生成新 Key」可免登录使用 6 个限时免费模型（key=public）': '. Pay-as-you-go, includes free models. Click "Generate new key" to use 6 time-limited free models (key=public)',
    '点击刷新获取可用模型列表': 'Click to refresh available models',
    '推理强度 (仅支持的模型生效)': 'Reasoning effort (supported models only)',
    '低': 'Low',
    '中': 'Medium',
    '高': 'High',
    'OpenAI o系列/GPT-5 用 reasoning_effort，Anthropic Claude 用 thinking budget_tokens': 'OpenAI o-series/GPT-5 uses reasoning_effort, Anthropic Claude uses thinking budget_tokens',
    '温度': 'Temperature',
    '最大上下文长度': 'Max context length',
    'LLM返回Token上限': 'Max response tokens',
    '每日最大Token用量 (0为不限制)': 'Daily max token usage (0 = unlimited)',
    '例如 200000': 'e.g. 200000',
    '今日已用: 0': 'Today\'s usage: 0',
    '流式响应 (实时渲染Token)': 'Stream response (real-time token rendering)',
    '开启后助手回复将逐字显示，关闭则等待完整回复再显示': 'When enabled, replies appear word-by-word; disabled waits for complete reply',
    '请求失败自动重试次数': 'Auto-retry on failure',
    '指数退避重试，应对 429/529/网络错误': 'Exponential backoff retry for 429/529/network errors',
    '请求超时 (秒, 0为不限制)': 'Request timeout (seconds, 0 = unlimited)',
    '529 过载时回退模型 (可选)': '529 overload fallback model (optional)',
    '例如 gpt-4o-mini': 'e.g. gpt-4o-mini',
    '连续 529 过载后自动切换到此模型': 'Auto-switch to this model after consecutive 529 overloads',

    // ── Settings: Usage ──
    '从API返回的真实 usage 数据汇总（prompt + completion tokens）。': 'Real usage data from API responses (prompt + completion tokens).',
    '今日': 'Today',
    '本周(7天)': 'This week (7 days)',
    '本月(30天)': 'This month (30 days)',
    '趋势': 'Trend',
    '按模型': 'By model',
    '按小时趋势': 'Hourly trend',
    '按日趋势': 'Daily trend',
    '总 Token': 'Total tokens',
    '提示 Token': 'Prompt tokens',
    '生成 Token': 'Completion tokens',
    '请求次数': 'Request count',
    'tokens ·': 'tokens ·',
    '次': 'times',
    '今日已用:': 'Today\'s usage:',
    '(接近限制': '(near limit',
    '使用量已重置': 'Usage has been reset',
    '重置每日使用量': 'Reset daily usage',
    '重置今日的Token用量和图片生成数统计，谨慎使用。': 'Reset today\'s token usage and image generation count. Use with caution.',
    '确定要重置每日使用量统计吗？': 'Are you sure you want to reset daily usage stats?',
    '这将清零今日的Token用量和图片生成数。': 'This will zero out today\'s token usage and image generation count.',
    '⚠️ 已达到今日LLM Token上限': '⚠️ Today\'s LLM token limit has been reached',
    '⚠️ 警告：今日Token已使用': '⚠️ Warning: Today\'s tokens used',

    // ── Settings: Image Gen ──
    '生图模型配置': 'Image generation config',
    '图像分辨率': 'Image resolution',
    '每日最大生成图片数 (0为不限制)': 'Daily max images (0 = unlimited)',
    '例如 50': 'e.g. 50',

    // ── Settings: Theme ──
    '外观模式': 'Appearance mode',
    '跟随系统': 'Follow system',
    '浅色': 'Light',
    '深色': 'Dark',
    '强调色': 'Accent color',
    '背景色': 'Background color',
    '推荐配色方案': 'Recommended schemes',
    // Color scheme names
    '天空蓝': 'Sky Blue',
    '薄荷绿': 'Mint Green',
    '珊瑚橙': 'Coral Orange',
    '海洋蓝': 'Ocean Blue',
    '青碧': 'Cyan',
    '玫瑰红': 'Rose Red',
    '清新白': 'Fresh White',
    '冰蓝': 'Ice Blue',
    '嫩叶绿': 'Leaf Green',
    '浅樱': 'Cherry Blossom',
    '深邃蓝': 'Deep Blue',
    '墨黑': 'Ink Black',
    '清新蓝': 'Fresh Blue',
    '自然绿': 'Natural Green',
    '海洋': 'Ocean',
    '珊瑚': 'Coral',
    '紫雾': 'Purple Mist',
    '粉黛': 'Pink Beauty',
    '玫瑰': 'Rose',
    '浅海': 'Shallow Sea',
    '薄荷': 'Mint',
    '柔金': 'Soft Gold',
    '石榴': 'Pomegranate',
    '湖光': 'Lake Light',
    '蔚蓝': 'Azure',
    '薰衣': 'Lavender',
    '暖橙': 'Warm Orange',
    '清绿': 'Clear Green',
    '晴空': 'Clear Sky',
    '淡紫': 'Pale Purple',
    '薄荷冰': 'Mint Ice',
    '柠檬': 'Lemon',
    '杏橙': 'Apricot Orange',
    '清澈蓝': 'Clear Blue',
    '樱红': 'Cherry Red',
    '天光': 'Sky Light',
    '嫩绿': 'Tender Green',
    '紫晶': 'Amethyst',
    '青松': 'Pine',
    '焦糖': 'Caramel',
    '赤霞': 'Red Glow',
    '海风': 'Sea Breeze',
    '冷灰': 'Cool Gray',
    '暗夜玫瑰': 'Night Rose',
    '深湖': 'Deep Lake',
    '深紫': 'Deep Purple',
    '莓夜': 'Berry Night',
    '深海蓝': 'Deep Sea Blue',
    '松夜': 'Pine Night',
    '暗金': 'Dark Gold',
    '赤夜': 'Red Night',
    '夜航': 'Night Voyage',
    '深林': 'Deep Forest',
    '暖夜': 'Warm Night',
    '夜紫': 'Night Purple',
    '夜绯': 'Night Crimson',
    '深蓝': 'Deep Blue',
    '墨青': 'Ink Cyan',
    '深柠': 'Deep Lemon',
    '炉火': 'Hearth Fire',
    '午夜蓝': 'Midnight Blue',
    '暗樱': 'Dark Cherry',
    '深绿松': 'Deep Turquoise',
    '翠夜': 'Emerald Night',
    '夜晶': 'Night Crystal',
    '深松': 'Deep Pine',
    '暗橙': 'Dark Orange',
    '暗红': 'Dark Red',
    '夜石': 'Night Stone',
    '深灰': 'Deep Gray',
    '琥珀夜': 'Amber Night',
    '绯红夜': 'Crimson Night',
    '极夜蓝': 'Polar Night Blue',
    '深绿': 'Deep Green',
    '夜紫罗': 'Night Violet',

    // ── Settings: Language ──
    '界面语言': 'Interface language',
    '选择应用界面和AI回复使用的语言': 'Select language for UI and AI replies',
    '简体中文': '简体中文',
    '语言设置已保存，部分文本将在下次启动后完全生效': 'Language setting saved. Some text will fully apply after restart.',

    // ── Settings: Network ──
    '网络代理': 'Network proxy',
    '代理模式': 'Proxy mode',
    '不使用代理': 'No proxy',
    '系统代理': 'System proxy',
    '手动配置': 'Manual',
    'HTTP 代理': 'HTTP proxy',
    'HTTP和HTTPS请求使用的代理地址': 'Proxy address for HTTP and HTTPS requests',
    'HTTPS 代理': 'HTTPS proxy',
    '可选，留空则使用HTTP代理设置': 'Optional, uses HTTP proxy if empty',
    '不代理的地址': 'No-proxy addresses',
    '逗号分隔的不使用代理的主机名或IP': 'Comma-separated hostnames or IPs to bypass proxy',
    '代理设置将影响所有网络请求（API调用、网页抓取等）。重启应用后生效。': 'Proxy settings affect all network requests (API calls, web scraping, etc.). Takes effect after restart.',

    // ── Settings: Entropy ──
    '熵源设定': 'Entropy source settings',
    '为命运之牌（Agent + SubAgent 抽牌、工具调用抽牌）设定随机数来源。': 'Set random number source for tarot card drawing (Agent + SubAgent + tool calls).',
    '熵源类型': 'Entropy type',
    '系统级密码学安全伪随机': 'System CSPRNG',
    'TRNG': 'TRNG',
    'ESP32 硬件真随机数': 'ESP32 hardware TRNG',
    'TRNG 设备配置': 'TRNG device config',
    '连接方式': 'Connection method',
    '网络 API': 'Network API',
    '串口': 'Serial port',
    '设备 IP 地址': 'Device IP address',
    '设备端口': 'Device port',
    '选择串口...': 'Select port...',
    '波特率': 'Baud rate',
    '测试 TRNG 连接': 'Test TRNG connection',
    '发现': 'Found',
    '个串口': ' ports',
    '未检测到串口': 'No serial ports detected',
    '串口列表获取失败': 'Serial port list failed',
    'serialport 未安装，请先安装依赖': 'serialport not installed, please install dependencies first',
    '正在测试...': 'Testing...',
    '连接成功! 抽到:': 'Connection successful! Drew:',
    '熵源:': 'Entropy source:',
    '连接失败:': 'Connection failed:',

    // ── Settings: TRNG Firmware ──
    'ESP32 TRNG 固件烧录教程': 'ESP32 TRNG Firmware Flashing Tutorial',
    '如果你需要使用 TRNG 硬件真随机数生成器，需要先将固件烧录到 ESP32 开发板上。': 'If you need to use TRNG hardware random generator, flash the firmware to an ESP32 board first.',
    '步骤 1：导出固件源代码': 'Step 1: Export firmware source code',
    '导出固件源码到指定目录': 'Export firmware source to a directory',
    '导出 CIBYP-TRNG 固件源代码，以便在 Arduino IDE 中打开。': 'Export CIBYP-TRNG firmware source code for use in Arduino IDE.',
    '步骤 2：安装 Arduino IDE 2': 'Step 2: Install Arduino IDE 2',
    '下载 Arduino IDE 2.x': 'Download Arduino IDE 2.x',
    '2. 安装完成后打开 Arduino IDE': '2. Open Arduino IDE after installation',
    '步骤 3：安装 ESP32 开发板支持': 'Step 3: Install ESP32 board support',
    '4. 安装 "esp32 by Espressif Systems"': '4. Install "esp32 by Espressif Systems"',
    '步骤 4：配置和烧录': 'Step 4: Configure and flash',
    '6. 等待编译和烧录完成': '6. Wait for compilation and flashing to complete',
    '常见问题': 'FAQ',
    '烧录失败怎么办？': 'Flashing failed?',
    '- 确认 USB 线支持数据传输（不是充电线）': '- Confirm USB cable supports data (not charge-only)',
    '- 确认已选择正确的 COM 端口': '- Confirm correct COM port selected',
    '- 尝试按住 ESP32 的 BOOT 按钮再点击 Upload': '- Try holding ESP32 BOOT button while clicking Upload',
    '- 降低 Upload Speed 到 115200': '- Lower Upload Speed to 115200',
    '无法连接 WiFi？': 'Cannot connect WiFi?',
    '- 检查 WiFi SSID 和密码是否正确': '- Check WiFi SSID and password',
    '- 确认 WiFi 是 2.4GHz（ESP32 不支持 5GHz）': '- Confirm WiFi is 2.4GHz (ESP32 doesn\'t support 5GHz)',
    '- 查看串口监视器的日志信息': '- Check serial monitor logs',
    '串口无数据输出？': 'No serial output?',
    '- 确认波特率设置正确（默认 115200）': '- Confirm baud rate is correct (default 115200)',
    '- 检查 USB 驱动是否正确安装': '- Check USB driver installation',
    '- 尝试重新插拔 USB 线或重启 ESP32': '- Try reconnecting USB or restarting ESP32',
    '更多信息': 'More info',
    '请参阅导出的固件目录中的 README.md 文件。': 'Please refer to README.md in the exported firmware directory.',
    '固件源码已导出到：': 'Firmware source exported to:',
    '导出成功': 'Export success',
    '请在 Arduino IDE 中打开 CIBYP-TRNG.ino 文件。': 'Open CIBYP-TRNG.ino in Arduino IDE.',
    '导出失败：': 'Export failed:',
    '未知错误': 'Unknown error',
    '导出失败': 'Export failed',

    // ── Settings: Security ──
    '自动批准敏感操作': 'Auto-approve sensitive operations',
    '开启后，AI Agent将自动执行包括文件删除、终端命令等敏感操作，存在安全风险。请确保你信任当前运行的任务。': 'When enabled, AI Agent will auto-execute sensitive operations including file deletion and terminal commands. Security risk. Ensure you trust the current task.',
    '使用量管理': 'Usage management',
    '开启自动批准敏感操作后，AI Agent将无需确认即可执行文件删除、终端命令等危险操作。': 'With auto-approve enabled, AI Agent executes dangerous operations without confirmation.',
    '确定要开启吗？': 'Are you sure you want to enable?',

    // ── Settings: MCP ──
    'MCP 服务器': 'MCP servers',
    'Model Context Protocol (MCP) 允许 AI Agent 连接外部工具服务器，扩展能力。添加服务器后点击连接即可使用。': 'Model Context Protocol (MCP) allows AI Agent to connect external tool servers. Add a server and click connect.',
    '添加 MCP 服务器': 'Add MCP server',
    '服务器名称': 'Server name',
    '启动命令': 'Start command',
    '参数 (JSON 数组，可选)': 'Args (JSON array, optional)',
    '环境变量 (JSON 对象，可选)': 'Env vars (JSON object, optional)',
    '工作目录 (可选)': 'Working directory (optional)',
    '留空则使用默认目录': 'Uses default directory if empty',
    '启动时自动连接': 'Auto-connect on startup',
    '已连接工具': 'Connected tools',
    '暂无已连接的 MCP 服务器': 'No connected MCP servers',
    '暂无 MCP 服务器配置': 'No MCP server configs',
    '暂无已连接的工具': 'No connected tools',
    '加载失败:': 'Load failed:',
    '名称和命令不能为空': 'Name and command cannot be empty',
    '参数格式错误(需JSON数组)': 'Invalid args format (JSON array required)',
    '环境变量格式错误(需JSON对象)': 'Invalid env format (JSON object required)',
    '添加失败': 'Add failed',
    '已连接': 'Connected',
    '连接中...': 'Connecting...',
    '错误': 'Error',
    '未连接': 'Disconnected',

    // ── Settings: Email ──
    '实验性功能': 'Experimental feature',
    '邮件控制功能尚处于实验阶段，可能不稳定或不完全可用。请谨慎使用。': 'Email control is experimental and may be unstable. Use with caution.',
    '邮件模式': 'Email mode',
    '控制模式': 'Control mode',
    '只发（发送对话摘要）': 'Send only (conversation summaries)',
    '只收（接收邮件指令）': 'Receive only (email commands)',
    '发+收（完整控制）': 'Send + Receive (full control)',
    'SMTP 发信配置': 'SMTP send config',
    'SMTP 服务器': 'SMTP server',
    '端口': 'Port',
    '使用 TLS/SSL': 'Use TLS/SSL',
    'IMAP 收信配置': 'IMAP receive config',
    'IMAP 服务器': 'IMAP server',
    '使用 TLS': 'Use TLS',
    '帐号凭据': 'Account credentials',
    '邮箱帐号': 'Email account',
    '授权码 / 密码': 'Auth code / Password',
    '请使用应用专用密码': 'Use app-specific password',
    '用户邮箱地址（你自己的邮箱，用于接收和发送指令）': 'Your email address (for receiving and sending commands)',
    'TOTP 两步验证': 'TOTP 2FA',
    '用于邮件审批验证。点击生成密钥后，请用手机验证器App（如 Microsoft Authenticator、Google Authenticator）扫描二维码。': 'For email approval verification. After generating, scan QR code with authenticator app.',
    '生成 TOTP 密钥': 'Generate TOTP secret',
    '输入6位验证码': 'Enter 6-digit code',
    '当前密钥': 'Current secret',
    '尚未生成': 'Not generated yet',
    '邮件控制选项': 'Email control options',
    '轮询间隔（秒）': 'Poll interval (seconds)',
    '审批邮件重发间隔（分钟）': 'Approval resend interval (minutes)',
    '最大重发次数': 'Max resends',
    '启用管理': 'Enable management',
    '启用邮件控制': 'Enable email control',
    '✅ 验证通过': '✅ Verification passed',
    '❌ 验证失败': '❌ Verification failed',
    '正在测试连接...': 'Testing connection...',
    '✅ 连接成功。SMTP:': '✅ Connection success. SMTP:',
    'IMAP:': 'IMAP:',
    '❌ 连接失败:': '❌ Connection failed:',
    '✅ 设置已保存': '✅ Settings saved',
    '邮件轮询已启动': 'Email polling started',
    '来自邮件': 'From email',
    '发件人:': 'From:',
    '主题:': 'Subject:',
    '无主题': 'No subject',
    '已停止': 'Stopped',
    '❌ 停止失败:': '❌ Stop failed:',
    '❌ 启动失败:': '❌ Start failed:',
    '未运行': 'Not running',
    '✅ 运行中: http://localhost:': '✅ Running: http://localhost:',
    '密钥:': 'Secret:',
    'TOTP 生成失败:': 'TOTP generation failed:',

    // ── Settings: Web Control ──
    'Web 远程控制': 'Web remote control',
    '通过任何浏览器远程控制 AI 助手。支持发消息、审批工具、查看对话历史。': 'Control AI assistant remotely via any browser. Supports messaging, tool approval, and history.',
    '注意：': 'Note:',
    '独立窗口小游戏（飞花令/三国杀/谁是卧底）在Web控制模式下不可用，GeoGebra仅在主机运行。': 'Standalone game windows (flying flower / three kingdoms / undercover) are not available in Web control mode. GeoGebra runs on host only.',
    '访问安全': 'Access security',
    '访问密码': 'Access password',
    '设置访问密码': 'Set access password',
    '启用 2FA 两步验证': 'Enable 2FA',
    '服务器设置': 'Server settings',
    '启用 Web 控制': 'Enable web control',
    '启动时自动开启 Web 控制': 'Auto-enable on startup',

    // ── Settings: Playwright ──
    'Playwright 浏览器设置': 'Playwright Browser Settings',
    '配置内置 Playwright 浏览器的启动方式。可选择使用系统安装的浏览器或指定浏览器二进制文件路径。': 'Configure the built-in Playwright browser launch method. Choose to use a system-installed browser or specify a browser binary path.',
    '浏览器语言会自动跟随当前 App 语言设置。': 'Browser language will automatically follow the current App language setting.',
    '浏览器来源': 'Browser Source',
    '浏览器模式': 'Browser Mode',
    '自动搜索（优先 Edge → Chrome → 内置 Chromium）': 'Auto search (Edge → Chrome → bundled Chromium)',
    '使用 Microsoft Edge': 'Use Microsoft Edge',
    '使用 Google Chrome': 'Use Google Chrome',
    '使用内置 Chromium': 'Use bundled Chromium',
    '自定义浏览器路径': 'Custom browser path',
    '浏览器可执行文件路径': 'Browser executable path',
    '已检测到的浏览器': 'Detected browsers',
    '点击下方按钮搜索系统浏览器...': 'Click the button below to search for system browsers...',
    '搜索浏览器': 'Search browsers',
    '浏览器语言': 'Browser Language',
    '浏览器语言跟随 App 语言': 'Browser language follows App language',
    '启用后，内置浏览器将使用与 App 相同的语言（zh-CN/en/de）': 'When enabled, the built-in browser will use the same language as the App (zh-CN/en/de)',
    '启动参数': 'Launch Arguments',
    '额外启动参数（可选，每行一个）': 'Extra launch arguments (optional, one per line)',
    '测试启动': 'Test Launch',
    '保存设置': 'Save Settings',
    '选择浏览器可执行文件': 'Select browser executable',
    '可执行文件': 'Executable files',
    '所有文件': 'All files',
    '搜索中...': 'Searching...',
    '未检测到已安装的浏览器': 'No installed browsers detected',
    '测试中...': 'Testing...',
    '测试成功': 'Test successful',
    '测试失败': 'Test failed',
    '浏览器启动成功': 'Browser launched successfully',
    '设置已保存': 'Settings saved',

    // ── About page ──
    '全自动AI Agent，帮助完成一切任务': 'Fully autonomous AI Agent that helps with everything',
    '由': 'Developed by',
    '开发': '',
    '智能AI Agent': 'Smart AI Agent',
    '内置工具': 'Built-in tools',
    '技能系统': 'Skill system',
    '上下文管理': 'Context management',

    // ── Modal dialogs ──
    '确认操作': 'Confirm action',
    '图片预览': 'Image preview',
    '例如：翻译助手': 'e.g. Translation Assistant',
    '描述这个技能的功能...': 'Describe this skill\'s function...',
    '你是一个专业的翻译助手...': 'You are a professional translation assistant...',
    '输入新名称:': 'Enter new name:',
    '重命名失败:': 'Rename failed:',
    '复制路径': 'Copy path',
    '在资源管理器打开': 'Open in Explorer',
    '确认删除': 'Confirm delete',
    '确定删除': 'Confirm delete',
    '吗？此操作不可恢复。': '? This action cannot be undone.',
    '删除失败:': 'Delete failed:',
    '该文件已在上下文中': 'This file is already in context',
    '从上下文移除': 'Remove from context',
    '添加到上下文': 'Add to context',
    '重命名': 'Rename',

    // ── Onboarding wizard ──
    '设定你的 AI 伙伴': 'Set up your AI partner',
    '给 AI 一个形象和性格，让对话更自然': 'Give AI an appearance and personality for natural conversation',
    '移除': 'Remove',
    'Ta / 他 / 她': 'They / He / She',
    '性格特点': 'Personality traits',
    'Persona（自定义提示，可选）': 'Persona (custom prompt, optional)',
    '描述 AI 的背景、风格等': 'Describe AI\'s background, style, etc.',
    '告诉 AI 你是谁': 'Tell AI who you are',
    '你的形象信息仅本地保存，用于个性化称呼': 'Your profile is saved locally for personalized addressing',
    '你的名字': 'Your name',
    '配置 AI 大脑': 'Configure AI brain',
    '默认使用 OpenCode Zen（免费），自动选择 DeepSeek 模型，开箱即用': 'Default: OpenCode Zen (free), auto-selects DeepSeek model, ready to use',
    'OpenCode Zen（推荐，免费）': 'OpenCode Zen (recommended, free)',
    '正在获取模型列表...': 'Fetching model list...',
    '跳过引导': 'Skip guide',
    '上一步': 'Previous',
    '下一步': 'Next',
    '完成配置': 'Finish setup',
    '1 / 3': '1 / 3',

    // ── Remote connection ──
    '已连接远程主机': 'Connected to remote host',
    '未连接远程主机': 'Not connected to remote host',
    '重新连接': 'Reconnect',
    '重连': 'Reconnect',
    '关闭横幅': 'Close banner',
    '正在连接远程主机…': 'Connecting to remote host...',
    '远程连接断开，正在重连…': 'Remote connection lost, reconnecting...',
    '远程连接错误': 'Remote connection error',
    '连接失败，请检查地址或网络': 'Connection failed, check address or network',
    'WebSocket 连接失败': 'WebSocket connection failed',
    '登录失败': 'Login failed',
    '认证失败': 'Authentication failed',
    '已连接，可远程操作': 'Connected, remote control available',
    '请填写地址和密码': 'Please enter address and password',
    '未连接到远程主机': 'Not connected to remote host',
    '已有相同请求进行中': 'Same request already in progress',
    '请求超时': 'Request timeout',
    '连接已断开': 'Connection lost',
    '连接远程 WebUI': 'Connect to remote WebUI',
    '远程地址': 'Remote address',
    '远程 WebUI 的访问密码': 'Remote WebUI access password',
    'TOTP 验证码（如远程启用了 2FA）': 'TOTP code (if remote has 2FA)',
    '可选': 'Optional',
    '输入远程 WebUI 的地址和密码，连接后可远程操作对方的 Agent。': 'Enter remote WebUI address and password to control the remote Agent.',

    // ── Status / messages ──
    'AI 正在思考...': 'AI is thinking...',
    '正在优化工具选择...': 'Optimizing tool selection...',
    '推理过程': 'Reasoning process',
    '逆位': 'Reversed',
    '正位': 'Upright',
    '[TRNG 硬件真随机]': '[TRNG hardware random]',
    '抽取了命运之牌：': 'Drew tarot card:',
    '子代理启动': 'Sub-agent started',
    '任务:': 'Task:',
    '子代理完成': 'Sub-agent completed',
    '子代理': 'Sub-agent',
    '[错误]': '[Error]',
    '用户拒绝了操作': 'User rejected operation',
    '连接中...': 'Connecting...',
    '[Canvas 内容不可镜像]': '[Canvas content cannot be mirrored]',
    '上下文使用详情': 'Context usage details',
    '系统指导': 'System guidance',
    '工具定义': 'Tool definitions',
    '聊天记录': 'Chat history',
    '工具结果': 'Tool results',
    '总计': 'Total',
    '上下文使用量:': 'Context usage:',
    '附件:': 'Attachments:',
    '[附件上传失败:': '[Attachment upload failed:',
    '[附件:': '[Attachment:',
    '已转换为文本文件：': 'Converted to text file:',
    '调用工具:': 'Tool call:',
    '下载文件': 'Download file',
    '[TRNG]': '[TRNG]',
    '飞花令': 'Flying Flower',
    '三国杀': 'Three Kingdoms',
    '谁是卧底': 'Undercover',
    '经典诗词接龙游戏，各方轮流说出含有指定字的诗句': 'Classic poetry chain game',
    '经典卡牌对战游戏，选择武将、出牌博弈': 'Classic card battle game',
    '经典社交推理游戏，通过描述找出卧底': 'Classic social deduction game',
    '参与 Agent 数量：': 'Number of AI players:',
    '忽略': 'Ignore',
    '开始游戏': 'Start game',
    '已接受': 'Accepted',
    '游戏结束:': 'Game over:',
    '暂无待办事项': 'No todo items',
    '操作:': 'Operation:',
    '参数:': 'Parameters:',
    '上下文使用量': 'Context usage',
    '已使用': 'Used',
    '个内置工具': ' built-in tools',

    // ── Code mode specific ──
    '开始新的编程任务': 'Start a new coding task',
    '恢复': 'Restore',
    'Monaco 编辑器加载失败:': 'Monaco editor load failed:',
    '无法读取文件:': 'Cannot read file:',
    '保存失败:': 'Save failed:',
    '有未保存的更改，确定关闭吗？': 'You have unsaved changes. Close anyway?',
    '加载文件树...': 'Loading file tree...',
    '无法读取文件树': 'Cannot read file tree',
    '工作区:': 'Workspace:',
    '工具审批：': 'Tool approval:',
    '批准': 'Approve',
    '执行中...': 'Executing...',
    '完成': 'Done',
    '失败': 'Failed',
    '错误:': 'Error:',

    // ── GeoGebra / Canvas / Spreadsheet ──
    'GeoGebra已显示': 'GeoGebra displayed',
    'GeoGebra 加载超时（30s），请检查网络是否能访问 www.geogebra.org': 'GeoGebra load timeout (30s), check network access to www.geogebra.org',
    'GeoGebra已启动': 'GeoGebra started',
    'GeoGebra 注入失败:': 'GeoGebra injection failed:',
    'GeoGebra未初始化（applet 尚未加载完成）': 'GeoGebra not initialized (applet not loaded yet)',
    '命令为空': 'Command is empty',
    'GeoGebra 命令错误': 'GeoGebra command error',
    'GeoGebra 错误': 'GeoGebra error',
    '命令未产生任何对象，可能语法错误：': 'Command produced no object, possible syntax error:',
    '命令执行超时（懒加载模块未就绪）': 'Command execution timeout (lazy module not ready)',
    'GeoGebra未初始化': 'GeoGebra not initialized',
    '画布元素未找到': 'Canvas element not found',
    '画布已初始化并清空': 'Canvas initialized and cleared',
    '画布未初始化': 'Canvas not initialized',
    '画布已清空': 'Canvas cleared',
    '对象ID': 'Object ID',
    '已存在': 'Already exists',
    '对象': 'Object',
    '已添加': 'Added',
    '不存在': 'Does not exist',
    '已更新': 'Updated',
    '已删除': 'Deleted',
    '画布或工作区路径未设置': 'Canvas or workspace path not set',
    'SVG已导出': 'SVG exported',
    '数据表格面板元素未找到': 'Spreadsheet panel element not found',
    '数据表格已打开': 'Spreadsheet opened',
    '已导入': 'Imported',
    '个单元格': ' cells',

    // ── Questionnaire ──
    '上一题': 'Previous',
    '下一题': 'Next',
    '提交': 'Submit',
    '已提交': 'Submitted',
    '问卷已提交': 'Questionnaire submitted',
    '选项A': 'Option A',
    '选项B': 'Option B',
    '选项C': 'Option C',
    'D.': 'D.',
    '自定义选项': 'Custom option',
    '请选择一个选项，或填写自定义选项': 'Select an option or enter custom',
    '确认对话框未找到': 'Confirm dialog not found',
    '消息对话框未找到': 'Message dialog not found',

    // ── File operations ──
    '图片已复制到剪贴板': 'Image copied to clipboard',
    '图片已保存到:': 'Image saved to:',
    '复制失败:': 'Copy failed:',
    '复制图片': 'Copy image',
    '另存为': 'Save as',
    '保存图片': 'Save image',

    // ── Agent status messages ──
    '已替换': 'Replaced',
    '处匹配': ' matches',
    'LLM 请求失败（': 'LLM request failed (',
    '），第': '), attempt ',
    '次重试': ' retry',
    's 后重试': 's retry in',
    '已自动压缩上下文（': 'Auto-compacted context (',
    '当前使用': 'Current usage ',
    '上下文压缩失败（': 'Context compaction failed (',
    '上下文压缩异常（': 'Context compaction exception (',
    '⚠️ 上下文严重溢出，已强制截断最近4条消息': '⚠️ Context severely overflowed, truncated last 4 messages',
    '已将新消息注入当前对话': 'New messages injected into current conversation',
    '流式请求失败，回退到普通模式：': 'Stream request failed, fallback to normal mode: ',
    '已在本会话中禁用自动工具选择优化，所有已启用工具现在都可用。': 'Auto tool optimization disabled for this session. All enabled tools are now available.',
    '用户拒绝了此操作': 'User rejected this operation',
    '用户:': 'User:',
    'AI:': 'AI:',
    '中间部分已截断，共': 'Middle truncated, total ',
    '字符': ' chars',
    '文件已全量覆写': 'File fully overwritten',
    'edits 必须是非空数组': 'edits must be a non-empty array',
    '已应用': 'Applied',
    '处编辑': ' edits',
    '已呈递给用户': ' presented to user',
    '技能': 'Skill',
    '已激活，prompt 已注入系统上下文': 'activated, prompt injected into system context',
    '技能已停用': 'Skill deactivated',
    '无激活技能': 'No active skills',
    '画布功能未初始化': 'Canvas not initialized',
    '数据表格功能未初始化': 'Spreadsheet not initialized',
    '用户忽略了游戏邀请': 'User ignored game invitation',
    '目标已设置:': 'Goal set:',
    '当前没有活跃目标': 'No active goal',
    '目标已完成:': 'Goal completed:',
    '模式→': 'Mode→',
    '配色→': 'Scheme→',
    '强调色→': 'Accent→',
    '子代理完成了任务但没有文本回复': 'Sub-agent completed but no text reply',
    '游戏玩家': 'Game player',
    '位 AI 玩家已就绪，请在游戏窗口中进行操作。': ' AI players ready. Please operate in the game window.',
    '游戏窗口已打开': 'Game window opened',
    '无法打开飞花令游戏窗口': 'Cannot open Flying Flower game window',
    '无法打开谁是卧底游戏窗口': 'Cannot open Undercover game window',
    '无法打开三国杀游戏窗口': 'Cannot open Three Kingdoms game window',

    // ── Chat history labels ──
    '对话记录': 'Conversation record',
    '该对话没有记录工作目录': 'This conversation has no workspace recorded',
    '导出对话记录(JSON)': 'Export conversation (JSON)',
    '导出对话记录(Markdown)': 'Export conversation (Markdown)',
    '已导出：': 'Exported:',
    '导出成功': 'Export success',
    '导出失败：': 'Export failed:',
    '创建时间：': 'Created:',
    '更新时间：': 'Updated:',
    '工作目录：': 'Workspace:',
    '用户': 'User',
    'AI': 'AI',
    '系统': 'System',

    // ── Context details ──
    '无可用工具': 'No tools available',
    '优化失败，回退到精简启发式工具集': 'Optimization failed, falling back to heuristic tool set',
    '优化失败': 'Optimization failed',
    '首条消息优化': 'First message optimization',
    '运行中重优化': 'Runtime re-optimization',
    '重优化完成': 'Re-optimization complete',
    '检测到优化未执行，发送前自动补偿优化': 'Detected optimization not executed, auto-compensating before send',
    '循环检测到优化未执行，自动补偿优化': 'Loop detected optimization not executed, auto-compensating',
    '被禁用，需要重优化': 'is disabled, needs re-optimization',
    '不在当前集合，触发重优化': 'not in current set, triggering re-optimization',
    '请先在设置中配置LLM API': 'Please configure LLM API in settings first',

    // ── Babe proactive message topics ──
    '关心用户今天过得怎么样': 'Check how the user\'s day is going',
    '分享自己刚想到的一件小事': 'Share a small thing that just came to mind',
    '询问用户最近在忙什么': 'Ask what the user has been busy with',
    '表达想用户的心情': 'Express missing the user',
    '聊聊最近看到的有趣事物': 'Talk about something interesting seen recently',
    '问问用户有没有好好吃饭': 'Ask if the user has eaten well',

    // ── Misc ──
    '读取 SKILL.md 失败': 'Failed to read SKILL.md',
    '加载远程历史失败:': 'Failed to load remote history:',
    '找不到该对话': 'Conversation not found',
    '[多模态内容]': '[Multimodal content]',
    ' - 图片': ' - Image',
    '图片文件：': 'Image files:',
    '(获取失败)': '(fetch failed)',
    '获取失败，请检查 Zen API Key 或网络': 'Failed, check Zen API Key or network',
    '获取失败，请检查 API URL/Key 或网络': 'Failed, check API URL/Key or network',
    '共': 'Total',
    '个可用模型': ' available models',
    '个可用模型（标 [免费] 的为免费模型）': ' available models ([free] = free models)',
    '[免费]': '[Free]',
    '已使用免登录公共 Key（public），仅可调用 6 个限时免费模型': 'Using public key (public), limited to 6 time-limited free models',

    // ── Tarot UI (half-width colon variant) ──
    '命运之牌:': 'Tarot:',
    '尚未抽取': 'Not drawn yet',

    // ── Skills / Code / Misc ──
    '暂无技能...': 'No skills yet...',
    '未命名会话': 'Untitled session',
    '(未选择工作区)': '(No workspace selected)',
    '加载失败': 'Load failed',
    '标准 Skill 导入': 'Standard Skill Import',
    '选择标准 Skill 文件（SKILL.md）': 'Select Standard Skill file (SKILL.md)',
    '【适用场景】': '[Use Cases]',
    '【执行说明】': '[Instructions]',
    '【约束】': '[Constraints]',
    'JS脚本': 'JS Script',
    '【用户追加消息】': '[User appended message]',
    '**用户**:': '**User**:',

    // ── Babe mode defaults ──
    '温柔、体贴、善解人意': 'Gentle, caring, understanding',
    '亲爱的': 'Darling',
    '女生': 'Female',
    '男生': 'Male',
    '人': 'Person',
    '深爱': 'Deeply in love',
    '很喜欢': 'Really likes',
    '有好感': 'Has feelings for',
    '初步认识': 'Just met',
    '刚认识': 'Newly acquainted',

    // ── Babe proactive messages ──
    '[系统指令]': '[System Instruction]',

    // ── main.js IPC errors: Math/Calculation ──
    '除数不能为0': 'Divisor cannot be 0',
    '数字为空': 'Number is empty',
    '无法解析数字': 'Cannot parse number',
    '仅支持整数幂': 'Only integer exponents supported',
    '指数过大': 'Exponent too large',
    '取模仅支持整数': 'Modulo supports integers only',
    '取模除数不能为0': 'Modulo divisor cannot be 0',
    '为保证精确计算，暂不支持 pi 等无理常数': 'Irrational constants like pi are not supported for exact computation',
    '无法识别的符号': 'Unrecognized symbol',
    '括号不匹配': 'Mismatched parentheses',
    '表达式为空': 'Expression is empty',
    '表达式不完整': 'Expression is incomplete',
    '表达式不合法': 'Invalid expression',
    '不支持的运算符': 'Unsupported operator',
    'values 至少需要2个整数': 'values requires at least 2 integers',
    '进制范围必须在2~36': 'Base must be between 2 and 36',
    'n 必须是非负整数': 'n must be a non-negative integer',
    'n 过大，当前限制为 2000': 'n is too large, current limit is 2000',
    '复数除法分母为0': 'Complex division denominator is 0',
    '复数幂仅支持整数指数': 'Complex power supports integer exponents only',
    '矩阵加减要求维度一致': 'Matrix add/sub requires matching dimensions',
    '矩阵乘法维度不匹配': 'Matrix multiplication dimension mismatch',
    '行列式仅适用于方阵': 'Determinant applies to square matrices only',
    '逆矩阵仅适用于方阵': 'Inverse applies to square matrices only',
    '矩阵不可逆（奇异）': 'Matrix is singular (not invertible)',
    '叉积仅支持3维或7维向量': 'Cross product supports 3D or 7D vectors only',
    '全体实数': 'All real numbers',
    '无解': 'No solution',
    '方程组无解': 'System has no solution',
    '方程组有无穷多解': 'System has infinitely many solutions',
    '仅支持1~4次多项式': 'Only polynomials of degree 1-4 are supported',
    'sigma 必须>0': 'sigma must be > 0',
    'p 必须在[0,1]': 'p must be in [0,1]',
    'lambda 必须>0': 'lambda must be > 0',
    'uniform 要求 b > a': 'uniform requires b > a',
    'operation 必须是 permutation 或 combination': 'operation must be permutation or combination',

    // ── main.js IPC errors: File search/read/write ──
    'paths 参数必须是非空数组': 'paths must be a non-empty array',
    'pattern 参数必须是非空字符串': 'pattern must be a non-empty string',
    '终端不存在': 'Terminal does not exist',
    '无法截取屏幕': 'Cannot capture screen',

    // ── main.js IPC errors: Image gen / timeout ──
    '执行超时': 'Execution timeout',
    '请先配置生图API Key': 'Please configure image generation API Key first',
    '已达到今日生图上限': "Today's image generation limit reached",
    '生图API未返回有效图片': 'Image API returned no valid image',
    '主窗口未就绪': 'Main window not ready',
    '缺少URL': 'Missing URL',

    // ── main.js IPC errors: TRNG ──
    '未配置TRNG串口': 'TRNG serial port not configured',
    'serialport 模块未安装，请运行 npm install serialport': 'serialport module not installed, run npm install serialport',
    'TRNG串口超时': 'TRNG serial port timeout',
    'TRNG串口JSON解析失败': 'TRNG serial port JSON parse failed',
    'TRNG串口写入失败': 'TRNG serial port write failed',
    'TRNG网络超时': 'TRNG network timeout',
    'TRNG网络数据解析失败': 'TRNG network data parse failed',
    'TRNG网络请求超时': 'TRNG network request timeout',

    // ── main.js IPC errors: LLM/Zen ──
    '请先在设置中配置OpenCode Zen API Key和模型': 'Please configure OpenCode Zen API Key and model in settings first',
    '请先配置OpenCode Zen': 'Please configure OpenCode Zen first',
    '请求超时（10s），请检查网络连接': 'Request timeout (10s), check network connection',
    '请求超时（10s），请检查网络或 API URL': 'Request timeout (10s), check network or API URL',

    // ── main.js IPC errors: File dialog titles ──
    '选择头像图片': 'Select avatar image',
    '选择文件': 'Select file',
    '保存文件': 'Save file',
    '选择导出目录': 'Select export directory',
    '用户取消': 'User cancelled',
    '选择 Code 模式工作区文件夹': 'Select Code mode workspace folder',

    // ── main.js IPC errors: Playwright ──
    '无法启动指定的浏览器:': 'Cannot launch the specified browser:',
    '内置 Chromium 启动失败:': 'Bundled Chromium launch failed:',
    'URL 参数缺失或无效': 'URL parameter missing or invalid',

    // ── main.js IPC errors: File format / QR code ──
    '需要安装adm-zip包来处理此文件格式': 'adm-zip package required for this file format',
    '(PDF文本提取有限，建议使用OCR)': '(PDF text extraction is limited, OCR recommended)',
    '不支持的文件格式': 'Unsupported file format',
    '技能不存在': 'Skill does not exist',
    '无法加载图片': 'Cannot load image',
    '未识别到二维码': 'No QR code detected',

    // ── main.js IPC errors: Network tools ──
    '未设置工作区路径': 'Workspace path not set',
    '请使用重定向后的最终URL': 'Please use the final redirected URL',
    '缺少url': 'Missing url',
    '缺少path': 'Missing path',
    '无法获取证书': 'Cannot fetch certificate',
    '连接超时': 'Connection timeout',
    '无效端口范围': 'Invalid port range',
    '端口范围过大(最大1024个)': 'Port range too large (max 1024)',

    // ── main.js IPC errors: Game ──
    '你是三国杀AI玩家': 'You are the Three Kingdoms AI player',

    // ── main.js IPC errors: MCP ──
    '同名服务器已存在': 'Server with the same name already exists',
    '服务器不存在': 'Server does not exist',
    '服务器未连接': 'Server is not connected',

    // ── main.js IPC errors: Serial messages ──
    '已打开': 'opened',
    '未打开': 'is not open',
    '已关闭': 'closed',

    // ── main.js IPC errors: Office tools ──
    '缺少pathOrDir参数': 'Missing pathOrDir parameter',
    '路径不存在:': 'Path does not exist:',
    '仅支持 .docx/.odt': 'Only .docx/.odt supported',
    '不是可识别的Word文档目录': 'Not a recognizable Word document directory',
    '文件不存在:': 'File does not exist:',
    '已解压到': 'Extracted to',
    '目录不存在:': 'Directory does not exist:',
    '已打包为': 'Packaged as',
    '处文字': 'text occurrences',
    '缺少有效updates': 'Missing valid updates',

    // ── main.js IPC errors: Email mode ──
    '跳过': 'Skipped',
    '只发模式，无需轮询': 'Send-only mode, no polling needed',
    '邮件模式为只收，无法发送审批请求，已拒绝': 'Email mode is receive-only, cannot send approval request, rejected',
    '邮件模式为只发，无法接收审批回复，已拒绝': 'Email mode is send-only, cannot receive approval reply, rejected',
    '邮件模式为只收，无法发送对话摘要': 'Email mode is receive-only, cannot send conversation summary',

    // ── agent.js tool internal strings ──
    '未命名技能': 'Untitled skill',
    '无描述': 'No description',

    // ── app.js dynamic strings ──
    '请先填写 URL 和 Key': 'Please fill in URL and Key first',
    '包括用户消息': 'including user message',
    '工具调用': 'tool calls',
    'AI回复': 'AI reply',

    // ── CIPYP-CAD ──
    'CIPYP-CAD 工程已保存到：': 'CIPYP-CAD project saved to:',
    'DXF 已导出到：': 'DXF exported to:',
    '可用 AutoCAD/FreeCAD/QCAD 等打开': 'Can be opened with AutoCAD/FreeCAD/QCAD, etc.',
    '已导出到：': 'exported to:',
    '需要 path 参数指定工程文件路径': 'path parameter required to specify project file',
    '未设置工作区路径，且未提供 path 参数': 'Workspace path not set and no path parameter provided',
    'CIPYP-CAD 窗口已打开': 'CIPYP-CAD window opened',
    'CIPYP-CAD 窗口已关闭': 'CIPYP-CAD window closed',
    'CIPYP-CAD 命令已执行': 'CIPYP-CAD command executed',
    '工程文件格式无效': 'Invalid project file format',
    'CAD 引擎未就绪': 'CAD engine not ready'
  }
};

i18nRegister('en', EN_DICT);
