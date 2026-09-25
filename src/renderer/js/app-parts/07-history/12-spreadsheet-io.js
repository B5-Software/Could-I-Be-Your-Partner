  // ---- Spreadsheet File Import/Export ----
  window.spreadsheetImportFile = async function(filePath) {
    const result = await window.api.spreadsheetImportFile(filePath);
    if (!result.ok) return result;
    ensureSpreadsheet();
    spreadsheetPanel.classList.remove('hidden');
    document.body.classList.add('geogebra-open');
    if (result.sheetName) ssEngine.title = result.sheetName;
    if (result.cells && result.cells.length > 0) {
      ssEngine.setCells(result.cells);
    }
    return { ok: true, message: `已导入 ${result.cells?.length || 0} 个单元格`, sheetName: result.sheetName };
  };

  window.spreadsheetExportFile = async function(filePath) {
    ensureSpreadsheet();
    const data = ssEngine.getData();
    // data.cells 是数组 [{addr, raw, value, format}, ...]
    // 直接传给导出函数，每个元素需要 addr + value/raw
    const cells = (data.cells || []).map(c => ({
      addr: c.addr,
      value: c.value,
      raw: c.raw,  // 保留原始公式/文本，让导出函数优先使用 raw
      format: c.format || {}  // 保留单元格格式（粗体/斜体/颜色/背景/对齐/字号）
    }));
    return await window.api.spreadsheetExportFile(filePath, cells, data.title || 'Sheet1');
  };
