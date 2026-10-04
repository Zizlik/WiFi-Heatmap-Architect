// Independent invariant checker for sanitized projects (SPEC section 3.1 + 14) - does not use the engine's own validators
// except geometry (validatePolygon), which has its own tests.
import assert from 'node:assert/strict';
import { E } from './_load.mjs';

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => num(v) && v >= lo && v <= hi;
const isPoint = (p) => p && num(p.x) && num(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const nullOr = (v, lo, hi) => v === null || inRange(v, lo, hi);
const inPlan = (plan, p) => plan.rooms.some((r) => E.geom.pointInPolygon(p, r.points));

/** One floor plan: ids, types, names, polygons, walls / doors / furniture. Returns the set of its room ids. */
function checkPlan(plan, fail) {
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
    if (w.material !== undefined && !['drywall', 'brick', 'concrete', 'reinforced_concrete', 'glass', 'wood', 'metal', 'masonry', 'solid_guess', 'custom'].includes(w.material)) fail(`wall material ${w.id}`);
  }
  for (const d of plan.doors) {
    if (!isPoint(d.a) || !isPoint(d.b) || !wallIds.has(d.wallId) || !inRange(d.loss, 0, 30)) fail(`door ${d.id}`);
  }
  if (plan.background !== null && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(plan.background)) fail('background');
  assert.deepEqual(Object.keys(plan).sort(), ['background', 'doors', 'furniture', 'rooms', 'walls'], 'plan keys');
  return roomIds;
}

/** One node of SPEC 14.2 (positions are checked against its floor's plan by the caller). */
function checkNode(nd, fail) {
  assert.deepEqual(Object.keys(nd).sort(), ['backhaulBand', 'backhaulThreshold', 'bands', 'enabled', 'id', 'maxMbps', 'mode', 'name', 'pos', 'power', 'uplink'], `node keys of ${nd.id}`);
  if (typeof nd.id !== 'string' || !nd.id || nd.id === 'router') fail(`node id ${nd.id}`);
  if (typeof nd.name !== 'string' || !nd.name || [...nd.name].length > 50) fail(`node name ${nd.id}`);
  if (!['ap_cable', 'mesh_cable', 'mesh_wifi', 'repeater'].includes(nd.mode)) fail(`node.mode ${nd.id}`);
  if (!isPoint(nd.pos)) fail(`node.pos ${nd.id}`);
  if (!inRange(nd.power, -10, 6) || !inRange(nd.backhaulThreshold, -80, -55) || ![2.4, 5, 6].includes(nd.backhaulBand)) fail(`node numbers ${nd.id}`);
  if (!['2.4', '5', '6'].every((b) => typeof nd.bands[b] === 'boolean')) fail(`node.bands ${nd.id}`);
  // SPEC 10: the node's ceiling in whole Mb/s, null = unknown
  if (!(nd.maxMbps === null || (Number.isInteger(nd.maxMbps) && nd.maxMbps >= 10 && nd.maxMbps <= 10000))) fail(`node.maxMbps ${nd.id}`);
  if (Object.values(nd.bands).some(Boolean) && !nd.bands[String(nd.backhaulBand)]) fail(`backhaul band is not enabled on node ${nd.id}`);
  if (typeof nd.uplink !== 'string' || !nd.uplink || nd.uplink === nd.id) fail(`node.uplink ${nd.id}`);
  if (typeof nd.enabled !== 'boolean') fail(`node.enabled ${nd.id}`);
}

/** One measurement list. `mids` = ids seen in the building (unique across floors). */
function checkMeasurements(list, mids, label, fail) {
  if (!Array.isArray(list) || list.length > 500) fail('measurements');
  for (const q of list) {
    // the signal may be missing (null) only on a speed-test point that has both download and upload (SPEC 6.2)
    const signalOk = inRange(q.value, -100, -20) || (q.value === null && inRange(q.download, 0, 10000) && inRange(q.upload, 0, 10000));
    // band null = "Nevím (automaticky)" (SPEC 13), inferred by the engine
    if (typeof q.id !== 'string' || mids.has(q.id) || !isPoint(q) || ![2.4, 5, 6, null].includes(q.band) || !signalOk) fail(`measurement ${q.id}`);
    mids.add(q.id);
    if (!nullOr(q.download, 0, 10000) || !nullOr(q.upload, 0, 10000) || typeof q.name !== 'string' || q.name.length > 50 || typeof q.device !== 'string' || q.device.length > 50 || !num(q.t)) fail(`measurement fields ${q.id}`);
    // optional speed-test extras: present only when known
    if ('ping' in q && !inRange(q.ping, 0, 10000)) fail(`measurement ping ${q.id}`);
    if ('jitter' in q && !inRange(q.jitter, 0, 10000)) fail(`measurement jitter ${q.id}`);
    if ('source' in q && q.source !== 'cloudflare') fail(`measurement source ${q.id}`);
    // optional Wi-Fi details / measuring device (SPEC 8): present only when known
    if ('wifi' in q) {
      const w = q.wifi;
      assert.deepEqual(Object.keys(w).filter((k) => k !== 'links').sort(), ['band', 'bssid', 'channel', 'radio', 'rxRate', 'security', 'ssid', 'txRate'], `${label}: wifi keys of ${q.id}`);
      // Wi-Fi 7 MLO links (SPEC 13): only when known, 1..4, strongest first, every field validated
      if ('links' in w) {
        const L = w.links;
        if (!Array.isArray(L) || !L.length || L.length > 4) fail(`measurement wifi links ${q.id}`);
        for (const l of L) {
          assert.deepEqual(Object.keys(l).sort(), ['band', 'channel', 'rssiDbm', 'widthMHz'], `${label}: link keys of ${q.id}`);
          if (!(l.band === null || [2.4, 5, 6].includes(l.band)) || !(l.channel === null || (Number.isInteger(l.channel) && l.channel >= 1 && l.channel <= 233)) || !nullOr(l.rssiDbm, -110, -20) || !(l.widthMHz === null || [20, 40, 80, 160, 320].includes(l.widthMHz))) fail(`measurement wifi link ${q.id}`);
          if (l.band === null && l.channel === null && l.rssiDbm === null) fail(`empty link kept on ${q.id}`);
        }
        for (let i = 1; i < L.length; i++) if (L[i].rssiDbm !== null && (L[i - 1].rssiDbm === null || L[i - 1].rssiDbm < L[i].rssiDbm)) fail(`links not strongest first on ${q.id}`);
      }
      if (!(w.ssid === null || (typeof w.ssid === 'string' && [...w.ssid].length <= 64)) || !(w.bssid === null || /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(w.bssid))) fail(`measurement wifi ${q.id}`);
      if (!(w.channel === null || (Number.isInteger(w.channel) && w.channel >= 1 && w.channel <= 233)) || !(w.band === null || [2.4, 5, 6].includes(w.band)) || !nullOr(w.rxRate, 0, 100000) || !nullOr(w.txRate, 0, 100000)) fail(`measurement wifi numbers ${q.id}`);
      if (Object.values(w).every((v) => v === null)) fail(`empty wifi kept on ${q.id}`);
    }
    if ('deviceInfo' in q) {
      const d = q.deviceInfo;
      assert.deepEqual(Object.keys(d).sort(), ['browser', 'connType', 'model', 'os'], `${label}: deviceInfo keys of ${q.id}`);
      if (Object.values(d).every((v) => v === null)) fail(`empty deviceInfo kept on ${q.id}`);
    }
    for (const k of Object.keys(q)) if (!['id', 'x', 'y', 'band', 'value', 'name', 'download', 'upload', 'device', 't', 'ping', 'jitter', 'source', 'wifi', 'deviceInfo'].includes(k)) fail(`measurement ${q.id}: stray key ${k}`);
  }
}

/** {room, excluded} of a floor against its room ids. */
function checkRoomGoal(g, roomIds, fail, where) {
  if (!(g.room === 'all' || roomIds.has(g.room))) fail(`${where} goal.room`);
  if (!Array.isArray(g.excluded) || g.excluded.some((id) => !roomIds.has(id)) || new Set(g.excluded).size !== g.excluded.length) fail(`${where} goal.excluded`);
}

export function assertValidProject(p, label = 'project') {
  const fail = (m) => assert.fail(`${label}: ${m}`);
  if (p.v !== 3) fail('v');
  if (typeof p.name !== 'string' || !p.name || p.name.length > 200) fail('name');
  // no stray keys at the top level (SPEC 14: nodes + floors replace the single node)
  assert.deepEqual(Object.keys(p).sort(), ['floors', 'goal', 'measurements', 'model', 'name', 'net', 'nodes', 'plan', 'scale', 'v', 'view'], `${label}: top-level keys`);
  const plan = p.plan;
  const roomIds = checkPlan(plan, fail);

  // ---- floors (SPEC 14.3): the active one's content is the top level ----
  if (!Array.isArray(p.floors) || p.floors.length < 1 || p.floors.length > 9) fail('floors');
  const fids = new Set();
  const holes = p.floors.filter((f) => f.plan === null);
  if (holes.length !== 1 || holes[0].id !== p.view.floor) fail('exactly the active floor (view.floor) holds null content');
  const floorPlan = new Map();
  const floorRooms = new Map();
  let lastLevel = -Infinity;
  for (const f of p.floors) {
    assert.deepEqual(Object.keys(f).sort(), ['ceiling', 'goal', 'id', 'level', 'measurements', 'name', 'nodes', 'plan'], `${label}: floor keys`);
    if (typeof f.id !== 'string' || !f.id || fids.has(f.id)) fail(`floor id ${f.id}`);
    fids.add(f.id);
    if (typeof f.name !== 'string' || !f.name || [...f.name].length > 50) fail(`floor name ${f.id}`);
    if (!Number.isInteger(f.level) || f.level < -3 || f.level > 20 || f.level <= lastLevel) fail(`floor levels unique and ascending (${f.id})`);
    lastLevel = f.level;
    const c = f.ceiling;
    assert.deepEqual(Object.keys(c).sort(), ['heightM', 'lossDb', 'material'], `${label}: ceiling keys`);
    if (!['concrete', 'reinforced_concrete', 'wood', 'custom'].includes(c.material) || !inRange(c.lossDb, 0, 40) || !inRange(c.heightM, 2, 6)) fail(`ceiling of ${f.id}`);
    if (c.material !== 'custom' && c.lossDb !== { concrete: 15, reinforced_concrete: 20, wood: 8 }[c.material]) fail(`preset ceiling with another number ${f.id}`);
    if (f.plan === null) {
      if (f.nodes !== null || f.measurements !== null || f.goal !== null) fail(`active floor ${f.id} keeps content`);
      floorPlan.set(f.id, plan);
      floorRooms.set(f.id, roomIds);
    } else {
      const ids = checkPlan(f.plan, (m) => fail(`floor ${f.id}: ${m}`));
      floorPlan.set(f.id, f.plan);
      floorRooms.set(f.id, ids);
      if (!Array.isArray(f.nodes) || !Array.isArray(f.measurements)) fail(`floor ${f.id} lists`);
      assert.deepEqual(Object.keys(f.goal).sort(), ['excluded', 'room'], `${label}: floor goal keys`);
      checkRoomGoal(f.goal, ids, fail, `floor ${f.id}`);
    }
  }

  // ---- scale (SPEC 14.1) ----
  assert.deepEqual(Object.keys(p.scale).sort(), ['method', 'mpp', 'ref', 'verified'], `${label}: scale keys`);
  if (!(num(p.scale.mpp) && p.scale.mpp > 0)) fail('mpp');
  if (typeof p.scale.verified !== 'boolean' || !['two-points', 'area', 'width', 'import', 'default'].includes(p.scale.method)) fail('scale');
  if (!(p.scale.ref === null || (typeof p.scale.ref === 'object' && !Array.isArray(p.scale.ref)))) fail('scale.ref');

  // ---- net ----
  const n = p.net;
  for (const k of ['router', 'baseline', 'optic']) if (!isPoint(n[k])) fail(`net.${k}`);
  if (!fids.has(n.routerFloor) || !fids.has(n.opticFloor)) fail('net.routerFloor / opticFloor');
  const rPlan = floorPlan.get(n.routerFloor);
  if (rPlan && rPlan.rooms.length) for (const k of ['router', 'baseline']) if (!inPlan(rPlan, n[k])) fail(`net.${k} is not on the router's floor`);
  for (const k of ['wanDown', 'wanUp']) if (!nullOr(n[k], 0, 10000)) fail(`net.${k}`);
  for (const k of ['wanPort', 'ontPort', 'wanLink']) if (!(n[k] === null || [100, 1000, 2500, 5000, 10000].includes(n[k]))) fail(`net.${k}`);
  if (!['unknown', 'cat5', 'cat5e', 'cat6', 'cat6a', 'cat7', 'cat8'].includes(n.cableCategory)) fail('cableCategory');
  if (!nullOr(n.cableLength, 0.1, 500)) fail('cableLength');
  // SPEC 13: the bands the router sends - booleans, at least one on
  if (!n.routerBands || Object.keys(n.routerBands).sort().join() !== '2.4,5,6' || !['2.4', '5', '6'].every((b) => typeof n.routerBands[b] === 'boolean') || !Object.values(n.routerBands).some(Boolean)) fail('net.routerBands');
  assert.deepEqual(Object.keys(n).sort(), ['baseline', 'cableCategory', 'cableLength', 'ontPort', 'optic', 'opticFloor', 'router', 'routerBands', 'routerFloor', 'wanDown', 'wanLink', 'wanPort', 'wanUp'], `${label}: net keys`);

  // ---- nodes (SPEC 14.2): <= 8 in the building, unique ids, valid uplinks, on their floor ----
  if (!Array.isArray(p.nodes)) fail('nodes');
  const all = [];
  for (const f of p.floors) for (const nd of f.plan === null ? p.nodes : f.nodes) all.push({ nd, floor: f.id });
  if (all.length > 8) fail('more than 8 nodes');
  const nids = new Set();
  for (const { nd, floor } of all) {
    checkNode(nd, fail);
    if (nids.has(nd.id)) fail(`duplicate node id ${nd.id}`);
    nids.add(nd.id);
    const fp = floorPlan.get(floor);
    if (fp.rooms.length && !inPlan(fp, nd.pos)) fail(`node ${nd.id} is not on its floor`);
  }
  for (const { nd } of all) if (nd.uplink !== 'router' && !nids.has(nd.uplink)) fail(`node ${nd.id} uplinks to nothing`);
  for (const { nd } of all) {
    // no cycles
    const seen = new Set([nd.id]);
    let cur = nd;
    while (cur.uplink !== 'router') {
      cur = all.find((x) => x.nd.id === cur.uplink).nd;
      if (seen.has(cur.id)) fail(`uplink cycle at ${nd.id}`);
      seen.add(cur.id);
    }
  }

  // ---- model ----
  const m = p.model;
  if (!inRange(m.nearSignal, -55, -25) || !inRange(m.n, 1.6, 4) || !inRange(m.wallLoss, 0, 20) || !inRange(m.threshold, -75, -55) || !inRange(m.rangeThreshold, -80, -45)) fail('model');
  // per-band transmit power difference (SPEC 7.1)
  if (!m.bandPower || Object.keys(m.bandPower).sort().join() !== '2.4,5,6' || !['2.4', '5', '6'].every((k) => inRange(m.bandPower[k], -10, 6))) fail('model.bandPower');
  // band-steering thresholds (SPEC 13)
  if (!m.steer || Object.keys(m.steer).sort().join() !== 'five,six' || !inRange(m.steer.six, -90, -50) || !inRange(m.steer.five, -90, -50)) fail('model.steer');
  // the calibration fit of SPEC 9 is optional (present only after the wizard), older projects keep the exact key set
  assert.deepEqual(Object.keys(m).filter((k) => k !== 'fit').sort(), ['bandPower', 'n', 'nearSignal', 'rangeThreshold', 'steer', 'threshold', 'wallLoss'], `${label}: model keys`);
  if ('fit' in m) {
    const f = m.fit;
    if (!inRange(f.n, 1.6, 4) || !inRange(f.wallFactor, 0.5, 2) || !['offset', 'offset+n+walls'].includes(f.method) || !Number.isInteger(f.count) || !Number.isInteger(f.at)) fail('model.fit');
    if (!f.fitted || typeof f.fitted.n !== 'boolean' || typeof f.fitted.wallFactor !== 'boolean') fail('model.fit.fitted');
    for (const [k, b] of Object.entries(f.byBand)) {
      if (!['2.4', '5', '6'].includes(k) || !inRange(b.offset, -40, 40) || !inRange(b.rms, 0, 100) || !nullOr(b.looRms, 0, 100) || !Number.isInteger(b.count) || !Array.isArray(b.outliers)) fail(`model.fit.byBand.${k}`);
    }
  }

  // ---- goal: room / excluded of the active floor, allowedRoom of the router's floor ----
  const g = p.goal;
  checkRoomGoal(g, roomIds, fail, 'active');
  const rRooms = floorRooms.get(n.routerFloor);
  if (!(g.allowedRoom === 'any' || (rRooms && rRooms.has(g.allowedRoom)))) fail('goal.allowedRoom');
  if (!['signal', 'speed'].includes(g.mode) || !inRange(g.targetDown, 1, 10000) || !inRange(g.targetUp, 1, 10000) || !inRange(g.reserve, 0, 80)) fail('goal numbers');
  if (typeof g.device !== 'string' || !g.device || g.device.length > 50) fail('goal.device');

  // ---- measurements of every floor (ids unique in the building) ----
  const mids = new Set();
  checkMeasurements(p.measurements, mids, label, fail);
  for (const f of p.floors) if (f.plan !== null) checkMeasurements(f.measurements, mids, label, (msg) => fail(`floor ${f.id}: ${msg}`));

  // ---- view ----
  const v = p.view;
  if (![2.4, 5, 6, 'auto'].includes(v.band) || !['signal', 'speed', 'diff'].includes(v.layer) || !['default', 'cb'].includes(v.palette)) fail('view');
  for (const k of ['ranges', 'walls', 'furniture', 'labels', 'values', 'points', 'whatif', 'sourceZones', 'calibrate']) if (typeof v[k] !== 'boolean') fail(`view.${k}`);
  if (!fids.has(v.floor)) fail('view.floor');
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
