  const pendingInteractiveData = new WeakMap();
  const rememberInteractiveData = (card, args) => {
    if (!Array.isArray(args?.columns) || !Array.isArray(args?.rows)) return;
    try { pendingInteractiveData.set(card, InteractiveContent.validate(args)); } catch { /* invalid tool input */ }
  };

  function renderInteractiveResult(card, result) {
    const spec = pendingInteractiveData.get(card);
    pendingInteractiveData.delete(card);
    if (!spec || result?.ok !== true || result.presentation !== 'interactive-table') return;
    const shell = document.createElement('article');
    shell.className = 'interactive-content';
    const root = shell.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; color: var(--text-primary); font: inherit; }
      * { box-sizing: border-box; }
      header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; }
      strong { flex: 1 1 100%; overflow-wrap: anywhere; }
      input, select { color: inherit; background: var(--bg-primary); border: 1px solid var(--border-color, #8886); border-radius: 6px; min-height: 30px; padding: 4px 7px; font: inherit; max-width: 100%; }
      input { flex: 1 1 140px; min-width: 0; }
      .values { max-height: 320px; overflow: auto; }
      table { border-collapse: collapse; width: 100%; }
      :is(th, td) { padding: 5px 9px; border-top: 1px solid var(--border-color, #8886); text-align: start; overflow-wrap: anywhere; }
      th { position: sticky; top: 0; background: var(--bg-primary); }
      .bars { display: grid; gap: 7px; padding: 9px 12px; }
      .bar { display: grid; grid-template-columns: minmax(55px, 1fr) minmax(72px, 2fr) auto; gap: 8px; align-items: center; overflow-wrap: anywhere; }
      meter { width: 100%; accent-color: var(--accent); }
    `;
    const element = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const header = element('header');
    const title = element('strong', spec.title);
    const filter = element('input');
    filter.type = 'search';
    filter.maxLength = 180;
    filter.placeholder = t('ui.interactive.filter', '筛选行');
    filter.setAttribute('aria-label', filter.placeholder);
    const sort = element('select');
    sort.setAttribute('aria-label', t('ui.interactive.sort', '排序'));
    sort.append(new Option(t('ui.interactive.sort', '排序'), ''));
    spec.columns.forEach((label, index) => sort.append(new Option(label, String(index))));
    header.append(title, filter, sort);
    const view = element('select');
    if (spec.chartColumn !== undefined) {
      view.setAttribute('aria-label', t('ui.interactive.view', '显示方式'));
      view.append(new Option(t('ui.interactive.table', '表格'), 'table'), new Option(t('ui.interactive.chart', '条形图'), 'chart'));
      header.append(view);
    }
    const content = element('div');
    content.className = 'values';
    root.append(style, header, content);
    function update() {
      const query = filter.value.trim().toLocaleLowerCase();
      const rows = spec.rows.filter(row => row.some(cell => String(cell ?? '').toLocaleLowerCase().includes(query)));
      if (sort.value !== '') {
        const index = Number(sort.value);
        rows.sort((a, b) => Number.isFinite(a[index]) && Number.isFinite(b[index])
          ? a[index] - b[index] : String(a[index] ?? '').localeCompare(String(b[index] ?? '')));
      }
      if (view.value === 'chart') {
        const column = spec.chartColumn;
        const bars = element('div');
        bars.className = 'bars';
        const max = Math.max(1, ...spec.rows.map(row => Math.abs(row[column] || 0)));
        for (const row of rows) {
          if (row[column] === null) continue;
          const bar = element('div');
          bar.className = 'bar';
          const caption = row[0] ?? '';
          const meter = element('meter');
          meter.max = max;
          meter.value = Math.abs(row[column]);
          meter.setAttribute('aria-label', String(caption));
          bar.append(element('span', caption), meter, element('span', row[column]));
          bars.append(bar);
        }
        content.replaceChildren(bars);
        return;
      }
      const table = element('table');
      const labels = table.createTHead().insertRow();
      for (const column of spec.columns) labels.append(element('th', column));
      const body = table.createTBody();
      for (const row of rows) {
        const tr = body.insertRow();
        for (const cell of row) tr.append(element('td', cell ?? '—'));
      }
      content.replaceChildren(table);
    }
    filter.addEventListener('input', update);
    sort.addEventListener('change', update);
    view.addEventListener('change', update);
    update();
    card.after(shell);
    scrollElementIntoView(shell);
  }
