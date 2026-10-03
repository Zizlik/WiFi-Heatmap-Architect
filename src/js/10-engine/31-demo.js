/* WiFi Heatmap Architect - engine.demo: the built-in demo flat (a 3+kk style flat, 9.0 x 6.6 m, six rooms).
 *
 * Designed in metres and converted to the normalized canvas with exactly 1 px = 1 cm (scale.mpp = 0.01), so the
 * numbers shown in the UI are round. The router "today" stands in the hall next to the internet inlet - the
 * classic bad spot - so the top rooms start weak and moving the router visibly helps.
 */
(function () {
  'use strict';
  const E = globalThis.WH.engine;
  const { W, H } = E.CANVAS;
  const { round } = E.util;

  const X0 = 90; // px of the flat's left edge
  const Y0 = 141; // px of the flat's top edge
  const PX_PER_M = 100;
  const nx = (xm) => round((X0 + xm * PX_PER_M) / W);
  const ny = (ym) => round((Y0 + ym * PX_PER_M) / H);
  const P = (xm, ym) => ({ x: nx(xm), y: ny(ym) });
  const rect = (x1, y1, x2, y2) => [P(x1, y1), P(x2, y1), P(x2, y2), P(x1, y2)];

  const NAMES = {
    cs: {
      project: 'Ukázkový byt',
      rooms: { living: 'Obývací pokoj', kitchen: 'Kuchyň', bedroom: 'Ložnice', hall: 'Chodba', bath: 'Koupelna', office: 'Pracovna' },
      walls: {
        n: 'Vnější stěna (sever)',
        e: 'Vnější stěna (východ)',
        s: 'Vnější stěna (jih)',
        w: 'Vnější stěna (západ)',
        livKit: 'Obývák / kuchyň',
        livBed: 'Obývák / ložnice',
        livHall: 'Obývák / chodba',
        kitSouth: 'Kuchyň / koupelna a pracovna',
        bedHall: 'Ložnice / chodba',
        hallBath: 'Chodba / koupelna',
        bathOffice: 'Koupelna / pracovna',
      },
      doors: { livKit: 'Průchod do kuchyně', livHall: 'Průchod do chodby', office: 'Dveře do pracovny', bedroom: 'Dveře do ložnice', bath: 'Dveře do koupelny' },
      furniture: {
        sofa: 'Sedačka',
        tv: 'TV skříňka',
        books: 'Knihovna',
        table: 'Jídelní stůl',
        counter: 'Kuchyňská linka',
        fridge: 'Lednice',
        bed: 'Postel',
        wardrobe: 'Šatní skříň',
        tub: 'Vana',
        washer: 'Pračka',
        desk: 'Psací stůl',
        shelf: 'Regál',
        shoes: 'Botník',
      },
    },
    en: {
      project: 'Demo flat',
      rooms: { living: 'Living room', kitchen: 'Kitchen', bedroom: 'Bedroom', hall: 'Hall', bath: 'Bathroom', office: 'Office' },
      walls: {
        n: 'Exterior wall (north)',
        e: 'Exterior wall (east)',
        s: 'Exterior wall (south)',
        w: 'Exterior wall (west)',
        livKit: 'Living room / kitchen',
        livBed: 'Living room / bedroom',
        livHall: 'Living room / hall',
        kitSouth: 'Kitchen / bathroom and office',
        bedHall: 'Bedroom / hall',
        hallBath: 'Hall / bathroom',
        bathOffice: 'Bathroom / office',
      },
      doors: { livKit: 'Opening to the kitchen', livHall: 'Opening to the hall', office: 'Office door', bedroom: 'Bedroom door', bath: 'Bathroom door' },
      furniture: {
        sofa: 'Sofa',
        tv: 'TV unit',
        books: 'Bookcase',
        table: 'Dining table',
        counter: 'Kitchen counter',
        fridge: 'Fridge',
        bed: 'Bed',
        wardrobe: 'Wardrobe',
        tub: 'Bathtub',
        washer: 'Washing machine',
        desk: 'Desk',
        shelf: 'Shelving unit',
        shoes: 'Shoe cabinet',
      },
    },
  };

  /**
   * Build the raw (unsanitized) demo project in the requested language; E.project.create() sanitizes it.
   * @param {'cs'|'en'} [lang]
   */
  function build(lang) {
    const L = NAMES[E.text.lang(lang)];
    const colors = E.project.ROOM_COLORS;

    const roomDefs = [
      ['living', rect(0, 0, 5.2, 3.8)],
      ['kitchen', rect(5.2, 0, 9, 3.8)],
      ['bedroom', rect(0, 3.8, 3.6, 6.6)],
      ['hall', rect(3.6, 3.8, 5.2, 6.6)],
      ['bath', rect(5.2, 3.8, 7, 6.6)],
      ['office', rect(7, 3.8, 9, 6.6)],
    ];
    const rooms = roomDefs.map(([key, points], i) => ({
      id: `room-${i + 1}`,
      type: 'room',
      roomId: i + 1,
      name: L.rooms[key],
      points,
      color: colors[i % colors.length],
    }));

    // [key, A (m), B (m), material]
    const wallDefs = [
      ['n', [0, 0], [9, 0], 'brick'],
      ['e', [9, 0], [9, 6.6], 'brick'],
      ['s', [9, 6.6], [0, 6.6], 'brick'],
      ['w', [0, 6.6], [0, 0], 'brick'],
      ['livKit', [5.2, 0], [5.2, 3.8], 'drywall'],
      ['livBed', [0, 3.8], [3.6, 3.8], 'brick'],
      ['livHall', [3.6, 3.8], [5.2, 3.8], 'drywall'],
      ['kitSouth', [5.2, 3.8], [9, 3.8], 'brick'],
      ['bedHall', [3.6, 3.8], [3.6, 6.6], 'brick'],
      ['hallBath', [5.2, 3.8], [5.2, 6.6], 'brick'],
      ['bathOffice', [7, 3.8], [7, 6.6], 'drywall'],
    ];
    const MAT = E.project.WALL_MATERIALS;
    const walls = wallDefs.map(([key, a, b, mat], i) => ({
      id: `wall-${i + 1}`,
      type: 'wall',
      name: L.walls[key],
      a: P(a[0], a[1]),
      b: P(b[0], b[1]),
      material: mat,
      loss: MAT[mat],
    }));
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
      return {
        id: `door-${i}`,
        type: 'door',
        name: L.doors[nameKey],
        a: P(w.a[0] + ux * s0, w.a[1] + uy * s0),
        b: P(w.a[0] + ux * s1, w.a[1] + uy * s1),
        wallId: w.id,
        loss,
      };
    };
    const doors = [
      door('livKit', 'livKit', 1.9, 1.2, 0, 1), // open doorway
      door('livHall', 'livHall', 1.0, 0.9, 0, 2), // open doorway
      door('office', 'kitSouth', 2.85, 0.9, 3, 3), // closed door
      door('bedroom', 'bedHall', 1.0, 0.9, 3, 4),
      door('bath', 'hallBath', 1.0, 0.8, 3, 5),
    ];

    // [nameKey, polygon, kind]
    const furnitureDefs = [
      ['sofa', rect(0.5, 2.6, 2.7, 3.4), 'bed'],
      ['tv', rect(1.0, 0.2, 2.6, 0.6), 'wood'],
      ['books', rect(4.7, 2.6, 5.1, 3.6), 'books'],
      ['table', rect(3.0, 1.2, 4.4, 2.2), 'wood'],
      [
        'counter',
        [P(5.4, 0.2), P(8.8, 0.2), P(8.8, 0.8), P(6.0, 0.8), P(6.0, 2.0), P(5.4, 2.0)],
        'wood',
      ],
      ['fridge', rect(8.2, 2.9, 8.8, 3.6), 'appliance'],
      ['bed', rect(0.3, 4.3, 2.2, 6.1), 'bed'],
      ['wardrobe', rect(2.4, 6.1, 3.5, 6.5), 'wood'],
      ['tub', rect(5.4, 4.0, 6.9, 4.8), 'custom'],
      ['washer', rect(6.3, 5.9, 6.9, 6.5), 'appliance'],
      ['desk', rect(7.2, 4.0, 8.8, 4.8), 'wood'],
      ['shelf', rect(8.6, 5.2, 8.9, 6.4), 'books'],
      ['shoes', rect(3.7, 5.6, 4.0, 6.5), 'wood'],
    ];
    const KIND = E.project.FURNITURE_KINDS;
    const furniture = furnitureDefs.map(([key, points, kind], i) => ({
      id: `furniture-${i + 1}`,
      type: 'furniture',
      name: L.furniture[key],
      points,
      loss: key === 'tub' ? 6 : KIND[kind],
      kind,
      blocksSignal: true,
    }));

    const router = P(4.45, 5.8); // hall, next to the internet inlet
    return {
      v: 3,
      name: L.project,
      plan: { rooms, walls, doors, furniture, background: null },
      scale: { mpp: 0.01 },
      net: { router, baseline: { ...router }, optic: P(4.85, 6.4) },
    };
  }

  E.demo = { build };
})();
