  // ---- 关闭时询问"后台运行"模态框（Tray Mode）----
  const trayAskModal = document.getElementById('tray-ask-modal');
  function _showTrayAskModal() {
    if (!trayAskModal) return;
    trayAskModal.classList.remove('hidden');
    WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
  }
  function _closeTrayAskModal() {
    if (!trayAskModal) return;
    fadeOutHide(trayAskModal, () => {
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#tray-ask-modal', attr: 'class', value: trayAskModal.className });
    });
  }
  function _respondTrayAsk(decision) {
    _closeTrayAskModal();
    try { window.api.trayRespondCloseDecision(decision); } catch {}
  }
  const _btnTrayNever = document.getElementById('btn-tray-never');
  const _btnTrayOnce = document.getElementById('btn-tray-once');
  const _btnTrayAlways = document.getElementById('btn-tray-always');
  const _btnTrayCancel = document.getElementById('btn-tray-cancel');
  if (_btnTrayNever) _btnTrayNever.addEventListener('click', () => _respondTrayAsk('never'));
  if (_btnTrayOnce) _btnTrayOnce.addEventListener('click', () => _respondTrayAsk('once'));
  if (_btnTrayAlways) _btnTrayAlways.addEventListener('click', () => _respondTrayAsk('always'));
  if (_btnTrayCancel) _btnTrayCancel.addEventListener('click', () => _respondTrayAsk('cancel'));
  // 监听主进程的询问事件
  try {
    window.api.onTrayAskCloseDecision(() => _showTrayAskModal());
  } catch {}
