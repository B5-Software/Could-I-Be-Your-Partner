/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

/** Match CIBYP's primary/secondary surfaces while preserving IDE syntax colors. */
function workbenchColors({ theme = {}, dark = false } = {}) {
  const valid = (value, fallback) =>
    /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : fallback;
  const accent = valid(theme.accentColor, '#4f8cff');
  const background = valid(theme.backgroundColor, dark ? '#1a2232' : '#f5f7fa');
  const rgb = (color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  const luminance = (color) => {
    const [r, g, b] = rgb(color);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  };
  const shift = (color, amount) =>
    '#' +
    rgb(color)
      .map((value) =>
        Math.min(255, Math.max(0, value + amount))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  const secondary = shift(background, luminance(background) < 0.5 ? 20 : -10);
  const tertiary = shift(background, luminance(background) < 0.5 ? 30 : -20);
  const hover = shift(background, luminance(background) < 0.5 ? 40 : -5);
  const accentForeground = luminance(accent) > 0.6 ? '#172033' : '#ffffff';
  return {
    focusBorder: accent,
    'button.background': accent,
    'button.hoverBackground': shift(accent, -20),
    'button.foreground': accentForeground,
    'progressBar.background': accent,
    'textLink.foreground': accent,
    'textLink.activeForeground': shift(accent, 25),
    'activityBar.background': secondary,
    'activityBar.activeBorder': accent,
    'activityBarBadge.background': accent,
    'activityBarBadge.foreground': accentForeground,
    'sideBar.background': background,
    'sideBarSectionHeader.background': secondary,
    'editor.background': background,
    'editorGutter.background': background,
    'editorGroup.emptyBackground': background,
    'editorGroupHeader.tabsBackground': secondary,
    'editorWidget.background': secondary,
    'editorSuggestWidget.background': secondary,
    'editorHoverWidget.background': secondary,
    'tab.activeBackground': background,
    'tab.inactiveBackground': secondary,
    'tab.activeBorderTop': accent,
    'tab.hoverBackground': hover,
    'panel.background': background,
    'panelTitle.activeBorder': accent,
    'titleBar.activeBackground': secondary,
    'titleBar.inactiveBackground': secondary,
    'statusBar.background': accent,
    'statusBar.foreground': accentForeground,
    'statusBar.noFolderBackground': accent,
    'statusBar.noFolderForeground': accentForeground,
    'statusBar.debuggingBackground': accent,
    'statusBar.debuggingForeground': accentForeground,
    'input.background': secondary,
    'inputOption.activeBorder': accent,
    'dropdown.background': secondary,
    'dropdown.listBackground': secondary,
    'list.hoverBackground': hover,
    'list.activeSelectionBackground': accent,
    'list.activeSelectionForeground': accentForeground,
    'list.focusOutline': accent,
    'badge.background': accent,
    'badge.foreground': accentForeground,
    'quickInput.background': secondary,
    'menu.background': secondary,
    'notificationCenterHeader.background': tertiary,
    'notifications.background': secondary,
    'peekViewEditor.background': background,
    'peekViewResult.background': secondary,
    'peekViewTitle.background': tertiary,
    'welcomePage.background': background,
    'terminal.background': background,
  };
}

module.exports = { workbenchColors };
