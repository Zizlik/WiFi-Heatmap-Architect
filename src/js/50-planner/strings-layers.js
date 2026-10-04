/* Planner strings: the map layers "Body měření" / "Předpověď u bodů" (view.points / view.whatif) and "Zdroj signálu"
 * (view.sourceZones, SPEC 10.3) + what the second node is called on the map (marker tag, legend, tooltip, Result), cs + en. */
(function () {
  'use strict';
  const I = globalThis.WH.i18n;

  I.add('cs', {
    'planner.layers.points': 'Body měření',
    'planner.layers.whatif': 'Předpověď u bodů',
    // why the "Předpověď u bodů" switch is greyed (shown in its "?" and after the P key)
    'planner.layers.why.points': 'Teď není co ukázat: body měření jsou skryté. Zapni nejdřív Body měření.',
    'planner.layers.why.none': 'Teď není co ukázat: zatím nemáš žádné měření.',
    'planner.layers.why.same': 'Teď není co ukázat: router stojí na dnešním místě a žádný další přístupový bod není zapnutý. Posuň router nebo přidej přístupový bod.',
    'planner.layers.whatifOn': 'Předpověď u bodů: zapnuto',
    'planner.layers.whatifOff': 'Předpověď u bodů: vypnuto',
    'planner.layers.pointsBack': 'Body měření jsou zase vidět, ať víš, kde už jsi měřil.',
    'planner.keys.whatif': 'Předpověď u bodů (zapnout / vypnout)',
    'help.layerPoints.t': 'Body měření',
    'help.layerPoints.b': 'Tečky na mapě tam, kde jsi měřil, s naměřenou hodnotou. Vypni je, když chceš vidět jen mapu signálu. Seznam měření v panelu zůstane.',
    'help.layerWhatIf.t': 'Předpověď u bodů',
    'help.layerWhatIf.b': 'Když posuneš router nebo zapneš další přístupový bod, ukáže u každé tečky, co by tam bylo, třeba −72 → −58 (+14) nebo ↓120 → ≈310. Vypnutá: tečky ukazují jen to, co jsi naměřil. Klávesa P.',
    'help.layerWhatIf.more': 'Souhrn „Co by se změnilo v tvých bodech“ v kartě Zpřesnit měřením zůstane i tak.',

    // SPEC 10.3: the layer "Zdroj signálu" - where the second point is the stronger source
    'planner.layers.source': 'Zdroj signálu',
    'planner.layers.why.noNode': 'Teď není co ukázat: žádný další přístupový bod není zapnutý. Přidej nebo zapni ho v kartě Další přístupové body.',
    'help.layerSource.t': 'Zdroj signálu',
    'help.layerSource.b': 'Když máš zapnuté další přístupové body, nakreslí hranice mezi částmi bytu, kde je silnější router a kde některý z bodů (ty jsou jemně šrafované modře). Hned vidíš, kdo pokrývá kterou místnost.',
    'help.layerSource.more': 'Čáry dosahu se kreslí kolem každého zdroje: ty od přístupových bodů mají modrý podklad a malou značku s číslem nebo písmenem z názvu bodu. U bezdrátového bodu se slabým spojením je šrafování šedé. V pohledu Rychlost se vrstva nekreslí.',
    // the legend's range-line row ("čáry: router · AP 2") and the source row (what the hatch means; the grey weak-uplink
    // hatch of a wireless node replaces the blue one)
    'planner.legend.lines': 'čáry:',
    'planner.legend.srcRouter': 'router',
    'planner.legend.source': 'šrafy: tady je silnější {node}, jinde router',
    'planner.legend.sourceWeak': 'šrafy: tady je silnější {node}, ale má slabé spojení s routerem',
    // the hover tooltip: "Silnější zdroj: AP 2 (−48 dBm) · router (−71 dBm)"
    'planner.tip.source': 'Silnější zdroj: {a} ({va}) · {b} ({vb})',
    'planner.tip.routerName': 'router',
    // what the second point is called by its type (the marker tag, the legend, the sentences)
    'planner.mk.nodeLbl.ap_cable': 'AP 2',
    'planner.mk.nodeLbl.mesh_cable': 'Mesh 2',
    'planner.mk.nodeLbl.mesh_wifi': 'Mesh 2',
    'planner.mk.nodeLbl.repeater': 'Opakovač',
    // the link to the router (dashed line between the two markers)
    'planner.mk.linkCable': 'kabel',
    'planner.mk.linkWifi': 'Wi-Fi',
    // the Result card: which rooms the second point covers
    'planner.res.srcOne': '{who} má navrch v místnosti {list}, jinde je silnější router.',
    'planner.res.srcMany': '{who} má navrch v místnostech {list}, jinde je silnější router.',
    'planner.res.srcAll': '{who} je silnější než router v celém bytě.',
    'planner.res.srcNone': '{who} není nikde silnější než router – zkus ho posunout dál od routeru.',
    'planner.res.and': 'a',
  });

  I.add('en', {
    'planner.layers.points': 'Measurement points',
    'planner.layers.whatif': 'Predicted change at points',
    'planner.layers.why.points': 'Nothing to show now: the measurement points are hidden. Switch on Measurement points first.',
    'planner.layers.why.none': 'Nothing to show yet: you have no measurements.',
    'planner.layers.why.same': 'Nothing to show now: the router is at today’s spot and no extra access point is on. Move the router or add an access point.',
    'planner.layers.whatifOn': 'Predicted change at points: on',
    'planner.layers.whatifOff': 'Predicted change at points: off',
    'planner.layers.pointsBack': 'Measurement points are visible again, so you can see where you have measured.',
    'planner.keys.whatif': 'Predicted change at points (on / off)',
    'help.layerPoints.t': 'Measurement points',
    'help.layerPoints.b': 'Dots on the map where you measured, with the measured value. Switch them off to see just the signal map. The list of measurements in the panel stays.',
    'help.layerWhatIf.t': 'Predicted change at points',
    'help.layerWhatIf.b': 'When you move the router or switch on an extra access point, every dot shows what it would get there, for example −72 → −58 (+14) or ↓120 → ≈310. Off: the dots show only what you measured. Key P.',
    'help.layerWhatIf.more': 'The “What would change at your points” summary in the Improve with measurements card stays either way.',

    'planner.layers.source': 'Signal source',
    'planner.layers.why.noNode': 'Nothing to show now: no extra access point is on. Add or switch one on in the More access points card.',
    'help.layerSource.t': 'Signal source',
    'help.layerSource.b': 'With extra access points on, it draws the borders between the parts of your home where the router is stronger and where one of the points is (those get a light blue hatch). You see at a glance who covers which room.',
    'help.layerSource.more': 'Range lines are drawn around every source: those of the access points have a blue backing and a small tag with the number or letter from the point’s name. With a wireless point whose link is weak, the hatch is grey. The Speed view does not draw this layer.',
    'planner.legend.lines': 'lines:',
    'planner.legend.srcRouter': 'router',
    'planner.legend.source': 'hatched: {node} is stronger here, the router elsewhere',
    'planner.legend.sourceWeak': 'hatched: {node} is stronger here, but its link to the router is weak',
    'planner.tip.source': 'Stronger source: {a} ({va}) · {b} ({vb})',
    'planner.tip.routerName': 'router',
    'planner.mk.nodeLbl.ap_cable': 'AP 2',
    'planner.mk.nodeLbl.mesh_cable': 'Mesh 2',
    'planner.mk.nodeLbl.mesh_wifi': 'Mesh 2',
    'planner.mk.nodeLbl.repeater': 'Repeater',
    'planner.mk.linkCable': 'cable',
    'planner.mk.linkWifi': 'Wi-Fi',
    'planner.res.srcOne': '{who} is the stronger source in {list}; the router elsewhere.',
    'planner.res.srcMany': '{who} is the stronger source in {list}; the router elsewhere.',
    'planner.res.srcAll': '{who} is stronger than the router everywhere.',
    'planner.res.srcNone': '{who} is nowhere stronger than the router – try moving it further from the router.',
    'planner.res.and': 'and',
  });
})();
