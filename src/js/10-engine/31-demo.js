/* WiFi Heatmap Architect - engine.demo: the built-in showcase flat (SPEC 11).
 *
 * A realistic Czech 3+kk of about 74 m² (+ a 3.9 m² balcony), designed in metres and converted to the normalized canvas
 * at 80 px per metre (scale.mpp = 0.0125, the plan centred on the 1080 x 942 canvas):
 *
 *            0          3.6        6.4  6.8         9.6  10 10.5 (m)
 *     -1.4                              +-------------+              balcony (north, glass door)
 *        0   +----------+----------+----+--D----------+--+
 *            | Ložnice  | Pracovna |  Obývák s        |   \          bay (arkýř) on the east wall
 *            | (bed,    | (desk,   |  kuchyní         |    |         (brick sides, glazed front)
 *            | wardrobe)| shelf)   |  (L sofa, TV)    |   /
 *      4.2   +--+----D--+---D------+                  +--+
 *            |K |   Předsíň (L)    D   (dining set)    |
 *      5.4   |o +--D-+             |       kitchen L   |             hall: corridor + entrance part
 *            |u | WC |  (shoes)    |   (fridge, oven)  |
 *      7.0   |p |    +----D--------+                   |             entrance niche (front door from
 *      7.4   +--+----+   niche     +-------------------+              the building's corridor)
 *
 * Materials: exterior Porotherm-like brick, the wall to the building's corridor reinforced concrete / concrete, a brick
 * load-bearing spine (east-west, between the bedrooms and the hall), plasterboard partitions bedroom / study / living
 * room, masonry between the hall and the living room and around the tiled bathroom and WC, a glass bay front and a
 * glass balcony railing. Doors: open doorway hall -> living room, closed doors elsewhere, a glass balcony
 * door, a heavy front door. Furniture at real sizes as real shapes (L corner sofa, L kitchen counter, double bed with two
 * nightstands, a round office chair and balcony table, a toilet with its cistern and oval bowl, a half-oval washbasin,
 * ...). The router stands by the shoe cabinet next to the front door, the fibre box (ONT) on the other side of the door -
 * the typical spot, weak in the far bedroom and on the balcony, so moving it (or adding a second AP) visibly helps
 * (5 GHz whole flat: about 52 % today, about 79 % at the best spot; 2.4 GHz about 93 % today).
 * The balcony does not count towards "Celý byt" (goal.excluded) - you rarely need indoor coverage there.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { round } = E.util;

  const PX_PER_M = 80; // => scale.mpp = 0.0125 m per canvas px
  const X0 = 120; // px of x = 0 m (the flat's west edge); the bay reaches 10.5 m = 960 px
  const Y0 = 231; // px of y = 0 m (the north wall); the balcony reaches -1.4 m = 119 px, the south wall 7.4 m = 823 px
  const nx = (xm) => round((X0 + xm * PX_PER_M) / W);
  const ny = (ym) => round((Y0 + ym * PX_PER_M) / H);
  const P = (xm, ym) => ({ x: nx(xm), y: ny(ym) });
  const rect = (x1, y1, x2, y2) => [P(x1, y1), P(x2, y1), P(x2, y2), P(x1, y2)];
  const poly = (...pts) => pts.map(([x, y]) => P(x, y));
  // a round / oval piece (n corners, <= 12 so the tracer stays exact): office chair, round table
  const oval = (cx, cy, rx, ry, n) => Array.from({ length: n }, (_, i) => P(cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)));

  const NAMES = {
    cs: {
      project: 'Ukázkový byt',
      rooms: { living: 'Obývák s kuchyní', bedroom: 'Ložnice', study: 'Pracovna', bath: 'Koupelna', wc: 'WC', hall: 'Předsíň', balcony: 'Balkon' },
      walls: {
        north: 'Obvodová zeď (sever)',
        eastN: 'Obvodová zeď (východ)',
        bayN: 'Arkýř (bok)',
        bay: 'Okno arkýře',
        bayS: 'Arkýř (bok)',
        eastS: 'Obvodová zeď (východ)',
        south: 'Obvodová zeď (jih)',
        nicheE: 'Výklenek u vchodu',
        entrance: 'Zeď ke chodbě domu',
        nicheW: 'Výklenek u vchodu',
        corridor: 'Zeď ke chodbě domu',
        west: 'Obvodová zeď (západ)',
        spine: 'Nosná zeď (střed bytu)',
        bedStudy: 'Ložnice / pracovna',
        middleN: 'Pracovna / obývák',
        middleS: 'Předsíň / obývák',
        bath: 'Koupelna (obklad)',
        wcN: 'WC (obklad)',
        wcE: 'WC (obklad)',
        rail: 'Zábradlí balkonu (sklo)',
      },
      doors: {
        balcony: 'Balkonové dveře',
        entrance: 'Vstupní dveře',
        bedroom: 'Dveře do ložnice',
        study: 'Dveře do pracovny',
        bath: 'Dveře do koupelny',
        wc: 'Dveře na WC',
        living: 'Průchod do obýváku',
      },
      furniture: {
        sofa: 'Rohová sedačka',
        coffee: 'Konferenční stolek',
        tv: 'TV stolek',
        dining: 'Jídelní stůl se židlemi',
        counter: 'Kuchyňská linka',
        fridge: 'Lednice',
        oven: 'Trouba',
        bed: 'Manželská postel',
        standL: 'Noční stolek',
        standR: 'Noční stolek',
        wardrobe: 'Šatní skříň',
        desk: 'Psací stůl',
        chair: 'Kancelářská židle',
        shelf: 'Knihovna',
        sofabed: 'Rozkládací pohovka',
        tub: 'Vana',
        basin: 'Umyvadlo',
        washer: 'Pračka',
        toilet: 'Záchod',
        shoes: 'Botník',
        closet: 'Vestavěná skříň',
        balconyTable: 'Balkonový stolek',
      },
    },
    en: {
      project: 'Demo flat',
      rooms: { living: 'Living & kitchen', bedroom: 'Bedroom', study: 'Study', bath: 'Bathroom', wc: 'WC', hall: 'Hall', balcony: 'Balcony' },
      walls: {
        north: 'Exterior wall (north)',
        eastN: 'Exterior wall (east)',
        bayN: 'Bay (side)',
        bay: 'Bay glazing',
        bayS: 'Bay (side)',
        eastS: 'Exterior wall (east)',
        south: 'Exterior wall (south)',
        nicheE: 'Entrance niche',
        entrance: 'Wall to the building corridor',
        nicheW: 'Entrance niche',
        corridor: 'Wall to the building corridor',
        west: 'Exterior wall (west)',
        spine: 'Load-bearing wall (middle)',
        bedStudy: 'Bedroom / study',
        middleN: 'Study / living room',
        middleS: 'Hall / living room',
        bath: 'Bathroom (tiled)',
        wcN: 'WC (tiled)',
        wcE: 'WC (tiled)',
        rail: 'Balcony railing (glass)',
      },
      doors: {
        balcony: 'Balcony door',
        entrance: 'Front door',
        bedroom: 'Bedroom door',
        study: 'Study door',
        bath: 'Bathroom door',
        wc: 'WC door',
        living: 'Opening to the living room',
      },
      furniture: {
        sofa: 'Corner sofa',
        coffee: 'Coffee table',
        tv: 'TV unit',
        dining: 'Dining table with chairs',
        counter: 'Kitchen counter',
        fridge: 'Fridge',
        oven: 'Oven',
        bed: 'Double bed',
        standL: 'Nightstand',
        standR: 'Nightstand',
        wardrobe: 'Wardrobe',
        desk: 'Desk',
        chair: 'Office chair',
        shelf: 'Bookcase',
        sofabed: 'Sofa bed',
        tub: 'Bathtub',
        basin: 'Washbasin',
        washer: 'Washing machine',
        toilet: 'Toilet',
        shoes: 'Shoe cabinet',
        closet: 'Built-in wardrobe',
        balconyTable: 'Balcony table',
      },
    },
  };

  /**
   * Build the raw (unsanitized) demo project in the requested language; E.project.create() sanitizes it.
   * @param {'cs'|'en'} [lang]
   */
  function build(lang) {
    const L = NAMES[E.text.lang(lang)];
    const C = E.project.ROOM_COLORS; // '#8eadd2' blue, '#deb879' sand, '#9e9ccb' lavender, '#97bbad' sage, '#d79a9a' rose, '#a8c686' green, '#c8a2c8' lilac, '#e6c27a' yellow

    // [key, outline, colour]
    const roomDefs = [
      ['living', poly([6.4, 0], [10, 0], [10, 2], [10.5, 2.4], [10.5, 4.2], [10, 4.6], [10, 7.4], [6.4, 7.4]), C[1]],
      ['bedroom', rect(0, 0, 3.6, 4.2), C[2]],
      ['study', rect(3.6, 0, 6.4, 4.2), C[7]],
      ['bath', rect(0, 4.2, 2.4, 7.4), C[0]],
      ['wc', rect(2.4, 5.4, 3.6, 7.4), C[3]],
      ['hall', poly([2.4, 4.2], [6.4, 4.2], [6.4, 7], [3.6, 7], [3.6, 5.4], [2.4, 5.4]), C[4]],
      ['balcony', rect(6.8, -1.4, 9.6, 0), C[5]],
    ];
    const rooms = roomDefs.map(([key, points, color], i) => ({ id: `room-${i + 1}`, type: 'room', roomId: i + 1, name: L.rooms[key], points, color }));

    // [key, A (m), B (m), material]
    const wallDefs = [
      ['north', [0, 0], [10, 0], 'brick'],
      ['eastN', [10, 0], [10, 2], 'brick'],
      ['bayN', [10, 2], [10.5, 2.4], 'brick'],
      ['bay', [10.5, 2.4], [10.5, 4.2], 'glass'],
      ['bayS', [10.5, 4.2], [10, 4.6], 'brick'],
      ['eastS', [10, 4.6], [10, 7.4], 'brick'],
      ['south', [10, 7.4], [6.4, 7.4], 'brick'],
      ['nicheE', [6.4, 7.4], [6.4, 7], 'concrete'],
      ['entrance', [6.4, 7], [3.6, 7], 'reinforced_concrete'],
      ['nicheW', [3.6, 7], [3.6, 7.4], 'concrete'],
      ['corridor', [3.6, 7.4], [0, 7.4], 'concrete'],
      ['west', [0, 7.4], [0, 0], 'brick'],
      ['spine', [0, 4.2], [6.4, 4.2], 'brick'],
      ['bedStudy', [3.6, 0], [3.6, 4.2], 'drywall'],
      ['middleN', [6.4, 0], [6.4, 4.2], 'drywall'],
      ['middleS', [6.4, 4.2], [6.4, 7], 'masonry'],
      ['bath', [2.4, 4.2], [2.4, 7.4], 'masonry'],
      ['wcN', [2.4, 5.4], [3.6, 5.4], 'masonry'],
      ['wcE', [3.6, 5.4], [3.6, 7], 'masonry'],
      // the balcony's glass railing (its outer edges)
      ['rail', [6.8, 0], [6.8, -1.4], 'glass'],
      ['rail', [6.8, -1.4], [9.6, -1.4], 'glass'],
      ['rail', [9.6, -1.4], [9.6, 0], 'glass'],
    ];
    const MAT = E.project.WALL_MATERIALS;
    const walls = wallDefs.map(([key, a, b, mat], i) => ({ id: `wall-${i + 1}`, type: 'wall', name: L.walls[key], a: P(a[0], a[1]), b: P(b[0], b[1]), material: mat, loss: MAT[mat] }));
    const wallByKey = {};
    wallDefs.forEach(([key, a, b], i) => {
      wallByKey[key] = { id: walls[i].id, a, b };
    });

    // door on wall `key`, centre `c` metres from the wall's start, `wd` metres wide
    const door = (nameKey, key, c, wd, loss, i) => {
      const w = wallByKey[key];
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const ux = (w.b[0] - w.a[0]) / len;
      const uy = (w.b[1] - w.a[1]) / len;
      const s0 = c - wd / 2;
      const s1 = c + wd / 2;
      return { id: `door-${i}`, type: 'door', name: L.doors[nameKey], a: P(w.a[0] + ux * s0, w.a[1] + uy * s0), b: P(w.a[0] + ux * s1, w.a[1] + uy * s1), wallId: w.id, loss };
    };
    const doors = [
      door('living', 'middleS', 1.5, 1.0, 0, 1), // open doorway hall -> living room (y 5.2-6.2)
      door('balcony', 'north', 8.05, 0.9, 4, 2), // glass balcony door (x 7.6-8.5)
      door('bedroom', 'spine', 3.05, 0.8, 3, 3), // x 2.65-3.45
      door('study', 'spine', 4.4, 0.8, 3, 4), // x 4.0-4.8
      door('bath', 'bath', 0.75, 0.8, 3, 5), // y 4.35-5.15
      door('wc', 'wcN', 0.6, 0.6, 3, 6), // x 2.7-3.3
      door('entrance', 'entrance', 1.35, 0.9, 12, 7), // heavy front door, x 4.6-5.5
    ];

    // [nameKey, outline, kind, loss (only for 'custom')]
    const furnitureDefs = [
      // living room: lounge (north) - corner sofa facing the TV on the middle wall, coffee table between them
      ['sofa', poly([8.95, 1.2], [9.85, 1.2], [9.85, 3.9], [7.5, 3.9], [7.5, 3.0], [8.95, 3.0]), 'bed'],
      ['coffee', rect(7.65, 1.7, 8.45, 2.6), 'wood'],
      ['tv', rect(6.45, 1.2, 6.9, 3.0), 'wood'],
      // dining (middle) and the L kitchen in the south-east corner
      ['dining', rect(7.3, 4.6, 8.7, 5.9), 'wood'],
      ['counter', poly([7.65, 6.8], [9.4, 6.8], [9.4, 5.6], [9.98, 5.6], [9.98, 7.38], [7.65, 7.38]), 'wood'],
      ['oven', rect(9.4, 5.0, 9.98, 5.6), 'appliance'],
      ['fridge', rect(7.0, 6.75, 7.65, 7.38), 'appliance'],
      // bedroom: 160 x 200 bed with its head on the west wall, two nightstands, a wardrobe by the door
      ['bed', rect(0.05, 1.1, 2.05, 2.7), 'bed'],
      ['standL', rect(0.05, 0.6, 0.45, 1.05), 'wood'],
      ['standR', rect(0.05, 2.75, 0.45, 3.2), 'wood'],
      ['wardrobe', rect(2.95, 0.3, 3.55, 2.7), 'wood'],
      // study: desk by the north wall, chair, bookcase on the partition, sofa bed
      ['desk', rect(4.0, 0.05, 5.4, 0.75), 'wood'],
      ['chair', oval(4.72, 1.12, 0.28, 0.28, 10), 'custom', 1],
      ['shelf', rect(3.65, 1.6, 4.0, 3.4), 'books'],
      ['sofabed', rect(5.55, 1.6, 6.35, 3.6), 'bed'],
      // bathroom and WC
      ['tub', rect(0.05, 6.6, 1.75, 7.35), 'custom', 5],
      // washbasin: a half-oval bowl on the west wall
      ['basin', poly([0.05, 4.6], [0.3, 4.63], [0.45, 4.72], [0.5, 4.9], [0.45, 5.08], [0.3, 5.17], [0.05, 5.2]), 'custom', 2],
      ['washer', rect(1.8, 6.75, 2.38, 7.35), 'appliance'],
      // toilet: the cistern on the south wall and the oval bowl in front of it
      ['toilet', poly([2.81, 7.35], [3.19, 7.35], [3.19, 7.17], [3.17, 7.17], [3.17, 6.9], [3.12, 6.76], [3.0, 6.69], [2.88, 6.76], [2.83, 6.9], [2.83, 7.17], [2.81, 7.17]), 'custom', 2],
      // hall: shoe cabinet by the front door, a built-in wardrobe in the corridor
      ['shoes', rect(3.65, 5.6, 4.0, 6.8), 'wood'],
      ['closet', rect(4.95, 4.25, 6.35, 4.85), 'wood'],
      // balcony
      ['balconyTable', oval(8.95, -0.75, 0.33, 0.33, 12), 'custom', 1],
    ];
    const KIND = E.project.FURNITURE_KINDS;
    const furniture = furnitureDefs.map(([key, points, kind, loss], i) => ({
      id: `furniture-${i + 1}`,
      type: 'furniture',
      name: L.furniture[key],
      points,
      loss: kind === 'custom' ? loss : KIND[kind],
      kind,
      blocksSignal: true,
    }));

    // the router on the shoe cabinet side of the front door, the fibre box (ONT) on the wall at the other side of the
    // door; both clear of the walls, of each other and of the hall label even on a phone (centring guard, SPEC 1.8.1)
    const router = P(4.45, 6.55);
    return {
      v: 3,
      name: L.project,
      plan: { rooms, walls, doors, furniture, background: null },
      // designed in metres: the scale is verified (SPEC 14.1) - the flat is 10.5 m wide incl. the bay
      scale: { mpp: 1 / PX_PER_M, verified: true, method: 'width', ref: { metres: 10.5 } },
      net: { router, baseline: { ...router }, optic: P(5.8, 6.6) },
      // no access point yet: "+ Přidat AP" places the first one in the room farthest from the router (the bedroom)
      nodes: [],
      goal: { excluded: [7] },
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // "Dům se dvěma patry" / "Two-storey house" (SPEC 14.3): a 9 x 8 m house, ground floor + 1st floor, the router
  // downstairs in the hall at the foot of the stairs, a Wi-Fi mesh node upstairs on the landing, a concrete ceiling
  // (15 dB at 5 GHz) between them. Upstairs the router alone is weak (the ceiling + walls); the node restores it.
  //
  //   Přízemí (ground floor)                         1. patro (1st floor)
  //     0        3.8   5.4      9 (m)                  0      2.8  4.2 5.4    9
  //   0 +--------+--------------+                    0 +---------+--------------+
  //     | Pracov.|   Obývák     |                      | Ložnice |  Dětský pokoj|
  //   3.4+--+----+              |                    4 +--D---+--+---D--+-------+
  //     |WC|Tech |              |                      |  Chodba     |  Pokoj    |
  //  4.4|  |    +--D---+--------+                   5.4+--D---+      D  pro     |
  //  5.2+--+----+ Předsíň|Kuchyň|                      |Koupel|  schody|  hosty  |
  //     | (stairs)       D       |                      |  na  |        |         |
  //   8 +----D-----------+-------+                    8 +------+--------+---------+
  // ---------------------------------------------------------------------------------------------------------------

  const HOUSE = {
    cs: {
      project: 'Dům se dvěma patry',
      floors: { ground: 'Přízemí', upper: '1. patro' },
      node: 'Mesh nahoře',
      rooms: { living: 'Obývák s kuchyní', study: 'Pracovna', wc: 'WC', tech: 'Technická místnost', hall: 'Předsíň se schodištěm', bedroom: 'Ložnice', kids: 'Dětský pokoj', guest: 'Pokoj pro hosty', bath: 'Koupelna', landing: 'Chodba se schodištěm' },
      walls: { north: 'Obvodová zeď (sever)', east: 'Obvodová zeď (východ)', south: 'Obvodová zeď (jih)', west: 'Obvodová zeď (západ)', spine: 'Nosná zeď', partition: 'Příčka', tiled: 'Příčka (obklad)', mid: 'Nosná zeď (střed domu)' },
      doors: { front: 'Vchodové dveře', study: 'Dveře do pracovny', wc: 'Dveře na WC', tech: 'Dveře do technické místnosti', living: 'Prosklené dveře do obýváku', kitchen: 'Průchod do kuchyně', bedroom: 'Dveře do ložnice', kids: 'Dveře do dětského pokoje', guest: 'Dveře do pokoje pro hosty', bath: 'Dveře do koupelny' },
      furniture: { sofa: 'Rohová sedačka', tv: 'TV stolek', table: 'Jídelní stůl', counter: 'Kuchyňská linka', fridge: 'Lednice', desk: 'Psací stůl', shelf: 'Knihovna', boiler: 'Kotel', stairs: 'Schodiště', shoes: 'Botník', bed: 'Manželská postel', wardrobe: 'Šatní skříň', kidsBed: 'Dětská postel', kidsDesk: 'Dětský stůl', guestBed: 'Postel pro hosty', tub: 'Vana', washer: 'Pračka', opening: 'Otvor schodiště' },
    },
    en: {
      project: 'Two-storey house',
      floors: { ground: 'Ground floor', upper: '1st floor' },
      node: 'Mesh upstairs',
      rooms: { living: 'Living room & kitchen', study: 'Study', wc: 'WC', tech: 'Utility room', hall: 'Hall & stairs', bedroom: 'Bedroom', kids: 'Kids room', guest: 'Guest room', bath: 'Bathroom', landing: 'Landing & stairs' },
      walls: { north: 'Exterior wall (north)', east: 'Exterior wall (east)', south: 'Exterior wall (south)', west: 'Exterior wall (west)', spine: 'Load-bearing wall', partition: 'Partition', tiled: 'Partition (tiled)', mid: 'Load-bearing wall (middle)' },
      doors: { front: 'Front door', study: 'Study door', wc: 'WC door', tech: 'Utility room door', living: 'Glass door to the living room', kitchen: 'Opening to the kitchen', bedroom: 'Bedroom door', kids: 'Kids room door', guest: 'Guest room door', bath: 'Bathroom door' },
      furniture: { sofa: 'Corner sofa', tv: 'TV unit', table: 'Dining table', counter: 'Kitchen counter', fridge: 'Fridge', desk: 'Desk', shelf: 'Bookcase', boiler: 'Boiler', stairs: 'Staircase', shoes: 'Shoe cabinet', bed: 'Double bed', wardrobe: 'Wardrobe', kidsBed: 'Kids bed', kidsDesk: 'Kids desk', guestBed: 'Guest bed', tub: 'Bathtub', washer: 'Washing machine', opening: 'Stairwell opening' },
    },
  };

  /**
   * Build the raw (unsanitized) two-storey house; E.project.create({template:'house2'}) sanitizes it.
   * @param {'cs'|'en'} [lang]
   */
  function buildHouse2(lang) {
    const L = HOUSE[E.text.lang(lang)];
    const C = E.project.ROOM_COLORS;
    const MAT = E.project.WALL_MATERIALS;
    const KIND = E.project.FURNITURE_KINDS;
    // 9 x 8 m centred on the canvas at 80 px per m
    const HX0 = (W - 9 * PX_PER_M) / 2;
    const HY0 = (H - 8 * PX_PER_M) / 2;
    const Q = (xm, ym) => ({ x: round((HX0 + xm * PX_PER_M) / W), y: round((HY0 + ym * PX_PER_M) / H) });
    const box = (x1, y1, x2, y2) => [Q(x1, y1), Q(x2, y1), Q(x2, y2), Q(x1, y2)];
    const pl = (...pts) => pts.map(([x, y]) => Q(x, y));

    /** One floor's plan from [key, outline, colour] rooms, [key, A, B, material] walls, doors, furniture. */
    const floorPlan = (roomDefs, wallDefs, doorDefs, furnDefs) => {
      const rooms = roomDefs.map(([key, points, color], i) => ({ id: `room-${i + 1}`, type: 'room', roomId: i + 1, name: L.rooms[key], points, color }));
      const walls = wallDefs.map(([key, a, b, mat], i) => ({ id: `wall-${i + 1}`, type: 'wall', name: L.walls[key], a: Q(a[0], a[1]), b: Q(b[0], b[1]), material: mat, loss: MAT[mat] }));
      // door [nameKey, wall index, from (m along the wall), to (m), loss]
      const doors = doorDefs.map(([key, wi, s0, s1, loss], i) => {
        const a = wallDefs[wi][1];
        const b = wallDefs[wi][2];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ux = (b[0] - a[0]) / len;
        const uy = (b[1] - a[1]) / len;
        return { id: `door-${i + 1}`, type: 'door', name: L.doors[key], a: Q(a[0] + ux * s0, a[1] + uy * s0), b: Q(a[0] + ux * s1, a[1] + uy * s1), wallId: walls[wi].id, loss };
      });
      const furniture = furnDefs.map(([key, points, kind, loss, blocks], i) => ({
        id: `furniture-${i + 1}`,
        type: 'furniture',
        name: L.furniture[key],
        points,
        loss: kind === 'custom' ? loss : KIND[kind],
        kind,
        blocksSignal: blocks !== false,
      }));
      return { rooms, walls, doors, furniture, background: null };
    };
    const outer = [
      ['north', [0, 0], [9, 0], 'brick'],
      ['east', [9, 0], [9, 8], 'brick'],
      ['south', [9, 8], [0, 8], 'brick'],
      ['west', [0, 8], [0, 0], 'brick'],
    ];

    const ground = floorPlan(
      [
        // one open-plan room (no wall between the living room and the kitchen - the plan check stays clean)
        ['living', pl([3.8, 0], [9, 0], [9, 8], [5.4, 8], [5.4, 4.4], [3.8, 4.4]), C[1]],
        ['study', box(0, 0, 3.8, 3.4), C[2]],
        ['wc', box(0, 3.4, 1.6, 5.2), C[3]],
        ['tech', box(1.6, 3.4, 3.8, 5.2), C[0]],
        ['hall', pl([0, 5.2], [3.8, 5.2], [3.8, 4.4], [5.4, 4.4], [5.4, 8], [0, 8]), C[4]],
      ],
      outer.concat([
        ['spine', [3.8, 0], [3.8, 4.4], 'brick'], // 4: study + utility | living room
        ['partition', [0, 3.4], [3.8, 3.4], 'drywall'], // 5: study | WC + utility
        ['tiled', [1.6, 3.4], [1.6, 5.2], 'masonry'], // 6: WC | utility
        ['partition', [0, 5.2], [3.8, 5.2], 'drywall'], // 7: WC + utility | hall
        ['partition', [3.8, 4.4], [3.8, 5.2], 'drywall'], // 8: utility | hall
        ['partition', [3.8, 4.4], [5.4, 4.4], 'drywall'], // 9: living room | hall (the kitchen is open to the living room)
        ['partition', [5.4, 4.4], [5.4, 8], 'drywall'], // 10: hall | kitchen part of the living room
      ]),
      [
        ['front', 2, 7.0, 8.0, 6], // south wall, x 1.0 - 2.0
        ['study', 4, 2.4, 3.2, 3], // study -> living room
        ['wc', 7, 0.4, 1.1, 3],
        ['tech', 7, 2.4, 3.2, 3],
        ['living', 9, 0.2, 1.2, 2], // glass door
        ['kitchen', 10, 1.3, 2.3, 0], // open doorway
      ],
      [
        ['sofa', pl([7.2, 0.6], [8.7, 0.6], [8.7, 3.2], [7.9, 3.2], [7.9, 1.4], [7.2, 1.4]), 'bed'],
        ['tv', box(4.0, 1.2, 4.45, 3.0), 'wood'],
        ['table', box(6.4, 5.2, 7.8, 6.3), 'wood'],
        ['counter', pl([5.6, 7.35], [8.95, 7.35], [8.95, 5.2], [8.35, 5.2], [8.35, 6.75], [5.6, 6.75]), 'wood'],
        ['fridge', box(8.35, 4.6, 8.95, 5.2), 'appliance'],
        ['desk', box(0.1, 0.1, 1.6, 0.8), 'wood'],
        ['shelf', box(3.35, 0.3, 3.75, 2.2), 'books'],
        ['boiler', box(3.05, 3.5, 3.7, 4.1), 'appliance'],
        ['stairs', box(4.2, 5.4, 5.3, 7.9), 'wood'],
        ['shoes', box(0.1, 6.3, 0.5, 7.5), 'wood'],
      ],
    );

    const upper = floorPlan(
      [
        ['bedroom', box(0, 0, 4.2, 4), C[2]],
        ['kids', box(4.2, 0, 9, 4), C[5]],
        ['guest', box(5.4, 4, 9, 8), C[6]],
        ['bath', box(0, 5.4, 2.8, 8), C[0]],
        ['landing', pl([0, 4], [5.4, 4], [5.4, 8], [2.8, 8], [2.8, 5.4], [0, 5.4]), C[4]],
      ],
      outer.concat([
        ['mid', [0, 4], [9, 4], 'brick'], // 4: bedrooms | landing + guest room
        ['partition', [4.2, 0], [4.2, 4], 'drywall'], // 5: bedroom | kids' room
        ['partition', [5.4, 4], [5.4, 8], 'drywall'], // 6: landing | guest room
        ['tiled', [0, 5.4], [2.8, 5.4], 'masonry'], // 7: landing | bathroom
        ['tiled', [2.8, 5.4], [2.8, 8], 'masonry'], // 8: bathroom | landing
      ]),
      [
        ['bedroom', 4, 1.0, 1.8, 3],
        ['kids', 4, 4.5, 5.3, 3],
        ['guest', 6, 0.4, 1.2, 3],
        ['bath', 7, 1.6, 2.4, 3],
      ],
      [
        ['bed', box(0.1, 0.9, 2.1, 2.5), 'bed'],
        ['wardrobe', box(3.55, 0.1, 4.15, 2.6), 'wood'],
        ['kidsBed', box(7.9, 0.1, 8.9, 2.1), 'bed'],
        ['kidsDesk', box(4.3, 0.1, 5.6, 0.75), 'wood'],
        ['guestBed', box(7.3, 5.6, 8.9, 7.6), 'bed'],
        ['tub', box(0.1, 7.15, 1.8, 7.9), 'custom', 5],
        ['washer', box(2.15, 5.5, 2.7, 6.1), 'appliance'],
        // the stairwell (an opening in the slab: drawn, not modelled - SPEC 14.3)
        ['opening', box(4.2, 5.4, 5.3, 7.9), 'custom', 0, false],
      ],
    );

    const router = Q(3.9, 6.3); // in the hall at the foot of the stairs
    const ceiling = { material: 'concrete', lossDb: 15, heightM: 2.8 };
    return {
      v: 3,
      name: L.project,
      plan: ground,
      scale: { mpp: 1 / PX_PER_M, verified: true, method: 'width', ref: { metres: 9 } },
      net: { router, baseline: { ...router }, optic: Q(0.35, 7.0), routerFloor: 'floor-1', opticFloor: 'floor-1' },
      nodes: [],
      goal: { excluded: [] },
      measurements: [],
      view: { band: 'auto', floor: 'floor-1' },
      floors: [
        { id: 'floor-1', name: L.floors.ground, level: 0, ceiling, plan: null, nodes: null, measurements: null, goal: null },
        {
          id: 'floor-2',
          name: L.floors.upper,
          level: 1,
          ceiling: { ...ceiling },
          plan: upper,
          // the mesh node on the landing, right above the router: its Wi-Fi uplink goes through the ceiling
          nodes: [{ id: 'node-1', name: L.node, mode: 'mesh_wifi', pos: Q(3.6, 4.7), bands: { '2.4': true, '5': true, '6': false }, power: 0, backhaulBand: 5, backhaulThreshold: -67, maxMbps: null, uplink: 'router', enabled: true }],
          measurements: [],
          goal: { room: 'all', excluded: [] },
        },
      ],
    };
  }

  E.demo = { build, buildHouse2 };
})();
