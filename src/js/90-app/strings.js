/* Strings of the app glue (90-app): the safety-net message and the optional browser-agent tools (titles, errors). */
(function () {
  'use strict';
  const WH = (globalThis.WH = globalThis.WH || {});
  WH.i18n.add('cs', {
    'app.tool.coverage': 'Přečíst odhad pokrytí',
    'app.tool.speed': 'Přečíst odhad rychlosti',
    'app.tool.exportPlan': 'Exportovat aktuální půdorys',
    'app.tool.exportSvg': 'Stáhnout vektorový půdorys',
    'app.tool.import': 'Načíst půdorys',
    'app.tool.router': 'Přesunout router na mapě',
    'app.tool.node': 'Přesunout přístupový bod',
    'app.tool.wholeFlat': 'Celý byt',
    'app.tool.err.position': 'Poloha musí ležet na podlaze bytu, x/y od 0 do 1.',
    'app.tool.err.noNode': 'Nejdřív přidej nebo zapni přístupový bod v kartě Další přístupové body.',
    'app.tool.err.import': 'Dodej jedno SVG nebo jeden obrázek PNG, JPG či WebP.',
    'app.tool.err.notReady': 'Aplikace se ještě načítá, zkus to za chvíli znovu.',
    'app.tool.speed.noCurve': 'Zadej alespoň dva testy downloadu i uploadu pro stejné zařízení a pásmo, se signálem lišícím se alespoň o 5 dB.',
    'app.err.unexpected': 'Něco se nepovedlo. Tvoje data jsou v bezpečí; když něco nereaguje, obnov stránku (F5).',
    'app.err.details': 'Podrobnosti',
  });
  WH.i18n.add('en', {
    'app.tool.coverage': 'Read the coverage estimate',
    'app.tool.speed': 'Read the speed estimate',
    'app.tool.exportPlan': 'Export the current floor plan',
    'app.tool.exportSvg': 'Download the vector floor plan',
    'app.tool.import': 'Load a floor plan',
    'app.tool.router': 'Move the router on the map',
    'app.tool.node': 'Move an access point',
    'app.tool.wholeFlat': 'Whole flat',
    'app.tool.err.position': 'The position must lie on the floor of the flat, x/y from 0 to 1.',
    'app.tool.err.noNode': 'Add or switch on an access point in the More access points card first.',
    'app.tool.err.import': 'Supply one SVG or one PNG, JPG or WebP image.',
    'app.tool.err.notReady': 'The app is still loading, try again in a moment.',
    'app.tool.speed.noCurve': 'Enter at least two download and upload tests for the same device and band whose signal differs by at least 5 dB.',
    'app.err.unexpected': 'Something went wrong. Your data is safe; if something stops responding, reload the page (F5).',
    'app.err.details': 'Details',
  });
})();
