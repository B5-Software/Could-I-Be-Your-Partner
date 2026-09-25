  // ---- 可拖动分割器 ----
  function initCodeResizers() {
    document.querySelectorAll('.code-resizer').forEach(resizer => {
      let dragging = false;
      let startX = 0;
      let p1, p2, p1Width, p2Width, p2Flex = false, p1Flex = false;

      resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        p1 = document.getElementById(resizer.dataset.panel1);
        p2 = document.getElementById(resizer.dataset.panel2);
        if (!p1 || !p2) return;
        p1Width = p1.getBoundingClientRect().width;
        p2Width = p2.getBoundingClientRect().width;
        p1Flex = false;
        p2Flex = false;
        // 如果 p2 是 flex 布局中的弹性项，改为固定宽度
        if (getComputedStyle(p2).flexGrow !== '0') {
          p2Flex = true;
          p2.style.flex = 'none';
          p2.style.width = p2Width + 'px';
        }
        if (getComputedStyle(p1).flexGrow !== '0') {
          p1Flex = true;
          p1.style.flex = 'none';
          p1.style.width = p1Width + 'px';
        }
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging || !p1 || !p2) return;
        const dx = e.clientX - startX;
        let newP1Width = p1Width + dx;
        let newP2Width = p2Width - dx;
        // 限制最小宽度
        const p1Min = parseInt(getComputedStyle(p1).minWidth) || 100;
        const p2Min = parseInt(getComputedStyle(p2).minWidth) || 100;
        const p1Max = parseInt(getComputedStyle(p1).maxWidth) || 9999;
        const p2Max = parseInt(getComputedStyle(p2).maxWidth) || 9999;
        if (newP1Width < p1Min) { newP1Width = p1Min; newP2Width = p1Width + p2Width - p1Min; }
        if (newP2Width < p2Min) { newP2Width = p2Min; newP1Width = p1Width + p2Width - p2Min; }
        if (newP1Width > p1Max) { newP1Width = p1Max; newP2Width = p1Width + p2Width - p1Max; }
        if (newP2Width > p2Max) { newP2Width = p2Max; newP1Width = p1Width + p2Width - p2Max; }
        p1.style.width = newP1Width + 'px';
        p2.style.width = newP2Width + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // 还原原本是弹性项的面板：清除拖拽期间钉死的内联 flex/width，
        // 让布局重新吸收容器剩余宽度，实现窗口拉大/缩小时实时匹配
        if (p1Flex && p1) {
          p1.style.removeProperty('flex');
          p1.style.removeProperty('width');
        }
        if (p2Flex && p2) {
          p2.style.removeProperty('flex');
          p2.style.removeProperty('width');
        }
        p1 = null;
        p2 = null;
        p1Flex = false;
        p2Flex = false;
      });
    });
  }
  initCodeResizers();
