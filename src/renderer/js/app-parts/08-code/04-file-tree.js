  // ---- File tree rendering (with collapsible dirs + context menu) ----
  function renderCodeFileTree(container, tree, basePath) {
    container.innerHTML = '';
    function buildNode(node, depth, holder) {
      const row = document.createElement('div');
      row.className = 'tree-node ' + (node.type === 'directory' ? 'dir' : 'file');
      row.style.paddingLeft = (depth * 12 + 8) + 'px';
      row.dataset.path = node.path;
      row.dataset.name = node.name;
      row.dataset.type = node.type;
      if (node.type === 'directory') {
        row.innerHTML = '<i class="fa-solid fa-chevron-right tree-toggle"></i><i class="fa-solid fa-folder"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          const toggle = row.querySelector('.tree-toggle');
          const folderIcon = row.querySelector('.fa-folder, .fa-folder-open');
          const childHolder = row.nextElementSibling;
          if (childHolder && childHolder.classList.contains('tree-children')) {
            const collapsed = childHolder.style.display === 'none';
            childHolder.style.display = collapsed ? 'block' : 'none';
            if (toggle) toggle.classList.toggle('fa-chevron-right', !collapsed);
            if (toggle) toggle.classList.toggle('fa-chevron-down', collapsed);
            if (folderIcon) folderIcon.className = collapsed ? 'fa-solid fa-folder-open' : 'fa-solid fa-folder';
          }
        });
      } else {
        row.innerHTML = '<span class="tree-toggle"></span><i class="fa-solid ' + fileIconClass(node.name) + '"></i> <span>' + escapeHtml(node.name) + '</span>';
        row.title = node.path;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          openFileInMonaco(node.path, node.name);
        });
      }
      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showCodeFileTreeContextMenu(e, node);
      });
      holder.appendChild(row);
      if (node.children && node.type === 'directory') {
        const childHolder = document.createElement('div');
        childHolder.className = 'tree-children';
        for (const child of node.children) buildNode(child, depth + 1, childHolder);
        holder.appendChild(childHolder);
      }
    }
    if (Array.isArray(tree)) {
      for (const node of tree) buildNode(node, 0, container);
    }
    // 增量推送：文件树渲染后同步到 WebUI
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#code-file-tree', html: container.innerHTML });
  }

  // ---- File tree context menu (Add to context / Rename / Delete) ----
  // 根据平台返回对应文案：macOS → "Finder"，Windows/Linux → "资源管理器"
