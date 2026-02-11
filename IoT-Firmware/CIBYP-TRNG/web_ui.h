/*
 * WebUI HTML for CIBYP-IoT-TRNG
 * Beautiful responsive single-page interface
 */

#ifndef WEB_UI_H
#define WEB_UI_H

String getWebUIHTML() {
  return R"rawliteral(
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CIBYP IoT TRNG</title>
  <style>
    :root {
      --accent: #f7c731;
      --accent-dark: #d4a800;
      --bg: #0f0f1a;
      --bg2: #1a1a2e;
      --bg3: #252540;
      --text: #e8e8f0;
      --text2: #9999bb;
      --border: #333355;
      --success: #20bf6b;
      --danger: #eb3b5a;
      --radius: 12px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, var(--bg2) 0%, var(--bg3) 100%);
      border-bottom: 2px solid var(--accent);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header h1 {
      font-size: 20px;
      background: linear-gradient(135deg, var(--accent), #ffe08a);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: 1px;
    }
    .header .chip-info {
      font-size: 11px;
      color: var(--text2);
      background: var(--bg);
      padding: 4px 10px;
      border-radius: 20px;
    }
    .tabs {
      display: flex;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }
    .tab {
      padding: 12px 20px;
      cursor: pointer;
      color: var(--text2);
      font-size: 13px;
      font-weight: 600;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .tab.active { color: var(--accent); border-color: var(--accent); }
    .tab:hover { color: var(--text); background: var(--bg3); }
    .content { padding: 20px; max-width: 900px; margin: 0 auto; }
    .panel { display: none; }
    .panel.active { display: block; }
    .card {
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
      margin-bottom: 16px;
    }
    .card h3 { margin-bottom: 12px; font-size: 16px; }
    .spread-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .spread-btn {
      padding: 16px;
      background: var(--bg3);
      border: 2px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      text-align: center;
      transition: all 0.2s;
    }
    .spread-btn:hover { border-color: var(--accent); background: rgba(247,199,49,0.08); }
    .spread-btn.active { border-color: var(--accent); background: rgba(247,199,49,0.15); color: var(--accent); }
    .spread-btn small { display: block; font-size: 11px; color: var(--text2); margin-top: 4px; font-weight: 400; }
    .draw-btn {
      display: block;
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-dark));
      border: none;
      border-radius: var(--radius);
      color: #1a1000;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: 1px;
      transition: all 0.3s;
      box-shadow: 0 4px 20px rgba(247,199,49,0.3);
    }
    .draw-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 30px rgba(247,199,49,0.5); }
    .draw-btn:active { transform: translateY(0); }
    .results { margin-top: 20px; }
    .tarot-card {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      margin-bottom: 12px;
      position: relative;
      overflow: hidden;
    }
    .tarot-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--accent), transparent);
    }
    .tarot-card.reversed::before {
      background: linear-gradient(90deg, var(--danger), transparent);
    }
    .tarot-card .name {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .tarot-card .name-en { font-size: 12px; color: var(--text2); margin-bottom: 8px; }
    .orientation-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .orientation-badge.upright { background: rgba(32,191,107,0.2); color: var(--success); }
    .orientation-badge.reversed { background: rgba(235,59,90,0.2); color: var(--danger); }
    .meaning { font-size: 13px; color: var(--text2); line-height: 1.6; }
    .meaning strong { color: var(--text); }
    .meaning.secondary { opacity: 0.85; margin-top: 4px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; color: var(--text2); margin-bottom: 6px; }
    input[type="text"], input[type="password"], input[type="number"] {
      width: 100%;
      padding: 10px 14px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-primary { background: var(--accent); color: #1a1000; }
    .btn-primary:hover { background: #ffe066; }
    .btn-danger { background: var(--danger); color: white; }
    .btn-danger:hover { background: #d63050; }
    .btn-secondary { background: var(--bg3); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    .status-msg { padding: 10px; border-radius: 8px; margin-top: 12px; font-size: 13px; }
    .status-msg.success { background: rgba(32,191,107,0.15); color: var(--success); }
    .status-msg.error { background: rgba(235,59,90,0.15); color: var(--danger); }
    .analysis { margin-top: 16px; padding: 16px; background: var(--bg); border-radius: var(--radius); border: 1px solid var(--border); }
    .analysis h4 { color: var(--accent); margin-bottom: 8px; }
    .analysis p { font-size: 13px; line-height: 1.8; color: var(--text2); }
    .spread-label { font-size: 11px; color: var(--accent); font-weight: 600; margin-bottom: 4px; }
    .ota-drop {
      border: 2px dashed var(--border);
      border-radius: var(--radius);
      padding: 40px;
      text-align: center;
      color: var(--text2);
      cursor: pointer;
      transition: all 0.2s;
    }
    .ota-drop:hover, .ota-drop.drag-over { border-color: var(--accent); color: var(--accent); }
    .progress-bar { height: 6px; background: var(--bg); border-radius: 3px; overflow: hidden; margin-top: 12px; }
    .progress-bar .fill { height: 100%; background: var(--accent); transition: width 0.3s; width: 0%; }
    .entropy-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 10px;
      background: linear-gradient(135deg, #f7c731, #e6a800);
      color: #4a3000;
      font-size: 11px;
      font-weight: 700;
      margin-bottom: 12px;
      box-shadow: 0 2px 8px rgba(247,199,49,0.4);
    }
    @media (max-width: 600px) {
      .spread-grid { grid-template-columns: repeat(2, 1fr); }
      .content { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>CIBYP IoT TRNG</h1>
    <span class="chip-info" id="chip-info">ESP32</span>
  </div>
  <div class="tabs">
    <div class="tab active" data-tab="draw">抽牌</div>
    <div class="tab" data-tab="config">AP 设置</div>
    <div class="tab" data-tab="ota">OTA 更新</div>
    <div class="tab" data-tab="about">设备信息</div>
  </div>
  <div class="content">
    <!-- Draw Tab -->
    <div class="panel active" data-tab="draw">
      <div class="card">
        <h3>选择牌阵</h3>
        <div class="spread-grid">
          <div class="spread-btn active" data-type="single">单牌<small>1张</small></div>
          <div class="spread-btn" data-type="three">三张牌阵<small>过去/现在/未来</small></div>
          <div class="spread-btn" data-type="yes_no">是非牌<small>1张</small></div>
          <div class="spread-btn" data-type="star">五芒星<small>5张</small></div>
          <div class="spread-btn" data-type="horseshoe">马蹄牌阵<small>7张</small></div>
          <div class="spread-btn" data-type="hexagram">六芒星<small>7张</small></div>
          <div class="spread-btn" data-type="celtic">凯尔特十字<small>10张</small></div>
          <div class="spread-btn" data-type="relationship">关系牌阵<small>5张</small></div>
          <div class="spread-btn" data-type="zodiac">黄道十二宫<small>12张</small></div>
        </div>
        <button class="draw-btn" id="btn-draw" onclick="doDraw()">抽牌</button>
      </div>
      <div class="results" id="results"></div>
    </div>
    <!-- Config Tab -->
    <div class="panel" data-tab="config">
      <div class="card">
        <h3>WiFi AP 设置</h3>
        <div class="form-group">
          <label>SSID</label>
          <input type="text" id="cfg-ssid" placeholder="CIBYP-IoT-TRNG">
        </div>
        <div class="form-group">
          <label>密码 (留空为开放网络)</label>
          <input type="password" id="cfg-pass" placeholder="">
        </div>
        <button class="btn btn-primary" onclick="saveConfig()">保存并重启</button>
        <div id="cfg-status"></div>
      </div>
    </div>
    <!-- OTA Tab -->
    <div class="panel" data-tab="ota">
      <div class="card">
        <h3>固件 OTA 更新</h3>
        <p style="color:var(--text2);font-size:13px;margin-bottom:16px;">上传 .bin 固件文件进行在线更新。更新过程中请勿断电。</p>
        <div class="ota-drop" id="ota-drop" onclick="document.getElementById('ota-file').click()">
          点击或拖拽固件文件到此处
          <input type="file" id="ota-file" style="display:none" accept=".bin" onchange="uploadOTA()">
        </div>
        <div class="progress-bar" id="ota-progress" style="display:none"><div class="fill" id="ota-fill"></div></div>
        <div id="ota-status"></div>
      </div>
    </div>
    <!-- About Tab -->
    <div class="panel" data-tab="about">
      <div class="card">
        <h3>设备信息</h3>
        <div id="device-info" style="font-size:13px;line-height:2;color:var(--text2)">加载中...</div>
      </div>
    </div>
  </div>

  <script>
    // Tab switching
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        document.querySelector('.panel[data-tab="'+t.dataset.tab+'"]').classList.add('active');
        if (t.dataset.tab==='about') loadDeviceInfo();
        if (t.dataset.tab==='config') loadConfig();
      });
    });

    // Spread selection
    let selectedSpread = 'single';
    document.querySelectorAll('.spread-btn').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.spread-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        selectedSpread = b.dataset.type;
      });
    });

    // Position labels for spreads
    const posLabels = {
      single: ['当前指引'],
      yes_no: ['回答'],
      three: ['过去', '现在', '未来'],
      star: ['当前处境', '挑战', '过去', '未来', '结果'],
      horseshoe: ['过去', '现在', '隐藏影响', '障碍', '周围环境', '建议', '结果'],
      hexagram: ['过去', '现在', '未来', '基础', '挑战', '近期', '结果'],
      celtic: ['现状', '挑战', '潜意识', '过去', '可能性', '近未来', '自我态度', '环境', '希望/恐惧', '最终结果'],
      relationship: ['你', '对方', '关系基础', '挑战', '未来走向'],
      zodiac: ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼']
    };

    async function doDraw() {
      const btn = document.getElementById('btn-draw');
      btn.textContent = '正在抽牌...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/spread?type=' + selectedSpread);
        const data = await res.json();
        renderResults(data);
      } catch(e) {
        document.getElementById('results').innerHTML = '<div class="status-msg error">抽牌失败: '+e.message+'</div>';
      }
      btn.textContent = '抽牌';
      btn.disabled = false;
    }

    function renderResults(data) {
      const el = document.getElementById('results');
      const labels = posLabels[selectedSpread] || [];
      let html = '<div class="entropy-badge">TRNG 硬件真随机</div>';
      html += '<h3 style="margin-bottom:16px">' + (data.spread||'抽牌结果') + '</h3>';
      data.cards.forEach((c, i) => {
        const label = labels[i] || ('位置 '+(i+1));
        const isRev = c.isReversed;
        const up = c.meaningOfUpright || '';
        const rev = c.meaningOfReversed || '';
        const primaryLabel = isRev ? '逆位含义' : '正位含义';
        const secondaryLabel = isRev ? '正位含义' : '逆位含义';
        const primaryText = isRev ? rev : up;
        const secondaryText = isRev ? up : rev;
        html += '<div class="tarot-card '+(isRev?'reversed':'')+'">';
        html += '<div class="spread-label">' + label + '</div>';
        html += '<div class="name">' + c.name + (isRev?' (逆位)':' (正位)') + '</div>';
        html += '<div class="name-en">' + c.nameEn + ' - ' + c.arcana + '</div>';
        html += '<span class="orientation-badge '+(isRev?'reversed':'upright')+'">'+(isRev?'逆位':'正位')+'</span>';
        html += '<div class="meaning"><strong>'+primaryLabel+':</strong> '+primaryText+'</div>';
        html += '<div class="meaning secondary"><strong>'+secondaryLabel+':</strong> '+secondaryText+'</div>';
        html += '</div>';
      });
      // Simple analysis
      html += '<div class="analysis"><h4>简要分析</h4><p>';
      if (data.cards.length === 1) {
        const c = data.cards[0];
        html += '你抽到了<strong>'+c.name+'</strong>'+(c.isReversed?'(逆位)':'(正位)')+
                '。这张牌代表: '+(c.isReversed?c.meaningOfReversed:c.meaningOfUpright)+
                '。请结合你当前的处境和问题来理解这张牌的指引。';
      } else {
        const up = data.cards.filter(c=>!c.isReversed).length;
        const rev = data.cards.filter(c=>c.isReversed).length;
        const major = data.cards.filter(c=>c.arcana==='major').length;
        html += '共'+data.cards.length+'张牌中，<strong>'+up+'张正位</strong>、<strong>'+rev+'张逆位</strong>';
        if (major > 0) html += '，其中<strong>'+major+'张大阿卡纳</strong>，显示出命运层面的重大影响';
        html += '。';
        if (up > rev) html += '整体能量偏向积极正面。';
        else if (rev > up) html += '整体需要更多的反思与调整。';
        else html += '正逆位均衡，暗示事物处于转折点。';
      }
      html += '</p></div>';
      el.innerHTML = html;
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        document.getElementById('cfg-ssid').value = data.ssid || '';
      } catch(e) {}
    }

    async function saveConfig() {
      const ssid = document.getElementById('cfg-ssid').value.trim();
      const pass = document.getElementById('cfg-pass').value;
      if (!ssid) { alert('SSID 不能为空'); return; }
      try {
        const res = await fetch('/api/config', {
          method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:'ssid='+encodeURIComponent(ssid)+'&password='+encodeURIComponent(pass)
        });
        const data = await res.json();
        document.getElementById('cfg-status').innerHTML = '<div class="status-msg '+(data.ok?'success':'error')+'">'+data.message||data.error+'</div>';
      } catch(e) {
        document.getElementById('cfg-status').innerHTML = '<div class="status-msg error">'+e.message+'</div>';
      }
    }

    async function uploadOTA() {
      const file = document.getElementById('ota-file').files[0];
      if (!file) return;
      const pb = document.getElementById('ota-progress');
      const fill = document.getElementById('ota-fill');
      const status = document.getElementById('ota-status');
      pb.style.display='block';
      fill.style.width='0%';
      status.innerHTML='';
      const form = new FormData();
      form.append('firmware', file);
      const xhr = new XMLHttpRequest();
      xhr.upload.onprogress = (e) => { if(e.lengthComputable) fill.style.width=(e.loaded/e.total*100)+'%'; };
      xhr.onload = () => {
        try {
          const r = JSON.parse(xhr.responseText);
          status.innerHTML='<div class="status-msg '+(r.ok?'success':'error')+'">'+(r.message||r.error)+'</div>';
        } catch(e) {
          status.innerHTML='<div class="status-msg error">'+xhr.responseText+'</div>';
        }
      };
      xhr.onerror = () => { status.innerHTML='<div class="status-msg error">上传失败</div>'; };
      xhr.open('POST', '/api/ota');
      xhr.send(form);
    }

    // OTA drag and drop
    const drop = document.getElementById('ota-drop');
    drop.addEventListener('dragover', e=>{e.preventDefault();drop.classList.add('drag-over');});
    drop.addEventListener('dragleave', ()=>drop.classList.remove('drag-over'));
    drop.addEventListener('drop', e=>{
      e.preventDefault();
      drop.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if(files.length>0){
        document.getElementById('ota-file').files = files;
        uploadOTA();
      }
    });

    async function loadDeviceInfo() {
      try {
        const res = await fetch('/api/info');
        const d = await res.json();
        document.getElementById('device-info').innerHTML =
          '<b>固件:</b> '+d.firmware+'<br>'+
          '<b>芯片型号:</b> '+d.chipModel+'<br>'+
          '<b>芯片版本:</b> '+d.chipRevision+'<br>'+
          '<b>CPU 频率:</b> '+d.cpuFreqMHz+' MHz<br>'+
          '<b>Flash 大小:</b> '+(d.flashSize/1024/1024).toFixed(1)+' MB<br>'+
          '<b>可用堆内存:</b> '+(d.freeHeap/1024).toFixed(1)+' KB<br>'+
          '<b>AP SSID:</b> '+d.ssid+'<br>'+
          '<b>IP 地址:</b> '+d.ip;
      } catch(e) {
        document.getElementById('device-info').textContent = '获取设备信息失败: '+e.message;
      }
    }

    // Load chip info on init
    fetch('/api/info').then(r=>r.json()).then(d=>{
      document.getElementById('chip-info').textContent=d.chipModel+' @ '+d.cpuFreqMHz+'MHz';
    }).catch(()=>{});
    loadConfig();
  </script>
</body>
</html>
)rawliteral";
}

#endif // WEB_UI_H
