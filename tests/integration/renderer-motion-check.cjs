/* Native CSSOM and animation checks across the app's owned styles and auxiliary windows. */
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function checkMotion(webContents) {
  const renderer = path.resolve(__dirname, '../../src/renderer');
  const styles = fs.readdirSync(path.join(renderer, 'css')).map((name) => ({
    name,
    css: fs.readFileSync(path.join(renderer, 'css', name), 'utf8'),
  }));
  for (const name of fs.readdirSync(path.join(renderer, 'pages'))) {
    const html = fs.readFileSync(path.join(renderer, 'pages', name), 'utf8');
    if (!html.includes('../css/motion.css')) throw new Error(`Motion policy missing in ${name}`);
    for (const match of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
      styles.push({ name, css: match[1] });
  }
  return webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const framesUse = (animation, property) => animation.effect.getKeyframes().every(frame =>
      Object.keys(frame).every(key => ['offset', 'computedOffset', 'easing', 'composite', property].includes(key)));
    let keyframes = 0;
    for (const { name, css } of ${JSON.stringify(styles)}) {
      const style = document.createElement('style');
      style.media = 'not all';
      style.textContent = css;
      document.head.appendChild(style);
      try {
        const inspect = rules => {
          for (const rule of rules) {
            if (rule.type === CSSRule.KEYFRAMES_RULE) {
              for (const frame of rule.cssRules)
                check([...frame.style].every(property => property === 'opacity'), name + ': non-fade keyframe ' + rule.name);
              keyframes++;
            } else if (rule.cssRules) inspect(rule.cssRules);
          }
        };
        inspect(style.sheet.cssRules);
      } finally { style.remove(); }
    }
    check(keyframes > 20, 'owned keyframes were not inspected');
    document.documentElement.dataset.animations = 'on';
    window.navigatePage('chat');
    const sidebar = document.getElementById('todo-panel');
    document.getElementById('btn-todo-sidebar').click();
    const sliding = sidebar.getAnimations();
    check(sliding.length && sliding.every(animation => animation.effect.getKeyframes().every(frame =>
      Object.keys(frame).every(key => ['offset', 'computedOffset', 'easing', 'composite', 'transform', 'marginRight'].includes(key)))), 'sidebar must slide and reserve horizontal space without fading');
    check(getComputedStyle(sidebar).opacity === '1', 'sidebar must not fade');
    document.documentElement.dataset.animations = 'off';
    document.getElementById('btn-close-todo').click();
    document.documentElement.dataset.animations = 'on';
    window.navigatePage('about');
    const pageMotion = document.getElementById('page-about').getAnimations();
    check(pageMotion.length && pageMotion.every(animation => framesUse(animation, 'opacity')), 'page must fade without movement');
    window.navigatePage('settings');
    window.activateSettingsTab('theme');
    const categoryMotion = document.querySelector('.settings-panel.active').getAnimations();
    check(categoryMotion.length && categoryMotion.every(animation => framesUse(animation, 'opacity')), 'settings category must only fade');
    const modal = document.getElementById('message-modal');
    modal.classList.remove('hidden');
    const modalMotion = modal.getAnimations({ subtree: true });
    check(modalMotion.length && modalMotion.every(animation => framesUse(animation, 'opacity')), 'modal must only fade');
    modal.classList.add('hidden');
    const spinner = document.createElement('i');
    spinner.className = 'fa-solid fa-spinner fa-spin';
    document.body.appendChild(spinner);
    check(spinner.getAnimations().length && spinner.getAnimations().every(animation => framesUse(animation, 'opacity')), 'loading indicator still rotates or scales');
    spinner.remove();
    document.documentElement.dataset.animations = 'off';
    modal.classList.remove('hidden');
    window.fadeOutHide(modal);
    check(modal.classList.contains('hidden'), 'disabled modal animation delays closing');
    await new Promise(resolve => setTimeout(resolve, 0));
    check(!document.getAnimations().some(animation => animation.playState === 'running'), 'disabled motion still runs');
    document.documentElement.dataset.animations = 'on';
    window.navigatePage('chat');
    return { keyframes, content: 'opacity only', sidebars: 'horizontal slide, no fade' };
  })()`);
};
