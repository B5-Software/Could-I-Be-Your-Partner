/**
 * 谁是卧底 - Undercover Game
 * Independent window with LLM-powered AI players
 */

(function () {
  'use strict';

  const WORD_PAIRS = [
    ['苹果', '梨子'], ['猫', '狗'], ['咖啡', '奶茶'], ['自行车', '电动车'], ['足球', '篮球'],
    ['医生', '护士'], ['钢琴', '吉他'], ['火锅', '烧烤'], ['高铁', '飞机'], ['开源', '自由'],
    ['数学', '物理'], ['春天', '秋天'], ['月亮', '太阳'], ['海洋', '湖泊'], ['小说', '电影'],
    ['面包', '蛋糕'], ['眼镜', '望远镜'], ['雨伞', '雨衣'], ['冰箱', '空调'], ['手表', '闹钟'],
  ];
  const PLAYER_NAMES = ['小明', '小红', '小刚', '小美', '小华', '小李', '小张', '小王'];

  const $ = (id) => document.getElementById(id);

  let players = [];       // { name, isUser, alive, word, isUndercover, descriptions }
  let round = 0;
  let gameOver = false;
  let wordPair = [];
  let userInputResolve = null;
  let userVoteResolve = null;
  let allDescriptions = []; // { round, name, text }

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
  async function askLLM(systemPrompt, userMsg) {
    try {
      const result = await window.gameAPI.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ], { temperature: 0.8, max_tokens: 200 });
      if (result.ok && result.data?.choices?.[0]?.message?.content) {
        return result.data.choices[0].message.content.trim();
      }
    } catch (e) { console.error('LLM error:', e); }
    return null;
  }

  async function aiDescribe(player) {
    const prevDescs = allDescriptions.map(d => `${d.name}: ${d.text}`).join('\n') || '暂无';
    const roleHint = player.isUndercover
      ? '你是卧底！你的词和其他人不同。你要尽量伪装，让别人以为你和他们一样。不要说得太具体以免暴露自己。'
      : '你是平民。你需要通过描述展示你知道这个词，但不要太直白以免让卧底猜到你的词。';

    const systemPrompt = `你是「${player.name}」，正在玩谁是卧底游戏。
你拿到的词是：「${player.word}」
${roleHint}

规则：
1. 用一句简短的话描述你的词，但不能直接说出这个词
2. 描述要有辨识度但不过于直白
3. 只回复一句描述，不要加解释或多余文字
4. 不要说"我的词是"之类的话`;

    const userMsg = `前面的发言记录：\n${prevDescs}\n\n请用一句话描述你的词「${player.word}」：`;
    return await askLLM(systemPrompt, userMsg);
  }

  async function aiVote(player, alivePlayers) {
    const prevDescs = allDescriptions.map(d => `${d.name}: ${d.text}`).join('\n');
    const aliveNames = alivePlayers.filter(p => p.name !== player.name).map(p => p.name);
    const roleHint = player.isUndercover
      ? '你是卧底。你需要把怀疑引向平民，保护自己。'
      : '你是平民。请根据发言找出描述可疑的人。';

    const systemPrompt = `你是「${player.name}」，正在玩谁是卧底游戏的投票环节。
你的词是：「${player.word}」
${roleHint}

规则：
1. 只回复一个你认为是卧底的玩家名字
2. 不能投自己
3. 只回复名字，不要加解释`;

    const userMsg = `发言记录：\n${prevDescs}\n\n存活玩家：${aliveNames.join('、')}\n你认为谁是卧底？只回复名字：`;
    const resp = await askLLM(systemPrompt, userMsg);
    if (resp) {
      const voted = aliveNames.find(n => resp.includes(n));
      return voted || aliveNames[Math.floor(Math.random() * aliveNames.length)];
    }
    return aliveNames[Math.floor(Math.random() * aliveNames.length)];
  }

  // ---- Rendering ----
  function renderPlayers() {
    const list = $('players-list');
    list.innerHTML = '';
    players.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = `uc-player-item${!p.alive ? ' eliminated' : ''}`;
      const initial = p.isUser ? '你' : p.name[0];
      let badge = '';
      if (!p.alive && gameOver) {
        badge = `<span class="uc-player-badge ${p.isUndercover ? 'undercover' : 'civilian'}">${p.isUndercover ? '卧底' : '平民'}</span>`;
      } else if (!p.alive) {
        badge = '<span class="uc-player-badge">已淘汰</span>';
      }
      item.innerHTML = `
        <div class="uc-player-avatar">${initial}</div>
        <span class="uc-player-name">${p.isUser ? '你' : p.name}</span>
        ${badge}`;
      list.appendChild(item);
    });
    $('alive-count').textContent = players.filter(p => p.alive).length;
  }

  function addDescription(name, text, round, isUser, isNewRound) {
    const list = $('desc-list');
    const entry = document.createElement('div');
    entry.className = `uc-desc-entry${isNewRound ? ' new-round' : ''}`;
    const initial = isUser ? '你' : name[0];
    entry.innerHTML = `
      <div class="uc-desc-avatar">${initial}</div>
      <div class="uc-desc-body">
        <div class="uc-desc-name">${isUser ? '你' : name} <span class="uc-desc-round-label">第${round}轮</span></div>
        <div class="uc-desc-text">${escapeHtml(text)}</div>
      </div>`;
    list.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function addVoteEntry(text) {
    const list = $('desc-list');
    const entry = document.createElement('div');
    entry.className = 'uc-vote-entry';
    entry.innerHTML = text;
    list.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function addVoteResult(text, isEliminated) {
    const list = $('desc-list');
    const entry = document.createElement('div');
    entry.className = `uc-vote-result ${isEliminated ? 'eliminated' : 'safe'}`;
    entry.textContent = text;
    list.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function showThinking(name) {
    const list = $('desc-list');
    const el = document.createElement('div');
    el.className = 'uc-thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="uc-thinking-dots"><span></span><span></span><span></span></div> ${name} 正在思考...`;
    list.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function removeThinking() {
    const el = $('thinking-indicator');
    if (el) el.remove();
  }

  function setDescInputVisible(visible) {
    $('desc-input-area').style.display = visible ? '' : 'none';
    if (visible) {
      $('desc-input').disabled = false;
      $('btn-desc-submit').disabled = false;
      $('desc-input').focus();
    }
  }

  function setVoteAreaVisible(visible, alivePlayers) {
    const area = $('vote-area');
    if (visible) {
      area.classList.remove('hidden');
      const opts = $('vote-options');
      opts.innerHTML = '';
      let selected = null;
      alivePlayers.filter(p => !p.isUser).forEach(p => {
        const btn = document.createElement('div');
        btn.className = 'uc-vote-option';
        btn.textContent = p.name;
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.uc-vote-option').forEach(o => o.classList.remove('selected'));
          btn.classList.add('selected');
          selected = p.name;
          $('btn-vote').disabled = false;
        });
        opts.appendChild(btn);
      });
      $('btn-vote').disabled = true;
      $('btn-vote').onclick = () => {
        if (selected && userVoteResolve) {
          area.classList.add('hidden');
          userVoteResolve(selected);
          userVoteResolve = null;
        }
      };
    } else {
      area.classList.add('hidden');
    }
  }

  function showGameOverResult(message, isUndercoverWin) {
    gameOver = true;
    if (window.gameAPI?.reportResult) {
      window.gameAPI.reportResult(`谁是卧底结束：${message}（${isUndercoverWin ? '卧底获胜' : '平民获胜'}）`);
    }
    setDescInputVisible(false);
    setVoteAreaVisible(false);
    renderPlayers(); // Shows roles
    const overlay = $('status-overlay');
    overlay.classList.remove('hidden');
    $('status-content').innerHTML = `
      <h2>${isUndercoverWin ? '卧底胜利' : '平民胜利'}！</h2>
      <p>${escapeHtml(message)}</p>
      <div class="uc-word-reveal">
        平民词：<strong>${wordPair[0]}</strong> &nbsp;|&nbsp; 卧底词：<strong>${wordPair[1]}</strong>
      </div>
      <p>共进行了 ${round} 轮</p>
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
  function waitForUserDesc() {
    return new Promise((resolve) => {
      userInputResolve = resolve;
      setDescInputVisible(true);
      $('desc-hint').textContent = `轮到你描述你的词语了（不能直接说出词语）`;
    });
  }

  function waitForUserVote(alivePlayers) {
    return new Promise((resolve) => {
      userVoteResolve = resolve;
      setVoteAreaVisible(true, alivePlayers);
    });
  }

  // ---- Game Loop ----
  async function gameLoop() {
    const maxRounds = 8;

    while (!gameOver && round < maxRounds) {
      round++;
      $('round-num').textContent = round;
      $('phase-info').textContent = '描述阶段';

      const alive = players.filter(p => p.alive);
      if (alive.length <= 2) break;

      // ---- Description Phase ----
      const roundDescs = [];
      let isFirst = true;
      for (const p of alive) {
        if (gameOver) break;

        let desc = '';
        if (p.isUser) {
          desc = await waitForUserDesc();
        } else {
          showThinking(p.name);
          desc = await aiDescribe(p);
          removeThinking();
          desc = desc || '(沉默)';
          // Clean up: take first line only
          desc = desc.split('\n')[0].trim();
        }

        allDescriptions.push({ round, name: p.isUser ? '你' : p.name, text: desc });
        roundDescs.push({ player: p, text: desc });
        addDescription(p.isUser ? '你' : p.name, desc, round, p.isUser, isFirst);
        isFirst = false;
        await delay(200);
      }

      setDescInputVisible(false);

      // ---- Voting Phase ----
      $('phase-info').textContent = '投票阶段';
      await delay(500);

      const aliveForVote = players.filter(p => p.alive);
      const votes = {};
      aliveForVote.forEach(p => { votes[p.name] = 0; });

      for (const p of aliveForVote) {
        let votedName = '';
        if (p.isUser) {
          votedName = await waitForUserVote(aliveForVote);
        } else {
          showThinking(p.name);
          votedName = await aiVote(p, aliveForVote);
          removeThinking();
        }
        votes[votedName] = (votes[votedName] || 0) + 1;
        addVoteEntry(`<strong>${p.isUser ? '你' : p.name}</strong> 投了 <strong>${votedName}</strong>`);
        await delay(200);
      }

      // Eliminate highest voted
      let maxVotes = 0, eliminated = null;
      for (const [name, count] of Object.entries(votes)) {
        if (count > maxVotes) { maxVotes = count; eliminated = name; }
      }

      if (eliminated) {
        const elimPlayer = players.find(p => (p.isUser ? '你' : p.name) === eliminated);
        if (elimPlayer) {
          elimPlayer.alive = false;
          addVoteResult(
            `${elimPlayer.isUser ? '你' : elimPlayer.name} 被淘汰！（${elimPlayer.isUndercover ? '卧底' : '平民'}）`,
            true
          );
          renderPlayers();

          if (elimPlayer.isUndercover) {
            showGameOverResult(`卧底「${elimPlayer.isUser ? '你' : elimPlayer.name}」被成功找出！`, false);
            return;
          }
        }
      }

      // Check undercover win condition
      const aliveNow = players.filter(p => p.alive);
      const undercoverAlive = aliveNow.some(p => p.isUndercover);
      if (aliveNow.length <= 2 && undercoverAlive) {
        const uc = aliveNow.find(p => p.isUndercover);
        showGameOverResult(`卧底${uc.isUser ? '（你）' : '「' + uc.name + '」'}成功隐藏到最后！`, true);
        return;
      }
      if (!undercoverAlive) {
        showGameOverResult('所有卧底已被找出！', false);
        return;
      }

      await delay(500);
    }

    // Max rounds reached
    if (!gameOver) {
      const uc = players.find(p => p.isUndercover && p.alive);
      if (uc) {
        showGameOverResult(`达到最大回合数，卧底${uc.isUser ? '（你）' : '「' + uc.name + '」'}存活到最后！`, true);
      } else {
        showGameOverResult('达到最大回合数，平民获胜！', false);
      }
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Init ----
  async function start() {
    await applyTheme();

    let aiCount = 4;
    let userIsUndercover = false;
    try {
      const config = await window.gameAPI.getGameConfig();
      if (config) {
        if (config.aiCount) aiCount = config.aiCount;
      }
    } catch { /* defaults */ }

    // Pick words
    wordPair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
    const totalPlayers = aiCount + 1;
    // At least 1 undercover among AI
    const undercoverIdx = Math.floor(Math.random() * totalPlayers);
    userIsUndercover = undercoverIdx === 0;

    // Build players
    players = [];
    players.push({
      name: '你',
      isUser: true,
      alive: true,
      word: userIsUndercover ? wordPair[1] : wordPair[0],
      isUndercover: userIsUndercover,
      descriptions: []
    });
    for (let i = 0; i < aiCount; i++) {
      const isUC = (i + 1) === undercoverIdx;
      players.push({
        name: PLAYER_NAMES[i % PLAYER_NAMES.length],
        isUser: false,
        alive: true,
        word: isUC ? wordPair[1] : wordPair[0],
        isUndercover: isUC,
        descriptions: []
      });
    }

    // Show user's word
    $('my-word').textContent = players[0].word;

    renderPlayers();
    setDescInputVisible(false);
    setVoteAreaVisible(false);

    // Bind input
    $('btn-desc-submit').addEventListener('click', () => {
      if (!userInputResolve) return;
      const val = $('desc-input').value.trim();
      if (!val) return;
      $('desc-input').value = '';
      setDescInputVisible(false);
      userInputResolve(val);
      userInputResolve = null;
    });

    $('desc-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('btn-desc-submit').click();
    });

    $('btn-close').addEventListener('click', () => window.close());

    // Start
    await delay(500);
    gameLoop();
  }

  start();
})();
