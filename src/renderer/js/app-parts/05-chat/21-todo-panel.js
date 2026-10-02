  // One persistent list is shared by Chat / Code / Babe and the next App launch.
  const todoSidebar = new TodoSidebar(todoPanel, {
    getAgent: () => window.CibypTodos,
    mirror: (element, contents) => {
      if (contents) WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#' + element.id, html: element.innerHTML });
      else ['class', 'style', 'aria-hidden', 'aria-expanded'].forEach(attr => {
        WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + element.id, attr, value: element.getAttribute(attr) || '' });
      });
    },
    reportError: message => showToast(message, 'error')
  });
  document.querySelectorAll('[data-todo-toggle]').forEach(button => {
    button.addEventListener('click', () => { button.focus(); todoSidebar.toggle(); });
  });
  function renderTodoList() { todoSidebar.refresh(); }
  ['session-activated', 'session-closed', 'session-title', 'todo-updated'].forEach(type => {
    AppBus.on(type, () => todoSidebar.refresh());
  });
  document.querySelectorAll('.mode-btn').forEach(button => {
    button.addEventListener('click', () => todoSidebar.refresh());
  });
