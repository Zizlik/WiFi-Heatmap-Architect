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
      scale: { mpp: 1 / PX_PER_M },
      net: { router, baseline: { ...router }, optic: P(5.8, 6.6) },
      // a second access point (off) waits in the bedroom, the weakest room - switch it on to see the what-if
      node: { pos: P(2.6, 3.6) },
      goal: { excluded: [7] },
    };
  }

  E.demo = { build };
})();
