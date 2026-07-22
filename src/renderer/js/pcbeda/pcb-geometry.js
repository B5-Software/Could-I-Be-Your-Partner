// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 B5-Software
// CIBYP-PCB-EDA - geometry utilities (internal unit: mm, Y-down world coordinates)
(function (global) {
  'use strict';

  const EPS = 1e-9;

  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }
  function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // distance from point p to segment (a,b)
  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < EPS) return dist(px, py, ax, ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    return dist(px, py, ax + t * dx, ay + t * dy);
  }

  // squared distance between two segments (approx via endpoint sampling + perpendicular feet)
  // Bug 6 修复：增加共线重叠判定，确保平行/斜线段距离计算正确
  function segmentSegmentDist(ax, ay, bx, by, cx, cy, dx, dy) {
    if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    // 共线重叠检查：四个点共线时，segmentsIntersect 返回 false，但线段可能重叠
    const d1 = _orient(ax, ay, bx, by, cx, cy);
    const d2 = _orient(ax, ay, bx, by, dx, dy);
    if (Math.abs(d1) < EPS && Math.abs(d2) < EPS) {
      // 四点共线：将 CD 端点投影到 AB 参数空间检查是否重叠
      const abx = bx - ax, aby = by - ay;
      const len2 = abx * abx + aby * aby;
      if (len2 < EPS) {
        // AB 退化为点
        return Math.min(dist(ax, ay, cx, cy), dist(ax, ay, dx, dy));
      }
      const tC = ((cx - ax) * abx + (cy - ay) * aby) / len2;
      const tD = ((dx - ax) * abx + (dy - ay) * aby) / len2;
      const tMin = Math.min(tC, tD), tMax = Math.max(tC, tD);
      // AB 参数范围 [0,1] 与 CD 参数范围 [tMin,tMax] 是否重叠
      if (tMax >= -EPS && tMin <= 1 + EPS) return 0; // 共线重叠
      // 不重叠：返回端点间最小距离
      return Math.min(
        dist(ax, ay, cx, cy), dist(ax, ay, dx, dy),
        dist(bx, by, cx, cy), dist(bx, by, dx, dy)
      );
    }
    return Math.min(
      pointToSegmentDist(ax, ay, cx, cy, dx, dy),
      pointToSegmentDist(bx, by, cx, cy, dx, dy),
      pointToSegmentDist(cx, cy, ax, ay, bx, by),
      pointToSegmentDist(dx, dy, ax, ay, bx, by)
    );
  }

  function _orient(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  }

  function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = _orient(cx, cy, dx, dy, ax, ay);
    const d2 = _orient(cx, cy, dx, dy, bx, by);
    const d3 = _orient(ax, ay, bx, by, cx, cy);
    const d4 = _orient(ax, ay, bx, by, dx, dy);
    if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
        ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
    return false;
  }

  function lineLineIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
    const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (Math.abs(den) < EPS) return null;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
    return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
  }

  function pointInPolygon(px, py, pts) {
    // ray casting, pts: [{x,y},...]
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / (yj - yi + EPS) + xi)) inside = !inside;
    }
    return inside;
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    }
    return a / 2; // signed
  }

  function ptsBBox(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function rotatePoint(x, y, cx, cy, deg) {
    const r = deg * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const dx = x - cx, dy = y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  }

  // 45-degree routing snap: from anchor (ax,ay) towards cursor (cx,cy).
  // mode: '45' | '90' | 'free'. Returns waypoint {x,y} (the snapped endpoint).
  function snapRoutePoint(ax, ay, cx, cy, mode) {
    if (mode === 'free') return { x: cx, y: cy };
    const dx = cx - ax, dy = cy - ay;
    if (mode === '90') {
      return (Math.abs(dx) >= Math.abs(dy)) ? { x: cx, y: ay } : { x: ax, y: cy };
    }
    // 45: snap to nearest of 8 directions
    const ang = Math.atan2(dy, dx);
    const len = Math.hypot(dx, dy);
    const step = Math.PI / 4;
    const a2 = Math.round(ang / step) * step;
    // project cursor onto snapped direction to keep length natural
    const proj = dx * Math.cos(a2) + dy * Math.sin(a2);
    const L = Math.max(0, proj);
    return { x: ax + L * Math.cos(a2), y: ay + L * Math.sin(a2) };
  }

  // convert arc (center, r, startDeg, endDeg, CCW positive) to polyline points
  function arcToPoints(cx, cy, r, startDeg, endDeg, segDeg) {
    const step = Math.max(2, segDeg || 6);
    let s = startDeg, e = endDeg;
    while (e < s) e += 360;
    const pts = [];
    const total = e - s;
    const n = Math.max(1, Math.ceil(total / step));
    for (let i = 0; i <= n; i++) {
      const a = (s + total * i / n) * Math.PI / 180;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  }

  // circle-circle intersection points (for advanced snapping)
  function circleCircleIntersect(x0, y0, r0, x1, y1, r1) {
    const d = dist(x0, y0, x1, y1);
    if (d > r0 + r1 || d < Math.abs(r0 - r1) || d < EPS) return [];
    const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
    const xm = x0 + a * (x1 - x0) / d, ym = y0 + a * (y1 - y0) / d;
    return [
      { x: xm + h * (y1 - y0) / d, y: ym - h * (x1 - x0) / d },
      { x: xm - h * (y1 - y0) / d, y: ym + h * (x1 - x0) / d }
    ];
  }

  // expand a polyline into a list of capsule segments for clearance testing
  function polylineCapsules(pts, width) {
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      segs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y, r: width / 2 });
    }
    return segs;
  }

  // distance between capsule (segment + radius) and circle
  function capsuleCircleDist(seg, cx, cy, cr) {
    const d = pointToSegmentDist(cx, cy, seg.ax, seg.ay, seg.bx, seg.by);
    return d - seg.r - cr;
  }

  function capsuleCapsuleDist(s1, s2) {
    const d = segmentSegmentDist(s1.ax, s1.ay, s1.bx, s1.by, s2.ax, s2.ay, s2.bx, s2.by);
    return d - s1.r - s2.r;
  }

  // minimum distance from polygon edge to point
  function polygonEdgeDist(px, py, pts) {
    let m = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      m = Math.min(m, pointToSegmentDist(px, py, pts[j].x, pts[j].y, pts[i].x, pts[i].y));
    }
    return m;
  }

  function snapToGrid(v, grid) {
    if (!grid || grid <= 0) return v;
    return Math.round(v / grid) * grid;
  }

  function fmt(v, digits) {
    return Math.abs(v) < 1e-12 ? '0' : Number(v).toFixed(digits === undefined ? 4 : digits);
  }

  const PCBGeo = {
    EPS, dist, dist2, clamp,
    pointToSegmentDist, segmentSegmentDist, segmentsIntersect, lineLineIntersection,
    pointInPolygon, polygonArea, ptsBBox, rotatePoint, snapRoutePoint,
    arcToPoints, circleCircleIntersect, polylineCapsules,
    capsuleCircleDist, capsuleCapsuleDist, polygonEdgeDist, snapToGrid, fmt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PCBGeo;
  else global.PCBGeo = PCBGeo;
})(typeof window !== 'undefined' ? window : globalThis);
