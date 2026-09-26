  // ---- 运行位置（本机 / 虚拟机）+ 虚拟机沙盒（CIBYP-VM-OS）----
  // 说明：资源下载/重置/自检全部走 window.api.vm.*；切换运行位置需要重启应用。
  const VM_VARIANT_INFO = {}; // 由 vm:variants 填充

  function _fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 ** 3) return (v / 1024 ** 3).toFixed(2) + ' GB';
    if (v >= 1024 ** 2) return (v / 1024 ** 2).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
  }

  function _vmSetText(id, text, warn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.style.color = warn ? 'var(--warning, #b7791f)' : 'var(--text-secondary)';
  }

  async function refreshVmAssetsStatus() {
    if (!window.api.vm) return;
    const variant = (document.getElementById('setting-vm-variant') || {}).value || 'base';
    try {
      const st = await window.api.vm.assetsStatus(variant);
      const info = VM_VARIANT_INFO[variant] || {};
      if (st && st.installed) {
        const sel = st.selected || (st.versions || [])[0] || {};
        _vmSetText('vm-assets-status', `✅ 已安装：${variant} ${sel.version || ''}（${_fmtBytes(sel.bytes)}）· ${st.dir}`, false);
        const btn = document.getElementById('btn-vm-download');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-download"></i> 检查更新';
      } else if (st && (st.versions || []).length) {
        _vmSetText('vm-assets-status', `⚠️ 安装不完整（缺少：${(st.missing || []).join(', ')}）`, true);
      } else {
        _vmSetText('vm-assets-status', `未安装${info.limitMB ? `（预计下载 ≤ ${info.limitMB}MB）` : ''}`, true);
      }
    } catch (e) {
      _vmSetText('vm-assets-status', '状态获取失败：' + (e.message || e), true);
    }
  }

  async function refreshVmRuntimeStatus() {
    if (!window.api.vm) return;
    try {
      const st = await window.api.vm.status();
      const inst = (st && st.inst) || {};
      const label = {
        idle: '未运行', checking: '检查资源', booting: '启动中', preparing: '等待就绪',
        ready: '已就绪', stopping: '正在关闭', failed: '启动失败'
      }[inst.state] || inst.state || '未知';
      const accel = st.accel ? ` · 加速：${st.accel}` : '';
      _vmSetText('vm-runtime-status',
        `${inst.state === 'ready' ? '✅' : inst.state === 'failed' ? '⚠️' : 'ℹ️'} ${label}${accel}` +
        (inst.detail ? ` · ${inst.detail}` : '') +
        (inst.uptimeMs ? ` · 已运行 ${Math.round(inst.uptimeMs / 1000)}s` : ''),
        inst.state === 'failed');
      const pre = document.getElementById('vm-serial-tail');
      if (pre) {
        const tail = inst.serialTail || '';
        pre.style.display = tail ? 'block' : 'none';
        if (tail) pre.textContent = tail.slice(-4000);
      }
    } catch (e) {
      _vmSetText('vm-runtime-status', '状态获取失败：' + (e.message || e), true);
    }
  }

  async function refreshVmSyncStatus(extra) {
    const el = document.getElementById('vm-sync-status');
    const rootEl = document.getElementById('vm-ws-root');
    if (!el || !window.api.vm.syncStatus) return;
    try {
      const st = await window.api.vm.syncStatus();
      const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleTimeString() : '尚未同步';
      if (rootEl) rootEl.textContent = st.workspaceRoot ? `宿主目录：${st.workspaceRoot}` : '';
      if (st.workspaceMode === 'isolated') {
        _vmSetText('vm-sync-status', '独立工作区模式：不自动同步（导出/导入请用下方按钮）', false);
        return;
      }
      const modeNote = '手动';
      const detail = extra || '';
      _vmSetText('vm-sync-status',
        `上次同步：${when}（${st.lastReason || modeNote}）· 基线文件 ${st.baselineFiles || 0} 个` +
        (detail ? ` · ${detail}` : ''), false);
    } catch (e) {
      _vmSetText('vm-sync-status', '状态获取失败：' + (e.message || e), true);
    }
  }

  function _vmBindSyncButtons() {
    const run = async (direction, label) => {
      _vmSetText('vm-sync-status', `${label}中…`, false);
      try {
        const r = await window.api.vm.sync({ direction });
        if (r && r.ok) {
          window.showToast?.(`同步完成：推送 ${r.pushed} / 拉回 ${r.pulled} / 删除 ${r.deleted}${r.conflicts && r.conflicts.length ? ` / 冲突 ${r.conflicts.length}` : ''}`, 'success', 3000);
          refreshVmSyncStatus(`用时 ${r.ms}ms`);
        } else {
          _vmSetText('vm-sync-status', `${label}失败：` + ((r && r.error) || '未知错误'), true);
        }
      } catch (e) {
        _vmSetText('vm-sync-status', `${label}失败：` + (e.message || e), true);
      }
    };
    document.getElementById('btn-vm-sync')?.addEventListener('click', () => run('both', '双向同步'));
    document.getElementById('btn-vm-sync-push')?.addEventListener('click', () => run('push', '推送'));
    document.getElementById('btn-vm-sync-pull')?.addEventListener('click', () => run('pull', '拉回'));
    document.getElementById('btn-vm-ws-root')?.addEventListener('click', async () => {
      const r = await window.api.vm.chooseWorkspaceRoot();
      if (r && r.ok) {
        window.showToast?.('工作区目录已更改，重启应用后生效：' + r.dir, 'success', 3500);
        _vmMarkRestartRequired('工作区目录已变更，需要重启应用后生效。');
        refreshVmSyncStatus();
      }
    });
    if (typeof window.api.vm.onSyncDone === 'function') {
      window.api.vm.onSyncDone((r) => {
        if (r && r.ok) refreshVmSyncStatus(`自动同步：推 ${r.pushed} / 拉 ${r.pulled}`);
      });
    }
    if (typeof window.api.vm.onSyncWarn === 'function') {
      window.api.vm.onSyncWarn((w) => {
        if (w && w.message) window.showToast?.(w.message, 'warning', 4000);
      });
    }
  }

  function _vmUpdateKindsLabel(p) {
    return { qemu: 'QEMU 运行时', image: '系统镜像', kernel: '内核', initrd: 'initrd' }[p.kind] || p.kind || '';
  }

  async function refreshVmForwards() {
    const el = document.getElementById('vm-forwards');
    if (!el || !window.api.vm.listForwards) return;
    try {
      const r = await window.api.vm.listForwards();
      const list = (r && r.forwards) || [];
      if (!list.length) { el.textContent = '未映射端口'; return; }
      el.innerHTML = list
        .map((f) => `VM :${f.guestPort} → <a href="#" data-host-port="${f.hostPort}" class="vm-fwd-link">http://127.0.0.1:${f.hostPort}</a> <a href="#" data-remove-port="${f.hostPort}" style="color:var(--warning,#b7791f)">解除</a>`)
        .join('<br>');
      el.querySelectorAll('[data-remove-port]').forEach((a) => a.addEventListener('click', async (ev) => {
        ev.preventDefault();
        await window.api.vm.unforwardPort(Number(a.dataset.removePort));
        refreshVmForwards();
      }));
      el.querySelectorAll('[data-host-port]').forEach((a) => a.addEventListener('click', (ev) => {
        ev.preventDefault();
        try { window.api.openExternal?.(a.getAttribute('href')) || window.open(a.getAttribute('href'), '_blank'); } catch (_) { /* ignore */ }
      }));
    } catch { /* ignore */ }
  }

  async function _vmRefreshWhpxButton(accel) {
    const btn = document.getElementById('btn-vm-enable-whpx');
    if (!btn) return;
    const isWin = (navigator.userAgent || '').includes('Windows');
    const unavailable = !accel || !accel.available || (accel.backend && accel.backend === 'tcg');
    btn.hidden = !(isWin && unavailable);
  }

  async function refreshVmDownloadUi() {
    const sel = document.getElementById('vm-dl-mirror');
    if (!sel || sel.dataset.ready === '1' || !window.api.vm.mirrors) return;
    try {
      const r = await window.api.vm.mirrors();
      if (!r || !r.ok) return;
      sel.innerHTML = '';
      for (const m of r.mirrors) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.prefix ? `${m.id}（${m.prefix}）` : 'official（直连）';
        sel.appendChild(opt);
      }
      sel.value = r.current || 'official';
      sel.dataset.ready = '1';
    } catch { /* ignore */ }
  }

  async function refreshVmSettings() {
    if (!window.api.vm || !window.api.runtime) return;
    try {
      const rt = await window.api.runtime.getLocation();
      const locEl = document.getElementById('setting-runtime-location');
      const wsEl = document.getElementById('setting-runtime-workspace-mode');
      if (locEl) locEl.value = (rt && rt.location) || 'host';
      if (wsEl) wsEl.value = (rt && rt.workspaceMode) || 'shared';

      const variants = await window.api.vm.variants();
      const sel = document.getElementById('setting-vm-variant');
      if (sel && variants && variants.ok) {
        const current = sel.value;
        sel.innerHTML = '';
        for (const v of variants.variants) {
          VM_VARIANT_INFO[v.id] = v;
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = `${v.label}（≤${v.limitMB}MB${v.installed ? ' · 已安装' : ''}）`;
          sel.appendChild(opt);
        }
        if (current) sel.value = current;
        _vmUpdateVariantDesc();
      }
      await Promise.all([refreshVmAssetsStatus(), refreshVmRuntimeStatus(), refreshVmSyncStatus(), refreshVmForwards(), refreshVmDownloadUi()]);
      _vmRefreshWhpxButton(null);
    } catch (e) {
      _vmSetText('vm-assets-status', '初始化失败：' + (e.message || e), true);
    }
  }

  function _vmUpdateVariantDesc() {
    const sel = document.getElementById('setting-vm-variant');
    const desc = document.getElementById('vm-variant-desc');
    if (!sel || !desc) return;
    const info = VM_VARIANT_INFO[sel.value];
    desc.textContent = info ? info.desc : '';
  }

  function _vmMarkRestartRequired(text) {
    const row = document.getElementById('runtime-restart-row');
    const hint = document.getElementById('runtime-restart-hint');
    if (hint) hint.textContent = text || '运行位置已变更，需要重启应用后生效。';
    if (row) row.hidden = false;
  }

  document.getElementById('setting-runtime-location')?.addEventListener('change', async (e) => {
    const target = e.target.value;
    window.api.runtime.setLocation(target).then((r) => {
      if (r && r.ok) {
        _vmMarkRestartRequired(target === 'vm'
          ? '已切换到「虚拟机」：重启后终端与命令将在 CIBYP-VM-OS 隔离环境中运行。'
          : '已切换到「本机」：重启后所有命令回到当前系统执行。');
        window.showToast?.('运行位置已保存，重启后生效', 'success', 2500);
      }
    }).catch((err) => window.showToast?.('保存失败：' + (err.message || err), 'error', 3000));
  });

  document.getElementById('setting-runtime-workspace-mode')?.addEventListener('change', async (e) => {
    const target = e.target.value;
    window.api.runtime.setWorkspaceMode(target).then((r) => {
      if (r && r.ok) {
        _vmMarkRestartRequired(target === 'isolated'
          ? '已切换到「独立工作区」：重启后工作区只存在于虚拟机内（导出才回本机），建议先导出/备份。'
          : '已切换到「共享工作区」：重启后工作区以本机为准并与虚拟机双向同步。');
        window.showToast?.('工作区模式已保存，重启后生效', 'success', 2500);
      }
    }).catch((err) => window.showToast?.('保存失败：' + (err.message || err), 'error', 3000));
  });

  document.getElementById('btn-runtime-relaunch')?.addEventListener('click', () => {
    window.api.runtime.relaunch();
  });

  document.getElementById('setting-vm-variant')?.addEventListener('change', async (e) => {
    _vmUpdateVariantDesc();
    const r = await window.api.vm.setVariant(e.target.value);
    if (r && r.ok) {
      window.showToast?.('镜像变体已切换，重启虚拟机后生效', 'success', 2500);
      refreshVmAssetsStatus();
    }
  });

  document.getElementById('btn-vm-download')?.addEventListener('click', async () => {
    if (!window.api.vm) return;
    const variant = (document.getElementById('setting-vm-variant') || {}).value || 'base';
    const wrap = document.getElementById('vm-progress-wrap');
    const bar = document.getElementById('vm-progress-bar');
    const txt = document.getElementById('vm-progress-text');
    if (wrap) wrap.hidden = false;
    const cancelBtn = document.getElementById('btn-vm-cancel-download');
    if (cancelBtn) cancelBtn.hidden = false;
    _vmSetText('vm-assets-status', '正在解析清单…', false);
    try {
      const r = await window.api.vm.download({ variant });
      if (r && r.ok) {
        window.showToast?.(`镜像下载完成（${r.version}）`, 'success', 3000);
        _vmSetText('vm-assets-status', `✅ 已安装：${r.variant} ${r.version}`, false);
      } else {
        _vmSetText('vm-assets-status', '下载失败：' + ((r && r.error) || '未知错误'), true);
      }
    } catch (e) {
      _vmSetText('vm-assets-status', '下载失败：' + (e.message || e), true);
    } finally {
      if (cancelBtn) cancelBtn.hidden = true;
      if (bar) bar.style.width = '0%';
      if (txt) txt.textContent = '';
      setTimeout(() => { if (wrap) wrap.hidden = true; }, 1500);
      refreshVmAssetsStatus();
    }
  });

  document.getElementById('btn-vm-cancel-download')?.addEventListener('click', async () => {
    await window.api.vm.cancelDownload().catch(() => {});
    window.showToast?.('已请求取消下载', 'info', 2000);
  });

  document.getElementById('btn-vm-reset')?.addEventListener('click', async () => {
    const ok = await (typeof window.confirmDialog === 'function'
      ? window.confirmDialog(
        '将把虚拟机恢复到出厂状态（删除实例磁盘）。\n\n共享工作区模式：本机文件不受影响。\n独立工作区模式：虚拟机内的改动会丢失，建议先导出。',
        '重置虚拟机')
      : Promise.resolve(window.confirm('确定重置虚拟机到出厂状态？')));
    if (!ok) return;
    try {
      const r = await window.api.vm.reset();
      if (r && r.ok) window.showToast?.('虚拟机已重置为出厂状态', 'success', 2500);
      else window.showToast?.('重置失败：' + ((r && r.error) || ''), 'error', 3000);
    } catch (e) {
      window.showToast?.('重置失败：' + (e.message || e), 'error', 3000);
    }
    refreshVmRuntimeStatus();
  });

  document.getElementById('btn-vm-open-dir')?.addEventListener('click', () => {
    window.api.vm.openAssetsDir().catch(() => {});
  });

  document.getElementById('btn-vm-choose-dir')?.addEventListener('click', async () => {
    const r = await window.api.vm.chooseAssetsDir();
    if (r && r.ok) {
      window.showToast?.('资源目录已更改：' + r.dir, 'success', 3000);
      refreshVmAssetsStatus();
    }
  });

  document.getElementById('btn-vm-probe')?.addEventListener('click', async () => {
    _vmSetText('vm-probe-status', '自检中…（首次会做真实启动探测，约 5~10 秒）', false);
    try {
      const r = await window.api.vm.probe();
      if (!r || !r.ok) {
        _vmSetText('vm-probe-status', '自检失败：' + ((r && r.error) || '未知错误'), true);
        return;
      }
      const lines = [];
      lines.push(r.qemuVersion ? `QEMU：${r.qemuVersion}` : 'QEMU：未安装（请先下载运行时）');
      if (r.accel) {
        lines.push(r.accel.available
          ? `加速：${r.accel.backend}（${r.accel.detail}）`
          : `加速：不可用 —— ${r.accel.detail}`);
      }
      const installed = (r.variants || []).filter(v => v.status && v.status.installed).map(v => v.id);
      lines.push(`镜像：${installed.length ? installed.join(', ') : '未安装'}`);
      lines.push(`资源目录：${r.assetsDir}`);
      _vmSetText('vm-probe-status', lines.join('　|　'), !(r.accel && r.accel.available));
      _vmRefreshWhpxButton(r.accel);
    } catch (e) {
      _vmSetText('vm-probe-status', '自检失败：' + (e.message || e), true);
    }
  });

  document.getElementById('btn-vm-start')?.addEventListener('click', async () => {
    _vmSetText('vm-runtime-status', '正在启动虚拟机…', false);
    const r = await window.api.vm.start().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) window.showToast?.('启动失败：' + ((r && r.error) || ''), 'error', 4000);
    setTimeout(refreshVmRuntimeStatus, 800);
  });

  document.getElementById('btn-vm-stop')?.addEventListener('click', async () => {
    await window.api.vm.stop().catch(() => {});
    refreshVmRuntimeStatus();
  });

  document.getElementById('btn-vm-enable-whpx')?.addEventListener('click', async () => {
    const ok = typeof window.confirmDialog === 'function'
      ? await window.confirmDialog('将调用 DISM 开启 Windows Hypervisor Platform（需要管理员权限，会弹 UAC）。\n\n若此前未开启，需要重启一次系统才能生效。是否继续？', '开启硬件加速')
      : window.confirm('开启 Windows Hypervisor Platform？需要管理员权限，可能需重启。');
    if (!ok) return;
    _vmSetText('vm-probe-status', '正在申请开启（请在 UAC 弹窗中确认）…', false);
    const r = await window.api.vm.enableWhpx();
    if (r && r.ok) {
      window.showToast?.(r.note || '已申请开启', 'success', 5000);
      _vmSetText('vm-probe-status', '✅ 已申请开启，若刚开启请重启系统后重新自检', false);
    } else {
      _vmSetText('vm-probe-status', '开启失败：' + ((r && r.error) || '未知错误'), true);
    }
  });

  document.getElementById('btn-vm-desktop')?.addEventListener('click', async () => {
    // 先确保 VM 就绪，再开桌面窗口（窗口内部会自动启动 Xvfb/x11vnc）
    const st = await window.api.vm.status().catch(() => null);
    if (!st || !st.inst || st.inst.state !== 'ready') {
      window.showToast?.('请先启动虚拟机，再打开 VM 桌面', 'warning', 3500);
      return;
    }
    await window.api.vm.openDesktop();
  });

  document.getElementById('btn-vm-dl')?.addEventListener('click', async () => {
    const url = (document.getElementById('vm-dl-url') || {}).value || '';
    const dir = (document.getElementById('vm-dl-dir') || {}).value || '/workspace';
    const mirror = (document.getElementById('vm-dl-mirror') || {}).value || 'official';
    const wrap = document.getElementById('vm-dl-progress-wrap');
    const bar = document.getElementById('vm-dl-bar');
    const txt = document.getElementById('vm-dl-progress-text');
    const cancelBtn = document.getElementById('btn-vm-dl-cancel');
    if (!/^https?:\/\//i.test(String(url).trim())) { window.showToast?.('请填写 http(s) 链接', 'warning', 3000); return; }
    if (wrap) wrap.hidden = false;
    if (cancelBtn) cancelBtn.hidden = false;
    _vmSetText('vm-dl-status', '下载中（宿主 aria2 → 推入虚拟机）…', false);
    try {
      const r = await window.api.vm.downloadFile({ url: String(url).trim(), dir, mirror });
      if (r && r.ok) {
        _vmSetText('vm-dl-status', `✅ 已下载到虚拟机：${r.path}（${_fmtBytes(r.size)}）`, false);
        window.showToast?.(`已下载到虚拟机：${r.path}`, 'success', 4000);
      } else {
        _vmSetText('vm-dl-status', '下载失败：' + ((r && r.error) || '未知错误'), true);
      }
    } catch (e) {
      _vmSetText('vm-dl-status', '下载失败：' + (e.message || e), true);
    } finally {
      if (cancelBtn) cancelBtn.hidden = true;
      if (bar) bar.style.width = '0%';
      if (txt) txt.textContent = '';
      setTimeout(() => { if (wrap) wrap.hidden = true; }, 1200);
    }
  });
  document.getElementById('btn-vm-dl-cancel')?.addEventListener('click', async () => {
    await window.api.vm.cancelDownload().catch(() => {});
    window.showToast?.('已请求取消下载', 'info', 2000);
  });

  document.getElementById('btn-vm-forward')?.addEventListener('click', async () => {    const input = document.getElementById('vm-forward-port');
    const port = parseInt((input && input.value) || '', 10);
    if (!port || port < 1 || port > 65535) { window.showToast?.('请填写 1-65535 的端口', 'warning', 3000); return; }
    const r = await window.api.vm.forwardPort(port);
    if (r && r.ok) {
      window.showToast?.(`已映射：VM :${port} → ${r.url}`, 'success', 4000);
      if (input) input.value = '';
    } else {
      window.showToast?.('映射失败：' + ((r && r.error) || '未知错误'), 'error', 4000);
    }
    refreshVmForwards();
  });

  // 下载进度事件（与资源下载页共用同一套事件机制）
  if (window.api.vm && typeof window.api.vm.onProgress === 'function') {
    window.api.vm.onProgress((p) => {
      const bar = document.getElementById('vm-progress-bar');
      const txt = document.getElementById('vm-progress-text');
      if (!p) return;
      const kindLabel = _vmUpdateKindsLabel(p);
      if (p.kind === 'vm-file') {
        const dbar = document.getElementById('vm-dl-bar');
        const dtxt = document.getElementById('vm-dl-progress-text');
        const dwrap = document.getElementById('vm-dl-progress-wrap');
        if (dwrap) dwrap.hidden = false;
        if (dbar && typeof p.percent === 'number') dbar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
        if (dtxt) dtxt.textContent = `${p.filename || ''}${p.percent != null ? ` · ${p.percent}%` : ''}${p.downloaded != null && p.total ? ` · ${_fmtBytes(p.downloaded)} / ${_fmtBytes(p.total)}` : ''}${p.speed ? ` · ${_fmtBytes(p.speed)}/s` : ''}`;
        return;
      }
      if (bar && typeof p.percent === 'number') bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      if (txt) {
        const speed = p.speed ? ` · ${_fmtBytes(p.speed)}/s` : '';
        txt.textContent = `${kindLabel}${p.percent != null ? ` · ${p.percent}%` : ''}` +
          (p.downloaded != null && p.total ? ` · ${_fmtBytes(p.downloaded)} / ${_fmtBytes(p.total)}` : '') + speed;
      }
    });
  }
  if (window.api.vm && typeof window.api.vm.onState === 'function') {
    window.api.vm.onState(() => { refreshVmRuntimeStatus(); });
  }
  if (window.api.vm && typeof window.api.vm.onSerial === 'function') {
    window.api.vm.onSerial(() => { /* 串口日志按需刷新，避免高频重排 */ });
  }

  // 首次渲染 + 打开该标签页时刷新
  if (window.api.vm) {
    _vmBindSyncButtons();
    refreshVmSettings().catch(() => {});
  }
