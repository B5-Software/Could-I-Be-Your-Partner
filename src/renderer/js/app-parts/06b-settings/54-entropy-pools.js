  (() => {
    const section = document.getElementById('entropy-pools-settings');
    const panel = section.closest('.settings-panel');
    const select = section.querySelector('select');
    const form = section.querySelector('form');
    const status = section.querySelector('[role="status"]');
    const sources = section.querySelector('ul');
    const testButton = form.querySelector('[data-pool-test]');
    const removeButton = form.querySelector('[data-pool-remove]');
    const label = (key, fallback, args) => t('ui.entropy.' + key, fallback, args);
    const rpc = (action, args) => window.api.backendRequest('entropy:request', action, args);
    let saved = {}, id = '', draft = false, busy = false, generation = 0;

    function drawReport(report) {
      const names = { os: label('os', '系统随机数'), drand: 'drand Quicknet',
        hardware: label('hardware', '已配置的 TRNG 设备'), device: label('deviceShort', '本地 RNG 端点') };
      sources.replaceChildren(...(report?.sources || []).map(source => {
        const item = document.createElement('li');
        const title = document.createElement('strong');
        const detail = document.createElement('small');
        item.dataset.used = String(source.status === 'used');
        title.textContent = names[source.kind] || source.kind;
        detail.textContent = source.status === 'used' ? label('used', '已混入') : label('unavailable', '本次不可用');
        if (source.round) detail.textContent += ' · #' + source.round;
        item.append(title, detail);
        return item;
      }));
    }

    function render() {
      const pools = saved.pools || [];
      select.replaceChildren(...pools.map(pool => new Option(pool.name, pool.id)));
      if (draft || !pools.length) select.add(new Option(label('none', '选择熵池'), ''));
      select.value = draft ? '' : id;
      const pool = pools.find(pool => pool.id === id);
      form.hidden = !draft && !pool;
      form.elements.poolName.value = pool?.name || '';
      form.elements.drand.checked = pool?.drand === true;
      form.elements.hardware.checked = pool?.hardware === true;
      form.elements.device.value = pool?.device || '';
      form.elements.active.checked = saved.source === 'pool' && Boolean(id) && saved.activePoolId === id;
      document.querySelectorAll('.entropy-mode-btn').forEach(button =>
        button.classList.toggle('active', button.dataset.source === (saved.source || 'csprng')));
      document.getElementById('entropy-trng-settings').style.display =
        saved.source === 'trng' || pools.some(pool => pool.hardware) ? '' : 'none';
      fields();
    }

    function fields() {
      const pool = (saved.pools || []).some(pool => pool.id === id);
      section.querySelectorAll('button, input, select').forEach(control => { control.disabled = busy; });
      testButton.disabled = busy || !pool;
      removeButton.disabled = busy || !pool;
      section.querySelector('[data-pool-new]').disabled = busy || (saved.pools || []).length >= 8;
    }

    async function refreshReport() {
      const requestId = ++generation;
      drawReport(null);
      if (draft || !id) return;
      const report = await rpc('status', { id });
      if (requestId === generation) drawReport(report);
    }

    async function work(task) {
      if (busy) return;
      busy = true;
      fields();
      try {
        await task();
      } catch (error) {
        status.textContent = label('error', '熵池操作失败') + ' · ' + (error.message || error);
      } finally {
        busy = false;
        fields();
      }
    }

    async function load() {
      saved = (await readSettings()).entropy || {};
      const pools = saved.pools || [];
      if (!pools.some(pool => pool.id === id)) id = saved.activePoolId || pools[0]?.id || '';
      render();
      await refreshReport();
    }

    async function save(pools, activePoolId) {
      saved = await rpc('save', { pools, activePoolId });
      draft = false;
      if (!pools.some(pool => pool.id === id)) id = saved.activePoolId || pools[0]?.id || '';
      render();
      await refreshReport();
      status.textContent = label('saved', '熵池设置已保存');
    }

    select.addEventListener('change', () => {
      id = select.value;
      draft = false;
      status.textContent = '';
      render();
      void work(refreshReport);
    });
    section.querySelector('[data-pool-new]').addEventListener('click', () => {
      id = '';
      draft = true;
      status.textContent = '';
      render();
      drawReport(null);
      form.elements.poolName.focus();
    });
    form.addEventListener('submit', event => {
      event.preventDefault();
      void work(async () => {
        const device = form.elements.device.value.trim();
        if (device && !/^\/dev\/[a-z\d/_-]+$/i.test(device)) {
          status.textContent = label('invalidDevice', '请输入 /dev 下的随机数设备路径');
          return;
        }
        const previous = id;
        if (draft) id = 'pool-' + Array.from(crypto.getRandomValues(new Uint8Array(12)), byte =>
          byte.toString(16).padStart(2, '0')).join('');
        const pool = { id, device, name: form.elements.poolName.value.trim(),
          drand: form.elements.drand.checked, hardware: form.elements.hardware.checked };
        if (!pool.name) { form.elements.poolName.focus(); return; }
        const pools = [...(saved.pools || [])];
        const index = pools.findIndex(item => item.id === id);
        if (index < 0) pools.push(pool);
        else pools[index] = pool;
        const active = saved.source === 'pool' ? saved.activePoolId : '';
        try { await save(pools, form.elements.active.checked ? id : active === id ? '' : active); }
        catch (error) { id = previous; throw error; }
      });
    });
    testButton.addEventListener('click', () => void work(async () => {
      status.textContent = label('testing', '正在采样已保存的输入源…');
      drawReport(await rpc('test', { id }));
      status.textContent = label('tested', '采样完成');
    }));
    removeButton.addEventListener('click', () => void work(async () => {
      const active = saved.source === 'pool' ? saved.activePoolId : '';
      await save(saved.pools.filter(pool => pool.id !== id), active === id ? '' : active);
    }));
    document.querySelectorAll('.entropy-mode-btn').forEach(button => button.addEventListener('click', () => {
      saved = { ...saved, source: button.dataset.source };
      if (!form.hidden) form.elements.active.checked = false;
    }));
    new MutationObserver(() => {
      if (panel.classList.contains('active')) void work(load);
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  })();
