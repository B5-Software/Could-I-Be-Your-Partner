/**
 * 飞花令 - Flying Flower Poetry Game
 * Independent window with LLM-powered AI players
 */

(function () {
  'use strict';

  const KEYWORDS = ['花', '月', '春', '风', '雨', '山', '水', '云', '雪', '梦', '夜', '天', '心', '红', '白', '秋', '江', '书', '人'];
  const AI_NAMES = ['诗仙', '词圣', '文豪', '才子', '雅士', '墨客', '诗人', '学士'];

  const $ = (id) => document.getElementById(id);

  let keyword = '';
  let players = [];       // { name, isUser, alive, avatar }
  let usedLines = new Set();
  let round = 0;
  let currentPlayerIdx = 0;
  let gameOver = false;
  let userInputResolve = null;

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
    } catch (e) {
      console.log('Theme error:', e.message);
    }
  }

  // ---- LLM ----
  async function askLLM(systemPrompt, userMsg) {
    try {
      const result = await window.gameAPI.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ], { temperature: 0.9, max_tokens: 200 });
      if (result.ok && result.data?.choices?.[0]?.message?.content) {
        return result.data.choices[0].message.content.trim();
      }
    } catch (e) { console.error('LLM error:', e); }
    return null;
  }

  // AI generates a poetry line
  async function aiGenerateLine(aiName) {
    const usedList = [...usedLines].join('\n') || '暂无';
    const systemPrompt = `你是「${aiName}」，一位精通中国古典诗词的文人，正在玩飞花令游戏。关键字是「${keyword}」。
规则：你必须说出一句包含「${keyword}」字的完整中国古诗词句（唐诗宋词元曲等皆可）。
要求：
1. 只回复一句诗词原文，不要加任何解释、标点说明、出处、作者或多余文字
2. 不能重复已经说过的诗句
3. 诗句必须包含「${keyword}」字
4. 如果实在想不出，回复"认输"
5. 请确保是真实存在的古诗词原句`;
    const userMsg = `已经使用过的诗句：\n${usedList}\n\n请说出一句包含「${keyword}」字的诗句：`;
    return await askLLM(systemPrompt, userMsg);
  }

  // Validate whether a line is a real ancient Chinese poetry quote
  async function validatePoetryLine(line, kw) {
    try {
      const result = await askLLM(
        `你是一位中国古典诗词鉴定专家。用户在飞花令游戏中给出了一句声称包含「${kw}」字的古诗词。
请严格判断这句话是否是真实存在的中国古诗词原句（唐诗、宋词、元曲、诗经、楚辞等皆可）。
注意：
1. 必须是完整的原句，不能是自己编造的
2. 允许标点差异或繁简体差异
3. 只回复"是"或"否"，不要解释`,
        `请判断：「${line}」`
      );
      if (!result) return true; // LLM failure → benefit of the doubt
      return !result.includes('否');
    } catch {
      return true; // on error, don't penalize
    }
  }

  // ---- Rendering ----
  function renderPlayers() {
    const bar = $('players-bar');
    bar.innerHTML = '';
    players.forEach((p, i) => {
      const tag = document.createElement('div');
      tag.className = `ff-player-tag${!p.alive ? ' eliminated' : ''}${p.isUser ? ' is-user' : ''}${currentPlayerIdx === i && p.alive && !gameOver ? ' active' : ''}`;
      const initial = p.isUser ? '你' : p.name[0];
      tag.innerHTML = `<div class="ff-player-icon">${initial}</div><span>${p.isUser ? '你' : p.name}</span>`;
      bar.appendChild(tag);
    });
    $('alive-count').textContent = players.filter(p => p.alive).length;
  }

  function addHistoryEntry(name, text, success, isUser) {
    const list = $('history-list');
    const entry = document.createElement('div');
    entry.className = `ff-history-entry ${success ? 'success' : 'fail'}`;
    const initial = isUser ? '你' : name[0];
    entry.innerHTML = `
      <div class="ff-entry-avatar">${initial}</div>
      <div class="ff-entry-body">
        <div class="ff-entry-name">${isUser ? '你' : name}</div>
        <div class="ff-entry-text">${escapeHtml(text)}</div>
        <div class="ff-entry-round">第 ${round} 轮</div>
      </div>
      <div class="ff-entry-status">${success ? '<i class="fa-solid fa-check" style="color:var(--ff-success)"></i>' : '<i class="fa-solid fa-xmark" style="color:var(--ff-danger)"></i>'}</div>`;
    list.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function showThinking(name) {
    const list = $('history-list');
    const el = document.createElement('div');
    el.className = 'ff-thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="ff-thinking-dots"><span></span><span></span><span></span></div> ${name} 正在思考...`;
    list.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function removeThinking() {
    const el = $('thinking-indicator');
    if (el) el.remove();
  }

  function setInputEnabled(enabled) {
    $('poetry-input').disabled = !enabled;
    $('btn-submit').disabled = !enabled;
    $('btn-pass').disabled = !enabled;
    if (enabled) {
      $('input-hint').textContent = `轮到你了，请输入含有「${keyword}」的诗句`;
      $('poetry-input').focus();
    } else {
      $('input-hint').textContent = '等待其他玩家...';
    }
  }

  function showGameOver(message, survivors) {
    gameOver = true;
    setInputEnabled(false);
    if (window.gameAPI?.reportResult) {
      window.gameAPI.reportResult(`飞花令结束：${message}（共 ${round} 轮，收录 ${usedLines.size} 句诗）`);
    }
    const overlay = $('status-overlay');
    overlay.classList.remove('hidden');
    $('status-content').innerHTML = `
      <h2>飞花令结束</h2>
      <p>${escapeHtml(message)}</p>
      <p>共进行了 ${round} 轮，收录 ${usedLines.size} 句诗</p>
      <div>
        <button onclick="location.reload()">再来一局</button>
        <button onclick="window.close()">关闭</button>
      </div>`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ---- User Input ----
  function waitForUserInput() {
    return new Promise((resolve) => {
      userInputResolve = resolve;
      setInputEnabled(true);
    });
  }

  // ---- Game Loop ----
  async function gameLoop() {
    const maxRounds = 20;

    while (!gameOver && round < maxRounds) {
      round++;
      $('round-num').textContent = round;
      renderPlayers();

      const alivePlayers = players.filter(p => p.alive);
      if (alivePlayers.length <= 1) {
        const surv = alivePlayers[0];
        showGameOver(surv ? `最后的赢家是「${surv.isUser ? '你' : surv.name}」！` : '所有玩家都被淘汰了！', alivePlayers);
        break;
      }

      for (let i = 0; i < players.length; i++) {
        if (gameOver) break;
        const p = players[i];
        if (!p.alive) continue;

        currentPlayerIdx = i;
        renderPlayers();

        let line = '';
        let success = false;

        if (p.isUser) {
          // User's turn
          line = await waitForUserInput();
          if (line === '__PASS__') {
            p.alive = false;
            addHistoryEntry('你', '认输', false, true);
            renderPlayers();
            continue;
          }
          // Validate
          if (!line.includes(keyword)) {
            p.alive = false;
            addHistoryEntry('你', line + ' (不含关键字)', false, true);
            renderPlayers();
            continue;
          }
          if (usedLines.has(line.trim())) {
            p.alive = false;
            addHistoryEntry('你', line + ' (重复)', false, true);
            renderPlayers();
            continue;
          }
          // LLM validation: check if this is a real ancient Chinese poetry line
          showThinking('裁判');
          const isReal = await validatePoetryLine(line.trim(), keyword);
          removeThinking();
          if (!isReal) {
            p.alive = false;
            addHistoryEntry('你', line + ' (非真实诗句)', false, true);
            renderPlayers();
            continue;
          }
          usedLines.add(line.trim());
          addHistoryEntry('你', line, true, true);
          success = true;
        } else {
          // AI's turn
          showThinking(p.name);
          line = await aiGenerateLine(p.name);
          removeThinking();

          if (!line || line.includes('认输') || !line.includes(keyword)) {
            p.alive = false;
            addHistoryEntry(p.name, line || '(无法作答)', false, false);
            renderPlayers();
            continue;
          }
          // Clean up the response - take only the first line that contains the keyword
          const lines = line.split('\n').map(l => l.trim()).filter(l => l && l.includes(keyword));
          const chosen = lines[0] || line.split('\n')[0].trim();

          if (usedLines.has(chosen)) {
            p.alive = false;
            addHistoryEntry(p.name, chosen + ' (重复)', false, false);
            renderPlayers();
            continue;
          }
          usedLines.add(chosen);
          addHistoryEntry(p.name, chosen, true, false);
          success = true;
        }

        // Short delay between players
        if (success) await delay(300);

        // Check if only 1 left
        if (players.filter(pp => pp.alive).length <= 1) {
          const surv = players.filter(pp => pp.alive);
          const msg = surv.length === 1
            ? `最后的赢家是「${surv[0].isUser ? '你' : surv[0].name}」！`
            : '所有玩家都被淘汰了！';
          showGameOver(msg, surv);
          break;
        }
      }
    }

    if (!gameOver) {
      const surv = players.filter(p => p.alive);
      showGameOver(`已达到最大回合数，幸存者：${surv.map(p => p.isUser ? '你' : p.name).join('、')}`, surv);
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Init ----
  async function start() {
    await applyTheme();

    let aiCount = 3;
    try {
      const config = await window.gameAPI.getGameConfig();
      if (config) {
        if (config.aiCount) aiCount = config.aiCount;
        if (config.keyword) keyword = config.keyword;
      }
    } catch { /* use defaults */ }

    if (!keyword) {
      keyword = KEYWORDS[Math.floor(Math.random() * KEYWORDS.length)];
    }

    $('keyword-display').textContent = keyword;

    // Build players: user first, then AIs
    players = [{ name: '你', isUser: true, alive: true }];
    for (let i = 0; i < aiCount; i++) {
      players.push({ name: AI_NAMES[i % AI_NAMES.length], isUser: false, alive: true });
    }

    renderPlayers();
    setInputEnabled(false);

    // Bind input events
    $('btn-submit').addEventListener('click', () => {
      if (!userInputResolve) return;
      const val = $('poetry-input').value.trim();
      if (!val) return;
      $('poetry-input').value = '';
      setInputEnabled(false);
      userInputResolve(val);
      userInputResolve = null;
    });

    $('poetry-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && userInputResolve) {
        $('btn-submit').click();
      }
    });

    $('btn-pass').addEventListener('click', () => {
      if (!userInputResolve) return;
      setInputEnabled(false);
      userInputResolve('__PASS__');
      userInputResolve = null;
    });

    $('btn-close').addEventListener('click', () => window.close());

    // Start game
    await delay(500);
    gameLoop();
  }

  start();
})();
