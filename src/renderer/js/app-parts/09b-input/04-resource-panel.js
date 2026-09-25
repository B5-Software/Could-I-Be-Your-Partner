  /* ==================== 设置页：资源下载（语音模型） ==================== */
  // 注意：这些状态必须用 var（函数作用域提升）。06 在文件顺序上早于 09，
  // 会在 appEntry 早期就调用 initResourceDownloads()；若用 let/const 会因 TDZ
  // 抛异常并被调用处的 try/catch 静默吞掉，导致下载按钮事件永远不会绑定。
  var RES_KIND_LABEL = { vad: 'VAD', kws: '唤醒词', stt: '语音识别', tts: '语音合成' };
  var _resModels = [];
  var _resProgress = {}; // modelId -> progress payload
  var _resActive = new Set(); // 正在下载的 modelId
  var _resBound = false;
  var _resDownloadingAll = false;

  function fmtBytes(n) {
    if (!n || n <= 0) return '0 B';
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  async function refreshResourcePanel() {
    const listEl = document.getElementById('res-models-list');
    if (!listEl || !window.api?.voiceModelsStatus) return;
    try {
      const st = await window.api.voiceModelsStatus();
      if (!st || st.ok === false) throw new Error((st && st.error) || '状态读取失败');
      _resModels = st.models || [];
      const mirrorEl = document.getElementById('setting-res-mirror');
      if (mirrorEl) mirrorEl.value = st.mirror || 'cn';
      const dirEl = document.getElementById('setting-res-dir');
      if (dirEl) dirEl.value = st.dir || '';
      renderResourceModels();
    } catch (e) {
      listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>读取模型状态失败：${e.message}</p></div>`;
    }
  }

  function resourceCardHtml(m) {
    const downloading = _resActive.has(m.id);
    const p = _resProgress[m.id] || {};
    const pct = downloading ? Math.max(0, Math.min(99, p.percent || 0)) : (m.installed ? 100 : 0);
    let status;
    if (downloading) status = `下载中 ${pct}%${p.file ? ' · ' + p.file.split(/[\\/]/).pop() : ''}`;
    else if (m.installed) status = `已下载${m.bytes ? ' · ' + fmtBytes(m.bytes) : ''}`;
    else status = `未下载 · ${m.size || ''}`;
    const action = downloading
      ? `<button class="btn-secondary btn-sm" data-res-act="cancel" data-res-id="${m.id}">取消</button>`
      : m.installed
        ? `<button class="btn-secondary btn-sm" data-res-act="delete" data-res-id="${m.id}">删除</button>`
        : `<button class="btn-secondary btn-sm" data-res-act="download" data-res-id="${m.id}"><i class="fa-solid fa-download"></i> 下载</button>`;
    return `
      <div class="res-model-card" id="res-model-${m.id}">
        <div class="res-model-info">
          <div class="res-model-name">${m.label}
            <span class="${m.required ? 'res-req' : 'res-opt'}">${m.required ? '必需' : '可选'}</span>
            <span class="res-kind">${RES_KIND_LABEL[m.kind] || m.kind}</span>
          </div>
          <div class="res-model-meta" data-role="status">${status}</div>
          <div class="res-model-progress" data-role="progress" ${downloading ? '' : 'style="display:none"'}>
            <div class="res-progress-bar"><i data-role="bar" style="width:${pct}%"></i></div>
          </div>
        </div>
        <div class="res-model-actions">${action}</div>
      </div>`;
  }

  function renderResourceModels() {
    const listEl = document.getElementById('res-models-list');
    if (!listEl) return;
    if (!_resModels.length) {
      listEl.innerHTML = '<div class="empty-state"><p>暂无模型清单</p></div>';
      return;
    }
    listEl.innerHTML = _resModels.map(resourceCardHtml).join('');
  }

  function updateResourceModelCard(id) {
    const m = _resModels.find(x => x.id === id);
    const card = document.getElementById('res-model-' + id);
    if (!m || !card) return;
    const downloading = _resActive.has(id);
    const p = _resProgress[id] || {};
    const pct = downloading ? Math.max(0, Math.min(99, p.percent || 0)) : (m.installed ? 100 : 0);
    const statusEl = card.querySelector('[data-role="status"]');
    const progressEl = card.querySelector('[data-role="progress"]');
    const barEl = card.querySelector('[data-role="bar"]');
    if (statusEl) {
      statusEl.textContent = downloading
        ? `下载中 ${pct}%${p.file ? ' · ' + p.file.split(/[\\/]/).pop() : ''}`
        : (m.installed ? `已下载${m.bytes ? ' · ' + fmtBytes(m.bytes) : ''}` : `未下载 · ${m.size || ''}`);
    }
    if (progressEl) progressEl.style.display = downloading ? '' : 'none';
    if (barEl) barEl.style.width = pct + '%';
  }
