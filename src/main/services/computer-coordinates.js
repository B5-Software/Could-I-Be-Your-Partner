/* SPDX-License-Identifier: GPL-3.0-or-later */
'use strict';

function toDesktopPoint(point, { platform, capture, display, space = 'screenshot' }) {
  if (typeof point.x !== 'number' || typeof point.y !== 'number')
    throw new Error('Coordinates must be finite numbers');
  const x = Number(point.x),
    y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error('Coordinates must be finite numbers');
  if (space === 'physical' || space === 'desktop') return { x: Math.round(x), y: Math.round(y) };
  if (space !== 'screenshot') throw new Error('Unknown coordinate space');
  const target = capture?.display || display;
  if (!target)
    throw new Error('Take a screenshot or select a display before using screenshot coordinates');
  const width = capture?.width || target.physical.width,
    height = capture?.height || target.physical.height;
  if (x < 0 || y < 0 || x >= width || y >= height)
    throw new Error(`Screenshot coordinates exceed ${width}×${height}`);
  const bounds = platform === 'darwin' ? target.bounds : target.physical;
  return {
    x: Math.round(bounds.x + (x * bounds.width) / width),
    y: Math.round(bounds.y + (y * bounds.height) / height),
  };
}

module.exports = { toDesktopPoint };
