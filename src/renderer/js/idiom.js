/**
 * 成语接龙 - Idiom Chain Game
 * Independent window with LLM-powered AI players + LLM judge
 * 简易上下文管理：保留最近 N 轮的接龙历史作为 LLM 上下文
 */

(function () {
  'use strict';

  const START_IDIOMS = [
    '一帆风顺', '心想事成', '马到成功', '万事如意', '春暖花开',
    '海阔天空', '风和日丽', '光明正大', '全力以赴', '胸有成竹',
    '画龙点睛', '锦上添花', '雪中送炭', '乘风破浪', '勇往直前'
  ];
  const AI_NAMES = ['才子', '学士', '文豪', '雅士', '墨客', '诗人', '博士', '教授'];

  // 上下文管理：保留最近 N 条接龙历史，避免 LLM context 无限增长
  const MAX_HISTORY_IN_CONTEXT = 20;

  const $ = (id) => document.getElementById(id);

  let currentTail = '';        // 当前需要接的字（上一成语末字）
  let players = [];
  let usedIdioms = new Set();
  let history = [];            // { name, idiom, success, reason }
  let round = 0;
  let currentPlayerIdx = 0;
  let gameOver = false;
  let userInputResolve = null;

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
      ], { temperature: 0.7, reasoningEffort: 'off' });
      if (result.ok && result.data?.choices?.[0]?.message?.content) {
        let content = result.data.choices[0].message.content.trim();
        // 清理思考标签： simd/<reasoning>/<reasoning_content>/<thought> 等成对与未闭合形式
        content = stripThinkingTags(content);
        // 清理 markdown 代码块包裹
        content = content.replace(/^```[\w]*\n?/gm, '').replace(/```$/gm, '').trim();
        return content || null;
      }
      if (result.ok) {
        const msg = result.data?.choices?.[0]?.message;
        console.warn('[idiom] LLM content 为空, reasoning:', msg?.reasoning?.substring(0, 200) || '(无)');
      } else {
        console.error('[idiom] LLM 请求失败:', result.error);
      }
    } catch (e) { console.error('[idiom] LLM error:', e); }
    return null;
  }

  // ---- 上下文管理：拼接最近 N 条接龙记录 ----
  function buildHistoryContext() {
    const recent = history.slice(-MAX_HISTORY_IN_CONTEXT);
    if (recent.length === 0) return '暂无';
    return recent.map((h, i) => `${i + 1}. ${h.name}：${h.idiom}${h.success ? '' : '（' + (h.reason || '失败') + '）'}`).join('\n');
  }

  // AI generates a 4-char idiom starting with currentTail
  async function aiGenerateIdiom(aiName) {
    const sys = `你是「${aiName}」，正在玩成语接龙游戏。
当前需要接的字是「${currentTail}」，你必须回复一个以「${currentTail}」字开头（同字，不接受同音字）的四字成语。
规则：
1. 只回复一个四字成语原文，不要加任何解释、拼音、标点、出处
2. 必须是真实存在的中文成语
3. 不能与历史中已出现过的成语重复
4. 第一个字必须是「${currentTail}」
5. 如果实在想不出，回复"认输"`;
    const userMsg = `最近接龙历史：\n${buildHistoryContext()}\n\n已使用成语：\n${[...usedIdioms].join('、') || '暂无'}\n\n请回复一个以「${currentTail}」字开头的四字成语：`;
    return await askLLM(sys, userMsg);
  }

  // LLM 裁判：判断是否为真实成语 + 是否首尾相接
  async function validateIdiom(idiom, tail) {
    try {
      const result = await askLLM(
        `你是一位中文成语鉴定专家，正在裁定成语接龙游戏。
请判断玩家给出的「${idiom}」是否符合以下两个条件：
1. 是一个真实存在的中文成语（四字）
2. 第一个字必须是「${tail}」（同字，不接受同音字）
只回复以下三个之一：
- "通过"：两个条件都满足
- "非成语"：不是真实成语
- "首字不符"：首字不是「${tail}」
不要解释。`,
        `请裁定：「${idiom}」（需以「${tail}」开头）`
      );
      if (!result) return { ok: true, reason: '' }; // LLM 失败时不惩罚
      if (result.includes('通过')) return { ok: true, reason: '' };
      if (result.includes('非成语')) return { ok: false, reason: t('game.idiom.reasonNotIdiom', '非真实成语') };
      if (result.includes('首字不符')) return { ok: false, reason: t('game.idiom.reasonHeadMismatch', '首字不符') };
      return { ok: true, reason: '' };
    } catch {
      return { ok: true, reason: '' };
    }
  }

  // ---- Rendering ----
  function renderPlayers() {
    const bar = $('players-bar');
    bar.innerHTML = '';
    const youLabel = t('game.common.you', '你');
    players.forEach((p, i) => {
      const tag = document.createElement('div');
      tag.className = `idiom-player-tag${!p.alive ? ' eliminated' : ''}${p.isUser ? ' is-user' : ''}${currentPlayerIdx === i && p.alive && !gameOver ? ' active' : ''}`;
      const initial = p.isUser ? youLabel : p.name[0];
      tag.innerHTML = `<div class="idiom-player-icon">${escapeHtml(initial)}</div><span>${p.isUser ? escapeHtml(youLabel) : escapeHtml(p.name)}</span>`;
      bar.appendChild(tag);
    });
    $('alive-count').textContent = players.filter(p => p.alive).length;
  }

  function addHistoryEntry(name, idiom, success, isUser, reason) {
    const list = $('history-list');
    const entry = document.createElement('div');
    entry.className = `idiom-history-entry ${success ? 'success' : 'fail'}`;
    const youLabel = t('game.common.you', '你');
    const initial = isUser ? youLabel : name[0];
    const tail = idiom ? idiom[idiom.length - 1] : '';
    entry.innerHTML = `
      <div class="idiom-entry-avatar">${escapeHtml(initial)}</div>
      <div class="idiom-entry-body">
        <div class="idiom-entry-name">${isUser ? escapeHtml(youLabel) : escapeHtml(name)}</div>
        <div class="idiom-entry-text">${escapeHtml(idiom || t('game.idiom.empty', '(无)'))}${success ? ` <span style="color:var(--idiom-text-tertiary);font-size:12px">${escapeHtml(t('game.idiom.tailIs', '→ 接'))} <b style="color:var(--idiom-accent)">${escapeHtml(tail)}</b></span>` : (reason ? ` <span style="color:var(--idiom-danger);font-size:12px">（${escapeHtml(reason)}）</span>` : '')}</div>
        <div class="idiom-entry-round">${escapeHtml(t('game.common.roundN', '第 {round} 轮', { round }))}</div>
      </div>
      <div class="idiom-entry-status">${success ? '<i class="fa-solid fa-check" style="color:var(--idiom-success)"></i>' : '<i class="fa-solid fa-xmark" style="color:var(--idiom-danger)"></i>'}</div>`;
    list.appendChild(entry);
    entry.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function showThinking(name) {
    const list = $('history-list');
    const el = document.createElement('div');
    el.className = 'idiom-thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `<div class="idiom-thinking-dots"><span></span><span></span><span></span></div> ${escapeHtml(t('game.common.thinking', '{name} 正在思考...', { name }))}`;
    list.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function removeThinking() {
    const el = $('thinking-indicator');
    if (el) el.remove();
  }

  function setInputEnabled(enabled) {
    $('idiom-input').disabled = !enabled;
    $('btn-submit').disabled = !enabled;
    $('btn-pass').disabled = !enabled;
    if (enabled) {
      $('input-hint').textContent = t('game.idiom.inputHintTail', '轮到你了，请输入以「{tail}」字开头的四字成语', { tail: currentTail });
      $('idiom-input').focus();
    } else {
      $('input-hint').textContent = t('game.common.waitingOthers', '等待其他玩家...');
    }
  }

  function showGameOver(message, survivors) {
    gameOver = true;
    setInputEnabled(false);
    if (window.gameAPI?.reportResult) {
      window.gameAPI.reportResult(t('game.idiom.reportResult', '成语接龙结束：{message}（共 {round} 轮，收录 {count} 个成语）', { message, round, count: history.filter(h => h.success).length }));
    }
    const overlay = $('status-overlay');
    overlay.classList.remove('hidden');
    $('status-content').innerHTML = `
      <h2>${escapeHtml(t('game.idiom.gameOver', '成语接龙结束'))}</h2>
      <p>${escapeHtml(message)}</p>
      <p>${escapeHtml(t('game.idiom.summary', '共进行了 {round} 轮，收录 {count} 个成语', { round, count: history.filter(h => h.success).length }))}</p>
      <div>
        <button type="button" onclick="location.reload()">${escapeHtml(t('game.common.playAgain', '再来一局'))}</button>
        <button type="button" onclick="window.close()">${escapeHtml(t('game.common.close', '关闭'))}</button>
      </div>`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
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
    const maxRounds = 30;
    const youLabel = t('game.common.you', '你');

    while (!gameOver && round < maxRounds) {
      round++;
      $('round-num').textContent = round;
      renderPlayers();

      const alivePlayers = players.filter(p => p.alive);
      if (alivePlayers.length <= 1) {
        const surv = alivePlayers[0];
        showGameOver(surv ? t('game.idiom.winnerIs', '最后的赢家是「{name}」！', { name: surv.isUser ? youLabel : surv.name }) : t('game.idiom.allEliminated', '所有玩家都被淘汰了！'), alivePlayers);
        break;
      }

      for (let i = 0; i < players.length; i++) {
        if (gameOver) break;
        const p = players[i];
        if (!p.alive) continue;

        currentPlayerIdx = i;
        renderPlayers();

        let idiom = '';
        let success = false;
        let reason = '';

        if (p.isUser) {
          // User's turn
          idiom = await waitForUserInput();
          if (idiom === '__PASS__') {
            p.alive = false;
            history.push({ name: youLabel, idiom: t('game.common.giveUp', '认输'), success: false, reason: t('game.idiom.activeGiveUp', '主动认输') });
            addHistoryEntry(youLabel, t('game.common.giveUp', '认输'), false, true, t('game.idiom.activeGiveUp', '主动认输'));
            renderPlayers();
            continue;
          }
          idiom = idiom.trim();
          // Quick local checks first
          if (idiom.length !== 4) {
            p.alive = false;
            reason = t('game.idiom.reasonNotFour', '非四字');
            history.push({ name: youLabel, idiom, success: false, reason });
            addHistoryEntry(youLabel, idiom, false, true, reason);
            renderPlayers();
            continue;
          }
          if (currentTail && idiom[0] !== currentTail) {
            p.alive = false;
            reason = t('game.idiom.reasonHeadShouldBe', '首字应为「{tail}」', { tail: currentTail });
            history.push({ name: youLabel, idiom, success: false, reason });
            addHistoryEntry(youLabel, idiom, false, true, reason);
            renderPlayers();
            continue;
          }
          if (usedIdioms.has(idiom)) {
            p.alive = false;
            reason = t('game.idiom.reasonDuplicate', '重复');
            history.push({ name: youLabel, idiom, success: false, reason });
            addHistoryEntry(youLabel, idiom, false, true, reason);
            renderPlayers();
            continue;
          }
          // LLM 裁判验证：是否为真实成语
          showThinking(t('game.idiom.judge', '裁判'));
          const verdict = await validateIdiom(idiom, currentTail || idiom[0]);
          removeThinking();
          if (!verdict.ok) {
            p.alive = false;
            reason = verdict.reason || t('game.idiom.reasonNotIdiom', '非真实成语');
            history.push({ name: youLabel, idiom, success: false, reason });
            addHistoryEntry(youLabel, idiom, false, true, reason);
            renderPlayers();
            continue;
          }
          usedIdioms.add(idiom);
          currentTail = idiom[idiom.length - 1];
          history.push({ name: youLabel, idiom, success: true, reason: '' });
          addHistoryEntry(youLabel, idiom, true, true);
          success = true;
        } else {
          // AI's turn
          showThinking(p.name);
          idiom = await aiGenerateIdiom(p.name);
          removeThinking();

          if (!idiom || idiom.includes('认输')) {
            p.alive = false;
            history.push({ name: p.name, idiom: idiom || t('game.idiom.noAnswer', '(无法作答)'), success: false, reason: t('game.common.giveUp', '认输') });
            addHistoryEntry(p.name, idiom || t('game.idiom.noAnswer', '(无法作答)'), false, false, t('game.common.giveUp', '认输'));
            renderPlayers();
            continue;
          }
          // Cleanup: take first 4 chars if model added extras; strip punctuation
          idiom = idiom.replace(/[\s，。！？、,.!?]/g, '');
          // Find the first 4-char segment starting with currentTail
          if (idiom.length >= 4) {
            const idx = currentTail ? idiom.indexOf(currentTail) : 0;
            if (idx >= 0) idiom = idiom.slice(idx, idx + 4);
            else idiom = idiom.slice(0, 4);
          }
          if (idiom.length !== 4) {
            p.alive = false;
            reason = t('game.idiom.reasonNotFour', '非四字');
            history.push({ name: p.name, idiom, success: false, reason });
            addHistoryEntry(p.name, idiom, false, false, reason);
            renderPlayers();
            continue;
          }
          if (currentTail && idiom[0] !== currentTail) {
            p.alive = false;
            reason = t('game.idiom.reasonHeadShouldBe', '首字应为「{tail}」', { tail: currentTail });
            history.push({ name: p.name, idiom, success: false, reason });
            addHistoryEntry(p.name, idiom, false, false, reason);
            renderPlayers();
            continue;
          }
          if (usedIdioms.has(idiom)) {
            p.alive = false;
            reason = t('game.idiom.reasonDuplicate', '重复');
            history.push({ name: p.name, idiom, success: false, reason });
            addHistoryEntry(p.name, idiom, false, false, reason);
            renderPlayers();
            continue;
          }
          usedIdioms.add(idiom);
          currentTail = idiom[idiom.length - 1];
          history.push({ name: p.name, idiom, success: true, reason: '' });
          addHistoryEntry(p.name, idiom, true, false);
          success = true;
        }

        if (success) await delay(300);

        // Check if only 1 left
        if (players.filter(pp => pp.alive).length <= 1) {
          const surv = players.filter(pp => pp.alive);
          const msg = surv.length === 1
            ? t('game.idiom.winnerIs', '最后的赢家是「{name}」！', { name: surv[0].isUser ? youLabel : surv[0].name })
            : t('game.idiom.allEliminated', '所有玩家都被淘汰了！');
          showGameOver(msg, surv);
          break;
        }
      }
    }

    if (!gameOver) {
      const surv = players.filter(p => p.alive);
      showGameOver(t('game.idiom.maxRoundsSurvivors', '已达到最大回合数，幸存者：{names}', { names: surv.map(p => p.isUser ? youLabel : p.name).join('、') }), surv);
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

    let aiCount = 3;
    let startIdiom = '';
    try {
      const config = await window.gameAPI.getGameConfig();
      if (config) {
        if (config.aiCount) aiCount = config.aiCount;
        if (config.startIdiom) startIdiom = config.startIdiom;
      }
    } catch { /* use defaults */ }

    if (!startIdiom) {
      startIdiom = START_IDIOMS[Math.floor(gameRng() * START_IDIOMS.length)];
    }

    // Initial tail = last char of starting idiom (the starting idiom is "round 0")
    usedIdioms.add(startIdiom);
    currentTail = startIdiom[startIdiom.length - 1];
    history.push({ name: t('game.idiom.opening', '开场'), idiom: startIdiom, success: true, reason: '' });

    $('keyword-display').textContent = currentTail;
    addHistoryEntry(t('game.idiom.opening', '开场'), startIdiom, true, false, '');

    // Build players: user first, then AIs
    players = [{ name: t('game.common.you', '你'), isUser: true, alive: true }];
    for (let i = 0; i < aiCount; i++) {
      players.push({ name: AI_NAMES[i % AI_NAMES.length], isUser: false, alive: true });
    }

    renderPlayers();
    setInputEnabled(false);

    // Bind input events
    $('btn-submit').addEventListener('click', () => {
      if (!userInputResolve) return;
      const val = $('idiom-input').value.trim();
      if (!val) return;
      $('idiom-input').value = '';
      setInputEnabled(false);
      userInputResolve(val);
      userInputResolve = null;
    });

    $('idiom-input').addEventListener('keydown', (e) => {
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
