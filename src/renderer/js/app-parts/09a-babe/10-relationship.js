/* SPDX-License-Identifier: GPL-3.0-or-later */
  let babeRelationshipView = null;
  let babeRelationshipEditing = false;
  const babeRelationText = value => typeof chatGPTText === 'function' ? chatGPTText(value) : value;
  const babeStages = { strangers: '初识', acquaintance: '渐渐熟悉', friends: '知心朋友', close: '心意渐近', dating: '约会中', partner: '彼此承诺' };
  const babeMoods = { calm: '平静自在', bright: '有点开心', touched: '心里暖暖的', unsettled: '需要一点理解' };
  const babeMemoryKinds = { moment: '共同经历', promise: '小小约定', preference: '彼此偏好', boundary: '相处边界' };

  function babeRelationElement(tag, className, text) {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = babeRelationText(text); return el;
  }
  function renderBabeRelationship(state) {
    if (!state) return;
    babeRelationshipView = state;
    const badge = document.getElementById('babe-relationship-stage');
    if (badge) badge.textContent = babeRelationText(state.ok ? babeStages[state.stage] : '关系暂不可用');
    const mood = document.getElementById('babe-relationship-mood');
    if (mood) mood.textContent = state.enabled ? babeRelationText(babeMoods[state.mood] || babeMoods.calm) : babeRelationText('关系成长已暂停');
    if (state.metrics) updateBabeAffection(state.metrics.affection);
    if (babeRelationshipEditing) return;
    for (const id of ['babe-relationship-detail', 'setting-babe-relationship-detail']) {
      const root = document.getElementById(id); if (!root) continue;
      root.replaceChildren();
      if (!state.ok) { root.append(babeRelationElement('p', 'setting-hint', '关系暂不可用')); continue; }
      const summary = babeRelationElement('div', 'babe-relationship-summary');
      const heading = babeRelationElement('div');
      heading.append(babeRelationElement('span', 'babe-relationship-eyebrow', '你们的故事'), babeRelationElement('h3', '', babeStages[state.stage]));
      const subtitle = babeRelationElement('p', 'setting-hint');
      subtitle.textContent = `${babeRelationText('相处天数')} ${state.daysTogether} · ${babeRelationText(babeMoods[state.mood] || babeMoods.calm)}`;
      heading.append(subtitle); summary.append(heading);
      const icon = babeRelationElement('i', 'fa-solid fa-heart'); icon.setAttribute('aria-hidden', 'true'); summary.append(icon); root.append(summary);
      const metrics = babeRelationElement('div', 'babe-relationship-metrics');
      for (const [key, label] of [['affection', '好感'], ['trust', '信任'], ['familiarity', '熟悉']]) {
        const card = babeRelationElement('div', 'babe-relationship-metric');
        const row = babeRelationElement('div'); row.append(babeRelationElement('span', '', label), babeRelationElement('strong', '', String(Math.round(state.metrics[key]))));
        const progress = document.createElement('progress'); progress.max = 100; progress.value = state.metrics[key]; progress.setAttribute('aria-label', babeRelationText(label));
        card.append(row, progress); metrics.append(card);
      }
      root.append(metrics);
      if (state.next?.stage) {
        const next = babeRelationElement('div', 'babe-relationship-next');
        next.append(babeRelationElement('strong', '', state.next.eligible ? '可以聊聊彼此的心意了' : '慢慢了解，一起靠近'));
        next.append(babeRelationElement('p', 'setting-hint', '亲近来自真诚交流、信任与共同经历；关系升级需要彼此明确确认。'));
        root.append(next);
      }
      const milestones = babeRelationElement('div', 'babe-relationship-milestones');
      for (const milestone of state.milestones || []) {
        const chip = babeRelationElement('span', 'babe-relationship-chip');
        chip.textContent = `${babeRelationText(babeStages[milestone.kind])} · ${new Date(milestone.at).toLocaleDateString(i18nGetLanguage())}`;
        milestones.append(chip);
      }
      root.append(milestones, babeRelationElement('h4', '', '共同记住的事'));
      if (!state.memories?.length) root.append(babeRelationElement('p', 'setting-hint', '从一段真诚的对话开始，值得珍惜的经历和约定会留在这里。'));
      for (const memory of [...state.memories || []].reverse()) {
        const item = babeRelationElement('article', 'babe-relationship-memory');
        const label = babeRelationElement('span', 'babe-relationship-eyebrow', babeMemoryKinds[memory.kind]);
        const content = babeRelationElement('p'); content.textContent = memory.content;
        const actions = babeRelationElement('div', 'babe-relationship-memory-actions');
        const edit = babeRelationElement('button', 'btn-icon'); edit.type = 'button'; edit.title = babeRelationText('编辑'); edit.setAttribute('aria-label', edit.title); edit.innerHTML = '<i class="fa-solid fa-pen"></i>';
        const remove = babeRelationElement('button', 'btn-icon'); remove.type = 'button'; remove.title = babeRelationText('删除'); remove.setAttribute('aria-label', remove.title); remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        edit.addEventListener('click', () => {
          if (babeRelationshipEditing) return; babeRelationshipEditing = true;
          const input = document.createElement('textarea'); input.value = memory.content; input.rows = 3; input.maxLength = 240; input.setAttribute('aria-label', babeRelationText('编辑共同记忆'));
          content.replaceWith(input); actions.replaceChildren();
          const save = babeRelationElement('button', 'btn-primary', '保存'); const cancel = babeRelationElement('button', 'btn-secondary', '取消');
          cancel.addEventListener('click', () => { babeRelationshipEditing = false; renderBabeRelationship(babeRelationshipView); });
          save.addEventListener('click', async () => {
            save.disabled = true;
            try {
              const result = await window.api.babeRelationshipEdit({ revision: state.revision, id: memory.id, content: input.value });
              if (!result.ok) { window.showToast?.(babeRelationText(result.conflict ? '关系已在其他界面更新，请刷新后重试' : '无法保存这条共同记忆'), 'warn'); return; }
              babeRelationshipEditing = false; renderBabeRelationship(result);
            } catch { window.showToast?.(babeRelationText('无法保存这条共同记忆'), 'warn'); }
            finally { save.disabled = false; }
          });
          actions.append(cancel, save); input.focus();
        });
        remove.addEventListener('click', async () => {
          if (!await window.api.confirmSensitive(babeRelationText('删除这条共同记忆？聊天记录将保留。'))) return;
          const result = await window.api.babeRelationshipEdit({ revision: state.revision, id: memory.id, remove: true });
          if (!result.ok) window.showToast?.(babeRelationText('关系已在其他界面更新，请刷新后重试'), 'warn');
          await refreshBabeRelationshipPanel();
        });
        actions.append(edit, remove); item.append(label, content, actions); root.append(item);
      }
    }
  }
  async function refreshBabeRelationshipPanel() {
    try { renderBabeRelationship(await window.api.babeRelationshipGet()); }
    catch { renderBabeRelationship({ ok: false }); }
  }
  function loadBabeRelationshipSettings(settings) {
    const b = settings.babe || {}, relationship = b.relationship || {};
    for (const key of ['enabled', 'showMetrics']) { const el = document.querySelector(`[data-babe-relationship="${key}"]`); if (el) el.checked = relationship[key] !== false; }
    for (const key of ['pace', 'start']) { const el = document.querySelector(`[data-babe-relationship="${key}"]`); if (el) el.value = relationship[key] || (key === 'pace' ? 'natural' : 'gradual'); }
    const interests = document.getElementById('setting-babe-interests'); if (interests) interests.value = b.interests || '';
    const boundaries = document.getElementById('setting-babe-boundaries'); if (boundaries) boundaries.value = b.boundaries || '';
    document.querySelector('.babe-affection-bar')?.classList.toggle('hidden', relationship.showMetrics === false);
  }
  document.getElementById('btn-babe-relationship')?.addEventListener('click', async event => {
    const panel = document.getElementById('babe-relationship-panel'); panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) await refreshBabeRelationshipPanel();
  });
  document.getElementById('btn-babe-relationship-close')?.addEventListener('click', () => {
    document.getElementById('babe-relationship-panel').hidden = true;
    const button = document.getElementById('btn-babe-relationship'); button.setAttribute('aria-expanded', 'false'); button.focus();
  });
  document.getElementById('btn-babe-relationship-reset')?.addEventListener('click', async () => {
    if (!await window.api.confirmSensitive(babeRelationText('重新开始这段关系？关系进度、里程碑和共同记忆将清空，聊天记录与自动记忆保留。'))) return;
    const result = await window.api.babeRelationshipEdit({ revision: babeRelationshipView?.revision, reset: true });
    if (!result.ok) window.showToast?.(babeRelationText('关系已在其他界面更新，请刷新后重试'), 'warn');
    await refreshBabeRelationshipPanel();
  });
  document.querySelectorAll('[data-babe-relationship]').forEach(input => input.addEventListener('change', async () => {
    const settings = await saveSettings({ babe: { relationship: { [input.dataset.babeRelationship]: input.type === 'checkbox' ? input.checked : input.value } } });
    loadBabeRelationshipSettings(settings); await refreshBabeRelationshipPanel();
  }));
  for (const key of ['interests', 'boundaries']) document.getElementById('setting-babe-' + key)?.addEventListener('change', async event => { await saveSettings({ babe: { [key]: event.target.value } }); });
  document.querySelectorAll('[data-babe-activity]').forEach(button => button.addEventListener('click', () => {
    const prompts = { date: '我们一起构思一次虚拟约会吧，选一个你也喜欢的地点。', game: '一起玩一个你喜欢的文字小游戏吧，你先介绍规则。', goal: '我们来定一个这周可以一起坚持的小目标吧。' };
    const input = document.getElementById('babe-chat-input'); input.value = babeRelationText(prompts[button.dataset.babeActivity]); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
  }));
  window.api.onBabeRelationshipChanged?.(state => renderBabeRelationship(state));
  window.api.onSettingsChanged?.(() => readSettings().then(loadBabeRelationshipSettings).catch(() => {}));
  window.addEventListener('languagechange', () => { if (babeRelationshipView) renderBabeRelationship(babeRelationshipView); });
