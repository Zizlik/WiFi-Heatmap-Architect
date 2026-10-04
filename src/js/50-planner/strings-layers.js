/* Planner strings: the map layers "Body měření" / "Předpověď u bodů" (view.points / view.whatif), cs + en. */
(function () {
  'use strict';
  const I = globalThis.WH.i18n;

  I.add('cs', {
    'planner.layers.points': 'Body měření',
    'planner.layers.whatif': 'Předpověď u bodů',
    // why the "Předpověď u bodů" switch is greyed (shown in its "?" and after the P key)
    'planner.layers.why.points': 'Teď není co ukázat: body měření jsou skryté. Zapni nejdřív Body měření.',
    'planner.layers.why.none': 'Teď není co ukázat: zatím nemáš žádné měření.',
    'planner.layers.why.same': 'Teď není co ukázat: router stojí na dnešním místě a druhý bod je vypnutý. Posuň router nebo zapni druhý bod.',
    'planner.layers.whatifOn': 'Předpověď u bodů: zapnuto',
    'planner.layers.whatifOff': 'Předpověď u bodů: vypnuto',
    'planner.layers.pointsBack': 'Body měření jsou zase vidět, ať víš, kde už jsi měřil.',
    'planner.keys.whatif': 'Předpověď u bodů (zapnout / vypnout)',
    'help.layerPoints.t': 'Body měření',
    'help.layerPoints.b': 'Tečky na mapě tam, kde jsi měřil, s naměřenou hodnotou. Vypni je, když chceš vidět jen mapu signálu. Seznam měření v panelu zůstane.',
    'help.layerWhatIf.t': 'Předpověď u bodů',
    'help.layerWhatIf.b': 'Když posuneš router nebo zapneš druhý bod, ukáže u každé tečky, co by tam bylo, třeba −72 → −58 (+14) nebo ↓120 → ≈310. Vypnutá: tečky ukazují jen to, co jsi naměřil. Klávesa P.',
    'help.layerWhatIf.more': 'Souhrn „Co by se změnilo v tvých bodech“ v kartě Zpřesnit měřením zůstane i tak.',
  });

  I.add('en', {
    'planner.layers.points': 'Measurement points',
    'planner.layers.whatif': 'Predicted change at points',
    'planner.layers.why.points': 'Nothing to show now: the measurement points are hidden. Switch on Measurement points first.',
    'planner.layers.why.none': 'Nothing to show yet: you have no measurements.',
    'planner.layers.why.same': 'Nothing to show now: the router is at today’s spot and the second point is off. Move the router or switch on a second point.',
    'planner.layers.whatifOn': 'Predicted change at points: on',
    'planner.layers.whatifOff': 'Predicted change at points: off',
    'planner.layers.pointsBack': 'Measurement points are visible again, so you can see where you have measured.',
    'planner.keys.whatif': 'Predicted change at points (on / off)',
    'help.layerPoints.t': 'Measurement points',
    'help.layerPoints.b': 'Dots on the map where you measured, with the measured value. Switch them off to see just the signal map. The list of measurements in the panel stays.',
    'help.layerWhatIf.t': 'Predicted change at points',
    'help.layerWhatIf.b': 'When you move the router or switch on a second point, every dot shows what it would get there, for example −72 → −58 (+14) or ↓120 → ≈310. Off: the dots show only what you measured. Key P.',
    'help.layerWhatIf.more': 'The “What would change at your points” summary in the Improve with measurements card stays either way.',
  });
})();
