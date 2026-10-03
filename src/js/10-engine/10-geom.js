/* WiFi Heatmap Architect - engine.geom: pure 2-D geometry on normalized points.
 *
 * Points are {x,y} in [0,1] over the 1080 x 942 px canvas. Anything that returns a distance returns CANVAS PIXELS
 * (the canvas is not square, so a normalized distance would be meaningless); areas are in normalized units
 * (fraction of the canvas, 0..1) unless the name ends in "Px".
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { clamp, isNum, round } = E.util;

  /** Distance between two normalized points, in canvas px. */
  function dist(a, b) {
    return Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
  }

  /** Distance between two normalized points in metres (mpp = metres per canvas px). */
  function distM(a, b, mpp) {
    return dist(a, b) * mpp;
  }

  /** Normalized point -> canvas px point. */
  function toPx(p) {
    return { x: p.x * W, y: p.y * H };
  }

  /** Canvas px -> normalized point. */
  function fromPx(x, y) {
    return { x: x / W, y: y / H };
  }

  /**
   * Even-odd point-in-polygon test (valid for normalized or px coordinates, the test is affine invariant).
   * @param {{x:number,y:number}} p
   * @param {Array<{x:number,y:number}>} pts polygon vertices
   */
  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /** Absolute polygon area in normalized units (fraction of the canvas). */
  function polygonArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /** Polygon area in canvas px^2. */
  function polygonAreaPx(pts) {
    return polygonArea(pts) * W * H;
  }

  /** Area centroid of a polygon (normalized). Degenerate polygons fall back to the vertex average. */
  function polygonCentroid(pts) {
    let a2 = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      const f = p.x * q.y - q.x * p.y;
      a2 += f;
      cx += (p.x + q.x) * f;
      cy += (p.y + q.y) * f;
    }
    if (Math.abs(a2) < 1e-12) {
      let sx = 0;
      let sy = 0;
      for (const p of pts) {
        sx += p.x;
        sy += p.y;
      }
      const n = pts.length || 1;
      return { x: sx / n, y: sy / n };
    }
    return { x: cx / (3 * a2), y: cy / (3 * a2) };
  }

  /** Distance (px) from px-point (x,y) to the segment (ax,ay)-(bx,by). Allocation free. */
  function pointSegDistPx(x, y, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }

  /** Signed distance (px) from p to the polygon outline: positive inside, negative outside. */
  function signedDistPx(p, pts) {
    const x = p.x * W;
    const y = p.y * H;
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const d = pointSegDistPx(x, y, pts[j].x * W, pts[j].y * H, pts[i].x * W, pts[i].y * H);
      if (d < best) best = d;
    }
    return pointInPolygon(p, pts) ? best : -best;
  }

  /**
   * "Visual centre" of a polygon: the point inside it that is farthest from the outline (pole of inaccessibility,
   * grid search with three refinement passes). Good anchor for room labels, also for L-shaped rooms.
   * @returns {{x:number,y:number}} normalized point
   */
  function labelPoint(pts) {
    if (!pts || !pts.length) return { x: 0.5, y: 0.5 };
    const bb = bbox(pts);
    const steps = 24;
    let x0 = bb.minX;
    let x1 = bb.maxX;
    let y0 = bb.minY;
    let y1 = bb.maxY;
    let best = null;
    let bestD = -Infinity;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < steps; i++) {
        for (let j = 0; j < steps; j++) {
          const p = { x: x0 + ((i + 0.5) / steps) * (x1 - x0), y: y0 + ((j + 0.5) / steps) * (y1 - y0) };
          const d = signedDistPx(p, pts);
          if (d > bestD) {
            bestD = d;
            best = p;
          }
        }
      }
      if (!best) break;
      const wx = ((x1 - x0) / steps) * 1.5;
      const wy = ((y1 - y0) / steps) * 1.5;
      x0 = best.x - wx;
      x1 = best.x + wx;
      y0 = best.y - wy;
      y1 = best.y + wy;
    }
    if (!best || bestD <= 0) return polygonCentroid(pts);
    return { x: best.x, y: best.y };
  }

  /**
   * Segment/segment intersection (inclusive ends). Computed in px space so the parallel test is meaningful.
   * @returns {{t:number,u:number,x:number,y:number}|null} t along a->b, u along c->d, (x,y) normalized; null when
   *          parallel/collinear or not touching.
   */
  function segIntersection(a, b, c, d) {
    const ax = a.x * W;
    const ay = a.y * H;
    const rx = b.x * W - ax;
    const ry = b.y * H - ay;
    const cx = c.x * W;
    const cy = c.y * H;
    const sx = d.x * W - cx;
    const sy = d.y * H - cy;
    const den = rx * sy - ry * sx;
    const scale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
    if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
    const qx = cx - ax;
    const qy = cy - ay;
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    const e = 1e-9;
    if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
    return { t, u, x: (ax + t * rx) / W, y: (ay + t * ry) / H };
  }

  /**
   * Closest point on segment a-b to p.
   * @returns {{x:number,y:number,t:number,d:number}} (x,y) normalized, t in [0,1] along a->b, d = distance in px.
   */
  function closestOnSegment(p, a, b) {
    const ax = a.x * W;
    const ay = a.y * H;
    const dx = b.x * W - ax;
    const dy = b.y * H - ay;
    const l2 = dx * dx + dy * dy;
    const px = p.x * W;
    const py = p.y * H;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return { x: qx / W, y: qy / H, t, d: Math.hypot(px - qx, py - qy) };
  }

  /** Axis aligned bounding box of points (normalized). Empty input -> null. */
  function bbox(pts) {
    if (!pts || !pts.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** orientation (cross product) helper in normalized space - kept identical to the legacy app on purpose. */
  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  /**
   * Is `pts` a usable polygon? 3..200 finite vertices, non self-intersecting, area > 2e-5 (normalized).
   * The crossing test is deliberately the same as in the legacy app, so every polygon we accept is also accepted by
   * the old app when it opens a file written by this one.
   */
  function validatePolygon(pts) {
    if (!Array.isArray(pts) || pts.length < 3 || pts.length > 200) return false;
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (!a || !isNum(a.x) || !isNum(a.y)) return false;
      const b = pts[(i + 1) % pts.length];
      if (!b || !isNum(b.x) || !isNum(b.y)) return false;
      area += a.x * b.y - b.x * a.y;
      for (let j = i + 2; j < pts.length; j++) {
        if (i === 0 && j === pts.length - 1) continue;
        const c = pts[j];
        const d = pts[(j + 1) % pts.length];
        if (!c || !d) return false;
        if (orient(a, b, c) * orient(a, b, d) < -1e-12 && orient(c, d, a) * orient(c, d, b) < -1e-12) return false;
      }
    }
    return Math.abs(area) / 2 > 0.00002;
  }

  /** Snap a normalized point to a grid of `step` (normalized units, default 0.01 = 1 % of the canvas). */
  function snapGrid(p, step = 0.01) {
    return { x: clamp(round(Math.round(p.x / step) * step), 0, 1), y: clamp(round(Math.round(p.y / step) * step), 0, 1) };
  }

  /** Four corner points (clockwise from a) of the axis aligned rectangle spanned by a and b. */
  function rectPoints(a, b) {
    return [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
      { x: a.x, y: b.y },
    ];
  }

  /** Project p onto the infinite line through a-b; returns the point on the segment (clamped) + t. Alias helper. */
  function projectToSegment(p, a, b) {
    const c = closestOnSegment(p, a, b);
    return { x: c.x, y: c.y, t: c.t };
  }

  /** Remove consecutive duplicate points and (optionally) collinear middle points; returns a new array. */
  function simplify(pts, tolPx = 0.5) {
    const out = [];
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last && dist(last, p) < tolPx) continue;
      out.push({ x: p.x, y: p.y });
    }
    if (out.length > 1 && dist(out[0], out[out.length - 1]) < tolPx) out.pop();
    // drop vertices lying on the line between their neighbours
    let changed = true;
    while (changed && out.length > 3) {
      changed = false;
      for (let i = 0; i < out.length; i++) {
        const a = out[(i + out.length - 1) % out.length];
        const b = out[i];
        const c = out[(i + 1) % out.length];
        if (closestOnSegment(b, a, c).d < tolPx) {
          out.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return out;
  }

  /** Compute the squared px distance between two px points. */
  function dist2Px(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }

  E.geom = {
    dist,
    distM,
    toPx,
    fromPx,
    pointInPolygon,
    polygonArea,
    polygonAreaPx,
    polygonCentroid,
    labelPoint,
    signedDistPx,
    pointSegDistPx,
    segIntersection,
    closestOnSegment,
    projectToSegment,
    bbox,
    validatePolygon,
    snapGrid,
    rectPoints,
    simplify,
    dist2Px,
  };
})();
