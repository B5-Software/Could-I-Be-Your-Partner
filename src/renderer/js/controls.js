/* SPDX-License-Identifier: GPL-3.0-or-later */
(() => {
  const selector = 'input[type="checkbox"]';
  const describe = input => {
    if (!input.matches(selector)) return;
    // A partially enabled tool group keeps its mixed accessibility state.
    input.setAttribute('role', input.indeterminate ? 'checkbox' : 'switch');
  };
  const discover = root => {
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches(selector)) describe(root);
    root.querySelectorAll(selector).forEach(describe);
  };
  discover(document.documentElement);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') describe(record.target);
      else record.addedNodes.forEach(discover);
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-indeterminate']
  });
  document.addEventListener('change', event => {
    if (event.target.matches?.(selector)) describe(event.target);
  }, true);
})();
