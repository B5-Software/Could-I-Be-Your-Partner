  for (const { id } of SCROLL_BTN_TARGETS) {
    const transcript = document.getElementById(id);
    if (!transcript) continue;
    const shell = transcript.parentElement;
    shell.classList.add('request-jump-anchor');
    const rail = document.createElement('nav');
    rail.className = 'request-jump';
    rail.hidden = true;
    const stops = document.createElement('div');
    stops.className = 'request-jump-stops';
    const preview = document.createElement('div');
    preview.className = 'request-jump-preview';
    preview.id = id + '-request-preview';
    preview.role = 'tooltip';
    preview.hidden = true;
    const heading = document.createElement('strong');
    const excerpt = document.createElement('p');
    preview.append(heading, excerpt);
    rail.append(stops, preview);
    transcript.before(rail);

    let entries = [], active = null, showing = null, selectedTop = null, frame = 0, pendingStops = false;
    const markers = new Map();
    const textFrom = (node, limit) => String(node?.dataset.lazyRaw || node?.dataset.vscRawContent ||
      node?.querySelector('.message-content')?.textContent || '').slice(0, limit * 4)
      .replace(/\s+/g, ' ').trim().slice(0, limit);

    function hidePreview() {
      showing?.button.removeAttribute('aria-describedby');
      showing = null;
      preview.hidden = true;
    }

    function positionPreview() {
      if (!showing) return;
      const marker = showing.button.getBoundingClientRect();
      const bounds = rail.getBoundingClientRect();
      const midpoint = marker.top + marker.height / 2 - bounds.top;
      preview.style.top = Math.max(0, Math.min(bounds.height - preview.offsetHeight,
        midpoint - preview.offsetHeight / 2)) + 'px';
    }

    function showPreview(entry) {
      hidePreview();
      heading.textContent = textFrom(entry.message, 180) || entry.button.getAttribute('aria-label');
      let reply = '';
      for (let next = entry.target.nextElementSibling; next; next = next.nextElementSibling) {
        const message = next.originalMessage || next;
        if (message.matches('.message.user')) break;
        if (message.matches('.message.assistant:not(.thinking-indicator)')) reply ||= textFrom(message, 240);
        if (reply) break;
      }
      excerpt.textContent = reply;
      excerpt.hidden = !reply;
      preview.hidden = false;
      showing = entry;
      entry.button.setAttribute('aria-describedby', preview.id);
      positionPreview();
    }

    function setActive(entry) {
      if (active !== entry) {
        active?.button.removeAttribute('aria-current');
        if (active) active.button.tabIndex = -1;
        active = entry;
        if (active) {
          active.button.setAttribute('aria-current', 'true');
          active.button.tabIndex = 0;
        }
      }
      if (active && !rail.matches(':hover, :focus-within')) {
        const top = active.button.offsetTop;
        const edge = stops.scrollTop + stops.clientHeight;
        if (top < stops.scrollTop) stops.scrollTop = top;
        else if (top + active.button.offsetHeight > edge)
          stops.scrollTop = top + active.button.offsetHeight - stops.clientHeight;
      }
    }

    function syncActive() {
      frame = 0;
      if (!entries.length || transcript.clientHeight === 0) return;
      if (selectedTop === transcript.scrollTop && active) return;
      selectedTop = null;
      const edge = transcript.getBoundingClientRect().top + 30;
      let low = 0, high = entries.length - 1;
      if (transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 2) low = high;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (entries[mid].target.getBoundingClientRect().top <= edge) low = mid;
        else high = mid - 1;
      }
      setActive(entries[low]);
    }

    function queueActive() {
      if (!frame) frame = requestAnimationFrame(syncActive);
    }

    function jump(entry) {
      if (!entry.target.isConnected) return;
      _ensureScrollState(transcript).stick = false;
      transcript.scrollTop += entry.target.getBoundingClientRect().top -
        transcript.getBoundingClientRect().top - 16;
      selectedTop = transcript.scrollTop;
      setActive(entry);
      hidePreview();
    }

    function syncStops() {
      pendingStops = false;
      entries = [];
      const retained = new Set();
      for (const target of transcript.children) {
        const message = target.originalMessage || target;
        if (!message.matches('.message.user')) continue;
        let entry = markers.get(message);
        if (!entry) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'request-jump-stop';
          button.tabIndex = -1;
          entry = { button, message, target };
          button.addEventListener('pointerenter', () => showPreview(entry));
          button.addEventListener('focus', () => showPreview(entry));
          button.addEventListener('click', () => jump(entry));
          markers.set(message, entry);
        }
        entry.target = target;
        const next = stops.children[entries.length];
        if (next !== entry.button) stops.insertBefore(entry.button, next || null);
        entry.button.setAttribute('aria-label', t('ui.requestJump.entry', '请求 {index}', {
          index: entries.length + 1,
        }));
        entries.push(entry);
        retained.add(message);
      }
      for (const [message, entry] of markers) {
        if (retained.has(message)) continue;
        if (showing === entry) hidePreview();
        if (active === entry) { active = null; selectedTop = null; }
        entry.button.remove();
        markers.delete(message);
      }
      rail.hidden = !entries.length;
      if (!active && entries.length) setActive(entries[0]);
      queueActive();
    }

    const layout = new ResizeObserver(() => {
      if (!transcript.clientHeight) return;
      const top = transcript.getBoundingClientRect().top - shell.getBoundingClientRect().top;
      rail.style.top = Math.max(0, top) + 8 + 'px';
      rail.style.height = Math.max(0, transcript.clientHeight - 16) + 'px';
      preview.style.maxWidth = Math.max(80, shell.clientWidth - 40) + 'px';
      positionPreview();
      queueActive();
    });
    layout.observe(shell);
    layout.observe(transcript);
    new MutationObserver(() => {
      if (pendingStops) return;
      pendingStops = true;
      requestAnimationFrame(syncStops);
    }).observe(transcript, { childList: true });
    transcript.addEventListener('scroll', queueActive, { passive: true });
    stops.addEventListener('scroll', positionPreview, { passive: true });
    stops.addEventListener('pointerleave', hidePreview);
    rail.addEventListener('focusout', event => { if (!rail.contains(event.relatedTarget)) hidePreview(); });
    rail.addEventListener('keydown', event => {
      if (event.key === 'Escape' && showing) {
        hidePreview();
        event.stopPropagation();
        return;
      }
      const index = entries.findIndex(entry => entry.button === event.target);
      const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: entries.length - 1 }[event.key];
      if (index < 0 || next === undefined) return;
      event.preventDefault();
      entries[Math.max(0, Math.min(entries.length - 1, next))].button.focus();
    });
    const localize = () => {
      rail.setAttribute('aria-label', t('ui.requestJump', '定位请求'));
      syncStops();
    };
    localize();
    window.addEventListener('languagechange', localize);
  }
