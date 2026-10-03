/* WiFi Heatmap Architect - engine strings (cs + en).
 *
 * Two kinds of keys:
 *   err.*     messages of Errors thrown by the engine - the Error's `message` IS the key, show it with
 *             WH.i18n.t(err.message);
 *   engine.*  default names / SVG texts that the engine writes into DATA (they need an explicit language, so the
 *             engine reads them from its own dictionary E.text; they are mirrored into WH.i18n for completeness).
 */
(function () {
  'use strict';
  const g = globalThis;
  const E = g.WH.engine;

  const cs = {
    'err.plan.invalid': 'Soubor nemá podporovaná data půdorysu.',
    'err.plan.format': 'Nepodporovaný formát půdorysu.',
    'err.plan.tooMany': 'Půdorys obsahuje příliš mnoho objektů (nejvýše 250 od každého druhu).',
    'err.plan.duplicateId': 'V souboru je duplicitní objekt.',
    'err.plan.point': 'Některý bod leží mimo mapu.',
    'err.plan.polygon': 'Některý obrys se kříží, nebo nemá plochu. Uprav jeho body.',
    'err.plan.roomId': 'Některá místnost má neplatné nebo opakované číslo.',
    'err.plan.door': 'Některé dveře nemají svoji zeď.',
    'err.svg.badData': 'SVG obsahuje poškozená data půdorysu.',
    'err.svg.dtd': 'SVG obsahuje nepodporované definice. Použij běžný export SVG nebo obrázek PNG.',
    'err.svg.tooBig': 'Soubor je příliš velký (nejvýše 8 MB).',
    'err.svg.invalid': 'Soubor není platné SVG.',
    'err.project.invalid': 'Projekt se nepodařilo vytvořit nebo načíst.',
    'err.opt.noFloor': 'Pro zvolenou oblast není kam router umístit, chybí tam podlaha.',
    'err.opt.speedNode': 'Hledání polohy podle rychlosti nejde se druhým uzlem. Rychlost přes druhý uzel nemáme změřenou.',
    'err.opt.noCurve': 'Pro odhad rychlosti chybí měření. Přidej alespoň dva rychlostní testy se signálem lišícím se o 5 dB.',

    'engine.project.name': 'Můj byt',
    'engine.device.default': 'Telefon',
    'engine.name.room': 'Místnost {n}',
    'engine.name.wall': 'Zeď',
    'engine.name.door': 'Dveře',
    'engine.name.furniture': 'Nábytek',
    'engine.name.measurement': 'Měření {n}',
    'engine.svg.title': 'Půdorys pro Wi-Fi',
    'engine.svg.desc': 'Přibližný půdorys. Rozměry, umístění zdí a útlum ověř podle skutečnosti.',
    'engine.svg.todayLetter': 'D',
  };

  const en = {
    'err.plan.invalid': 'The file does not contain supported floor-plan data.',
    'err.plan.format': 'Unsupported floor-plan format.',
    'err.plan.tooMany': 'The floor plan has too many objects (at most 250 of each kind).',
    'err.plan.duplicateId': 'The file contains a duplicate object.',
    'err.plan.point': 'A point lies outside the map.',
    'err.plan.polygon': 'An outline crosses itself or has no area. Adjust its points.',
    'err.plan.roomId': 'A room has an invalid or repeated number.',
    'err.plan.door': 'A door has no wall.',
    'err.svg.badData': 'The SVG contains damaged floor-plan data.',
    'err.svg.dtd': 'The SVG contains unsupported definitions. Use a regular SVG export or a PNG image.',
    'err.svg.tooBig': 'The file is too large (8 MB at most).',
    'err.svg.invalid': 'The file is not a valid SVG.',
    'err.project.invalid': 'The project could not be created or loaded.',
    'err.opt.noFloor': 'There is no floor in the chosen area to place the router on.',
    'err.opt.speedNode': 'Searching by speed does not work with a second node, because speed through the second node has not been measured.',
    'err.opt.noCurve': 'Speed estimates need measurements. Add at least two speed tests whose signal differs by 5 dB.',

    'engine.project.name': 'My flat',
    'engine.device.default': 'Phone',
    'engine.name.room': 'Room {n}',
    'engine.name.wall': 'Wall',
    'engine.name.door': 'Door',
    'engine.name.furniture': 'Furniture',
    'engine.name.measurement': 'Measurement {n}',
    'engine.svg.title': 'Floor plan for Wi-Fi',
    'engine.svg.desc': 'Approximate floor plan. Check dimensions, wall positions and attenuation against reality.',
    'engine.svg.todayLetter': 'T',
  };

  E.text.add('cs', cs);
  E.text.add('en', en);
  const i18n = g.WH && g.WH.i18n;
  if (i18n && typeof i18n.add === 'function') {
    i18n.add('cs', cs);
    i18n.add('en', en);
  }
  /** All i18n keys the engine can throw or use (for completeness checks). */
  E.text.errorKeys = Object.keys(cs).filter((k) => k.startsWith('err.'));
})();
