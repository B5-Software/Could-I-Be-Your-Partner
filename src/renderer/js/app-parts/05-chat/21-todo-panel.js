  // ---- Todo Panel ----
  document.getElementById('btn-todo-toggle').addEventListener('click', () => {
    todoPanel.classList.toggle('hidden');
  });

  document.getElementById('btn-close-todo').addEventListener('click', () => {
    todoPanel.classList.add('hidden');
  });

  document.getElementById('btn-add-todo').addEventListener('click', () => {
    const text = todoInput.value.trim();
    if (!text) return;
    agent.handleTodo({ action: 'add', text });
    todoInput.value = '';
  });

  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const text = todoInput.value.trim();
      if (!text) return;
      agent.handleTodo({ action: 'add', text });
      todoInput.value = '';
    }
  });

  function renderTodoList(items) {
    if (items.length === 0) {
      todoList.innerHTML = '<div class="empty-state" style="padding:30px"><i class="fa-solid fa-list-check"></i><p>暂无待办事项</p></div>';
    } else {
      todoList.innerHTML = items.map(item => `
        <div class="todo-item ${item.done ? 'done' : ''}" data-id="${item.id}">
          <div class="todo-checkbox"><i class="fa-solid fa-check"></i></div>
          <span class="todo-text">${escapeHtml(item.text)}</span>
          <button class="btn-icon todo-delete" title="删除"><i class="fa-solid fa-xmark"></i></button>
        </div>`).join('');
    }
    // 增量推送：替换待办列表内容
    WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#todo-list', html: todoList.innerHTML });
  }

  // 事件委托：勾选/删除（列表内容每次重渲染，绑定在容器上）
  todoList.addEventListener('click', (e) => {
    const itemEl = e.target.closest('.todo-item');
    if (!itemEl) return;
    const id = Number(itemEl.dataset.id);
    if (!Number.isFinite(id)) return;
    if (e.target.closest('.todo-delete')) {
      agent.handleTodo({ action: 'remove', id });
    } else if (e.target.closest('.todo-checkbox')) {
      agent.handleTodo({ action: 'toggle', id });
    }
  });
