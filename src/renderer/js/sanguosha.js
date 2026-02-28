/**
 * 三国杀 - Sanguosha Game Engine
 * Full client-side game logic with AI players
 */

(function () {
  'use strict';

  // ========== Hero Definitions ==========
  const HEROES = [
    { id: 'caocao',    name: '曹操',  title: '魏武帝', icon: '<i class="fa-solid fa-crown"></i>',            maxHp: 4, kingdom: '魏', skill: '奸雄(被动)：受到伤害时获得造成伤害的牌',              skillFn: 'jianxiong' },
    { id: 'liubei',    name: '刘备',  title: '昭烈帝', icon: '<i class="fa-solid fa-dragon"></i>',           maxHp: 4, kingdom: '蜀', skill: '仁德：将手牌给他人；累计2张时回血1',                 skillFn: 'rende'     },
    { id: 'sunquan',   name: '孙权',  title: '吴大帝', icon: '<i class="fa-solid fa-sun"></i>',              maxHp: 4, kingdom: '吴', skill: '制衡：弃任意张牌并摸等量牌',                       skillFn: 'zhiheng'   },
    { id: 'guanyu',    name: '关羽',  title: '美髯公', icon: '<i class="fa-solid fa-khanda"></i>',           maxHp: 4, kingdom: '蜀', skill: '武圣：将红色牌当杀使用（技能键）',                   skillFn: 'wusheng'   },
    { id: 'zhangfei',  name: '张飞',  title: '万人敌', icon: '<i class="fa-solid fa-fire-flame-curved"></i>',maxHp: 4, kingdom: '蜀', skill: '咆哮(被动)：出牌阶段可使用任意张杀',               skillFn: 'paoxiao'   },
    { id: 'zhaoyun',   name: '赵云',  title: '常胜将军',icon: '<i class="fa-solid fa-shield-halved"></i>',   maxHp: 4, kingdom: '蜀', skill: '龙胆：杀→闪自动防御；技能键将闪当杀攻击',           skillFn: 'longdan'   },
    { id: 'zhugeliang',name: '诸葛亮',title: '卧龙',   icon: '<i class="fa-solid fa-star"></i>',             maxHp: 3, kingdom: '蜀', skill: '观星(摸牌阶段)：观看并排列牌堆顶5张',              skillFn: 'guanxing'  },
    { id: 'lvbu',      name: '吕布',  title: '飞将',   icon: '<i class="fa-solid fa-horse"></i>',            maxHp: 4, kingdom: '群', skill: '无双(被动)：杀需两张闪才能抵消',                   skillFn: 'wushuang'  },
    { id: 'diaochan',  name: '貂蝉',  title: '闭月',   icon: '<i class="fa-solid fa-moon"></i>',             maxHp: 3, kingdom: '群', skill: '离间：令男性角色与另一男性角色决斗',                skillFn: 'lijian'    },
    { id: 'huatuo',    name: '华佗',  title: '神医',   icon: '<i class="fa-solid fa-staff-snake"></i>',      maxHp: 3, kingdom: '群', skill: '急救：将红色牌当桃（技能键主动回血）',              skillFn: 'jijiu'     },
    { id: 'simayi',    name: '司马懿',title: '狼顾',   icon: '<i class="fa-solid fa-eye"></i>',              maxHp: 3, kingdom: '魏', skill: '反馈(被动)：受到伤害后获得来源一张牌',             skillFn: 'fankui'    },
    { id: 'xuchu',     name: '许褚',  title: '虎痴',   icon: '<i class="fa-solid fa-paw"></i>',              maxHp: 4, kingdom: '魏', skill: '裸衣(摸牌阶段)：少摸一张，本回合杀伤害+1',        skillFn: 'luoyi'     },
  ];

  // ========== Card Definitions ==========
  const SUITS = ['♠', '♥', '♣', '♦'];
  const SUIT_COLORS = { '♠': 'black', '♥': 'red', '♣': 'black', '♦': 'red' };
  const NUMBERS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  const CARD_TYPES = {
    sha:              { name: '杀',     icon: '<i class="fa-solid fa-khanda"></i>',            type: 'basic',  cssClass: 'sg-card-type-sha'    },
    shan:             { name: '闪',     icon: '<i class="fa-solid fa-shield-halved"></i>',     type: 'basic',  cssClass: 'sg-card-type-shan'   },
    tao:              { name: '桃',     icon: '<i class="fa-solid fa-heart"></i>',              type: 'basic',  cssClass: 'sg-card-type-tao'    },
    guohechaiqiao:    { name: '过河拆桥',icon: '<i class="fa-solid fa-hammer"></i>',            type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    shunshouqianyang: { name: '顺手牵羊',icon: '<i class="fa-solid fa-hand"></i>',              type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    wuzhongshengyou:  { name: '无中生有',icon: '<i class="fa-solid fa-wand-sparkles"></i>',    type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    juedou:           { name: '决斗',   icon: '<i class="fa-solid fa-gun"></i>',               type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    nanmanruqin:      { name: '南蛮入侵',icon: '<i class="fa-solid fa-arrows-to-dot"></i>',    type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    wanjianqifa:      { name: '万箭齐发',icon: '<i class="fa-solid fa-crosshairs"></i>',       type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    taoyuanjieyi:     { name: '桃园结义',icon: '<i class="fa-solid fa-hand-holding-heart"></i>',type:'jinnang',cssClass: 'sg-card-type-jinnang' },
    wuxiekeji:        { name: '无懈可击',icon: '<i class="fa-solid fa-ban"></i>',               type: 'jinnang',cssClass: 'sg-card-type-jinnang' },
    // Equipment
    zhugenu:          { name: '诸葛连弩',icon: '<i class="fa-solid fa-bullseye"></i>',          type: 'equip', subtype: 'weapon',    range: 1, cssClass: 'sg-card-type-equip' },
    qinggangjian:     { name: '青釭剑',  icon: '<i class="fa-solid fa-bolt"></i>',              type: 'equip', subtype: 'weapon',    range: 2, cssClass: 'sg-card-type-equip' },
    qinglongyanyuedao:{ name: '青龙偃月刀',icon:'<i class="fa-solid fa-circle-notch"></i>',   type: 'equip', subtype: 'weapon',    range: 3, cssClass: 'sg-card-type-equip' },
    zhangbashemao:    { name: '丈八蛇矛',icon: '<i class="fa-solid fa-staff-aesculapius"></i>',type: 'equip', subtype: 'weapon',    range: 3, cssClass: 'sg-card-type-equip' },
    guanshifu:        { name: '贯石斧',  icon: '<i class="fa-solid fa-gavel"></i>',             type: 'equip', subtype: 'weapon',    range: 3, cssClass: 'sg-card-type-equip' },
    fangtianhuaji:    { name: '方天画戟',icon: '<i class="fa-solid fa-star-of-life"></i>',      type: 'equip', subtype: 'weapon',    range: 4, cssClass: 'sg-card-type-equip' },
    baguazhen:        { name: '八卦阵',  icon: '<i class="fa-solid fa-yin-yang"></i>',           type: 'equip', subtype: 'armor',               cssClass: 'sg-card-type-equip' },
    jiama:            { name: '+1马',    icon: '<i class="fa-solid fa-horse"></i>',              type: 'equip', subtype: 'horse_def',            cssClass: 'sg-card-type-equip' },
    jianma:           { name: '-1马',    icon: '<i class="fa-solid fa-horse-head"></i>',         type: 'equip', subtype: 'horse_atk',            cssClass: 'sg-card-type-equip' },
  };

  // ========== Build Deck ==========
  function buildDeck() {
    const deck = [];
    let id = 0;

    function add(cardKey, suit, number, count = 1) {
      for (let i = 0; i < count; i++) {
        deck.push({ id: id++, key: cardKey, suit, number, ...CARD_TYPES[cardKey] });
      }
    }

    // Basic cards distribution
    for (const suit of SUITS) {
      for (let n = 0; n < 13; n++) {
        const num = NUMBERS[n];
        if (n < 7) add('sha', suit, num);        // 杀: lots
        if (n >= 7 && n < 10) add('shan', suit, num); // 闪
        if (n >= 10) add('tao', suit, num);       // 桃
      }
    }
    // Extra sha
    for (let i = 0; i < 8; i++) add('sha', SUITS[i % 4], NUMBERS[i % 13]);
    for (let i = 0; i < 4; i++) add('shan', SUITS[i % 4], NUMBERS[(i + 3) % 13]);
    for (let i = 0; i < 2; i++) add('tao', SUITS[i], NUMBERS[(i + 5) % 13]);

    // Jinnang (trick) cards
    for (let i = 0; i < 3; i++) add('guohechaiqiao', SUITS[i], NUMBERS[i + 3]);
    for (let i = 0; i < 3; i++) add('shunshouqianyang', SUITS[i], NUMBERS[i + 1]);
    for (let i = 0; i < 4; i++) add('wuzhongshengyou', SUITS[i % 2], NUMBERS[i + 7]);
    for (let i = 0; i < 3; i++) add('juedou', SUITS[i], NUMBERS[i]);
    add('nanmanruqin', '♠', '7', 2);
    add('wanjianqifa', '♥', '1', 2);
    add('taoyuanjieyi', '♥', 'J', 1);
    for (let i = 0; i < 3; i++) add('wuxiekeji', SUITS[i], NUMBERS[i + 10]);

    // Equipment
    add('zhugenu', '♣', '1');
    add('qinggangjian', '♠', '6');
    add('qinglongyanyuedao', '♠', '5');
    add('zhangbashemao', '♠', 'Q');
    add('guanshifu', '♦', '5');
    add('fangtianhuaji', '♦', 'Q');
    add('baguazhen', '♠', '2', 2);
    add('jiama', '♥', '5', 2);
    add('jianma', '♠', '5', 2);

    // Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // ========== Role Assignment ==========
  const ROLES_CONFIG = {
    2: ['zhugong', 'fanzei'],
    3: ['zhugong', 'fanzei', 'neijian'],
    4: ['zhugong', 'zhongchen', 'fanzei', 'neijian'],
    5: ['zhugong', 'zhongchen', 'fanzei', 'fanzei', 'neijian'],
    6: ['zhugong', 'zhongchen', 'fanzei', 'fanzei', 'fanzei', 'neijian'],
    7: ['zhugong', 'zhongchen', 'zhongchen', 'fanzei', 'fanzei', 'fanzei', 'neijian'],
    8: ['zhugong', 'zhongchen', 'zhongchen', 'fanzei', 'fanzei', 'fanzei', 'neijian', 'neijian'],
  };

  const ROLE_NAMES = { zhugong: '主公', zhongchen: '忠臣', fanzei: '反贼', neijian: '内奸' };
  const ROLE_CSS = { zhugong: 'zhugong', zhongchen: 'zhongchen', fanzei: 'fanzei', neijian: 'neijian' };
  const PHASE_NAMES = ['准备阶段', '判定阶段', '摸牌阶段', '出牌阶段', '弃牌阶段', '结束阶段'];

  // ========== Game State ==========
  class SanguoshaGame {
    constructor(aiCount) {
      this.playerCount = aiCount + 1; // 1 human + N AI
      if (this.playerCount < 2) this.playerCount = 2;
      if (this.playerCount > 8) this.playerCount = 8;

      this.deck = [];
      this.discardPile = [];
      this.players = [];
      this.turnIndex = 0;
      this.turn = 1;
      this.phase = 0; // 0-5
      this.gameOver = false;
      this.winner = null;
      this.humanIndex = 0;
      this.selectedCard = null;
      this.selectedTarget = null;
      this.shaUsedThisTurn = false;
      this.waitingForResponse = null; // { type, resolver, ... }
      this.logEntries = [];
      this.skillState = null;           // multi-step skill tracking (e.g. lijian)

      // ---- LLM context management per AI player ----
      // Map<playerIndex, Array<{role, content}>> rolling conversation history
      this.aiContexts = new Map();
      this.aiContextMaxHistory = 10; // max messages kept (5 user+assistant pairs)

      this.init();
    }

    init() {
      this.deck = buildDeck();
      this.discardPile = [];

      // Assign roles
      const totalPlayers = this.playerCount;
      const roleList = (ROLES_CONFIG[totalPlayers] || ROLES_CONFIG[4]).slice();
      // Shuffle ALL roles (fully random identity assignment)
      for (let i = roleList.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roleList[i], roleList[j]] = [roleList[j], roleList[i]];
      }
      const allRoles = roleList;

      // Pick heroes
      const shuffledHeroes = [...HEROES].sort(() => Math.random() - 0.5);

      this.players = [];
      for (let i = 0; i < totalPlayers; i++) {
        const hero = shuffledHeroes[i % shuffledHeroes.length];
        this.players.push({
          index: i,
          isHuman: i === 0,
          hero: { ...hero },
          role: allRoles[i],
          hp: hero.maxHp,
          maxHp: hero.maxHp,
          hand: [],
          equip: { weapon: null, armor: null, horse_atk: null, horse_def: null },
          alive: true,
          shaUsedThisTurn: false,
          rendeParts: 0,
        });
      }

      // Deal 4 cards to each player
      for (const p of this.players) {
        for (let i = 0; i < 4; i++) {
          p.hand.push(this.drawCard());
        }
      }

      // Set turn to zhugong
      this.turnIndex = this.players.findIndex(p => p.role === 'zhugong');
      if (this.turnIndex < 0) this.turnIndex = 0;
      this.humanChoices = null;
    }

    drawCard() {
      if (this.deck.length === 0) {
        // Reshuffle discard pile
        if (this.discardPile.length === 0) {
          // Create emergency cards
          return { id: Date.now() + Math.random(), key: 'sha', suit: '♠', number: 'A', ...CARD_TYPES.sha };
        }
        this.deck = [...this.discardPile].sort(() => Math.random() - 0.5);
        this.discardPile = [];
      }
      return this.deck.pop();
    }

    drawCards(count) {
      const cards = [];
      for (let i = 0; i < count; i++) cards.push(this.drawCard());
      return cards;
    }

    currentPlayer() {
      return this.players[this.turnIndex];
    }

    alivePlayers() {
      return this.players.filter(p => p.alive);
    }

    otherAlivePlayers(playerIndex) {
      return this.players.filter(p => p.alive && p.index !== playerIndex);
    }

    getAttackRange(player) {
      let range = 1;
      if (player.equip.weapon) {
        const w = CARD_TYPES[player.equip.weapon.key];
        if (w && w.range) range = w.range;
      }
      if (player.equip.horse_atk) range += 1;
      return range;
    }

    getDistance(from, to) {
      const alive = this.alivePlayers();
      const fromIdx = alive.findIndex(p => p.index === from.index);
      const toIdx = alive.findIndex(p => p.index === to.index);
      if (fromIdx === -1 || toIdx === -1) return 999;
      const n = alive.length;
      let dist = Math.min(Math.abs(fromIdx - toIdx), n - Math.abs(fromIdx - toIdx));
      if (to.equip.horse_def) dist += 1;
      return dist;
    }

    isInRange(attacker, target) {
      return this.getDistance(attacker, target) <= this.getAttackRange(attacker);
    }

    discardCard(card) {
      this.discardPile.push(card);
    }

    removeCardFromHand(player, cardId) {
      const idx = player.hand.findIndex(c => c.id === cardId);
      if (idx !== -1) return player.hand.splice(idx, 1)[0];
      return null;
    }

    log(text, type = '') {
      this.logEntries.push({ text, type, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) });
      renderLog();
    }

    // Damage
    dealDamage(source, target, amount = 1) {
      target.hp -= amount;
      this.log(`${target.hero.name} 受到 ${amount} 点伤害 (HP: ${target.hp}/${target.maxHp})`, 'damage');

      // Jianxiong (曹操 skill)
      if (target.hero.skillFn === 'jianxiong' && source && source.lastPlayedCard) {
        target.hand.push({ ...source.lastPlayedCard, id: Date.now() + Math.random() });
        this.log(`${target.hero.name} 发动【奸雄】获得造成伤害的牌`, 'action');
      }

      // Fankui (司马懿 skill)
      if (target.hero.skillFn === 'fankui' && source && source.hand.length > 0) {
        const stolen = source.hand.splice(Math.floor(Math.random() * source.hand.length), 1)[0];
        if (stolen) {
          target.hand.push(stolen);
          this.log(`${target.hero.name} 发动【反馈】获得 ${source.hero.name} 一张牌`, 'action');
        }
      }

      if (target.hp <= 0) {
        this.handleDying(target, source);
      }
    }

    handleDying(player, source) {
      // Try to use tao
      const taoCard = player.hand.find(c => c.key === 'tao');
      // Huatuo jijiu: red cards as tao
      const jijiu = player.hero.skillFn === 'jijiu';
      const redCard = jijiu ? player.hand.find(c => SUIT_COLORS[c.suit] === 'red') : null;

      if (taoCard) {
        this.removeCardFromHand(player, taoCard.id);
        this.discardCard(taoCard);
        player.hp = 1;
        this.log(`${player.hero.name} 使用桃自救 (HP: 1)`, 'heal');
      } else if (redCard && jijiu) {
        this.removeCardFromHand(player, redCard.id);
        this.discardCard(redCard);
        player.hp = 1;
        this.log(`${player.hero.name} 发动【急救】自救 (HP: 1)`, 'heal');
      } else {
        // Player dies
        player.alive = false;
        player.hp = 0;
        this.log(`${player.hero.name}(${ROLE_NAMES[player.role]}) 阵亡！`, 'damage');

        // Reward/punishment
        if (player.role === 'fanzei' && source) {
          // Killer draws 3 cards
          const reward = this.drawCards(3);
          source.hand.push(...reward);
          this.log(`${source.hero.name} 击杀反贼，摸3张牌`, 'action');
        }
        if (player.role === 'zhongchen' && source && source.role === 'zhugong') {
          // Zhugong kills zhongchen: discard all
          this.discardPile.push(...source.hand);
          source.hand = [];
          for (const slot of Object.keys(source.equip)) {
            if (source.equip[slot]) { this.discardCard(source.equip[slot]); source.equip[slot] = null; }
          }
          this.log(`${source.hero.name} 误杀忠臣，弃置所有牌`, 'damage');
        }

        this.checkGameOver();
      }
    }

    checkGameOver() {
      const alive = this.alivePlayers();
      const zhugong = this.players.find(p => p.role === 'zhugong');

      if (!zhugong.alive) {
        // Check if neijian is the last survivor
        if (alive.length === 1 && alive[0].role === 'neijian') {
          this.gameOver = true;
          this.winner = '内奸';
          this.log('游戏结束！内奸获胜！');
        } else {
          this.gameOver = true;
          this.winner = '反贼';
          this.log('游戏结束！反贼获胜！');
        }
      } else if (!alive.some(p => p.role === 'fanzei') && !alive.some(p => p.role === 'neijian')) {
        this.gameOver = true;
        this.winner = '主公与忠臣';
        this.log('游戏结束！主公与忠臣获胜！');
      }
    }

    heal(player, amount = 1) {
      player.hp = Math.min(player.hp + amount, player.maxHp);
      this.log(`${player.hero.name} 回复 ${amount} 点体力 (HP: ${player.hp}/${player.maxHp})`, 'heal');
    }

    equipCard(player, card) {
      const cardDef = CARD_TYPES[card.key];
      if (!cardDef || cardDef.type !== 'equip') return;
      const slot = cardDef.subtype;
      if (player.equip[slot]) {
        this.discardCard(player.equip[slot]);
      }
      player.equip[slot] = card;
      this.log(`${player.hero.name} 装备了 ${card.name}`, 'action');
    }

    // ===== AI Decision Making (LLM-powered) =====

    // Helper: build game state summary for LLM
    _buildGameSummary(player) {
      const alive = this.alivePlayers();
      const playerSummaries = alive.map(p => {
        const equips = [];
        if (p.equip.weapon) equips.push(p.equip.weapon.name);
        if (p.equip.armor) equips.push(p.equip.armor.name);
        if (p.equip.horse_atk) equips.push(p.equip.horse_atk.name);
        if (p.equip.horse_def) equips.push(p.equip.horse_def.name);
        const roleLabel = p.role === 'zhugong' ? '主公' : (p.index === player.index ? ROLE_NAMES[p.role] : '未知');
        return `- ${p.hero.name}(${roleLabel}) HP:${p.hp}/${p.maxHp} 手牌:${p.hand.length}张 装备:[${equips.join(',')||'无'}] 距离:${this.getDistance(player, p)}`;
      }).join('\n');

      const handDesc = player.hand.map(c => {
        const ct = CARD_TYPES[c.key];
        return `${ct?.name || c.key}(${c.suit}${c.number})`;
      }).join('、');

      return { playerSummaries, handDesc };
    }

    async _askLLM(systemPrompt, userPrompt, contextKey = null) {
      // Build message list, optionally including per-player rolling history
      let messages;
      if (contextKey !== null) {
        if (!this.aiContexts.has(contextKey)) {
          this.aiContexts.set(contextKey, []);
        }
        const history = this.aiContexts.get(contextKey);

        // Trim history to keep within token budget (keep newest pairs)
        while (history.length > this.aiContextMaxHistory) {
          history.splice(0, 2); // Always remove in pairs (user + assistant)
        }

        messages = [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: userPrompt }
        ];
      } else {
        messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ];
      }

      try {
        const result = await window.sanguoshaAPI.chatLLM(messages, { temperature: 0.7, max_tokens: 300 });
        if (result.ok && result.data?.choices?.[0]?.message?.content) {
          const content = result.data.choices[0].message.content.trim();

          // Persist exchange into rolling context for this player
          if (contextKey !== null) {
            const history = this.aiContexts.get(contextKey);
            history.push({ role: 'user', content: userPrompt });
            history.push({ role: 'assistant', content });
          }

          return content;
        }
      } catch (e) { console.error('LLM error:', e); }
      return null;
    }

    async aiPlayPhase(player) {
      // Always do basic no-brainer actions first
      const actions = [];

      // Use tao if hurt (always good)
      if (player.hp < player.maxHp) {
        const tao = player.hand.find(c => c.key === 'tao');
        if (tao) actions.push({ type: 'play', card: tao, target: player });
      }

      // Equip items (always good)
      const equipCards = player.hand.filter(c => c.type === 'equip');
      for (const ec of equipCards) {
        actions.push({ type: 'play', card: ec, target: player });
      }

      // Use wuzhongshengyou (always good - draw 2)
      const wzsy = player.hand.find(c => c.key === 'wuzhongshengyou');
      if (wzsy) actions.push({ type: 'play', card: wzsy, target: player });

      // Now use LLM for strategic decisions
      const { playerSummaries, handDesc } = this._buildGameSummary(player);
      const inRangeTargets = this.otherAlivePlayers(player.index).filter(t => this.isInRange(player, t));
      const allTargets = this.otherAlivePlayers(player.index);

      const strategicCards = player.hand.filter(c =>
        ['sha', 'juedou', 'guohechaiqiao', 'shunshouqianyang', 'nanmanruqin', 'wanjianqifa', 'taoyuanjieyi'].includes(c.key)
      );

      if (strategicCards.length > 0 && (inRangeTargets.length > 0 || allTargets.length > 0)) {
        const cardsDesc = strategicCards.map(c => CARD_TYPES[c.key]?.name || c.key).join('、');
        const targetsDesc = allTargets.map(t => {
          const inRange = this.isInRange(player, t);
          return `${t.hero.name}(HP:${t.hp}/${t.maxHp},手牌${t.hand.length}张${inRange ? ',在攻击范围内' : ''})`;
        }).join('、');

        const systemPrompt = `你是三国杀AI玩家「${player.hero.name}」，身份是${ROLE_NAMES[player.role]}。
技能：${player.hero.skill}

身份职责：
- 主公：消灭反贼和内奸
- 忠臣：保护主公，消灭反贼
- 反贼：消灭主公
- 内奸：最后与主公单挑，先帮主公清反贼再击败主公

请根据局势决定出牌策略。注意：你只能看到主公身份，其他人身份未知，需要根据行为判断。`;

        const userPrompt = `当前局势:
${playerSummaries}

你的手牌: ${handDesc}
可用的战略牌: ${cardsDesc}
可选目标: ${targetsDesc}

回合已使用杀: ${player.shaUsedThisTurn ? '是' : '否'}
${player.hero.skillFn === 'paoxiao' ? '(咆哮技能：可无限出杀)' : ''}

请决定出牌顺序。每行一个动作，格式：
"使用 [牌名] 对 [目标英雄名]" 或 "使用 [牌名]"（无目标牌）或 "不出"（跳过该牌）
只回复动作列表，不要解释。`;

        const resp = await this._askLLM(systemPrompt, userPrompt, player.index);
        if (resp) {
          const lines = resp.split('\n').filter(l => l.trim());
          for (const line of lines) {
            if (line.includes('不出') || line.includes('跳过')) continue;

            // Parse action
            for (const sc of strategicCards) {
              const cardName = CARD_TYPES[sc.key]?.name || sc.key;
              if (!line.includes(cardName)) continue;
              if (actions.find(a => a.card?.id === sc.id)) continue; // Already added

              if (sc.key === 'sha') {
                const canMulti = player.hero.skillFn === 'paoxiao' || (player.equip.weapon && player.equip.weapon.key === 'zhugenu');
                if (player.shaUsedThisTurn && !canMulti) continue;
                const target = this._findTargetInText(line, inRangeTargets);
                if (target) actions.push({ type: 'play', card: sc, target });
              } else if (sc.key === 'juedou' || sc.key === 'guohechaiqiao' || sc.key === 'shunshouqianyang') {
                const pool = sc.key === 'guohechaiqiao'
                  ? allTargets.filter(t => t.hand.length > 0 || Object.values(t.equip).some(e => e))
                  : allTargets;
                const target = this._findTargetInText(line, pool);
                if (target) actions.push({ type: 'play', card: sc, target });
              } else if (sc.key === 'nanmanruqin' || sc.key === 'wanjianqifa') {
                actions.push({ type: 'play', card: sc, target: null });
              } else if (sc.key === 'taoyuanjieyi') {
                if (this.alivePlayers().some(p => p.hp < p.maxHp)) {
                  actions.push({ type: 'play', card: sc, target: null });
                }
              }
              break;
            }
          }
        }
      }

      // Fallback: if LLM didn't produce sha action but we can, use heuristic target
      const canMultiSha = player.hero.skillFn === 'paoxiao' || (player.equip.weapon && player.equip.weapon.key === 'zhugenu');
      const shaCards = player.hand.filter(c => c.key === 'sha');
      if (shaCards.length > 0 && (!player.shaUsedThisTurn || canMultiSha) && !actions.find(a => a.card?.key === 'sha')) {
        if (inRangeTargets.length > 0) {
          const target = this._fallbackSelectTarget(player, inRangeTargets);
          actions.push({ type: 'play', card: shaCards[0], target });
        }
      }

      // Zhiheng (孙权)
      if (player.hero.skillFn === 'zhiheng' && player.hand.length > 2) {
        const worst = player.hand.reduce((a, b) => (this.cardValue(a) < this.cardValue(b) ? a : b));
        actions.push({ type: 'skill', skillName: '制衡', cards: [worst] });
      }

      // Wusheng (关羽): use red non-sha cards as sha attack
      const canMultiSha2 = player.hero.skillFn === 'paoxiao' || (player.equip.weapon && player.equip.weapon.key === 'zhugenu');
      if (player.hero.skillFn === 'wusheng' && (!player.shaUsedThisTurn || canMultiSha2) && !actions.find(a => a.card?.key === 'sha' || a.type === 'skill_sha')) {
        const redOther = player.hand.find(c => SUIT_COLORS[c.suit] === 'red' && c.key !== 'sha' && c.type !== 'equip');
        if (redOther && inRangeTargets.length > 0) {
          const target = this._fallbackSelectTarget(player, inRangeTargets);
          actions.push({ type: 'skill_sha', card: redOther, target, skillName: '武圣' });
        }
      }

      // Longdan (赵云): use shan as sha to attack
      if (player.hero.skillFn === 'longdan' && (!player.shaUsedThisTurn || canMultiSha2) && !actions.find(a => a.card?.key === 'sha' || a.type === 'skill_sha')) {
        const shanForAtk = player.hand.find(c => c.key === 'shan');
        if (shanForAtk && inRangeTargets.length > 0) {
          const target = this._fallbackSelectTarget(player, inRangeTargets);
          actions.push({ type: 'skill_sha', card: shanForAtk, target, skillName: '龙胆' });
        }
      }

      // Jijiu (华佗): use red card to proactively heal
      if (player.hero.skillFn === 'jijiu' && player.hp < player.maxHp) {
        const redHeal = player.hand.find(c => SUIT_COLORS[c.suit] === 'red' && c.key !== 'sha');
        if (redHeal) actions.unshift({ type: 'skill', skillName: '急救', card: redHeal });
      }

      // Lijian (貂蝉): force a duel between two opponents each turn
      if (player.hero.skillFn === 'lijian') {
        const others = this.otherAlivePlayers(player.index);
        if (others.length >= 2) {
          const t1 = this._fallbackSelectTarget(player, others);
          const t2 = others.find(t => t.index !== t1.index);
          if (t2) actions.unshift({ type: 'skill', skillName: '离间', target1: t1, target2: t2 });
        }
      }

      return actions;
    }

    _findTargetInText(text, targets) {
      for (const t of targets) {
        if (text.includes(t.hero.name)) return t;
      }
      return targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
    }

    _fallbackSelectTarget(player, targets) {
      const role = player.role;
      if (role === 'zhugong' || role === 'zhongchen') {
        const fanzei = targets.find(t => t.role === 'fanzei');
        if (fanzei) return fanzei;
      } else if (role === 'fanzei') {
        const zg = targets.find(t => t.role === 'zhugong');
        if (zg) return zg;
      }
      return targets[Math.floor(Math.random() * targets.length)];
    }

    aiSelectTarget(player, targets) {
      // Synchronous fallback used by some code paths
      return this._fallbackSelectTarget(player, targets);
    }

    async aiRespondSha(player) {
      // AI decides whether to use shan when attacked
      const shan = player.hand.find(c => c.key === 'shan');
      const longdanSha = (!shan && player.hero.skillFn === 'longdan') ? player.hand.find(c => c.key === 'sha') : null;
      const canBlock = shan || longdanSha;

      if (!canBlock) return null;

      // Use LLM to decide if it's worth blocking
      const { playerSummaries } = this._buildGameSummary(player);
      const systemPrompt = `你是三国杀AI玩家「${player.hero.name}」(${ROLE_NAMES[player.role]})。有人对你使用了【杀】，你需要决定是否使用闪来抵消。`;
      const userPrompt = `当前局势:\n${playerSummaries}\n\n你的HP: ${player.hp}/${player.maxHp}\n手牌数: ${player.hand.length}\n${shan ? '你有闪可以使用' : '你可以用龙胆技能将杀当闪使用'}\n\n是否使用闪？回复"是"或"否"，不要解释。`;

      const resp = await this._askLLM(systemPrompt, userPrompt, player.index);
      if (resp && resp.includes('否')) {
        // LLM decided not to block - but if HP critical, override
        if (player.hp <= 1) return canBlock; // Always block if dying
        return null;
      }
      return canBlock;
    }

    async aiRespondShan(player) {
      // For juedou etc - AI decides whether to use sha
      const sha = player.hand.find(c => c.key === 'sha');
      if (!sha) return null;

      // LLM decides whether to counter in duel
      const { playerSummaries } = this._buildGameSummary(player);
      const systemPrompt = `你是三国杀AI玩家「${player.hero.name}」(${ROLE_NAMES[player.role]})。你正处于决斗中，需要决定是否出杀来继续决斗。`;
      const userPrompt = `当前局势:\n${playerSummaries}\n\n你的HP: ${player.hp}/${player.maxHp}\n手牌中杀的数量: ${player.hand.filter(c => c.key === 'sha').length}\n\n是否出杀继续决斗？回复"是"或"否"。`;

      const resp = await this._askLLM(systemPrompt, userPrompt, player.index);
      if (resp && resp.includes('否') && player.hp > 1) {
        return null; // Accept damage
      }
      return sha;
    }

    cardValue(card) {
      const values = { tao: 10, shan: 8, sha: 6, wuzhongshengyou: 9, wuxiekeji: 7, juedou: 5, guohechaiqiao: 5, shunshouqianyang: 4 };
      return values[card.key] || 3;
    }

    // ===== Execute Card =====
    async executeCard(player, card, target) {
      this.removeCardFromHand(player, card.id);
      player.lastPlayedCard = card;

      switch (card.key) {
        case 'sha': {
          player.shaUsedThisTurn = true;
          this.log(`${player.hero.name} 对 ${target.hero.name} 使用了【杀】`, 'action');
          renderPlayPile([card]);

          const needShan = player.hero.skillFn === 'wushuang' ? 2 : 1;
          let blocked = 0;

          for (let i = 0; i < needShan; i++) {
            let shanCard = null;
            if (target.isHuman) {
              shanCard = await this.waitForHumanResponse('shan', target, `${player.hero.name} 对你使用了【杀】，是否使用闪？`);
            } else {
              shanCard = await this.aiRespondSha(target);
            }
            if (shanCard) {
              this.removeCardFromHand(target, shanCard.id);
              this.discardCard(shanCard);
              blocked++;
              this.log(`${target.hero.name} 使用了闪`, 'action');
            } else {
              break;
            }
          }

          if (blocked >= needShan) {
            this.log(`${target.hero.name} 成功闪避`, 'action');
          } else {
            let dmg = 1;
            if (player.hero.skillFn === 'luoyi' && player.luoyiActive) dmg += 1;
            this.dealDamage(player, target, dmg);
          }
          this.discardCard(card);
          break;
        }
        case 'shan':
          this.log(`${player.hero.name} 使用了闪`, 'action');
          this.discardCard(card);
          break;
        case 'tao':
          this.heal(player, 1);
          this.discardCard(card);
          break;
        case 'wuzhongshengyou': {
          this.log(`${player.hero.name} 使用了【无中生有】`, 'action');
          const drawn = this.drawCards(2);
          player.hand.push(...drawn);
          this.discardCard(card);
          break;
        }
        case 'juedou': {
          this.log(`${player.hero.name} 对 ${target.hero.name} 发起【决斗】`, 'action');
          renderPlayPile([card]);
          let attacker = target, defender = player;
          let resolved = false;
          while (!resolved) {
            let resp;
            if (attacker.isHuman) {
              resp = await this.waitForHumanResponse('sha_duel', attacker, '决斗中，请出杀或放弃');
            } else {
              resp = await this.aiRespondShan(attacker);
            }
            if (!resp) {
              this.dealDamage(defender === player ? player : target, attacker);
              resolved = true;
            } else {
              this.removeCardFromHand(attacker, resp.id);
              this.discardCard(resp);
              [attacker, defender] = [defender, attacker];
            }
          }
          this.discardCard(card);
          break;
        }
        case 'guohechaiqiao': {
          if (!target) break;
          this.log(`${player.hero.name} 对 ${target.hero.name} 使用【过河拆桥】`, 'action');
          // Remove a random card from target
          if (target.hand.length > 0) {
            const removed = target.hand.splice(Math.floor(Math.random() * target.hand.length), 1)[0];
            this.discardCard(removed);
            this.log(`拆掉了 ${target.hero.name} 的一张手牌`, 'action');
          } else {
            const equipSlots = Object.entries(target.equip).filter(([k, v]) => v);
            if (equipSlots.length > 0) {
              const [slot, equipCard] = equipSlots[Math.floor(Math.random() * equipSlots.length)];
              target.equip[slot] = null;
              this.discardCard(equipCard);
              this.log(`拆掉了 ${target.hero.name} 的 ${equipCard.name}`, 'action');
            }
          }
          this.discardCard(card);
          break;
        }
        case 'shunshouqianyang': {
          if (!target) break;
          this.log(`${player.hero.name} 对 ${target.hero.name} 使用【顺手牵羊】`, 'action');
          if (target.hand.length > 0) {
            const stolen = target.hand.splice(Math.floor(Math.random() * target.hand.length), 1)[0];
            player.hand.push(stolen);
            this.log(`偷走了 ${target.hero.name} 的一张手牌`, 'action');
          }
          this.discardCard(card);
          break;
        }
        case 'nanmanruqin': {
          this.log(`${player.hero.name} 使用了【南蛮入侵】`, 'action');
          renderPlayPile([card]);
          for (const p of this.otherAlivePlayers(player.index)) {
            let resp;
            if (p.isHuman) {
              resp = await this.waitForHumanResponse('sha_defend', p, '南蛮入侵！请出杀或受到伤害');
            } else {
              resp = p.hand.find(c => c.key === 'sha');
            }
            if (resp) {
              this.removeCardFromHand(p, resp.id);
              this.discardCard(resp);
              this.log(`${p.hero.name} 出杀闪避`, 'action');
            } else {
              this.dealDamage(player, p);
            }
          }
          this.discardCard(card);
          break;
        }
        case 'wanjianqifa': {
          this.log(`${player.hero.name} 使用了【万箭齐发】`, 'action');
          renderPlayPile([card]);
          for (const p of this.otherAlivePlayers(player.index)) {
            let resp;
            if (p.isHuman) {
              resp = await this.waitForHumanResponse('shan', p, '万箭齐发！请出闪或受到伤害');
            } else {
              resp = await this.aiRespondSha(p);
            }
            if (resp) {
              this.removeCardFromHand(p, resp.id);
              this.discardCard(resp);
              this.log(`${p.hero.name} 使用闪闪避`, 'action');
            } else {
              this.dealDamage(player, p);
            }
          }
          this.discardCard(card);
          break;
        }
        case 'taoyuanjieyi': {
          this.log(`${player.hero.name} 使用了【桃园结义】`, 'action');
          for (const p of this.alivePlayers()) {
            if (p.hp < p.maxHp) this.heal(p, 1);
          }
          this.discardCard(card);
          break;
        }
        default: {
          if (card.type === 'equip') {
            this.equipCard(player, card);
          } else {
            this.discardCard(card);
          }
        }
      }
    }

    // ===== Turn Execution =====
    async executeTurn() {
      if (this.gameOver) return;
      const player = this.currentPlayer();
      if (!player.alive) { this.nextTurn(); return; }

      player.shaUsedThisTurn = false;
      player.luoyiActive = false;

      this.log(`━━━ ${player.hero.name} 的回合 ━━━`);

      // Phase 0: 准备阶段
      this.phase = 0;
      showPhaseBanner(PHASE_NAMES[0] + ' - ' + player.hero.name);
      await delay(600);

      // Phase 1: 判定阶段
      this.phase = 1;

      // Phase 2: 摸牌阶段
      this.phase = 2;
      player.luoyiActive = false; // reset each turn
      this.skillState = null;     // reset multi-step skill state each turn

      if (player.hero.skillFn === 'guanxing') {
        // 观星: view top N cards (up to alive player count, max 5), freely arrange deck
        const n = Math.min(this.alivePlayers().length, 5);
        const topCards = [];
        for (let i = 0; i < n; i++) topCards.push(this.drawCard());
        if (player.isHuman) {
          const arranged = await this.guanxingOverlay(topCards);
          for (const c of arranged.bottom) this.deck.unshift(c);          // put bottom cards at deck start (draw from end)
          for (const c of [...arranged.top].reverse()) this.deck.push(c); // put top cards at deck end (drawn first)
        } else {
          // AI: best cards on top
          topCards.sort((a, b) => this.cardValue(b) - this.cardValue(a));
          const half = Math.ceil(topCards.length / 2);
          const top = topCards.slice(0, half), bottom = topCards.slice(half);
          for (const c of bottom) this.deck.unshift(c);
          for (const c of [...top].reverse()) this.deck.push(c);
        }
        this.log(`${player.hero.name} 发动【观星】整理了牌堆`, 'action');
        const drawn2 = this.drawCards(2);
        player.hand.push(...drawn2);
        this.log(`${player.hero.name} 摸了 2 张牌`, 'action');
      } else {
        let drawCount = 2;
        if (player.hero.skillFn === 'luoyi') {
          if (player.isHuman) {
            drawCount = await this.humanLuoyiPrompt(player);
          } else if (player.hand.filter(c => c.key === 'sha').length > 0) {
            drawCount = 1;
            player.luoyiActive = true;
            this.log(`${player.hero.name} 发动【裸衣】少摸一张牌`, 'action');
          }
        }
        const drawn = this.drawCards(drawCount);
        player.hand.push(...drawn);
        this.log(`${player.hero.name} 摸了 ${drawCount} 张牌`, 'action');
      }
      renderAll();

      // Phase 3: 出牌阶段
      this.phase = 3;
      await delay(300);

      if (player.isHuman) {
        // Human play phase - enable UI
        await this.humanPlayPhase(player);
      } else {
        // AI play phase
        await this.aiPlayTurn(player);
      }

      if (this.gameOver) return;

      // Phase 4: 弃牌阶段
      this.phase = 4;
      const maxHand = player.hp > 0 ? player.hp : 0;
      while (player.hand.length > maxHand && player.alive) {
        if (player.isHuman) {
          await this.humanDiscardPhase(player, player.hand.length - maxHand);
        } else {
          // AI discards worst cards
          player.hand.sort((a, b) => this.cardValue(a) - this.cardValue(b));
          const discarded = player.hand.shift();
          if (discarded) this.discardCard(discarded);
        }
      }

      // Phase 5: 结束阶段
      this.phase = 5;
      renderAll();
      await delay(300);

      this.nextTurn();
    }

    nextTurn() {
      if (this.gameOver) return;
      do {
        this.turnIndex = (this.turnIndex + 1) % this.players.length;
      } while (!this.players[this.turnIndex].alive);
      this.turn++;
      renderAll();
      this.executeTurn();
    }

    async aiPlayTurn(player) {
      const actions = await this.aiPlayPhase(player);
      for (const action of actions) {
        if (this.gameOver || !player.alive) break;

        if (action.type === 'play') {
          // Verify card still in hand
          if (!player.hand.find(c => c.id === action.card.id)) continue;

          if (action.card.key === 'sha') {
            const canMulti = player.hero.skillFn === 'paoxiao' || (player.equip.weapon && player.equip.weapon.key === 'zhugenu');
            if (player.shaUsedThisTurn && !canMulti) continue;
          }

          await this.executeCard(player, action.card, action.target);
          renderAll();
          await delay(500);
        } else if (action.type === 'skill') {
          if (action.skillName === '制衡' && action.cards.length > 0) {
            for (const c of action.cards) {
              this.removeCardFromHand(player, c.id);
              this.discardCard(c);
            }
            const drawn = this.drawCards(action.cards.length);
            player.hand.push(...drawn);
            this.log(`${player.hero.name} 发动【制衡】弃 ${action.cards.length} 张摸 ${action.cards.length} 张`, 'action');
            renderAll();
            await delay(400);
          } else if (action.skillName === '急救') {
            if (!player.hand.find(c => c.id === action.card.id)) continue;
            if (player.hp >= player.maxHp) continue;
            this.removeCardFromHand(player, action.card.id);
            this.discardCard(action.card);
            this.heal(player, 1);
            this.log(`${player.hero.name} 发动【急救】回复1血`, 'action');
            renderAll();
            await delay(400);
          } else if (action.skillName === '离间') {
            const t1 = this.players[action.target1.index];
            const t2 = this.players[action.target2.index];
            if (!t1?.alive || !t2?.alive) continue;
            await this.executeLijian(player, t1, t2);
            renderAll();
            await delay(400);
          }
        } else if (action.type === 'skill_sha') {
          // Wusheng / Longdan: use non-sha card as sha
          if (!player.hand.find(c => c.id === action.card.id)) continue;
          if (player.shaUsedThisTurn) continue;
          if (!action.target?.alive || !this.isInRange(player, action.target)) continue;
          this.log(`${player.hero.name} 发动【${action.skillName}】将《${action.card.name}》当杀使用`, 'action');
          this.removeCardFromHand(player, action.card.id);
          this.discardPile.push(action.card);
          const vsha = { ...action.card, id: Date.now() + Math.random(), key: 'sha', name: `杀(${action.skillName})`, cssClass: 'sg-card-type-sha' };
          await this.executeCard(player, vsha, action.target);
          renderAll();
          await delay(500);
        }
      }
    }

    // ===== Human Interaction =====
    async humanPlayPhase(player) {
      return new Promise((resolve) => {
        this.humanPlayResolve = resolve;
        enableActionBar(true, player);
        renderAll();
      });
    }

    async humanDiscardPhase(player, count) {
      this.log(`请弃 ${count} 张牌`);
      return new Promise((resolve) => {
        this.humanDiscardResolve = resolve;
        this.discardCount = count;
        enableDiscardMode(true, count);
        renderAll();
      });
    }

    humanEndTurn() {
      if (this.humanPlayResolve) {
        enableActionBar(false);
        this.humanPlayResolve();
        this.humanPlayResolve = null;
      }
    }

    humanDiscardSelected(card) {
      const player = this.players[this.humanIndex];
      this.removeCardFromHand(player, card.id);
      this.discardCard(card);
      this.discardCount--;
      renderAll();
      if (this.discardCount <= 0) {
        enableDiscardMode(false);
        if (this.humanDiscardResolve) {
          this.humanDiscardResolve();
          this.humanDiscardResolve = null;
        }
      }
    }

    async humanPlayCard(card, target) {
      const player = this.players[this.humanIndex];
      if (!player.hand.find(c => c.id === card.id)) return;

      // Validation
      if (card.key === 'sha') {
        const canMulti = player.hero.skillFn === 'paoxiao' || (player.equip.weapon && player.equip.weapon.key === 'zhugenu');
        if (player.shaUsedThisTurn && !canMulti) {
          this.log('本回合已使用过杀');
          return;
        }
        if (!target) { this.log('请选择目标'); return; }
        if (!this.isInRange(player, target)) { this.log('目标不在攻击范围内'); return; }
      }
      if ((card.key === 'juedou' || card.key === 'guohechaiqiao' || card.key === 'shunshouqianyang') && !target) {
        this.log('请选择目标');
        return;
      }

      await this.executeCard(player, card, target || player);
      renderAll();
    }

    waitForHumanResponse(type, player, msg) {
      if (!player.isHuman) return Promise.resolve(null);
      return new Promise((resolve) => {
        this.waitingForResponse = { type, player, msg, resolve };
        showResponsePrompt(type, msg, player);
      });
    }

    humanRespond(card) {
      if (!this.waitingForResponse) return;
      hideResponsePrompt();
      this.waitingForResponse.resolve(card);
      this.waitingForResponse = null;
    }

    // ===== 观星 Overlay =====
    guanxingOverlay(cards) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'sg-guanxing-overlay';

        const topCards = [];
        const botCards = [...cards];

        const render = () => {
          overlay.innerHTML = `
            <div class="sg-guanxing-title"><i class="fa-solid fa-star"></i> 观星——整理牌堆</div>
            <div class="sg-guanxing-subtitle">点击牌可将其移至【置顶】或【置底】，第一张会最先摸到。</div>
            <div class="sg-guanxing-row">
              <div class="sg-guanxing-col">
                <div class="sg-guanxing-label">房内牌（点击→置顶）</div>
                <div class="sg-guanxing-cards" id="gx-bot">${botCards.map((c, i) => `<div class="sg-card ${c.cssClass||''}" data-z="bot" data-i="${i}"><span class="sg-card-suit ${SUIT_COLORS[c.suit]==='red'?'red':'black'}">${c.suit}</span><span class="sg-card-number">${c.number}</span><span class="sg-card-icon">${c.icon||''}</span><span class="sg-card-name">${c.name}</span></div>`).join('')}</div>
              </div>
              <div class="sg-guanxing-col">
                <div class="sg-guanxing-label"><i class="fa-solid fa-arrow-up"></i> 置顶（次回先摸，点击取回）</div>
                <div class="sg-guanxing-cards" id="gx-top">${topCards.map((c, i) => `<div class="sg-card ${c.cssClass||''} gx-top-card" data-z="top" data-i="${i}"><span class="sg-card-suit ${SUIT_COLORS[c.suit]==='red'?'red':'black'}">${c.suit}</span><span class="sg-card-number">${c.number}</span><span class="sg-card-icon">${c.icon||''}</span><span class="sg-card-name">${c.name}</span></div>`).join('')}</div>
              </div>
            </div>
            <button class="sg-hero-select-btn" id="gx-confirm"><i class="fa-solid fa-check"></i> 确认</button>
          `;

          overlay.querySelectorAll('[data-z="bot"]').forEach(el => {
            el.addEventListener('click', () => { topCards.push(botCards.splice(parseInt(el.dataset.i), 1)[0]); render(); });
          });
          overlay.querySelectorAll('[data-z="top"]').forEach(el => {
            el.addEventListener('click', () => { botCards.push(topCards.splice(parseInt(el.dataset.i), 1)[0]); render(); });
          });
          overlay.querySelector('#gx-confirm').addEventListener('click', () => {
            overlay.remove();
            resolve({ top: topCards, bottom: botCards });
          });
        };

        render();
        document.body.appendChild(overlay);
      });
    }

    // ===== 裸衣 Human Prompt =====
    humanLuoyiPrompt(player) {
      return new Promise((resolve) => {
        const prompt = document.createElement('div');
        prompt.className = 'sg-response-prompt';
        prompt.innerHTML = `
          <div class="sg-response-text"><i class="fa-solid fa-paw"></i> 【裸衣】是否发动？</div>
          <div class="sg-response-hint">发动：摸取1张牌，本回合杀伤害+1</div>
          <div style="display:flex;gap:8px;margin-top:8px;justify-content:center">
            <button class="sg-response-pass-btn" id="luoyi-yes" style="border-color:var(--sg-accent);color:var(--sg-accent)"><i class="fa-solid fa-paw"></i> 发动</button>
            <button class="sg-response-pass-btn" id="luoyi-no"><i class="fa-solid fa-xmark"></i> 不发动</button>
          </div>
        `;
        $('game-container').appendChild(prompt);
        prompt.querySelector('#luoyi-yes').addEventListener('click', () => {
          prompt.remove();
          player.luoyiActive = true;
          this.log(`${player.hero.name} 发动【裸衣】，本回合杀伤害+1`, 'action');
          resolve(1);
        });
        prompt.querySelector('#luoyi-no').addEventListener('click', () => { prompt.remove(); resolve(2); });
      });
    }

    // ===== 离间 Execution =====
    async executeLijian(source, t1, t2) {
      this.log(`${source.hero.name} 发动【离间】，令 ${t1.hero.name} 与 ${t2.hero.name} 决斗`, 'action');
      let attacker = t1, defender = t2;
      let resolved = false;
      while (!resolved && !this.gameOver) {
        let resp;
        if (attacker.isHuman) {
          resp = await this.waitForHumanResponse('sha_duel', attacker, `离间！与 ${defender.hero.name} 决斗，出杀继续`);
        } else {
          resp = await this.aiRespondShan(attacker);
        }
        if (!resp) {
          this.dealDamage(defender, attacker, 1);
          resolved = true;
        } else {
          this.removeCardFromHand(attacker, resp.id);
          this.discardCard(resp);
          [attacker, defender] = [defender, attacker];
        }
      }
    }
  }

  // ========== Rendering ==========
  let game = null;
  let selectedCardId = null;
  let selectedTargetIdx = null;
  let discardMode = false;

  const $ = (id) => document.getElementById(id);

  function renderAll() {
    if (!game) return;
    renderOpponents();
    renderHand();
    renderPlayerInfo();
    renderGameInfo();
  }

  function renderOpponents() {
    const area = $('opponents-area');
    area.innerHTML = '';
    for (const p of game.players) {
      if (p.index === game.humanIndex) continue;
      const slot = document.createElement('div');
      slot.className = `sg-player-slot${game.turnIndex === p.index ? ' active' : ''}${!p.alive ? ' dead' : ''}${selectedTargetIdx === p.index ? ' targeted' : ''}`;
      slot.dataset.idx = p.index;

      const hpDots = [];
      for (let i = 0; i < p.maxHp; i++) {
        if (i < p.hp) {
          hpDots.push(`<span class="sg-hp-dot ${p.hp <= 1 ? 'danger' : 'full'}"></span>`);
        } else {
          hpDots.push('<span class="sg-hp-dot lost"></span>');
        }
      }

      const equipIcons = [];
      if (p.equip.weapon)   equipIcons.push(`<span class="sg-equip-icon" title="${p.equip.weapon.name}"><i class="fa-solid fa-khanda"></i></span>`);
      if (p.equip.armor)    equipIcons.push(`<span class="sg-equip-icon" title="${p.equip.armor.name}"><i class="fa-solid fa-shield-halved"></i></span>`);
      if (p.equip.horse_atk)equipIcons.push(`<span class="sg-equip-icon" title="${p.equip.horse_atk.name}"><i class="fa-solid fa-horse-head"></i></span>`);
      if (p.equip.horse_def)equipIcons.push(`<span class="sg-equip-icon" title="${p.equip.horse_def.name}"><i class="fa-solid fa-horse"></i></span>`);

      // AI players can't see role (except zhugong)
      const roleText = p.role === 'zhugong' ? ROLE_NAMES.zhugong : '？';

      slot.innerHTML = `
        <div class="sg-hero-portrait">${p.hero.icon}</div>
        <div class="sg-player-name">${p.hero.name}</div>
        <div class="sg-player-role">${roleText}</div>
        <div class="sg-hp-bar">${hpDots.join('')}</div>
        <div class="sg-player-cards-count">手牌: ${p.hand.length}</div>
        <div class="sg-equip-icons">${equipIcons.join('')}</div>
        ${!p.alive ? '<div style="color:var(--sg-red);font-size:11px;margin-top:2px">阵亡</div>' : ''}
      `;

      if (p.alive) {
        slot.addEventListener('click', () => {
          if (discardMode) return;
          selectedTargetIdx = selectedTargetIdx === p.index ? null : p.index;
          renderAll();
        });
      }

      area.appendChild(slot);
    }
  }

  function renderHand() {
    const area = $('hand-cards');
    area.innerHTML = '';
    const player = game.players[game.humanIndex];
    if (!player) return;

    $('my-cards-count').textContent = `手牌: ${player.hand.length}`;

    for (const card of player.hand) {
      const el = document.createElement('div');
      const suitColor = SUIT_COLORS[card.suit] || 'black';

      el.className = `sg-card ${card.cssClass || ''}${selectedCardId === card.id ? ' selected' : ''}`;
      el.dataset.cardId = card.id;
      el.innerHTML = `
        <span class="sg-card-suit ${suitColor}">${card.suit}</span>
        <span class="sg-card-number">${card.number}</span>
        <span class="sg-card-icon">${card.icon || '?'}</span>
        <span class="sg-card-name">${card.name}</span>
      `;

      el.addEventListener('click', () => {
        if (discardMode) {
          game.humanDiscardSelected(card);
          selectedCardId = null;
          return;
        }
        if (game.waitingForResponse) {
          // Check if this card is a valid response
          const wr = game.waitingForResponse;
          if (wr.type === 'shan' && (card.key === 'shan' || (player.hero.skillFn === 'longdan' && card.key === 'sha'))) {
            game.humanRespond(card);
            selectedCardId = null;
            renderAll();
            return;
          }
          if ((wr.type === 'sha_duel' || wr.type === 'sha_defend') && card.key === 'sha') {
            game.humanRespond(card);
            selectedCardId = null;
            renderAll();
            return;
          }
        }
        selectedCardId = selectedCardId === card.id ? null : card.id;
        renderAll();
      });

      area.appendChild(el);
    }
  }

  function renderPlayerInfo() {
    const player = game.players[game.humanIndex];
    if (!player) return;

    $('my-hero-name').textContent = player.hero.name;
    const roleEl = $('my-role');
    roleEl.textContent = ROLE_NAMES[player.role];
    roleEl.className = `sg-my-role ${ROLE_CSS[player.role]}`;

    const hpArea = $('my-hp');
    hpArea.innerHTML = '';
    for (let i = 0; i < player.maxHp; i++) {
      const dot = document.createElement('span');
      dot.className = `sg-hp-dot ${i < player.hp ? (player.hp <= 1 ? 'danger' : 'full') : 'lost'}`;
      hpArea.appendChild(dot);
    }
  }

  function renderGameInfo() {
    $('info-turn').textContent = game.turn;
    $('info-deck').textContent = game.deck.length;
    $('info-discard').textContent = game.discardPile.length;
    $('info-phase').textContent = PHASE_NAMES[game.phase] || '—';
  }

  function renderPlayPile(cards) {
    const pile = $('play-pile');
    pile.innerHTML = '';
    for (const card of cards) {
      const el = document.createElement('div');
      const suitColor = SUIT_COLORS[card.suit] || 'black';
      el.className = `sg-card ${card.cssClass || ''}`;
      el.innerHTML = `
        <span class="sg-card-suit ${suitColor}">${card.suit}</span>
        <span class="sg-card-number">${card.number}</span>
        <span class="sg-card-icon">${card.icon || '?'}</span>
        <span class="sg-card-name">${card.name}</span>
      `;
      pile.appendChild(el);
    }
    // Clear after 2 seconds
    setTimeout(() => { if (pile) pile.innerHTML = ''; }, 2000);
  }

  function renderLog() {
    const logEl = $('game-log');
    if (!logEl || !game) return;
    const entries = game.logEntries.slice(-50); // Show last 50
    logEl.innerHTML = entries.map(e => {
      const cls = e.type === 'damage' ? 'log-damage' : e.type === 'heal' ? 'log-heal' : e.type === 'action' ? 'log-action' : '';
      return `<div class="sg-log-entry"><span class="log-time">${e.time}</span> <span class="${cls}">${e.text}</span></div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function showPhaseBanner(text) {
    const existing = document.querySelector('.sg-phase-banner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.className = 'sg-phase-banner';
    banner.textContent = text;
    $('game-container').appendChild(banner);
    setTimeout(() => banner.remove(), 1500);
  }

  function enableActionBar(enabled, player) {
    const btnPlay  = $('btn-play');
    const btnSkill = $('btn-skill');
    const btnEnd   = $('btn-end-turn');

    btnPlay.disabled = !enabled;
    btnEnd.disabled  = !enabled;

    if (player) {
      const SKILL_LABELS = {
        jianxiong: { label: '奸雄(被动)', passive: true },
        rende:     { label: '仁德',    passive: false },
        zhiheng:   { label: '制衡',    passive: false },
        wusheng:   { label: '武圣',    passive: false },
        paoxiao:   { label: '咆哮(被动)', passive: true  },
        longdan:   { label: '龙胆',    passive: false },
        guanxing:  { label: '观星(摸牌)', passive: true  }, // auto at draw
        wushuang:  { label: '无双(被动)', passive: true  },
        lijian:    { label: '离间',    passive: false },
        jijiu:     { label: '急救',    passive: false },
        fankui:    { label: '反馈(被动)', passive: true  },
        luoyi:     { label: '裸衣(摸牌)', passive: true  }, // auto at draw
      };
      const info = SKILL_LABELS[player.hero.skillFn];
      if (info) {
        btnSkill.innerHTML = `<i class="fa-solid fa-bolt"></i> ${info.label}`;
        btnSkill.disabled  = !enabled || info.passive;
        btnSkill.title     = info.passive ? '被动技能，不需要手动激活' : `发动【${info.label}】`;
      } else {
        btnSkill.innerHTML = `<i class="fa-solid fa-bolt"></i> 技能`;
        btnSkill.disabled  = !enabled;
      }
    } else {
      btnSkill.disabled = !enabled;
    }
  }

  function enableDiscardMode(enabled, count) {
    discardMode = enabled;
    if (enabled) {
      showPhaseBanner(`请弃 ${count} 张牌`);
    }
  }

  let responsePromptEl = null;
  function showResponsePrompt(type, msg, player) {
    hideResponsePrompt();
    responsePromptEl = document.createElement('div');
    responsePromptEl.className = 'sg-response-prompt';
    responsePromptEl.innerHTML = `
      <div class="sg-response-text">${msg}</div>
      <div class="sg-response-hint">选择一张手牌进行响应</div>
      <button class="sg-response-pass-btn"><i class="fa-solid fa-xmark"></i> 放弃响应</button>
    `;
    responsePromptEl.querySelector('.sg-response-pass-btn').addEventListener('click', () => {
      game.humanRespond(null);
      hideResponsePrompt();
    });
    $('game-container').appendChild(responsePromptEl);
    renderAll();
  }

  function hideResponsePrompt() {
    if (responsePromptEl) {
      responsePromptEl.remove();
      responsePromptEl = null;
    }
  }

  function showGameOver() {
    if (window.sanguoshaAPI?.reportResult) {
      window.sanguoshaAPI.reportResult(`三国杀结束：${game.winner} 获胜！共进行了 ${game.turn} 回合`);
    }
    const overlay = document.createElement('div');
    overlay.className = 'sg-game-over';
    overlay.innerHTML = `
      <h1><i class="fa-solid fa-trophy" style="color:var(--sg-accent)"></i> 游戏结束</h1>
      <p>${game.winner} 获胜！</p>
      <p>共进行了 ${game.turn} 回合</p>
      <button onclick="location.reload()">重新开始</button>
      <button onclick="window.close()" style="margin-top:8px;background:#555;color:#fff">关闭</button>
    `;
    document.body.appendChild(overlay);
  }

  function showHeroSelect(heroes, count, humanRole, callback) {
    const overlay = document.createElement('div');
    overlay.className = 'sg-hero-select-overlay';
    let selectedHero = null;

    const title = document.createElement('div');
    title.className = 'sg-hero-select-title';
    title.textContent = '选择你的武将';

    const subtitle = document.createElement('div');
    subtitle.className = 'sg-hero-select-subtitle';
    subtitle.textContent = `你的身份：${ROLE_NAMES[humanRole]}`;

    const grid = document.createElement('div');
    grid.className = 'sg-hero-grid';

    const choices = heroes.slice(0, Math.min(count, heroes.length));
    for (const hero of choices) {
      const opt = document.createElement('div');
      opt.className = 'sg-hero-option';
      opt.innerHTML = `
        <div class="sg-hero-option-emoji">${hero.icon}</div>
        <div class="sg-hero-option-name">${hero.name}</div>
        <div class="sg-hero-option-title">${hero.title}</div>
        <div class="sg-hero-option-hp"><i class="fa-solid fa-heart" style="color:var(--sg-red)"></i> ${hero.maxHp}</div>
        <div class="sg-hero-option-skill">${hero.skill}</div>
      `;
      opt.addEventListener('click', () => {
        grid.querySelectorAll('.sg-hero-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedHero = hero;
        confirmBtn.disabled = false;
      });
      grid.appendChild(opt);
    }

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'sg-hero-select-btn';
    confirmBtn.textContent = '确认选择';
    confirmBtn.disabled = true;
    confirmBtn.addEventListener('click', () => {
      if (selectedHero) {
        overlay.remove();
        callback(selectedHero);
      }
    });

    overlay.appendChild(title);
    overlay.appendChild(subtitle);
    overlay.appendChild(grid);
    overlay.appendChild(confirmBtn);
    document.body.appendChild(overlay);
  }

  // ===== Theme Application =====
  async function applyTheme() {
    try {
      const settings = await window.sanguoshaAPI.getSettings();
      const theme = settings?.theme || {};
      // Apply theme mode
      let isDark = true;
      if (theme.mode === 'light') isDark = false;
      else if (theme.mode === 'system') {
        const sysTheme = await window.sanguoshaAPI.getTheme();
        isDark = sysTheme?.shouldUseDarkColors ?? true;
      }
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

      // Apply accent color
      if (theme.accentColor) {
        const r = parseInt(theme.accentColor.slice(1, 3), 16);
        const g = parseInt(theme.accentColor.slice(3, 5), 16);
        const b = parseInt(theme.accentColor.slice(5, 7), 16);
        document.documentElement.style.setProperty('--accent', theme.accentColor);
        document.documentElement.style.setProperty('--accent-light', `rgb(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)})`);
        document.documentElement.style.setProperty('--accent-dark', `rgb(${Math.max(0, r - 30)}, ${Math.max(0, g - 30)}, ${Math.max(0, b - 30)})`);
      }

      // Apply background color
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
      console.log('Theme apply error, using defaults:', e.message);
    }
  }

  // ===== Delay util =====
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ===== Initialize =====
  async function startGame() {
    await applyTheme();

    let aiCount = 3;
    try {
      const config = await window.sanguoshaAPI.getGameConfig();
      if (config && config.aiCount) aiCount = config.aiCount;
    } catch (e) {
      console.log('Using default config');
    }

    // Create game first to get role assignment, then show hero select
    const tempGame = new SanguoshaGame(aiCount);
    const humanRole = tempGame.players[0].role;

    // Show hero selection
    const shuffled = [...HEROES].sort(() => Math.random() - 0.5);
    showHeroSelect(shuffled, 5, humanRole, async (selectedHero) => {
      game = tempGame;
      // Replace human hero with selected one
      game.players[0].hero = { ...selectedHero };
      game.players[0].hp = selectedHero.maxHp;
      game.players[0].maxHp = selectedHero.maxHp;

      renderAll();

      // Bind action buttons
      $('btn-play').addEventListener('click', async () => {
        if (!selectedCardId) { game.log('请先选择一张牌'); return; }
        const player = game.players[game.humanIndex];
        const card = player.hand.find(c => c.id === selectedCardId);
        if (!card) return;

        let target = null;
        if (selectedTargetIdx !== null) {
          target = game.players[selectedTargetIdx];
        }

        // Self-targeting cards
        if (card.key === 'tao' || card.key === 'wuzhongshengyou' || card.type === 'equip') {
          target = player;
        }
        if (card.key === 'nanmanruqin' || card.key === 'wanjianqifa' || card.key === 'taoyuanjieyi') {
          target = null;
        }

        await game.humanPlayCard(card, target);
        selectedCardId = null;
        selectedTargetIdx = null;
        renderAll();

        if (game.gameOver) showGameOver();
      });

      $('btn-end-turn').addEventListener('click', () => {
        selectedCardId = null;
        selectedTargetIdx = null;
        game.humanEndTurn();
      });

      $('btn-skill').addEventListener('click', async () => {
        const player = game.players[game.humanIndex];
        if (!player || !player.alive || !game.humanPlayResolve) {
          game.log('现在不是你的出牌阶段');
          return;
        }
        const skill = player.hero.skillFn;

        // ── 制衡 (孙权): discard selected card, draw same count ─────────
        if (skill === 'zhiheng') {
          if (!selectedCardId) { game.log('请先选一张要弃置的牌（可多次使用）', 'action'); return; }
          const card = player.hand.find(c => c.id === selectedCardId);
          if (!card) return;
          game.removeCardFromHand(player, card.id);
          game.discardCard(card);
          const drawn = game.drawCards(1);
          player.hand.push(...drawn);
          game.log(`${player.hero.name} 发动【制衡】弃1摸1`, 'action');
          selectedCardId = null;
          renderAll();

        // ── 仁德 (刘备): give selected card to selected target ──────────
        } else if (skill === 'rende') {
          if (!selectedCardId || selectedTargetIdx === null) {
            game.log('仁德：请先选一张牌和一个目标', 'action'); return;
          }
          const card = player.hand.find(c => c.id === selectedCardId);
          const target = game.players[selectedTargetIdx];
          if (!card || !target?.alive || target.index === player.index) {
            game.log('目标无效', 'action'); return;
          }
          game.removeCardFromHand(player, card.id);
          target.hand.push(card);
          player.rendeParts = (player.rendeParts || 0) + 1;
          game.log(`${player.hero.name} 发动【仁德】将【${card.name}】给了 ${target.hero.name}（累计${player.rendeParts}张）`, 'action');
          if (player.rendeParts >= 2 && player.hp < player.maxHp) {
            game.heal(player, 1);
            player.rendeParts = 0;
          }
          selectedCardId = null;
          selectedTargetIdx = null;
          renderAll();

        // ── 急救 (华佗): use selected red card as tao to heal self ──────
        } else if (skill === 'jijiu') {
          if (!selectedCardId) { game.log('急救：请先选一张红色牌', 'action'); return; }
          const card = player.hand.find(c => c.id === selectedCardId);
          if (!card) return;
          if (SUIT_COLORS[card.suit] !== 'red') { game.log('急救：需要选一张红色牌（♥或♦）', 'action'); return; }
          if (player.hp >= player.maxHp) { game.log('HP已满，无需急救', 'action'); return; }
          game.removeCardFromHand(player, card.id);
          game.discardCard(card);
          game.heal(player, 1);
          game.log(`${player.hero.name} 发动【急救】回复1血`, 'action');
          selectedCardId = null;
          renderAll();

        // ── 武圣 (关羽): use selected red card as sha to attack ──────────
        } else if (skill === 'wusheng') {
          if (!selectedCardId) { game.log('武圣：请先选一张红色牌', 'action'); return; }
          const card = player.hand.find(c => c.id === selectedCardId);
          if (!card) return;
          if (SUIT_COLORS[card.suit] !== 'red') { game.log('武圣：需要红色牌（♥或♦）', 'action'); return; }
          if (selectedTargetIdx === null) { game.log('武圣：请再选择一个攻击目标', 'action'); return; }
          const target = game.players[selectedTargetIdx];
          if (!target?.alive) return;
          if (!game.isInRange(player, target)) { game.log('目标不在攻击范围内', 'action'); return; }
          const canMultiW = player.equip.weapon?.key === 'zhugenu';
          if (player.shaUsedThisTurn && !canMultiW) { game.log('本回合已使用过杀', 'action'); return; }
          game.removeCardFromHand(player, card.id);
          game.discardPile.push(card);
          const vsha = { ...card, id: Date.now() + Math.random(), key: 'sha', name: `杀(武圣)`, cssClass: 'sg-card-type-sha', icon: CARD_TYPES.sha.icon };
          await game.executeCard(player, vsha, target);
          selectedCardId = null;
          selectedTargetIdx = null;
          renderAll();
          if (game.gameOver) showGameOver();

        // ── 龙胆 (赵云): use selected shan card as sha to attack ─────────
        } else if (skill === 'longdan') {
          if (!selectedCardId) { game.log('龙胆：请先选一张闪', 'action'); return; }
          const card = player.hand.find(c => c.id === selectedCardId);
          if (!card || card.key !== 'shan') { game.log('龙胆当杀：需要选一张【闪】', 'action'); return; }
          if (selectedTargetIdx === null) { game.log('龙胆：请再选择一个攻击目标', 'action'); return; }
          const target = game.players[selectedTargetIdx];
          if (!target?.alive) return;
          if (!game.isInRange(player, target)) { game.log('目标不在攻击范围内', 'action'); return; }
          const canMultiL = player.equip.weapon?.key === 'zhugenu';
          if (player.shaUsedThisTurn && !canMultiL) { game.log('本回合已使用过杀', 'action'); return; }
          game.log(`${player.hero.name} 发动【龙胆】将【闪】当杀使用`, 'action');
          game.removeCardFromHand(player, card.id);
          game.discardPile.push(card);
          const vshaL = { ...card, id: Date.now() + Math.random(), key: 'sha', name: `杀(龙胆)`, cssClass: 'sg-card-type-sha', icon: CARD_TYPES.sha.icon };
          await game.executeCard(player, vshaL, target);
          selectedCardId = null;
          selectedTargetIdx = null;
          renderAll();
          if (game.gameOver) showGameOver();

        // ── 离间 (貂蝉): multi-step — select two male targets ───────────
        } else if (skill === 'lijian') {
          if (!game.skillState) {
            game.skillState = { skill: 'lijian', step: 1, target1: null };
            game.log('【离间】第一步：点击一名目标角色（第一人）', 'action');
          } else if (game.skillState.skill === 'lijian' && game.skillState.step === 1) {
            if (selectedTargetIdx === null) { game.log('离间：请先点选第一个目标', 'action'); return; }
            const t1 = game.players[selectedTargetIdx];
            if (!t1?.alive || t1.index === player.index) { game.log('请选择其他角色', 'action'); return; }
            game.skillState.target1 = t1;
            game.skillState.step = 2;
            selectedTargetIdx = null;
            game.log(`已锁定 ${t1.hero.name}，再点选第二名目标后再次点【离间】`, 'action');
            renderAll();
          } else if (game.skillState.skill === 'lijian' && game.skillState.step === 2) {
            if (selectedTargetIdx === null) { game.log('离间：请先点选第二个目标', 'action'); return; }
            const t2 = game.players[selectedTargetIdx];
            const t1 = game.skillState.target1;
            if (!t2?.alive || t2.index === player.index || t2.index === t1.index) {
              game.log('请选择不同的角色', 'action'); return;
            }
            game.skillState = null;
            selectedTargetIdx = null;
            await game.executeLijian(player, t1, t2);
            renderAll();
            if (game.gameOver) showGameOver();
          }

        } else {
          game.log(`【${player.hero.skill}】（被动技能，自动生效）`);
        }
      });

      $('btn-close').addEventListener('click', () => window.close());

      // Game over check loop
      const checkLoop = setInterval(() => {
        if (game && game.gameOver) {
          clearInterval(checkLoop);
          showGameOver();
        }
      }, 1000);

      // Start game
      game.log('游戏开始！');
      game.executeTurn();
    });
  }

  startGame();
})();
