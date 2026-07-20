/**
 * 是否猜人物 - Guess Character Game
 * AI thinks of a character (real or fictional), user asks yes/no questions to guess.
 * LLM-driven: AI picks character, AI answers questions, AI judges final guess.
 * 简易上下文管理：保留最近 N 条问答作为 LLM 上下文
 */

(function () {
  'use strict';

  const CATEGORIES = [
    { id: 'history', name: '历史人物', desc: '真实存在的历史人物' },
    { id: 'celebrity', name: '名人明星', desc: '当代影视/音乐/体育明星' },
    { id: 'anime', name: '动漫角色', desc: '日本动漫/游戏中的虚构角色' },
    { id: 'fiction', name: '文学影视', desc: '小说、电影、电视剧中的角色' },
    { id: 'mixed', name: '混合', desc: '任意领域的人物' }
  ];
  const MAX_GUESSES = 3;
  const MAX_QUESTIONS = 30;
  const MAX_HISTORY_IN_CONTEXT = 24;

  const $ = (id) => document.getElementById(id);

  let category = 'mixed';
  let categoryName = '混合';
  let character = '';          // AI 心中的人物（保密）
  let characterHint = '';      // 用于在游戏结束时展示的简介
  let questionCount = 0;
  let guessRemaining = MAX_GUESSES;
  let history = [];            // { role, text, answer }
  let gameOver = false;
  let userInputResolve = null;
  let inGuessMode = false;

  // ---- PRNG (TRNG-seeded) ----
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let gameRng = () => Math.random();

  // ---- Theme ----
  async function applyTheme() {
    try {
      const settings = await window.gameAPI.getSettings();
      const theme = settings?.theme || {};
      let isDark = false;
      if (theme.mode === 'dark') isDark = true;
      else if (theme.mode === 'system') {
        const sys = await window.gameAPI.getTheme();
        isDark = sys?.shouldUseDarkColors ?? false;
      }
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

      if (theme.accentColor) {
        const r = parseInt(theme.accentColor.slice(1, 3), 16);
        const g = parseInt(theme.accentColor.slice(3, 5), 16);
        const b = parseInt(theme.accentColor.slice(5, 7), 16);
        document.documentElement.style.setProperty('--accent', theme.accentColor);
        document.documentElement.style.setProperty('--accent-light', `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`);
        document.documentElement.style.setProperty('--accent-dark', `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)})`);
        document.documentElement.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.08)`);
        document.documentElement.style.setProperty('--accent-bg-hover', `rgba(${r}, ${g}, ${b}, 0.14)`);
      }

      if (theme.backgroundColor) {
        const bgR = parseInt(theme.backgroundColor.slice(1, 3), 16);
        const bgG = parseInt(theme.backgroundColor.slice(3, 5), 16);
        const bgB = parseInt(theme.backgroundColor.slice(5, 7), 16);
        const luminance = (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255;
        document.documentElement.style.setProperty('--bg-primary', theme.backgroundColor);
        if (luminance < 0.5) {
          document.documentElement.style.setProperty('--bg-secondary', `rgb(${Math.min(255, bgR + 20)}, ${Math.min(255, bgG + 20)}, ${Math.min(255, bgB + 20)})`);
          document.documentElement.style.setProperty('--bg-tertiary', `rgb(${Math.min(255, bgR + 30)}, ${Math.min(255, bgG + 30)}, ${Math.min(255, bgB + 30)})`);
          document.documentElement.style.setProperty('--bg-hover', `rgb(${Math.min(255, bgR + 40)}, ${Math.min(255, bgG + 40)}, ${Math.min(255, bgB + 40)})`);
        } else {
          document.documentElement.style.setProperty('--bg-secondary', `rgb(${Math.max(0, bgR - 10)}, ${Math.max(0, bgG - 10)}, ${Math.max(0, bgB - 10)})`);
          document.documentElement.style.setProperty('--bg-tertiary', `rgb(${Math.max(0, bgR - 20)}, ${Math.max(0, bgG - 20)}, ${Math.max(0, bgB - 20)})`);
          document.documentElement.style.setProperty('--bg-hover', `rgb(${Math.max(0, bgR - 5)}, ${Math.max(0, bgG - 5)}, ${Math.max(0, bgB - 5)})`);
        }
      }
    } catch (e) { console.log('Theme error:', e.message); }
  }

  // ---- LLM ----
  async function askLLM(systemPrompt, userMsg, temperature = 0.5, maxTokens = 200) {
    try {
      const result = await window.gameAPI.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ], { temperature, max_tokens: maxTokens });
      if (result.ok && result.data?.choices?.[0]?.message?.content) {
        let content = result.data.choices[0].message.content.trim();
        // 清理思考标签：<think>/<reasoning>/<reasoning_content>/<thought> 等成对与未闭合形式
        content = content.replace(/\u003C(?:think|reasoning|reasoning_content|thought|reflection)\b[\s\S]*?\u003C\/\1\u003E/gi, '');
        content = content.replace(/\u003C(?:think|reasoning|reasoning_content|thought|reflection)\b[\s\S]*$/gi, '');
        // 清理 markdown 代码块包裹
        content = content.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
        return content || null;
      }
    } catch (e) { console.error('LLM error:', e); }
    return null;
  }

  // ---- 上下文管理：拼接最近 N 条问答 ----
  function buildHistoryContext() {
    const recent = history.slice(-MAX_HISTORY_IN_CONTEXT);
    if (recent.length === 0) return '（暂无提问）';
    return recent.map((h, i) => {
      if (h.role === 'q') return `${i + 1}. 玩家问：${h.text}`;
      if (h.role === 'a') return `${i + 1}. AI答：${h.text}`;
      if (h.role === 'guess') return `${i + 1}. 玩家猜：${h.text} → 判定：${h.answer || '未判定'}`;
      return `${i + 1}. ${h.text}`;
    }).join('\n');
  }

  // AI 选定一个人物
  async function aiPickCharacter() {
    const sys = `你在玩"是否猜人物"游戏，需要选定一个人物让玩家来猜。
人物类别：${categoryName}（${CATEGORIES.find(c => c.id === category)?.desc || '任意'}）
要求：
1. 选择一个该类别下广为人知、但有一定挑战性的人物（真实或虚构皆可，视类别而定）
2. 第一行输出人物姓名（标准中文译名或原名）
3. 第二行起用一句话简短介绍这个人物（用于游戏结束时展示给玩家，包含主要身份/作品/成就等识别信息）
4. 不要加多余说明
格式：
姓名
简介`;
    const userMsg = `请选定一个${categoryName}类别的人物。`;
    const resp = await askLLM(sys, userMsg, 0.9, 200);
    if (!resp) return null;
    const lines = resp.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const name = lines[0];
    const intro = lines.slice(1).join(' / ') || '（无简介）';
    return { name, intro };
  }

  // AI 回答玩家提问
  async function aiAnswerQuestion(question) {
    const sys = `你在玩"是否猜人物"游戏。
你心中已选定人物：「${character}」（不要直接说出名字）。
玩家将通过提问来猜测，你只能用以下三种方式回答：
- "是"
- "否"
- "不确定"

规则：
1. 只回复上述三个之一，不要加任何解释、标点说明或多余文字
2. 根据人物的真实属性诚实回答
3. 如果玩家的问题与人物无关或无法判断，回复"不确定"
4. 不要透露人物姓名`;
    const userMsg = `问答历史：\n${buildHistoryContext()}\n\n玩家新提问：${question}\n\n请回复"是"、"否"或"不确定"：`;
    const resp = await askLLM(sys, userMsg, 0.3, 30);
    if (!resp) return '不确定';
    // 提取首个有效答案
    const lower = resp.toLowerCase();
    if (lower.includes('是') && !lower.includes('不是') && !lower.includes('否')) return '是';
    if (lower.includes('否') || lower.includes('不是') || lower.includes('no')) return '否';
    if (lower.includes('不确定') || lower.includes('未知') || lower.includes('uncertain')) return '不确定';
    // 默认
    if (lower.startsWith('是')) return '是';
    if (lower.startsWith('否')) return '否';
    return '不确定';
  }

  // AI 判定玩家猜测
  async function aiJudgeGuess(guess) {
    const sys = `你在玩"是否猜人物"游戏。
你心中已选定人物：「${character}」。
玩家现在给出了猜测：「${guess}」。
请判断玩家猜测的人物是否就是「${character}」。
判断规则：
1. 必须是同一个人物（姓名可能存在别名/译名差异，允许同指一人）
2. 只回复"正确"或"错误"，不要加任何解释
3. 如果玩家猜测的人物与你选定的是同一人（即使姓名写法略有差异），回复"正确"
4. 否则回复"错误"`;
    const userMsg = `请判定：玩家猜「${guess}」，正确答案是「${character}」。`;
    const resp = await askLLM(sys, userMsg, 0.2, 30);
    if (!resp) return false;
    return resp.includes('正确') && !resp.includes('不正确');
  }

  // ---- Rendering ----
  function addQuestionEntry(question, answer) {
    const list = $('history-list');
    const entry = document.createElement('div');
    entry.className = 'gc-history-entry q-role';
    entry.innerHTML = `
      <div class="gc-entry-avatar"><i class="fa-solid fa-user"></i></div>
      <div class="gc-entry-body">
        <div class="gc-entry-role">玩家提问</div>
        <div class="gc-entry-text">${escapeHtml(question)}</div>
      </div>`;
    list.appendChild(entry);

    const ansEntry = document.createElement('div');
    ansEntry.className = 'gc-history-entry a-role';
    const ansClass = answer === '是' ? 'yes' : (answer === '否' ? 'no' : 'uncertain');
    ansEntry.innerHTML = `
      <div class="gc-entry-avatar"><i class="fa-solid fa-robot"></i></div>
      <div class="gc-entry-body">
        <div class="gc-entry-role">AI 回答</div>
        <div class="gc-entry-text"><span class="gc-entry-answer ${ansClass}">${escapeHtml(answer)}</span></div>
      </div>`;
    list.appendChild(ansEntry);
    list.scrollTop = list.scrollHeight;
  }

  function addGuessEntry(guess, correct) {
    const list = $('history-list');
    const entry = document.createElement('div');
    entry.className = `gc-history-entry ${correct ? 'guess-correct' : 'guess-wrong'}`;
    entry.innerHTML = `
      <div class="gc-entry-avatar"><i class="fa-solid fa-bullseye"></i></div>
      <div class="gc-entry-body">
        <div class="gc-entry-role">玩家猜测</div>
        <div class="gc-entry-text">${escapeHtml(guess)} <span class="gc-entry-answer ${correct ? 'yes' : 'no'}">${correct ? '正确！' : '错误'}</span></div>
      </div>`;
    list.appendChild(entry);
    list.scrollTop = list.scrollHeight;
  }

  function showThinking(label) {
    const list = $('history-list');
    let el = document.getElementById('thinking-indicator');
    if (el) el.remove();
    el = document.createElement('div');
    el.className = 'gc-thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="gc-thinking-dots"><span></span><span></span><span></span></div> ${escapeHtml(label)} 正在思考...`;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  }

  function removeThinking() {
    const el = $('thinking-indicator');
    if (el) el.remove();
  }

  function setInputEnabled(enabled) {
    $('question-input').disabled = !enabled;
    $('btn-ask').disabled = !enabled;
    $('btn-guess').disabled = !enabled;
    $('btn-pass').disabled = !enabled;
    if (enabled && !inGuessMode) {
      $('question-input').focus();
    }
  }

  function enterGuessMode() {
    inGuessMode = true;
    $('guess-mode').classList.remove('hidden');
    $('input-area').classList.add('hidden');
    $('guess-input').value = '';
    $('guess-input').focus();
  }

  function exitGuessMode() {
    inGuessMode = false;
    $('guess-mode').classList.add('hidden');
    $('input-area').classList.remove('hidden');
    $('question-input').focus();
  }

  function showGameOver(win, message) {
    gameOver = true;
    setInputEnabled(false);
    if (window.gameAPI?.reportResult) {
      window.gameAPI.reportResult(`是否猜人物结束：${message}（共提问 ${questionCount} 次）`);
    }
    const overlay = $('status-overlay');
    overlay.classList.remove('hidden');
    $('status-content').innerHTML = `
      <h2 class="${win ? 'win' : 'lose'}">${win ? '猜对了！' : '游戏结束'}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="gc-answer-reveal"><i class="fa-solid fa-star"></i> 正确答案：${escapeHtml(character)}</div>
      ${characterHint ? `<p style="margin-top:8px;font-size:13px;color:var(--gc-text-dim)">${escapeHtml(characterHint)}</p>` : ''}
      <p style="margin-top:8px;font-size:13px;color:var(--gc-text-dim)">共提问 ${questionCount} 次，剩余猜测 ${guessRemaining} 次</p>
      <div>
        <button type="button" onclick="location.reload()">再来一局</button>
        <button type="button" onclick="window.close()">关闭</button>
      </div>`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  // ---- Game Loop ----
  async function gameLoop() {
    while (!gameOver) {
      // 等待用户输入（提问或猜测）
      const action = await waitForUserAction();
      if (gameOver) break;

      if (action.type === 'pass') {
        showGameOver(false, '你选择了认输');
        break;
      }

      if (action.type === 'question') {
        if (questionCount >= MAX_QUESTIONS) {
          showGameOver(false, `已达到最大提问次数（${MAX_QUESTIONS} 次）`);
          break;
        }
        questionCount++;
        $('question-count').textContent = questionCount;
        showThinking('AI');
        const answer = await aiAnswerQuestion(action.text);
        removeThinking();
        history.push({ role: 'q', text: action.text });
        history.push({ role: 'a', text: answer, answer });
        addQuestionEntry(action.text, answer);
        continue;
      }

      if (action.type === 'guess') {
        showThinking('裁判');
        const correct = await aiJudgeGuess(action.text);
        removeThinking();
        history.push({ role: 'guess', text: action.text, answer: correct ? '正确' : '错误' });
        addGuessEntry(action.text, correct);
        guessRemaining--;
        $('guess-remaining').textContent = guessRemaining;

        if (correct) {
          showGameOver(true, `恭喜你猜对了！用了 ${questionCount} 次提问`);
          break;
        } else {
          if (guessRemaining <= 0) {
            showGameOver(false, `猜测次数已用完（共 ${MAX_GUESSES} 次）`);
            break;
          }
          $('hint-text').textContent = `猜测错误，还剩 ${guessRemaining} 次猜测机会，请继续提问缩小范围`;
        }
      }
    }
  }

  function waitForUserAction() {
    return new Promise((resolve) => {
      userInputResolve = resolve;
      setInputEnabled(true);
    });
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Init ----
  async function start() {
    await applyTheme();

    // Initialize entropy source
    try {
      const trng = await window.gameAPI.trngGetSeed();
      if (trng && trng.ok) {
        gameRng = mulberry32(trng.seed);
        if (trng.entropySource === 'TRNG') {
          const badge = document.getElementById('game-trng-badge');
          if (badge) badge.style.display = 'inline-flex';
        }
      }
    } catch { /* use default Math.random */ }

    // Load config
    try {
      const config = await window.gameAPI.getGameConfig();
      if (config?.category) {
        const found = CATEGORIES.find(c => c.id === config.category);
        if (found) { category = found.id; categoryName = found.name; }
      }
    } catch { /* use defaults */ }

    $('category-display').textContent = categoryName;
    $('guess-remaining').textContent = guessRemaining;
    $('question-count').textContent = questionCount;
    setInputEnabled(false);

    // AI 选定人物
    $('hint-text').textContent = 'AI 正在选定人物...';
    showThinking('AI');
    const picked = await aiPickCharacter();
    removeThinking();

    if (!picked || !picked.name) {
      $('hint-text').textContent = 'AI 无法选定人物，请稍后重试';
      showGameOver(false, 'AI 无法选定人物，游戏终止');
      return;
    }

    character = picked.name;
    characterHint = picked.intro;
    $('hint-text').textContent = `AI 已想好一位「${categoryName}」类别的人物，请开始提问`;
    console.log('[Game] AI picked character:', character); // for debug only

    // Bind input events
    $('btn-ask').addEventListener('click', () => {
      if (!userInputResolve) return;
      const val = $('question-input').value.trim();
      if (!val) return;
      $('question-input').value = '';
      setInputEnabled(false);
      userInputResolve({ type: 'question', text: val });
      userInputResolve = null;
    });

    $('question-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && userInputResolve) {
        $('btn-ask').click();
      }
    });

    $('btn-guess').addEventListener('click', () => {
      if (!userInputResolve) return;
      enterGuessMode();
    });

    $('btn-pass').addEventListener('click', () => {
      if (!userInputResolve) return;
      setInputEnabled(false);
      userInputResolve({ type: 'pass' });
      userInputResolve = null;
    });

    // Guess mode events
    $('btn-guess-confirm').addEventListener('click', () => {
      if (!userInputResolve) return;
      const val = $('guess-input').value.trim();
      if (!val) return;
      $('guess-input').value = '';
      exitGuessMode();
      setInputEnabled(false);
      userInputResolve({ type: 'guess', text: val });
      userInputResolve = null;
    });

    $('guess-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && userInputResolve) {
        $('btn-guess-confirm').click();
      }
    });

    $('btn-guess-cancel').addEventListener('click', () => {
      exitGuessMode();
      setInputEnabled(true);
    });

    $('btn-close').addEventListener('click', () => window.close());

    // Start game
    await delay(300);
    gameLoop();
  }

  start();
})();
