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

  // ---- LLM ----
  async function askLLM(systemPrompt, userMsg) {
    try {
      const result = await window.gameAPI.chatLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ], { temperature: 0.8, max_tokens: 200, reasoningEffort: 'off' });
      if (result.ok && result.data?.choices?.[0]?.message) {
        const msg = result.data.choices[0].message;
        let content = (msg.content || '').trim();
        // 清理思考标签： simd/<reasoning>/<reasoning_content>/<thought> 等成对与未闭合形式
        content = stripThinkingTags(content);
        // 清理 markdown 代码块包裹
        content = content.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
        return content || null;
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
      return voted || aliveNames[Math.floor(gameRng() * aliveNames.length)];
    }
    return aliveNames[Math.floor(gameRng() * aliveNames.length)];
  }

  // ---- Rendering ----
  function renderPlayers() {
    const list = $('players-list');
    list.innerHTML = '';
    players.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = `uc-player-item${!p.alive ? ' eliminated' : ''}`;
      const youLabel = t('game.common.you', '你');
      const initial = p.isUser ? youLabel : p.name[0];
      let badge = '';
      if (!p.alive && gameOver) {
        badge = `<span class="uc-player-badge ${p.isUndercover ? 'undercover' : 'civilian'}">${p.isUndercover ? t('game.undercover.undercover', '卧底') : t('game.undercover.civilian', '平民')}</span>`;
      } else if (!p.alive) {
        badge = `<span class="uc-player-badge">${t('game.undercover.eliminated', '已淘汰')}</span>`;
      }
      item.innerHTML = `
        <div class="uc-player-avatar">${escapeHtml(initial)}</div>
        <span class="uc-player-name">${p.isUser ? escapeHtml(youLabel) : escapeHtml(p.name)}</span>
        ${badge}`;
      list.appendChild(item);
    });
    $('alive-count').textContent = players.filter(p => p.alive).length;
  }

  function addDescription(name, text, round, isUser, isNewRound) {
    const list = $('desc-list');
    const entry = document.createElement('div');
    entry.className = `uc-desc-entry${isNewRound ? ' new-round' : ''}`;
    const youLabel = t('game.common.you', '你');
    const initial = isUser ? youLabel : name[0];
    entry.innerHTML = `
      <div class="uc-desc-avatar">${escapeHtml(initial)}</div>
      <div class="uc-desc-body">
        <div class="uc-desc-name">${isUser ? escapeHtml(youLabel) : escapeHtml(name)} <span class="uc-desc-round-label">${escapeHtml(t('game.common.roundN', '第 {round} 轮', { round }))}</span></div>
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
    el.innerHTML = `<div class="uc-thinking-dots"><span></span><span></span><span></span></div> ${escapeHtml(t('game.common.thinking', '{name} 正在思考...', { name }))}`;
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
      window.gameAPI.reportResult(t('game.undercover.reportResult', '谁是卧底结束：{message}（{winner}）', { message, winner: isUndercoverWin ? t('game.undercover.undercoverWin', '卧底获胜') : t('game.undercover.civilianWin', '平民获胜') }));
    }
    setDescInputVisible(false);
    setVoteAreaVisible(false);
    renderPlayers(); // Shows roles
    const overlay = $('status-overlay');
    overlay.classList.remove('hidden');
    $('status-content').innerHTML = `
      <h2>${escapeHtml(isUndercoverWin ? t('game.undercover.undercoverVictory', '卧底胜利') : t('game.undercover.civilianVictory', '平民胜利'))}！</h2>
      <p>${escapeHtml(message)}</p>
      <div class="uc-word-reveal">
        ${escapeHtml(t('game.undercover.civilianWord', '平民词'))}：<strong>${escapeHtml(wordPair[0])}</strong> &nbsp;|&nbsp; ${escapeHtml(t('game.undercover.undercoverWord', '卧底词'))}：<strong>${escapeHtml(wordPair[1])}</strong>
      </div>
      <p>${escapeHtml(t('game.undercover.totalRounds', '共进行了 {round} 轮', { round }))}</p>
      <div>
        <button onclick="location.reload()">${escapeHtml(t('game.common.playAgain', '再来一局'))}</button>
        <button onclick="window.close()">${escapeHtml(t('game.common.close', '关闭'))}</button>
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
      $('desc-hint').textContent = t('game.undercover.descHint', '轮到你描述你的词语了（不能直接说出词语）');
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
    const youLabel = t('game.common.you', '你');

    while (!gameOver && round < maxRounds) {
      round++;
      $('round-num').textContent = round;
      $('phase-info').textContent = t('game.undercover.phaseDescribe', '描述阶段');

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
          desc = desc || t('game.undercover.silent', '(沉默)');
          // Clean up: take first line only
          desc = desc.split('\n')[0].trim();
        }

        allDescriptions.push({ round, name: p.isUser ? youLabel : p.name, text: desc });
        roundDescs.push({ player: p, text: desc });
        addDescription(p.isUser ? youLabel : p.name, desc, round, p.isUser, isFirst);
        isFirst = false;
        await delay(200);
      }

      setDescInputVisible(false);

      // ---- Voting Phase ----
      $('phase-info').textContent = t('game.undercover.phaseVote', '投票阶段');
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
        addVoteEntry(`<strong>${escapeHtml(p.isUser ? youLabel : p.name)}</strong> ${escapeHtml(t('game.undercover.voted', '投了'))} <strong>${escapeHtml(votedName)}</strong>`);
        await delay(200);
      }

      // Eliminate highest voted
      let maxVotes = 0, eliminated = null;
      for (const [name, count] of Object.entries(votes)) {
        if (count > maxVotes) { maxVotes = count; eliminated = name; }
      }

      if (eliminated) {
        const elimPlayer = players.find(p => (p.isUser ? youLabel : p.name) === eliminated);
        if (elimPlayer) {
          elimPlayer.alive = false;
          addVoteResult(
            t('game.undercover.eliminatedMsg', '{name} 被淘汰！（{role}）', { name: elimPlayer.isUser ? youLabel : elimPlayer.name, role: elimPlayer.isUndercover ? t('game.undercover.undercover', '卧底') : t('game.undercover.civilian', '平民') }),
            true
          );
          renderPlayers();

          if (elimPlayer.isUndercover) {
            showGameOverResult(t('game.undercover.undercoverFound', '卧底「{name}」被成功找出！', { name: elimPlayer.isUser ? youLabel : elimPlayer.name }), false);
            return;
          }
        }
      }

      // Check undercover win condition
      const aliveNow = players.filter(p => p.alive);
      const undercoverAlive = aliveNow.some(p => p.isUndercover);
      if (aliveNow.length <= 2 && undercoverAlive) {
        const uc = aliveNow.find(p => p.isUndercover);
        showGameOverResult(t('game.undercover.undercoverHidden', '卧底{name}成功隐藏到最后！', { name: uc.isUser ? t('game.undercover.youParens', '（你）') : '「' + uc.name + '」' }), true);
        return;
      }
      if (!undercoverAlive) {
        showGameOverResult(t('game.undercover.allUndercoverFound', '所有卧底已被找出！'), false);
        return;
      }

      await delay(500);
    }

    // Max rounds reached
    if (!gameOver) {
      const uc = players.find(p => p.isUndercover && p.alive);
      if (uc) {
        showGameOverResult(t('game.undercover.maxRoundsUndercoverAlive', '达到最大回合数，卧底{name}存活到最后！', { name: uc.isUser ? t('game.undercover.youParens', '（你）') : '「' + uc.name + '」' }), true);
      } else {
        showGameOverResult(t('game.undercover.maxRoundsCivilianWin', '达到最大回合数，平民获胜！'), false);
      }
    }
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---- Init ----
  async function start() {
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

    let aiCount = 4;
    let userIsUndercover = false;
    try {
      const config = await window.gameAPI.getGameConfig();
      if (config) {
        if (config.aiCount) aiCount = config.aiCount;
      }
    } catch { /* defaults */ }

    // Pick words
    wordPair = WORD_PAIRS[Math.floor(gameRng() * WORD_PAIRS.length)];
    const totalPlayers = aiCount + 1;
    // At least 1 undercover among AI
    const undercoverIdx = Math.floor(gameRng() * totalPlayers);
    userIsUndercover = undercoverIdx === 0;

    // Build players
    players = [];
    players.push({
      name: t('game.common.you', '你'),
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
