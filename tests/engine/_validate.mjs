// Independent invariant checker for sanitized projects (SPEC section 3.1) - does not use the engine's own validators
// except geometry (validatePolygon), which has its own tests.
import assert from 'node:assert/strict';
import { E } from './_load.mjs';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;
const isPoint = (p) => p && num(p.x) && num(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const nullOr = (v, lo, hi) => v === null || inRange(v, lo, hi);

export function assertValidProject(p, label = 'project') {
  const fail = (m) => assert.fail(`${label}: ${m}`);
  if (p.v !== 3) fail('v');
  if (typeof p.name !== 'string' || !p.name || p.name.length > 200) fail('name');
  const plan = p.plan;
  const ids = new Set();
  const roomIds = new Set();
  for (const k of ['rooms', 'walls', 'doors', 'furniture']) {
    if (!Array.isArray(plan[k]) || plan[k].length > 250) fail(`${k} array`);
    for (const o of plan[k]) {
      if (typeof o.id !== 'string' || !o.id || o.id.length > 80 || ids.has(o.id)) fail(`id ${o.id}`);
      ids.add(o.id);
      if (o.type !== { rooms: 'room', walls: 'wall', doors: 'door', furniture: 'furniture' }[k]) fail(`type of ${o.id}`);
      if (typeof o.name !== 'string' || [...o.name].length > 50) fail(`name of ${o.id}`);
      if (/[\u0000-\u001f\u007f-\u009f]/.test(o.name)) fail(`control chars in name of ${o.id}`);
    }
  }
  for (const r of plan.rooms) {
    if (!Number.isInteger(r.roomId) || r.roomId < 1 || r.roomId > 250 || roomIds.has(r.roomId)) fail(`roomId ${r.roomId}`);
    roomIds.add(r.roomId);
    if (!/^#[0-9a-f]{6}$/.test(r.color)) fail(`color ${r.color}`);
    if (!r.points.every(isPoint) || !E.geom.validatePolygon(r.points)) fail(`polygon of ${r.id}`);
  }
  for (const f of plan.furniture) {
    if (!f.points.every(isPoint) || !E.geom.validatePolygon(f.points)) fail(`polygon of ${f.id}`);
    if (!inRange(f.loss, 0, 30) || !['custom', 'bed', 'wood', 'books', 'appliance', 'metal'].includes(f.kind) || typeof f.blocksSignal !== 'boolean') fail(`furniture ${f.id}`);
  }
  const wallIds = new Set(plan.walls.map((w) => w.id));
  for (const w of plan.walls) {
    if (!isPoint(w.a) || !isPoint(w.b)) fail(`wall points ${w.id}`);
    if ((w.loss !== undefined) !== (w.material !== undefined)) fail(`wall loss/material pair ${w.id}`);
    if (w.loss !== undefined && !inRange(w.loss, 0, 30)) fail(`wall loss ${w.id}`);
  }
  for (const d of plan.doors) {
    if (!isPoint(d.a) || !isPoint(d.b) || !wallIds.has(d.wallId) || !inRange(d.loss, 0, 30)) fail(`door ${d.id}`);
  }
  if (plan.background !== null && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(plan.background)) fail('background');

  if (!(num(p.scale.mpp) && p.scale.mpp > 0)) fail('mpp');
  const n = p.net;
  for (const k of ['router', 'baseline', 'optic']) if (!isPoint(n[k])) fail(`net.${k}`);
  if (plan.rooms.length) {
    for (const k of ['router', 'baseline']) if (!E.project.floorMaskAt(plan, n[k])) fail(`net.${k} is not on the floor`);
    if (!E.project.floorMaskAt(plan, p.node.pos)) fail('node.pos is not on the floor');
  }
  for (const k of ['wanDown', 'wanUp']) if (!nullOr(n[k], 0, 10000)) fail(`net.${k}`);
  for (const k of ['wanPort', 'ontPort', 'wanLink']) if (!(n[k] === null || [100, 1000, 2500, 5000, 10000].includes(n[k]))) fail(`net.${k}`);
  if (!['unknown', 'cat5', 'cat5e', 'cat6', 'cat6a', 'cat7', 'cat8'].includes(n.cableCategory)) fail('cableCategory');
  if (!nullOr(n.cableLength, 0.1, 500)) fail('cableLength');
  const nd = p.node;
  if (!['none', 'ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'].includes(nd.mode)) fail('node.mode');
  if (!inRange(nd.power, -10, 6) || !inRange(nd.backhaulThreshold, -80, -55) || ![2.4, 5, 6].includes(nd.backhaulBand)) fail('node numbers');
  if (!['2.4', '5', '6'].every((b) => typeof nd.bands[b] === 'boolean')) fail('node.bands');
  if (Object.values(nd.bands).some(Boolean) && !nd.bands[String(nd.backhaulBand)]) fail('backhaul band is not enabled on the node');
  const m = p.model;
  if (!inRange(m.nearSignal, -55, -25) || !inRange(m.n, 1.6, 4) || !inRange(m.wallLoss, 0, 20) || !inRange(m.threshold, -75, -55) || !inRange(m.rangeThreshold, -80, -45)) fail('model');
  // per-band transmit power difference (SPEC 7.1)
  if (!m.bandPower || Object.keys(m.bandPower).sort().join() !== '2.4,5,6' || !['2.4', '5', '6'].every((k) => inRange(m.bandPower[k], -10, 6))) fail('model.bandPower');
  assert.deepEqual(Object.keys(m).sort(), ['bandPower', 'n', 'nearSignal', 'rangeThreshold', 'threshold', 'wallLoss'], `${label}: model keys`);
  for (const w of plan.walls) if (w.material !== undefined && !['drywall', 'brick', 'concrete', 'reinforced_concrete', 'glass', 'wood', 'metal', 'masonry', 'solid_guess', 'custom'].includes(w.material)) fail(`wall material ${w.id}`);
  const g = p.goal;
  if (!(g.room === 'all' || roomIds.has(g.room))) fail('goal.room');
  if (!(g.allowedRoom === 'any' || roomIds.has(g.allowedRoom))) fail('goal.allowedRoom');
  if (!Array.isArray(g.excluded) || g.excluded.some((id) => !roomIds.has(id)) || new Set(g.excluded).size !== g.excluded.length) fail('goal.excluded');
  if (!['signal', 'speed'].includes(g.mode) || !inRange(g.targetDown, 1, 10000) || !inRange(g.targetUp, 1, 10000) || !inRange(g.reserve, 0, 80)) fail('goal numbers');
  if (typeof g.device !== 'string' || !g.device || g.device.length > 50) fail('goal.device');
  if (!Array.isArray(p.measurements) || p.measurements.length > 500) fail('measurements');
  const mids = new Set();
  for (const q of p.measurements) {
    // the signal may be missing (null) only on a speed-test point that has both download and upload (SPEC 6.2)
    const signalOk = inRange(q.value, -100, -20) || (q.value === null && inRange(q.download, 0, 10000) && inRange(q.upload, 0, 10000));
    if (typeof q.id !== 'string' || mids.has(q.id) || !isPoint(q) || ![2.4, 5, 6].includes(q.band) || !signalOk) fail(`measurement ${q.id}`);
    mids.add(q.id);
    if (!nullOr(q.download, 0, 10000) || !nullOr(q.upload, 0, 10000) || typeof q.name !== 'string' || q.name.length > 50 || typeof q.device !== 'string' || q.device.length > 50 || !num(q.t)) fail(`measurement fields ${q.id}`);
    // optional speed-test extras: present only when known
    if ('ping' in q && !inRange(q.ping, 0, 10000)) fail(`measurement ping ${q.id}`);
    if ('jitter' in q && !inRange(q.jitter, 0, 10000)) fail(`measurement jitter ${q.id}`);
    if ('source' in q && q.source !== 'cloudflare') fail(`measurement source ${q.id}`);
    for (const k of Object.keys(q)) if (!['id', 'x', 'y', 'band', 'value', 'name', 'download', 'upload', 'device', 't', 'ping', 'jitter', 'source'].includes(k)) fail(`measurement ${q.id}: stray key ${k}`);
  }
  const v = p.view;
  if (![2.4, 5, 6].includes(v.band) || !['signal', 'speed', 'diff'].includes(v.layer) || !['default', 'cb'].includes(v.palette)) fail('view');
  for (const k of ['ranges', 'walls', 'furniture', 'labels', 'values', 'calibrate']) if (typeof v[k] !== 'boolean') fail(`view.${k}`);
  // no stray keys at the top level
  assert.deepEqual(Object.keys(p).sort(), ['goal', 'measurements', 'model', 'name', 'net', 'node', 'plan', 'scale', 'v', 'view'], `${label}: top-level keys`);
}

/** Minimal XML well-formedness check: balanced tags, quoted attributes, only known entities. */
export function assertWellFormedXml(xml) {
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(xml), 'illegal XML characters');
  const stack = [];
  const tag = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  let last = 0;
  let m;
  let text = '';
  while ((m = tag.exec(xml))) {
    text += xml.slice(last, m.index);
    last = tag.lastIndex;
    if (m[1]) {
      assert.equal(stack.pop(), m[2], `closing </${m[2]}> does not match`);
    } else if (!m[4]) stack.push(m[2]);
  }
  text += xml.slice(last);
  assert.deepEqual(stack, [], 'unclosed tags');
  assert.ok(!/<[^>]*$/.test(xml.replace(tag, '')), 'stray <');
  const noEntities = text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
  assert.ok(!/[&<]/.test(noEntities), 'raw & or < in text');
  // attribute values: entities must be valid too
  for (const a of xml.matchAll(/\s[\w:-]+\s*=\s*"([^"]*)"/g)) assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(a[1]), `bad entity in attribute: ${a[1].slice(0, 40)}`);
}
