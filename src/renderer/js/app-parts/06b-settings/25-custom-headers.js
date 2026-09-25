  // ---- 自定义请求头行编辑器（LLM / 生图共用）----
  // 存储格式：[{ name, value }]；行内输入 change 即保存，删除按钮即时生效。
  function initHeaderEditor(listElId, addBtnId, persistFn) {
    const listEl = document.getElementById(listElId);
    const addBtn = document.getElementById(addBtnId);
    if (!listEl || !addBtn) return null;
    let items = [];
    const redraw = () => {
      listEl.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'setting-hint';
        empty.textContent = '暂无自定义请求头';
        listEl.appendChild(empty);
        return;
      }
      items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'custom-header-row';
        row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center;';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = '名称 (如 X-Title)';
        nameInput.value = item.name || '';
        nameInput.style.cssText = 'flex:0 0 38%;min-width:0;';
        const valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.placeholder = '值';
        valueInput.value = item.value || '';
        valueInput.style.cssText = 'flex:1;min-width:0;';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-icon';
        delBtn.title = '删除此请求头';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        nameInput.addEventListener('change', () => { items[idx] = { name: nameInput.value.trim(), value: items[idx]?.value || '' }; persistFn(items.slice()); });
        valueInput.addEventListener('change', () => { items[idx] = { name: items[idx]?.name || '', value: valueInput.value }; persistFn(items.slice()); });
        delBtn.addEventListener('click', () => {
          items.splice(idx, 1);
          redraw();
          persistFn(items.slice());
        });
        row.append(nameInput, valueInput, delBtn);
        listEl.appendChild(row);
      });
    };
    addBtn.addEventListener('click', () => {
      items.push({ name: '', value: '' });
      redraw();
      persistFn(items.slice());
      const inputs = listEl.querySelectorAll('.custom-header-row input');
      if (inputs.length >= 2) inputs[inputs.length - 2].focus();
    });
    return {
      render(list) {
        items = Array.isArray(list) ? list.map(x => ({ name: x?.name || '', value: x?.value || '' })) : [];
        redraw();
      }
    };
  }
  const llmHeaderEditor = initHeaderEditor('llm-custom-headers', 'btn-llm-add-header', async (list) => {
    const s = await window.api.getSettings();
    s.llm.customHeaders = list;
    await saveSettings(s);
  });
  const imgHeaderEditor = initHeaderEditor('img-custom-headers', 'btn-img-add-header', async (list) => {
    const s = await window.api.getSettings();
    s.imageGen.customHeaders = list;
    await saveSettings(s);
  });
