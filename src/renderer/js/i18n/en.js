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
    inviteGame: 'Invite to play a game (flying flower/undercover/three kingdoms)',
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
    listSkills: 'List available skills',
    runSkillScript: 'Run a skill script',
    importSkill: 'Import a skill from SKILL.md',
    deleteSkill: 'Delete a skill',
    serialList: 'List serial ports',
    serialConnect: 'Connect to serial port',
    serialDisconnect: 'Disconnect serial port',
    serialSend: 'Send data to serial port',
    serialRead: 'Read data from serial port'
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
    'MCP': 'MCP'
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
10. When the user wants to play a game (flying flower, three kingdoms, undercover, etc.), you MUST call the inviteGame tool to initiate the game — never simulate the game through plain conversation

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
  }
};

i18nRegister('en', EN_DICT);
