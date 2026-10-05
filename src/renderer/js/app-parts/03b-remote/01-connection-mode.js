  // Remote renders the same local components, with their API routed to the
  // remote backend. Legacy mirror special cases stay disabled.
  var isRemoteMode = false;
  const remoteWs = null;
  const remoteAvatars = null;
  let remoteBaseUrl = '';
  const remoteText = value => t('ui.remote.' + value, value);
  async function setConnectionMode(mode) {
    if (mode === 'remote') { document.getElementById('remote-connect-modal').classList.remove('hidden'); return; }
    await window.api.backendRemoteDisconnect(); location.reload();
  }
  function setRemoteBanner(state, message) {
    const banner=document.getElementById('remote-conn-banner');
    if (!banner) return;
    banner.dataset.state=state; banner.classList.remove('hidden');
    const text=banner.querySelector('.remote-conn-text');
    if(text) text.textContent=message || remoteBaseUrl;
  }
  function setRemoteBadge(url) {
    const badge=document.getElementById('remote-addr-badge');
    if(badge) { badge.textContent=url; badge.classList.toggle('hidden', !url); }
    document.getElementById('conn-btn-local')?.classList.toggle('active', !url);
    document.getElementById('conn-btn-remote')?.classList.toggle('active', !!url);
  }
  async function connectRemote(url,password,code) {
    const button=document.getElementById('btn-remote-connect');
    const status=document.getElementById('remote-status');
    button.disabled=true; status.textContent=remoteText('正在连接远程后台…');
    try {
      if(location.protocol !== 'file:') { location.assign(new URL(url).origin); return; }
      const result=await window.api.backendRemoteConnect({url,password,code});
      if(!result.ok)throw new Error(result.error);
      location.reload();
    } catch(error) { status.textContent=error.message; }
    finally { button.disabled=false; }
  }
  document.getElementById('conn-btn-local')?.addEventListener('click',()=>setConnectionMode('local'));
  document.getElementById('conn-btn-remote')?.addEventListener('click',()=>setConnectionMode('remote'));
  document.getElementById('btn-remote-cancel')?.addEventListener('click',()=>fadeOutHide(document.getElementById('remote-connect-modal')));
  document.getElementById('btn-remote-connect')?.addEventListener('click',()=>{
    let url=document.getElementById('remote-url').value.trim();
    if(!/^https?:\/\//i.test(url))url='http://'+url;
    connectRemote(url,document.getElementById('remote-password').value,document.getElementById('remote-totp').value);
  });
  document.querySelector('#remote-conn-banner .remote-conn-dismiss')?.addEventListener('click',()=>document.getElementById('remote-conn-banner').classList.add('hidden'));
  const remoteState=await window.api.backendRemoteStatus();
  if(remoteState?.connected) { remoteBaseUrl=remoteState.url;setRemoteBadge(remoteBaseUrl); }
  window.api.onBackendConnection?.(state=>setRemoteBanner(state.connected?'connected':'reconnecting',remoteText(state.connected?'已连接远程后台':'连接中断，正在重连…')));
