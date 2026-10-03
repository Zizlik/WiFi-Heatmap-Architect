/* WiFi Heatmap Architect - engine.edit: small, pure helpers for the floor-plan editor.
 *
 * They only deal with plan geometry (normalized points) so they can be unit tested without a DOM. Functions that
 * change a plan do it IN PLACE and are meant to run inside a store.commit()/store.live() mutator; helpers that build
 * a new object (makeDoor) return it without adding it.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const geom = E.geom;
  const { clamp, round, isNum, fail } = E.util;

  const MIN_DOOR_PX = 8;

  /**
   * The wall closest to a point.
   * @param {object} plan
   * @param {{x:number,y:number}} p normalized point (e.g. the mouse position)
   * @param {{maxPx?:number, exclude?:string}} [opts] maxPx: largest accepted distance in canvas px (default 12);
   *        exclude: a wall id to skip
   * @returns {{wall:object, x:number, y:number, t:number, d:number}|null} (x,y) = closest point on the wall
   *          (normalized), t in [0,1] along wall.a -> wall.b, d = distance in px
   */
  function nearestWall(plan, p, opts) {
    const o = opts || {};
    const maxPx = isNum(o.maxPx) ? o.maxPx : 12;
    let best = null;
    for (const w of plan.walls || []) {
      if (w.id === o.exclude) continue;
      const c = geom.closestOnSegment(p, w.a, w.b);
      if (c.d <= maxPx && (!best || c.d < best.d)) best = { wall: w, x: c.x, y: c.y, t: c.t, d: c.d };
    }
    return best;
  }

  /**
   * A door (or open doorway) on a wall, centred at the projection of `p`, `widthM` wide, kept entirely inside the wall.
   * A wall shorter than the door gets a door of 80 % of its length. The door is NOT added to the plan.
   * @param {object} plan
   * @param {string} wallId
   * @param {{x:number,y:number}} p normalized click point
   * @param {{widthM?:number, mpp?:number, loss?:number, name?:string, lang?:'cs'|'en'}} [opts]
   *        widthM default 0.9, mpp default 0.012, loss default 0 (open doorway; ~3 = closed door)
   * @returns {object} door {id, type:'door', name, a, b, wallId, loss}
   * @throws {Error} 'err.plan.door' when the wall does not exist
   */
  function makeDoor(plan, wallId, p, opts) {
    const o = opts || {};
    const wall = (plan.walls || []).find((w) => w.id === wallId);
    if (!wall) throw fail('err.plan.door');
    const ax = wall.a.x * W;
    const ay = wall.a.y * H;
    const len = Math.hypot(wall.b.x * W - ax, wall.b.y * H - ay);
    const mpp = isNum(o.mpp) && o.mpp > 0 ? o.mpp : 0.012;
    const widthPx = Math.max(MIN_DOOR_PX, (isNum(o.widthM) ? o.widthM : 0.9) / mpp);
    const c = geom.closestOnSegment(p, wall.a, wall.b);
    let half = Math.min(widthPx, len * 0.8) / 2;
    if (len <= 0) half = 0;
    const center = clamp(c.t * len, half, Math.max(half, len - half));
    const at = (s) => {
      const t = len > 0 ? s / len : 0;
      return { x: round(wall.a.x + (wall.b.x - wall.a.x) * t), y: round(wall.a.y + (wall.b.y - wall.a.y) * t) };
    };
    return {
      id: E.project.nextId(plan, 'door'),
      type: 'door',
      name: o.name || E.text.t('engine.name.door', o.lang),
      a: at(center - half),
      b: at(center + half),
      wallId,
      loss: clamp(isNum(o.loss) ? o.loss : 0, 0, 30),
    };
  }

  /**
   * After a wall was moved or reshaped, put its doors back on it: every door keeps its relative position along the
   * wall. Mutates plan.doors.
   * @param {object} plan
   * @param {string} wallId
   * @param {{a:{x,y}, b:{x,y}}} oldWall the wall's endpoints BEFORE the change
   * @returns {number} number of doors moved
   */
  function fitDoors(plan, wallId, oldWall) {
    const wall = (plan.walls || []).find((w) => w.id === wallId);
    if (!wall) return 0;
    let moved = 0;
    for (const d of plan.doors || []) {
      if (d.wallId !== wallId) continue;
      for (const k of ['a', 'b']) {
        const t = geom.closestOnSegment(d[k], oldWall.a, oldWall.b).t;
        d[k] = { x: round(wall.a.x + (wall.b.x - wall.a.x) * t), y: round(wall.a.y + (wall.b.y - wall.a.y) * t) };
      }
      moved++;
    }
    return moved;
  }

  /**
   * Delete an object by id from rooms / walls / doors / furniture. Deleting a wall also deletes its doors.
   * Mutates the plan.
   * @returns {string[]} ids that were removed (empty when the id was not found)
   */
  function removeObject(plan, id) {
    const removed = [];
    for (const k of ['rooms', 'walls', 'doors', 'furniture']) {
      const list = plan[k] || [];
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === id) {
          removed.push(id);
          list.splice(i, 1);
        }
      }
    }
    if (removed.length && (plan.doors || []).length) {
      for (let i = plan.doors.length - 1; i >= 0; i--) {
        if (!plan.walls.some((w) => w.id === plan.doors[i].wallId)) {
          removed.push(plan.doors[i].id);
          plan.doors.splice(i, 1);
        }
      }
    }
    return removed;
  }

  /**
   * Snap a point for drawing: first to an existing vertex (room / furniture corner, wall or door end) within
   * `vertexPx` canvas px, otherwise to the grid, otherwise unchanged.
   * @param {object} plan
   * @param {{x:number,y:number}} p normalized
   * @param {{vertexPx?:number, grid?:number|false, exclude?:string}} [opts] vertexPx default 8; grid = step in
   *        normalized units (default 0.01, false = no grid); exclude = id of the object being edited
   * @returns {{x:number,y:number,kind:'vertex'|'grid'|'none'}}
   */
  function snapPoint(plan, p, opts) {
    const o = opts || {};
    const vertexPx = isNum(o.vertexPx) ? o.vertexPx : 8;
    let best = null;
    const consider = (q) => {
      const d = geom.dist(p, q);
      if (d <= vertexPx && (!best || d < best.d)) best = { d, x: q.x, y: q.y };
    };
    for (const k of ['rooms', 'furniture']) for (const obj of plan[k] || []) if (obj.id !== o.exclude) for (const q of obj.points) consider(q);
    for (const k of ['walls', 'doors']) {
      for (const obj of plan[k] || []) {
        if (obj.id === o.exclude) continue;
        consider(obj.a);
        consider(obj.b);
      }
    }
    if (best) return { x: best.x, y: best.y, kind: 'vertex' };
    if (o.grid !== false) {
      const s = geom.snapGrid(p, isNum(o.grid) ? o.grid : 0.01);
      return { x: s.x, y: s.y, kind: 'grid' };
    }
    return { x: p.x, y: p.y, kind: 'none' };
  }

  E.edit = { nearestWall, makeDoor, fitDoors, removeObject, snapPoint };
})();
