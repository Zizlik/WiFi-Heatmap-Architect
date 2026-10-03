// Faithful ports of the OLD app's validation + propagation code (puvodni-verze/index.cs.html), used by the tests to
//  - prove that files written by the new engine still pass the OLD loader (safePlan / cleanFloorSettings), and
//  - show that the new tracer fixes artifacts the old one produced.
// Do not "improve" anything in here: it is a reference.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

/** old validatePolygon (line 516) */
export function legacyValidatePolygon(ps) {
  if (ps.length < 3 || ps.length > 200) return false;
  let area = 0;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    const b = ps[(i + 1) % ps.length];
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 2; j < ps.length; j++) {
      if (i === 0 && j === ps.length - 1) continue;
      const c = ps[j];
      const d = ps[(j + 1) % ps.length];
      if (orient(a, b, c) * orient(a, b, d) < -1e-12 && orient(c, d, a) * orient(c, d, b) < -1e-12) return false;
    }
  }
  return Math.abs(area) > 0.00002;
}

/** old cleanFloorSettings (line 477) */
export function legacyCleanFloorSettings(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  if (Number.isFinite(raw.width) && raw.width >= 6 && raw.width <= 25) result.width = raw.width;
  for (const key of ['router', 'original', 'optic']) {
    const p = raw[key];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) result[key] = { x: p.x, y: p.y };
  }
  return result;
}

/** old safePlan (lines 593-602); throws on anything the old app refused. */
export function legacySafePlan(raw) {
  if (!raw || !['rooms', 'walls', 'doors', 'furniture'].every((k) => Array.isArray(raw[k]) && raw[k].length <= 250)) throw new Error('Soubor nema podporovana data pudorysu.');
  const point = (p) => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) throw new Error('Nektery bod je mimo mapu.');
    return { x: p.x, y: p.y };
  };
  const plan = { rooms: [], walls: [], doors: [], furniture: [], background: null };
  const ids = new Set();
  const roomids = new Set();
  for (const k of ['rooms', 'walls', 'doors', 'furniture']) {
    for (const r of raw[k]) {
      const type = { rooms: 'room', walls: 'wall', doors: 'door', furniture: 'furniture' }[k];
      const id = String(r.id).slice(0, 80);
      if (ids.has(id)) throw new Error('Duplicitni objekt v souboru.');
      ids.add(id);
      const o = { type, id, name: String(r.name || 'Bez nazvu').slice(0, 50) };
      if (type === 'room' || type === 'furniture') {
        if (!Array.isArray(r.points) || r.points.length > 200) throw new Error('Neplatny obrys.');
        o.points = r.points.map(point);
        if (!legacyValidatePolygon(o.points)) throw new Error('Neplatny nebo krizici se obrys.');
        if (type === 'room') {
          if (!Number.isInteger(r.roomId) || r.roomId < 1 || r.roomId > 250 || roomids.has(r.roomId)) throw new Error('Neplatne cislo mistnosti.');
          roomids.add(r.roomId);
          o.roomId = r.roomId;
          o.color = /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#6099d8';
        } else {
          o.loss = clamp(Number(r.loss) || 0, 0, 30);
          o.kind = ['custom', 'bed', 'wood', 'books', 'appliance', 'metal'].includes(r.kind) ? r.kind : 'custom';
          o.blocksSignal = r.blocksSignal !== false;
        }
      } else {
        o.a = point(r.a);
        o.b = point(r.b);
        if (type === 'wall' && Number.isFinite(r.loss)) {
          o.loss = clamp(r.loss, 0, 30);
          o.material = ['drywall', 'brick', 'concrete', 'reinforced_concrete', 'glass', 'wood', 'metal', 'masonry', 'solid_guess', 'custom'].includes(r.material) ? r.material : 'custom';
        }
        if (type === 'door') {
          o.wallId = String(r.wallId).slice(0, 80);
          o.loss = clamp(Number(r.loss) || 0, 0, 30);
        }
      }
      plan[k].push(o);
    }
  }
  for (const d of plan.doors) if (!plan.walls.some((w) => w.id === d.wallId)) throw new Error('Dvere nemaji svoji zed.');
  if (typeof raw.background === 'string' && raw.background.length < 7000000 && /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(raw.background)) plan.background = raw.background;
  return plan;
}

/**
 * What the old app does with an SVG file's text (DOM-free equivalent of parseFloorSvg + the metadata branch of
 * importFloorFile): finds <metadata id="wifi-plan-data">, decodes it, requires format 'wifi-floor-v2', runs safePlan and
 * cleanFloorSettings. Returns {plan, settings, data}; throws like the old app.
 */
export function legacyLoadSvg(source) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('SVG contains definitions');
  const m = /<metadata id="wifi-plan-data">([\s\S]*?)<\/metadata>/.exec(source);
  if (!m) throw new Error('no metadata');
  const text = m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const data = JSON.parse(text);
  if (data.format !== 'wifi-floor-v2') throw new Error('unsupported format');
  const plan = legacySafePlan(data.plan);
  return { plan, settings: legacyCleanFloorSettings(data), data };
}

// ---------------------------------------------------------------------------------------------------------------
// old propagation (walls only) - lines 176-190, 191
// ---------------------------------------------------------------------------------------------------------------

function crossingPoint(a, b, c, d) {
  const rx = b.x - a.x;
  const ry = b.y - a.y;
  const sx = d.x - c.x;
  const sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-10) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t <= 0.0001 || t >= 0.9999 || u < 0 || u > 1) return null;
  return { x: a.x + t * rx, y: a.y + t * ry, t };
}
function alongWall(a, b, w) {
  if (Math.abs(orient(a, b, w.a)) > 1e-9 || Math.abs(orient(a, b, w.b)) > 1e-9) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const den = dx * dx + dy * dy;
  if (den < 1e-12) return null;
  const t = (p) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / den;
  const lo = Math.max(0.0001, Math.min(t(w.a), t(w.b)));
  const hi = Math.min(0.9999, Math.max(t(w.a), t(w.b)));
  if (hi - lo < 0.0001) return null;
  return { x: a.x + (dx * (lo + hi)) / 2, y: a.y + (dy * (lo + hi)) / 2, along: true };
}

/** old obstacleLoss for walls only (no doors / furniture), normalized points. */
export function legacyWallLoss(walls, defaultLoss, a, b) {
  let loss = 0;
  const seen = [];
  for (const w of walls) {
    const p = crossingPoint(a, b, w.a, w.b) || alongWall(a, b, w);
    if (!p || seen.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.002)) continue;
    seen.push(p);
    loss += Number.isFinite(w.loss) ? w.loss : defaultLoss;
  }
  return loss;
}
