  // All docked apps share one state owner; switching apps preserves the previous app.
  const dockPanels = new DockPanels(
    [...document.querySelectorAll('.geogebra-panel')],
    document.getElementById('panel-tabs-container'),
    element => {
      if (element.id === 'panel-tabs-container') WebUIMirror.pushDomEvent({ type: 'dom_replace', container: '#' + element.id, html: element.innerHTML });
      else ['class', 'aria-hidden'].forEach(attr => WebUIMirror.pushDomEvent({ type: 'dom_update', selector: '#' + element.id, attr, value: element.getAttribute(attr) || '' }));
      WebUIMirror.pushDomEvent({ type: 'dom_update', selector: 'body', attr: 'class', value: document.body.className });
    }
  );
  window.setAppPanelOpen = (id, open) => dockPanels.setOpen(id, open);
  window.minimizePanel = id => dockPanels.minimize(id);
  window.restorePanel = id => dockPanels.setOpen(id, true);
  document.querySelectorAll('.btn-minimize-panel').forEach(button => {
    button.addEventListener('click', () => dockPanels.minimize(button.closest('.geogebra-panel')?.id));
  });
