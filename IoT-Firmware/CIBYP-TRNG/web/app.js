/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const labels = {
    zh: {drawNav:'抽牌空间',historyNav:'抽牌记录',networkNav:'设备与连接',railNote:'留一点时间，听听内心的声音。',title:'从一张牌，开始新的思考。',subtitle:'真实硬件随机，让每一次相遇都独一无二。',question:'此刻，你在想什么？',questionHint:'一个问题，或只是今天的心情（可选）',questionPrivacy:'仅保存在此浏览器，不发送到设备。',spreadLabel:'选择牌阵',drawAction:'开始抽牌',drawing:'正在抽牌…',readyTitle:'为你的问题，留一点空间',footer:'ESP32 硬件随机 · 不重复抽取 · 正逆位独立采样',disclaimer:'牌面是自我探索的灵感，不替代医疗、法律或财务建议。',export:'导出这次记录 ↗',historyPrivacy:'最多保留 50 次，仅存于此浏览器。设备不保存你的问题。',clearHistory:'清空记录',clearConfirm:'删除此设备在当前浏览器的全部抽牌记录？',empty:'还没有抽牌记录。留给下一次相遇吧。',networkIntro:'抽牌可以离线于互联网进行，WebSocket 与 REST 共用同一抽牌核心。',deviceTitle:'当前设备',deviceId:'设备标识',version:'固件',channel:'连接通道',address:'地址',entropyBoundary:'网络抽牌不提供钱包配对或受保护熵源。钱包能力需独立的 USB 安全流程。',wifiTitle:'Wi-Fi 热点设置',wifiHelp:'通过 USB 发送 NETWORK 获取独立热点密码和管理码。保存后手动重启设备，再连接新热点。',admin:'设备管理码',ssid:'热点名称',wifiPassword:'新热点密码',saveNetwork:'保存热点设置',integration:'连接应用',apiHelp:'在 CIBYP 设置中选择网络 TRNG，填写地址和端口 80。开发者也可以使用以下接口：',updateHelp:'升级固件：在 CIBYP 的「IoT 固件」中通过 USB 识别设备、校验镜像并烧录。',connected:'设备已连接',connecting:'正在连接设备',offline:'设备离线',rest:'REST 已连接',reconnect:'重连',upright:'正位',reversed:'逆位',past:'过去',present:'现在',future:'未来',position:'位置',saved:'已保存。请手动重启设备并连接新热点。',failed:'操作未完成，请检查设备连接后再试。',uncertain:'未收到抽牌结果，设备可能已抽取。不会自动重抽，请确认连接后手动操作。',storage:'浏览器无法保存记录，本次结果仍可导出。',adminError:'管理码不正确。请通过 USB 获取 NETWORK 信息。',configError:'名称需 1–32 个 UTF-8 字节，密码需 8–63 个可打印 ASCII 字符。',busy:'设备正在忙，请稍后再试。',rate:'操作太频繁，请稍后再试。',entropy:'硬件熵源不可用，请重启并检查设备。',networkForbidden:'此命令不能通过网络执行。'},
    en: {drawNav:'Reading space',historyNav:'Your readings',networkNav:'Device & connection',railNote:'A little time to listen to yourself.',title:'A new perspective, one card away.',subtitle:'Hardware randomness makes every encounter unique.',question:'What is on your mind?',questionHint:'A question, or just a feeling (optional)',questionPrivacy:'Stays in this browser. Never sent to the device.',spreadLabel:'Choose a spread',drawAction:'Draw cards',drawing:'Drawing…',readyTitle:'Make a little room for your question',footer:'ESP32 hardware randomness · No duplicate cards · Independent orientation',disclaimer:'A spark for reflection, not medical, legal or financial advice.',export:'Export reading ↗',historyPrivacy:'Up to 50 readings, stored only in this browser. Questions never reach the device.',clearHistory:'Clear history',clearConfirm:'Delete all readings for this device in this browser?',empty:'No readings yet. A new encounter awaits.',networkIntro:'No internet required. WebSocket and REST share the same reading core.',deviceTitle:'Your device',deviceId:'Device ID',version:'Firmware',channel:'Connection',address:'Address',entropyBoundary:'Network readings cannot access wallet pairing or protected entropy. Wallet features use a separate USB security flow.',wifiTitle:'Wi-Fi access point',wifiHelp:'Send NETWORK over USB to find the unique Wi-Fi password and admin code. Restart the device manually after saving, then join the new network.',admin:'Device admin code',ssid:'Network name',wifiPassword:'New Wi-Fi password',saveNetwork:'Save network',integration:'Connect your apps',apiHelp:'In CIBYP, select network TRNG, enter this address and port 80. Developer endpoints:',updateHelp:'Firmware updates: identify your device and flash a verified image over USB in CIBYP → IoT firmware.',connected:'Device connected',connecting:'Connecting to device',offline:'Device offline',rest:'REST connected',reconnect:'Reconnect',upright:'Upright',reversed:'Reversed',past:'Past',present:'Present',future:'Future',position:'Position',saved:'Saved. Restart the device manually and join the new network.',failed:'Could not complete this action. Check the connection and try again.',uncertain:'No reading received; the device may have drawn cards. No automatic redraw. Reconnect and draw manually.',storage:'Browser storage is unavailable. You can still export this reading.',adminError:'Incorrect admin code. Read NETWORK over USB.',configError:'Name: 1–32 UTF-8 bytes. Password: 8–63 printable ASCII characters.',busy:'Device is busy. Please try again shortly.',rate:'Too many requests. Please wait a moment.',entropy:'Hardware entropy is unavailable. Restart and check your device.',networkForbidden:'This command cannot run over the network.'},
    de: {drawNav:'Kartenraum',historyNav:'Deine Legungen',networkNav:'Gerät & Verbindung',railNote:'Ein wenig Zeit, um dir selbst zuzuhören.',title:'Eine Karte. Eine neue Perspektive.',subtitle:'Hardware-Zufall macht jede Begegnung einzigartig.',question:'Was beschäftigt dich?',questionHint:'Eine Frage oder ein Gefühl (optional)',questionPrivacy:'Bleibt in diesem Browser. Wird nie an das Gerät gesendet.',spreadLabel:'Legesystem',drawAction:'Karten ziehen',drawing:'Wird gezogen…',readyTitle:'Raum für deine Frage',footer:'ESP32 Hardware-Zufall · Keine Duplikate · Unabhängige Ausrichtung',disclaimer:'Anregung zur Reflexion, keine medizinische, rechtliche oder finanzielle Beratung.',export:'Legung exportieren ↗',historyPrivacy:'Bis zu 50 Legungen, nur in diesem Browser gespeichert. Fragen verlassen den Browser nicht.',clearHistory:'Verlauf löschen',clearConfirm:'Alle Legungen dieses Geräts in diesem Browser löschen?',empty:'Noch keine Legungen. Eine neue Begegnung wartet.',networkIntro:'Kein Internet nötig. WebSocket und REST nutzen denselben Kern.',deviceTitle:'Dein Gerät',deviceId:'Gerätekennung',version:'Firmware',channel:'Verbindung',address:'Adresse',entropyBoundary:'Netzwerkzugriff erlaubt weder Wallet-Kopplung noch geschützte Entropie. Wallet-Funktionen verwenden einen separaten USB-Ablauf.',wifiTitle:'WLAN-Zugangspunkt',wifiHelp:'NETWORK über USB zeigt das individuelle WLAN-Passwort und den Verwaltungscode. Nach dem Speichern das Gerät manuell neu starten und neu verbinden.',admin:'Verwaltungscode',ssid:'Netzwerkname',wifiPassword:'Neues WLAN-Passwort',saveNetwork:'Netzwerk speichern',integration:'Apps verbinden',apiHelp:'In CIBYP Netzwerk-TRNG wählen, diese Adresse und Port 80 eintragen. Entwickler-Endpunkte:',updateHelp:'Firmware über USB aktualisieren: CIBYP → IoT-Firmware → Gerät erkennen und geprüftes Image schreiben.',connected:'Gerät verbunden',connecting:'Verbindung wird aufgebaut',offline:'Gerät offline',rest:'REST verbunden',reconnect:'Verbinden',upright:'Aufrecht',reversed:'Umgekehrt',past:'Vergangenheit',present:'Gegenwart',future:'Zukunft',position:'Position',saved:'Gespeichert. Gerät manuell neu starten und neues WLAN verbinden.',failed:'Aktion fehlgeschlagen. Verbindung prüfen und erneut versuchen.',uncertain:'Kein Ergebnis erhalten; möglicherweise wurden Karten gezogen. Keine automatische Wiederholung. Manuell erneut verbinden.',storage:'Browser-Speicher nicht verfügbar. Export ist weiterhin möglich.',adminError:'Verwaltungscode falsch. NETWORK über USB abfragen.',configError:'Name: 1–32 UTF-8-Bytes. Passwort: 8–63 druckbare ASCII-Zeichen.',busy:'Gerät beschäftigt. Bitte kurz warten.',rate:'Zu viele Anfragen. Bitte kurz warten.',entropy:'Hardware-Entropie nicht verfügbar. Gerät neu starten und prüfen.',networkForbidden:'Dieser Befehl ist im Netzwerk gesperrt.'},
  };
  Object.assign(labels.zh, {setupTitle:'先为你的设备，设置一把钥匙。',setupIntro:'欢迎。首次连接不需要密码，请先设置自己的 Wi-Fi 密码，再开始抽牌。',setupPrivate:'设置完成前，仅开放初始化页面，抽牌和随机数服务均已锁定。',firstUse:'首次设置',confirmPassword:'再次输入密码',passwordHelp:'8–63 个英文字母、数字或符号。请保存好密码，之后也用它管理热点设置。',setupAction:'保存并启用设备 →',passwordMismatch:'两次输入的密码不一致。',setupSaved:'已保存，设备即将重启。请使用刚设置的密码连接新热点，然后刷新此页面。',admin:'当前热点密码或管理码',adminError:'密码不正确。请使用当前热点密码，或通过 USB 获取管理码。',wifiHelp:'使用当前热点密码即可管理设置。保存后手动重启设备，再连接新热点。也可通过 USB 发送 NETWORK 获取连接信息。'});
  Object.assign(labels.en, {setupTitle:'A key to your own little space.',setupIntro:'Welcome. Your first connection needs no password. Set your own Wi-Fi password before drawing cards.',setupPrivate:'Only initial setup is available. Readings and random data stay locked until setup is complete.',firstUse:'FIRST-TIME SETUP',confirmPassword:'Confirm password',passwordHelp:'8–63 ASCII letters, numbers or symbols. Keep this password: it also manages your network settings.',setupAction:'Save & activate device →',passwordMismatch:'The passwords do not match.',setupSaved:'Saved. The device will restart. Join the new Wi-Fi with your chosen password, then refresh this page.',admin:'Current Wi-Fi password or admin code',adminError:'Incorrect password. Use the current Wi-Fi password or read the admin code over USB.',wifiHelp:'Use your current Wi-Fi password to manage settings. Restart manually after saving, then join the new network. NETWORK over USB also shows connection details.'});
  Object.assign(labels.de, {setupTitle:'Ein Schlüssel für deinen eigenen Raum.',setupIntro:'Willkommen. Die erste Verbindung benötigt kein Passwort. Lege vor der ersten Legung dein WLAN-Passwort fest.',setupPrivate:'Nur die Ersteinrichtung ist verfügbar. Legungen und Zufallsdaten bleiben bis zum Abschluss gesperrt.',firstUse:'ERSTE EINRICHTUNG',confirmPassword:'Passwort bestätigen',passwordHelp:'8–63 ASCII-Buchstaben, Ziffern oder Zeichen. Passwort aufbewahren: Es verwaltet auch die Netzwerkeinstellungen.',setupAction:'Speichern & Gerät aktivieren →',passwordMismatch:'Die Passwörter stimmen nicht überein.',setupSaved:'Gespeichert. Das Gerät startet neu. Mit dem gewählten Passwort neu verbinden und die Seite aktualisieren.',admin:'Aktuelles WLAN-Passwort oder Verwaltungscode',adminError:'Passwort falsch. Aktuelles WLAN-Passwort oder Verwaltungscode über USB verwenden.',wifiHelp:'Das aktuelle WLAN-Passwort verwaltet die Einstellungen. Nach dem Speichern manuell neu starten und verbinden. NETWORK über USB zeigt ebenfalls die Verbindungsdaten.'});
  Object.assign(labels.zh,{questionPrivacy:'原文留在此浏览器，仅将随机加盐的摘要发送给设备参与抽牌。',historyPrivacy:'最多保留 50 次，仅存于此浏览器。设备只接收问题摘要，不保存问题原文。',footerMixed:'ESP32 硬件随机 × 问题摘要 · HKDF 混合 · 不重复抽取'});
  Object.assign(labels.en,{questionPrivacy:'Text stays in this browser. Only a randomly salted digest joins the hardware draw.',historyPrivacy:'Up to 50 readings in this browser. The device receives only a question digest, never the original text.',footerMixed:'ESP32 hardware randomness × question digest · HKDF mixing · No duplicate cards'});
  Object.assign(labels.de,{questionPrivacy:'Der Text bleibt im Browser. Nur ein zufällig gesalzener Hash fließt in die Hardware-Ziehung ein.',historyPrivacy:'Bis zu 50 Legungen im Browser. Das Gerät erhält nur einen Fragen-Hash, niemals den Originaltext.',footerMixed:'ESP32 Hardware-Zufall × Fragen-Hash · HKDF-Mischung · Keine Duplikate'});
  const spreads = [
    ['single',1,'单张牌','Single card','Einzelkarte'],['three',3,'过去 · 现在 · 未来','Past · Present · Future','Vergangenheit · Gegenwart · Zukunft'],['celtic',10,'凯尔特十字','Celtic cross','Keltisches Kreuz'],['horseshoe',7,'马蹄牌阵','Horseshoe','Hufeisen'],['star',5,'五芒星牌阵','Five-point star','Fünfstern'],['hexagram',7,'六芒星牌阵','Hexagram','Hexagramm'],['zodiac',12,'黄道十二宫','Zodiac','Tierkreis'],['yes_no',1,'是非牌','Yes / No','Ja / Nein'],['relationship',5,'关系牌阵','Relationship','Beziehung'],
  ];
  const readStorage = (key, fallback) => {try {return localStorage.getItem(key) ?? fallback;} catch {return fallback;}};
  let language = readStorage('tarot-language',navigator.language.startsWith('zh')?'zh':navigator.language.startsWith('de')?'de':'en');
  if (!labels[language]) language='en';
  let theme=readStorage('tarot-theme','auto'), view='draw', socket=null, reconnectTimer, heartbeatTimer, attempts=0, pending=null;
  let device=null, catalog=[], deck=null, history=[], current=null, busy=false, online=false, connectionState='connecting', fallback=false, stopped=false;
  const text = key => labels[language][key] || labels.en[key] || key;
  const node = (tag,cls,value) => {const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;};
  const artPaths={
    star:'M40 9 48 32 71 40 48 48 40 71 32 48 9 40 32 32Z',
    history:'M18 24A28 28 0 1 1 12 40M18 11V24H5M40 22V40L53 48',
    network:'M12 31Q40 7 68 31M22 42Q40 26 58 42M33 53Q40 47 47 53M40 63h0',
    swords:'M40 6 46 17 43 49 52 58M28 58 37 49 34 17ZM26 50 54 50M40 53V72',
    cups:'M23 15H57V31Q57 49 40 49Q23 49 23 31ZM40 49V65M27 67H53M23 22H14V29Q14 38 25 38M57 22H66V29Q66 38 55 38',
    pentacles:'M40 14 47 33 67 33 51 45 57 65 40 53 23 65 29 45 13 33 33 33ZM40 8A32 32 0 1 1 39.99 8',
    wands:'M25 64 55 16M41 37 59 33M33 49 17 45M47 27 45 13M25 64 21 72',
    sun:'M40 21A19 19 0 1 1 39.99 21M40 4V12M40 68V76M4 40H12M68 40H76M14 14 20 20M60 60 66 66M14 66 20 60M60 20 66 14',
    moon:'M49 10A30 30 0 1 0 68 56A29 29 0 0 1 49 10Z',
  };
  function art(kind='star') {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 80 80');svg.setAttribute('aria-hidden','true');const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',artPaths[kind]||artPaths.star);svg.append(path);return svg;}
  const formatTime = time => new Date(time).toLocaleString(language==='zh'?'zh-CN':language==='de'?'de-DE':'en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  const spread = id => spreads.find(item=>item[0]===id) || spreads[0];
  const spreadName = id => spread(id)[language==='zh'?2:language==='de'?4:3];
  const notify = message => {$('notice').textContent=message;$('notice').hidden=!message;};
  const errors = {DEVICE_BUSY:'busy',RATE_LIMIT:'rate',ENTROPY_UNAVAILABLE:'entropy',NETWORK_COMMAND_FORBIDDEN:'networkForbidden',NETWORK_CONFIG_REJECTED:'configError',ADMIN_REQUIRED:'adminError'};
  const check = result => {if(result?.error)throw Error(text(errors[result.error]||'failed'));return result;};
  async function request(url, options={}) {
    const response=await fetch(url,{...options,signal:AbortSignal.timeout(6000),cache:'no-store',credentials:'omit'});
    const result=await response.json();check(result);if(!response.ok)throw Error(text('failed'));return result;
  }
  function updateConnection(state) {
    connectionState=state;online=state==='connected'||state==='rest';
    $('connection-label').textContent=text(state);$('connection-dot').classList.toggle('online',online);
    $('reconnect').hidden=online||state==='connecting';$('channel').textContent=state==='connected'?'WebSocket':state==='rest'?'REST':'—';updateButton();
  }
  function updateButton() {$('draw').disabled=busy||!online||catalog.length!==78||!!device?.setupRequired;$('draw-label').textContent=text(busy?'drawing':'drawAction');}
  function setDevice(info) {
    if(typeof info?.deviceId!=='string'||!/^[a-f0-9]{12}$/.test(info.deviceId))throw Error(text('failed'));
    if(!device||device.deviceId!==info.deviceId) {
      device=info;current=null;
      try {const parsed=JSON.parse(readStorage('tarot-history-'+info.deviceId,'[]'));history=Array.isArray(parsed)?parsed.filter(validReading).slice(0,50):[];} catch {history=[];}
      renderCards();renderHistory();
    }
    document.body.classList.toggle('setup-mode',!!info.setupRequired);$('setup').hidden=!info.setupRequired;
    if(info.setupRequired&&!$('setup-ssid').value)$('setup-ssid').value='CIBYP-Tarot-'+info.deviceId.slice(-6);
    $('device-id').textContent=info.deviceId;$('firmware').textContent=String(info.firmware||'—');
  }
  function validCards(cards) {return Array.isArray(cards)&&cards.length>0&&cards.length<=12&&cards.every(c=>Number.isInteger(c?.cardIndex)&&c.cardIndex>=0&&c.cardIndex<78&&typeof c.isReversed==='boolean')&&new Set(cards.map(c=>c.cardIndex)).size===cards.length;}
  function validReading(r) {return r&&typeof r.question==='string'&&r.question.length<=200&&Number.isFinite(r.time)&&spreads.some(s=>s[0]===r.spread)&&validCards(r.cards)&&r.cards.length===spread(r.spread)[1];}
  function ask(command) {
    return new Promise((resolve,reject)=>{
      if(!socket||socket.readyState!==WebSocket.OPEN||pending)return reject(Error(text('busy')));
      const timer=setTimeout(()=>{pending=null;reject(Error(text('uncertain')));socket?.close();},6000);
      pending={resolve,reject,timer};
      try {socket.send(command);}catch(error){clearTimeout(timer);pending=null;reject(error);}
    });
  }
  function connect() {
    clearTimeout(reconnectTimer);clearInterval(heartbeatTimer);
    if(stopped||document.hidden||navigator.onLine===false)return;
    if(socket && socket.readyState<2)return;
    updateConnection(fallback?'rest':'connecting');
    const ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws');socket=ws;
    ws.onopen=async()=>{
      try {setDevice(check(await ask('INFO')));attempts=0;fallback=false;updateConnection('connected');
        heartbeatTimer=setInterval(()=>{if(!pending&&!busy)ask('PING').catch(()=>ws.close());},20000);
      } catch {ws.close();}
    };
    ws.onmessage=event=>{
      if(typeof event.data!=='string'||event.data.length>8192) {ws.close();return;}
      // A reply belongs only to the current single in-flight command. Never
      // replay a draw automatically after reconnecting or a timed-out response.
      if(!pending)return;const wait=pending;pending=null;clearTimeout(wait.timer);
      try{wait.resolve(check(JSON.parse(event.data)));}catch(error){wait.reject(error);}
    };
    ws.onerror=()=>ws.close();
    ws.onclose=()=>{
      if(socket!==ws)return;socket=null;clearInterval(heartbeatTimer);
      if(pending){clearTimeout(pending.timer);pending.reject(Error(text('uncertain')));pending=null;}
      if(stopped)return;
      updateConnection(fallback?'rest':'offline');
      if(!document.hidden){
        // Read-only discovery can safely fall back to REST. A failed draw is
        // never retried by this fallback path.
        request('/api/info').then(info=>{if(stopped||document.hidden)return;if(!socket||socket.readyState!==WebSocket.OPEN){setDevice(info);fallback=true;updateConnection('rest');}}).catch(()=>{fallback=false;updateConnection('offline');});
        const delay=Math.min(30000,1000*2**Math.min(attempts++,5))*(.85+Math.random()*.3);
        reconnectTimer=setTimeout(connect,delay);
      }
    };
  }
  function showView(next) {view=next;for(const id of ['draw','history','network'])$('view-'+id).hidden=id!==next;document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===next;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});$('page-title').textContent=text(next+'Nav');}
  function placeholder() {
    const wrap=node('div','card-wrap');wrap.append(node('div','position','✧'));
    const face=node('div','tarot-card card-placeholder'),drawing=node('div','card-art');drawing.append(art());face.append(drawing,node('div','placeholder-label','CIBYP · TAROT'));wrap.append(face);return wrap;
  }
  function renderCards(animate=false) {
    const target=$('cards');target.replaceChildren();document.querySelector('[data-i=footer]').textContent=text(current?.questionMixed?'footerMixed':'footer');target.classList.toggle('reveal',animate);
    $('export').hidden=!current;$('reading-time').textContent=current?formatTime(current.time):'';
    $('reading-label').textContent=current?(current.question||spreadName(current.spread)):text('readyTitle');
    if(!current){for(let i=0;i<3;i++)target.append(placeholder());return;}
    current.cards.forEach((draw,index)=>{
      const card=catalog[draw.cardIndex];if(!card)return;
      const wrap=node('article','card-wrap');
      wrap.append(node('div','position',current.spread==='three'?text(['past','present','future'][index]):current.cards.length>1?text('position')+' '+(index+1):spreadName(current.spread)));
      const face=node('div','tarot-card has-art'+(draw.isReversed?' reverse':''));
      const picture=node('img','card-illustration');picture.alt=language==='zh'?card.name:card.nameEn;picture.width=224;picture.height=336;picture.decoding='async';picture.loading=index<3?'eager':'lazy';
      const artEntry=deck?.images.find(entry=>entry.id===card.id);
      picture.onerror=()=>{picture.hidden=true;face.classList.add('art-unavailable');};
      if(artEntry){picture.src='/cards/'+String(card.id).padStart(2,'0')+'.webp?v='+encodeURIComponent(deck?.deckId||'pending');face.append(picture);}else face.classList.add('art-unavailable');
      const name=node('div','card-name');name.append(node('strong','',language==='zh'?card.name:card.nameEn),node('small','',language==='zh'?card.nameEn:card.name));
      wrap.append(face,name,node('span','card-orientation',(draw.isReversed?'↓ ':'↑ ')+text(draw.isReversed?'reversed':'upright')),
        node('p','meaning',language==='zh'?(draw.isReversed?card.meaningOfReversed:card.meaningOfUpright):card.nameEn+' · '+text(draw.isReversed?'reversed':'upright')));
      target.append(wrap);
    });
  }
  function renderHistory() {
    $('history-count').textContent=String(history.length);const list=$('history-list');list.replaceChildren();
    if(!history.length){list.append(node('div','empty',text('empty')));return;}
    for(const reading of history) {
      const row=node('button','history-item');row.type='button';const detail=node('span');detail.append(node('strong','',reading.question||spreadName(reading.spread)),node('small','',spreadName(reading.spread)+' · '+formatTime(reading.time)));
      row.append(node('span','history-icon','✦'),detail,node('span','','↗'));row.onclick=()=>{current=reading;showView('draw');renderCards();notify('');};list.append(row);
    }
  }
  function applyTheme() {document.documentElement.dataset.theme=theme==='auto'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):theme;}
  function translate() {
    document.documentElement.lang=language==='zh'?'zh-CN':language;$('language').value=language;
    document.querySelectorAll('[data-i]').forEach(item=>item.textContent=text(item.dataset.i));document.querySelectorAll('[data-placeholder]').forEach(item=>item.placeholder=text(item.dataset.placeholder));
    const selected=$('spread').value||'three';$('spread').replaceChildren(...spreads.map(s=>{const option=node('option','',spreadName(s[0]));option.value=s[0];return option;}));$('spread').value=selected;
    showView(view);updateConnection(connectionState);renderCards();renderHistory();
  }
  $('draw-form').onsubmit=async event=>{
    event.preventDefault();if(busy||!online||catalog.length!==78)return;
    const type=$('spread').value;busy=true;updateButton();notify('');
    try {
      const question=$('question').value.trim();
      const digest=question?globalThis.CibypTarotQuestionDigest(question):null;
      const wire=digest?'SPREAD2 '+type+' '+digest:'SPREAD:'+type;
      const result=fallback?(digest?await request('/api/spread',{method:'POST',headers:{'Content-Type':'text/plain'},body:wire}):await request('/api/spread?type='+encodeURIComponent(type))):await ask(wire);
      if(question&&result.questionMixed!==true)throw Error(text('failed'));
      if(!validCards(result.cards)||result.cards.length!==spread(type)[1])throw Error(text('failed'));
      current={question,questionMixed:!!digest,spread:type,time:Date.now(),cards:result.cards.map(({cardIndex,isReversed})=>({cardIndex,isReversed}))};
      history.unshift(current);history=history.slice(0,50);
      try{localStorage.setItem('tarot-history-'+device.deviceId,JSON.stringify(history));}catch{notify(text('storage'));}
      renderCards(true);renderHistory();
    }catch(error){notify(error.message||text('uncertain'));}finally{busy=false;updateButton();}
  };
  $('setup-form').onsubmit=async event=>{
    event.preventDefault();const button=$('setup-submit');button.disabled=true;
    const name=new TextEncoder().encode($('setup-ssid').value.trim()),password=$('setup-password').value;
    try {
      if(password!==$('setup-confirm').value)throw Error(text('passwordMismatch'));
      if(!name.length||name.length>32||password.length<8||password.length>63||!/^[\x20-\x7e]+$/.test(password))throw Error(text('configError'));
      const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      await request('/api/config',{method:'POST',headers:{'X-CIBYP-Setup':'1','Content-Type':'text/plain'},body:'NETCFG '+hex(name)+' '+hex(new TextEncoder().encode(password))});
      $('setup-status').textContent=text('setupSaved');$('setup-password').value='';$('setup-confirm').value='';
      stopped=true;clearTimeout(reconnectTimer);clearInterval(heartbeatTimer);socket?.close();
    }catch(error){$('setup-status').textContent=error.message||text('failed');button.disabled=false;}
  };
  $('network-form').onsubmit=async event=>{
    event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;
    const name=new TextEncoder().encode($('ssid').value.trim()),password=$('wifi-password').value,token=$('admin').value;
    try {
      if(!name.length||name.length>32||password.length<8||password.length>63||!/^[\x20-\x7e]+$/.test(password))throw Error(text('configError'));
      const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      await request('/api/config',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'text/plain'},body:'NETCFG '+hex(name)+' '+hex(new TextEncoder().encode(password))});
      $('network-status').textContent=text('saved');
    }catch(error){$('network-status').textContent=error.message||text('failed');}finally{$('admin').value='';$('wifi-password').value='';button.disabled=false;}
  };
  $('export').onclick=()=>{if(!current)return;const blob=new Blob([JSON.stringify({...current,deviceId:device?.deviceId},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download='tarot-'+new Date(current.time).toISOString().replace(/[:.]/g,'-')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  $('clear-history').onclick=()=>{if(!history.length||!window.confirm(text('clearConfirm')))return;history=[];try{localStorage.removeItem('tarot-history-'+device.deviceId);}catch{}renderHistory();};
  $('language').onchange=()=>{language=$('language').value;try{localStorage.setItem('tarot-language',language);}catch{}translate();};
  $('theme').onclick=()=>{theme=document.documentElement.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('tarot-theme',theme);}catch{}applyTheme();};
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(theme==='auto')applyTheme();});
  document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>showView(button.dataset.view));
  $('reconnect').onclick=()=>{attempts=0;connect();};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(reconnectTimer);clearInterval(heartbeatTimer);socket?.close();}else connect();});
  window.addEventListener('pageshow',event=>{if(event.persisted){stopped=false;connect();}});
  window.addEventListener('online',connect);window.addEventListener('offline',()=>{fallback=false;socket?.close();updateConnection('offline');});
  window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(reconnectTimer);clearInterval(heartbeatTimer);socket?.close();});
  for(const [selector,kind] of [['[data-view=draw]>span:first-child','star'],['[data-view=history]>span:first-child','history'],['[data-view=network]>span:first-child','network'],['#draw>span:first-child','star'],['.tiny-star','star']])document.querySelector(selector)?.replaceChildren(art(kind));
  applyTheme();translate();
  Promise.all([request('/catalog.json'),request('/deck.json')]).then(([value,art])=>{if(!Array.isArray(value)||value.length!==78||!Array.isArray(art.images))throw Error('catalog');catalog=value;deck=art;renderCards();updateButton();}).catch(()=>notify(text('failed')));
  connect();
})();
