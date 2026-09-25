  async function startModelDownload(id) {
    if (!window.api?.voiceModelsDownload || _resActive.has(id)) return;
    _resActive.add(id);
    _resProgress[id] = { percent: 0 };
    updateResourceModelCard(id);
    try {
      const r = await window.api.voiceModelsDownload(id);
      if (r?.ok) window.showToast('模型下载完成', 'success', 2500);
      else if (r?.error && r.error !== '已取消' && !/取消/.test(r.error)) {
        window.showToast('下载失败: ' + r.error, 'error', 5000);
      }
    } catch (e) {
      window.showToast('下载失败: ' + e.message, 'error', 5000);
    } finally {
      _resActive.delete(id);
      delete _resProgress[id];
      await refreshResourcePanel();
      await refreshVoiceGate();
      await refreshVoiceModelStatus();
    }
  }

  async function downloadAllRequiredModels() {
    if (_resDownloadingAll) return;
    _resDownloadingAll = true;
    const btn = document.getElementById('btn-res-download-all');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 下载中…'; }
    try {
      const pending = _resModels.filter(m => m.required && !m.installed);
      for (const m of pending) {
        await startModelDownload(m.id);
        await refreshResourcePanel();
      }
      if (pending.length === 0) window.showToast('必需模型均已下载', 'info', 2500);
    } finally {
      _resDownloadingAll = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-download"></i> 下载全部必需模型'; }
      await refreshResourcePanel();
    }
  }

  function initResourceDownloads() {
    if (_resBound) return;
    _resBound = true;
    document.getElementById('setting-res-mirror')?.addEventListener('change', async (e) => {
      await window.api.voiceModelsSetMirror(e.target.value);
    });
    document.getElementById('btn-res-choose-dir')?.addEventListener('click', async () => {
      const r = await window.api.voiceModelsChooseDir();
      if (r && r.ok) {
        await refreshResourcePanel();
        await refreshVoiceGate();
      }
    });
    document.getElementById('btn-res-open-dir')?.addEventListener('click', () => {
      const dir = document.getElementById('setting-res-dir')?.value;
      window.api.voiceModelsOpenDir(dir || undefined);
    });
    document.getElementById('btn-res-download-all')?.addEventListener('click', () => downloadAllRequiredModels());
    document.getElementById('res-models-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-res-act]');
      if (!btn) return;
      const id = btn.dataset.resId;
      const act = btn.dataset.resAct;
      if (act === 'download') await startModelDownload(id);
      else if (act === 'cancel') await window.api.voiceModelsCancel(id);
      else if (act === 'delete') {
        const confirmed = window.api.confirmSensitive
          ? await window.api.confirmSensitive('确定删除该语音模型文件吗？')
          : window.confirm('确定删除该语音模型文件吗？');
        if (!confirmed) return;
        const r = await window.api.voiceModelsDelete(id);
        if (r && r.ok === false) window.showToast(r.error || '删除失败', 'error');
        await refreshResourcePanel();
        await refreshVoiceGate();
      }
    });
    window.api.onVoiceModelsProgress?.((p) => {
      if (!p || !p.modelId) return;
      _resProgress[p.modelId] = p;
      updateResourceModelCard(p.modelId);
    });
    // 语音设置页「前往资源下载」
    document.getElementById('btn-voice-goto-resources')?.addEventListener('click', () => {
      // openSettingsTab 定义在命令面板 IIFE 内，通过 window 暴露；不可用时直接激活面板兜底
      if (typeof window.openSettingsTab === 'function') {
        window.openSettingsTab('resources');
        return;
      }
      if (typeof window.activateSettingsTab === 'function' && window.activateSettingsTab('resources')) return;
      document.querySelectorAll('.settings-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'resources'));
      document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === 'resources'));
      if (typeof refreshResourcePanel === 'function') refreshResourcePanel().catch(() => {});
    });
  }
