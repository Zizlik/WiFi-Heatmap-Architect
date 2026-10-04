/* Plain-language explanations behind every tiny round "?" hint (help.<key>.t = title, .b = 1-3 sentences, .more = optional
 * second paragraph).  The glossary in the Help panel is generated from this list, so keep titles short and unique.
 * Obstacle losses are 5 GHz reference values scaled per band (x0.65 at 2.4 GHz, x1.15 at 6 GHz, SPEC 7.1); material presets
 * 2.4 / 5 / 6 GHz: drywall 3/4/5, wood 3/5/6, glass 2/4/5, brick 7/11/13, concrete 12/18/21, reinforced 17/26/30, metal 25/30/32 dB. */
(function () {
  'use strict';
  const I = globalThis.WH.i18n;

  I.add('cs', {
    'ui.hint.about': 'Vysvětlení: {topic}',

    // --- general -------------------------------------------------------------------------------------------------
    'help.estimate.t': 'Orientační odhad',
    'help.estimate.b': 'Mapa vychází z matematického modelu, ne z měření v každém koutě bytu. Skutečný signál se může lišit o 5 až 10 dB, tedy zhruba o jeden stupeň ve slovním hodnocení.',
    'help.estimate.more': 'Čím víc míst v bytě změříš telefonem a zadáš do aplikace, tím přesnější mapa bude. Než router opravdu přestěhuješ nebo koupíš další zařízení, výsledek vždy ověř měřením.',

    'help.mode.t': 'Dva režimy',
    'help.mode.b': 'Půdorys slouží ke kreslení bytu (místnosti, zdi, dveře, nábytek). Wi-Fi ukáže mapu signálu a hledá nejlepší místo pro router.',
    'help.mode.more': 'Přepínáš je klávesami 1 a 2. Změny v půdorysu se do mapy signálu promítnou hned, nic nemusíš potvrzovat.',

    'help.dbm.t': 'dBm (síla signálu)',
    'help.dbm.b': 'dBm je jednotka síly signálu. Je to záporné číslo: čím blíž nule, tím lepší signál. Například −50 dBm je výborný, −67 dBm ještě dobrý a −80 dBm už je slabý a často vypadává.',
    'help.dbm.more': 'Rozdíl 3 dB znamená zhruba dvojnásobek nebo polovinu výkonu, rozdíl 10 dB je desetinásobek.',

    'help.quality.t': 'Slovní hodnocení signálu',
    'help.quality.b': 'Slova jsou jen pohodlný překlad dBm: Výborný od −50, Velmi dobrý −50 až −60, Dobrý −60 až −67, Slabý −67 až −75, Velmi slabý −75 až −85. Pod −85 dBm je signál nepoužitelný.',

    'help.palette.t': 'Barevná paleta',
    'help.palette.b': 'Výchozí paleta jde od červené (špatný signál) přes žlutou po modrozelenou (výborný). Při barvosleposti zapni alternativní paletu od tmavě fialové po žlutou, která se dá rozlišit i bez rozeznávání červené a zelené.',

    // --- bands ---------------------------------------------------------------------------------------------------
    'help.band.t': 'Pásmo (2,4 / 5 / 6 GHz)',
    'help.band.b': 'Wi-Fi vysílá na různých frekvencích. 2,4 GHz doletí nejdál a zdmi prochází nejlépe, ale je nejpomalejší. 5 GHz je rychlejší, ale zdi ho tlumí víc. 6 GHz je nejrychlejší a má nejkratší dosah.',
    'help.band.more': 'Stejná zeď ubere na 2,4 GHz zhruba o třetinu méně než na 5 GHz a na 6 GHz asi o šestinu víc: cihlová zeď třeba 7 / 11 / 13 dB, betonová 12 / 18 / 21 dB. Přepni pásmo a uvidíš, jak se pokrytí změní. Volba Auto ukáže v každém místě to pásmo, které by si tam telefon nebo notebook nejspíš vybral sám.',

    'help.band24.t': '2,4 GHz',
    'help.band24.b': 'Největší dosah, protože zdmi prochází nejlépe (cihla ubere asi 7 dB, na 5 GHz 11 dB). Rychlost je ale nejnižší (v praxi zhruba 50 až 150 Mb/s) a hodně ho ruší sousedé, mikrovlnka nebo Bluetooth. Hodí se pro chytré zásuvky, kamery a vzdálené místnosti.',

    'help.band5.t': '5 GHz',
    'help.band5.b': 'Dobrý kompromis: několikrát rychlejší než 2,4 GHz (v praxi stovky Mb/s), ale zdi ho tlumí víc (cihla asi 11 dB, beton 18 dB). Většina notebooků a telefonů na něm běží nejčastěji, proto je to výchozí pásmo v aplikaci.',

    'help.band6.t': '6 GHz (Wi-Fi 6E / 7)',
    'help.band6.b': 'Nejrychlejší a nejméně rušené pásmo, ale s nejkratším dosahem: zdi tlumí nejvíc (cihla asi 13 dB, beton 21 dB), takže už jedna zeď signál citelně zeslabí. Funguje jen s routerem i zařízením, které 6 GHz umí (Wi-Fi 6E nebo 7).',

    'help.bandSteering.t': 'Wi-Fi 7 a automatické přepínání pásem',
    'help.bandSteering.b': 'Moderní routery (Wi-Fi 6, 6E a hlavně Wi-Fi 7) mají jednu síť pro všechna pásma a zařízení si samo vybírá, na kterém pojede: u routeru 6 nebo 5 GHz, dál za zdmi 2,4 GHz. Wi-Fi 7 (MLO) dokonce jede na dvou pásmech naráz. Nic nepřepínej ani nevypínej, měř normálně tak, jak síť používáš.',
    'help.bandSteering.more': 'Aplikace si u každého měření zapíše pásmo, na kterém jsi v tu chvíli byl (na počítači ho zjistí pomocník, na telefonu ho vybereš, nebo zvolíš „Nevím“ a aplikace ho odhadne). Model se pak ladí pro každé pásmo zvlášť. Pásmo Auto na mapě ukazuje, kde budeš nejspíš na 6, 5 a kde na 2,4 GHz.',

    // --- results -------------------------------------------------------------------------------------------------
    'help.threshold.t': 'Hranice dobrého signálu',
    'help.threshold.b': 'Od jaké síly signálu považujeme místo za pokryté. Výchozí −67 dBm stačí na plynulé video i hovory. Zvýšíš-li ji třeba na −60, bude mapa přísnější a pokrytí vyjde nižší, snížení na −72 je shovívavější.',

    'help.coverage.t': 'Pokrytí',
    'help.coverage.b': 'Kolik procent podlahové plochy má signál alespoň na hranici dobrého signálu. Například 80 % znamená, že pětina bytu (třeba koupelna a komora) má signál slabší, než chceš.',
    'help.coverage.more': 'Počítá se podle plochy, ne podle počtu místností: velký obývák váží víc než malá komora.',

    'help.avgSignal.t': 'Průměrný signál',
    'help.avgSignal.b': 'Průměr síly signálu přes celou vybranou plochu. Hodí se k porovnání dvou poloh routeru: o 3 dB lepší průměr je už znatelné zlepšení. Jedno slabé místo ale průměr neprozradí, na to se dívej na pokrytí a na nejhorších 10 %.',

    'help.p10.t': 'Nejslabších 10 %',
    'help.p10.b': 'Hodnota, pod kterou je jen nejslabších 10 % plochy. Průměr může vypadat dobře, i když je v bytě mrtvé místo, a právě to toto číslo prozradí.',

    'help.target.t': 'Cíl: celý byt, nebo místnost',
    'help.target.b': 'Určuje, pro co se pokrytí počítá a co hledáme. „Celý byt“ bere všechny místnosti, které nevyřadíš v Pokročilém. Vybereš-li místnost, hledá se poloha routeru nejlepší hlavně pro ni, třeba pro pracovnu s počítačem.',

    'help.roomsCount.t': 'Místnosti v „Celý byt“',
    'help.roomsCount.b': 'Zvol, které místnosti se počítají do výsledku pro celý byt. Vyřaď třeba terasu, sklep nebo garáž, kde Wi-Fi nepotřebuješ, aby nesnižovaly pokrytí.',

    'help.viewSwitch.t': 'Co mapa ukazuje',
    'help.viewSwitch.b': 'Signál ukáže, jak silné Wi-Fi je v kterém místě. Rychlost odhadne Mb/s (potřebuje měření s rychlostí). Změna ukáže rozdíl proti dnešní poloze routeru.',
    'help.viewSwitch.more': 'Mezi pohledy přepínáš klávesou V.',

    'help.speedView.t': 'Pohled Rychlost',
    'help.speedView.b': 'Místo síly signálu ukáže, jakou rychlost internetu v dané části bytu pravděpodobně dostaneš. Aby to šlo, potřebuje aplikace k měření i stahování a odesílání (Mb/s) z testu rychlosti, aspoň ve dvou místech s různě silným signálem.',

    'help.diffView.t': 'Změna proti dnešku',
    'help.diffView.b': 'Barevně ukáže rozdíl mezi zkušební a dnešní polohou routeru: zeleně tam, kde se signál zlepší, červeně kde zhorší, šedě kde zůstane stejný. Rychlý způsob, jak poznat, jestli se přesun vyplatí.',

    'help.layers.t': 'Vrstvy mapy',
    'help.layers.b': 'Zapni nebo vypni, co je na mapě vidět: čáry dosahu, zdroj signálu (který přístupový bod je kde nejsilnější), zdi, nábytek, názvy místností, čísla v dBm, body měření a předpověď u nich. Nic z toho nemění výpočet, jen vzhled.',

    'help.ranges.t': 'Čáry dosahu',
    'help.ranges.b': 'Tenké čáry na mapě spojují místa se stejnou sílou signálu, podobně jako vrstevnice na turistické mapě. Ukazují, kam až signál dosáhne při zvolené hranici. Přepni pásmo: na 2,4 GHz sahají čáry přes zdi dál než na 5 nebo 6 GHz.',

    'help.rangeThreshold.t': 'Hranice čar dosahu',
    'help.rangeThreshold.b': 'Při jaké síle signálu se čára dosahu kreslí. Výchozí −60 dBm je „pohodlný“ dosah, −75 dBm ukáže, kam signál ještě s námahou dosáhne.',

    // --- positions -----------------------------------------------------------------------------------------------
    'help.today.t': 'Dnešní poloha',
    'help.today.b': 'Místo, kde router skutečně stojí teď. S ním porovnáváme všechny výsledky, takže vidíš, o kolik se situace zlepší nebo zhorší. Měření signálu se vždy vztahují právě k této poloze.',

    'help.trial.t': 'Zkušební poloha',
    'help.trial.b': 'Tady router jen zkoušíš, doopravdy se nic neděje. Přetahuj červený router po půdorysu a mapa se hned přepočítá. Když najdeš lepší místo, přenes tam router i ve skutečnosti.',

    'help.baseline.t': 'Základ pro měření',
    'help.baseline.b': 'Všechna měření, která zadáš, platí pro router na dnešním místě. Pokud ho opravdu přestěhuješ a označíš novou polohu jako dnešní, stará měření se smažou, protože by už neodpovídala.',

    'help.inlet.t': 'Přípojka internetu',
    'help.inlet.b': 'Místo, kde do bytu přichází internet (zásuvka, modem nebo optická krabička). Router k němu musí dosáhnout kabelem, proto aplikace ukazuje vzdálenost.',

    'help.cable.t': 'Délka kabelu k přípojce',
    'help.cable.b': 'Orientační délka kabelu mezi přípojkou a routerem. Kabel se vede podél stěn a rohů, takže bývá zhruba o třetinu až polovinu delší než vzdušná čára: z 5 m vzdušnou čarou jsou asi 7 m kabelu. Před nákupem ho raději změř metrem.',

    'help.optimize.t': 'Najít nejlepší místo',
    'help.optimize.b': 'Aplikace vyzkouší stovky poloh rozmístěných po bytě zhruba po půl metru a vybere tu s nejlepším pokrytím a průměrným signálem pro zvolený cíl. Trvá to pár sekund. Výsledek ber jako tip a ověř, jestli tam jde router prakticky zapojit.',

    'help.allowedArea.t': 'Kam ho můžu dát?',
    'help.allowedArea.b': 'Omezí hledání na jednu místnost, například na chodbu, kde je přípojka a zásuvka. „Kamkoli“ hledá po celém bytě, což dá nejlepší signál, ale nemusí to být místo, kam se router dá umístit.',

    // --- model ---------------------------------------------------------------------------------------------------
    'help.nearSignal.t': 'Signál 1 m od routeru',
    'help.nearSignal.b': 'Jak silný je signál metr od routeru (u 5 GHz). Typicky −40 dBm, slabší router nebo hodně tlumený signál dá třeba −45. Běžně na to nesahej: po zadání měření se doladí samo.',

    'help.decay.t': 'Slábnutí se vzdáleností',
    'help.decay.b': 'Číslo, které říká, jak rychle signál slábne s odstupem od routeru. 2 je volný prostor, v bytě bývá 2,2 až 3, v domě s hodně přepážkami víc. Vyšší číslo znamená rychlejší slábnutí.',

    'help.wallLoss.t': 'Výchozí útlum zdi',
    'help.wallLoss.b': 'O kolik dB signál zeslábne při průchodu jednou zdí, když u konkrétní zdi není nastaveno jinak. Hodnota platí pro 5 GHz; na 2,4 GHz s ní aplikace počítá zhruba ze dvou třetin (×0,65) a na 6 GHz trochu vyšší (×1,15), takže 8 dB je asi 5 dB na 2,4 GHz a 9 dB na 6 GHz.',
    'help.wallLoss.more': 'Každé 3 dB navíc znamenají polovinu výkonu. Sádrokarton ubere při 5 GHz asi 4 dB, cihla 11 dB, beton 18 dB.',

    'help.scale.t': 'Měřítko',
    'help.scale.b': 'Aplikace potřebuje vědět, kolik metrů je jeden kus nákresu. Nejjednodušší je zadat plochu bytu v m² (najdeš ji ve smlouvě nebo v inzerátu). Jinak v Půdorysu označ dvě místa, jejichž vzdálenost znáš (třeba šířka dveří 80 cm), nebo zadej skutečnou šířku celého půdorysu. Špatné měřítko zkresluje celý odhad.',

    // --- measurements --------------------------------------------------------------------------------------------
    'help.calibration.t': 'Kalibrace podle měření',
    'help.calibration.b': 'Z naměřených hodnot aplikace zjistí, o kolik je tvůj router silnější nebo slabší, než model čekal („o 4 dB silnější“), a celou mapu podle toho upraví. Se 4 a více měřeními v různých místnostech doladí i útlum zdí a úbytek signálu se vzdáleností.',
    'help.calibration.more': '„Sedí na ±3 dB“ je poctivý odhad přesnosti: každé měření se zkusí předpovědět bez něj samotného. Vypnutím přepínače uvidíš výchozí model.',

    'help.measurement.t': 'Měření',
    'help.measurement.b': 'Skutečně změřený signál na konkrétním místě bytu (telefonem nebo notebookem, viz Nápověda → Jak změřit signál). Při měření musí router stát na dnešním místě. Čím víc míst a místností, tím věrnější mapa.',

    'help.residual.t': 'Odchylka od modelu',
    'help.residual.b': 'Rozdíl mezi tím, co jsi naměřil, a tím, co model na tom místě předpověděl po kalibraci. Do ±3 dB je to výborné, nad ±8 dB zkontroluj zdi mezi routerem a měřeným místem nebo polohu měření.',

    'help.unitPct.t': 'dBm, nebo % (Windows)',
    'help.unitPct.b': 'Windows ukazuje signál v procentech. Aplikace je převede vzorcem dBm ≈ % ÷ 2 − 100, například 70 % je zhruba −65 dBm. Je to hrubý převod, proto je přesnější použít program, který dBm ukáže přímo.',

    'help.device.t': 'Zařízení',
    'help.device.b': 'Rychlost záleží na tom, čím měříš (starý telefon se chová jinak než nový notebook). Vyber zařízení ze seznamu, nebo zadej vlastní název. Odhad rychlosti se učí zvlášť pro každé zařízení, takže se měření nemíchají.',

    // --- speed ---------------------------------------------------------------------------------------------------
    'help.speedTarget.t': 'Cílová rychlost',
    'help.speedTarget.b': 'Jakou rychlost chceš v místnosti mít, třeba 50 Mb/s pro 4K video nebo 20 Mb/s pro videohovory. Aplikace zvýrazní místa, kde ji pravděpodobně dosáhneš. Nemůže být vyšší než rychlost tvé přípojky.',

    'help.reserve.t': 'Rezerva',
    'help.reserve.b': 'Kolik procent rychlosti necháváš stranou, protože ji obvykle celou nevyužiješ (rušení, ostatní zařízení, špičky). Při rezervě 30 % musí síť na cíl 50 Mb/s zvládat asi 71 Mb/s.',

    'help.plan.t': 'Tarif (rychlost přípojky)',
    'help.plan.b': 'Rychlost, kterou platíš u poskytovatele, třeba 500 Mb/s stahování a 500 Mb/s odesílání. Wi-Fi nemůže být rychlejší než přípojka, proto slouží jako strop pro odhad.',

    'help.wan.t': 'Vstup z internetu (WAN)',
    'help.wan.b': 'WAN je „vstup do internetu“, tedy kabel nebo optika od poskytovatele. Pokud je jeho rychlost nižší než rychlost Wi-Fi, brzdí celou síť právě on.',

    'help.wanPort.t': 'Port WAN na routeru',
    'help.wanPort.b': 'Rychlost zásuvky na routeru, do které se připojuje internet. Nejběžnější je 1000 Mb/s (1 Gb/s). Starší routery mají jen 100 Mb/s, což zbrzdí i rychlejší tarif.',

    'help.ontPort.t': 'Port optické krabičky (ONT)',
    'help.ontPort.b': 'U optiky je mezi zásuvkou a routerem malá krabička (ONT) s vlastním síťovým portem. Má-li jen 1 Gb/s, rychlejší tarif, třeba 2 Gb/s, nevyužiješ. Rychlost najdeš na štítku nebo v návodu.',

    'help.link.t': 'Sjednaná rychlost linky',
    'help.link.b': 'Rychlost, na které se router a krabička nebo modem po kabelu dohodly (zobrazuje ji správa routeru, např. 1000 Mb/s). Je-li nižší, než čekáš, bývá vadný kabel nebo konektor.',

    'help.cableCategory.t': 'Kategorie kabelu',
    'help.cableCategory.b': 'Kategorie bývá natištěná na plášti kabelu (Cat5e, Cat6, …). Cat5e zvládne 1 Gb/s, Cat6 až 10 Gb/s na kratší vzdálenost, Cat6a na plných 100 m. Starý Cat5 nebo velmi dlouhý kabel může rychlost omezit.',

    // --- access points, mesh, repeaters ----------------------------------------------------------------------------
    'help.secondAp.t': 'Proč další přístupový bod',
    'help.secondAp.b': 'Další zařízení, které vysílá Wi-Fi, pokryje vzdálenou část bytu nebo domu, kam router nedosáhne. Nejlepší je připojit ho k routeru kabelem. Přidej jich, kolik potřebuješ (až 8), vyber typ podle toho, co máš nebo chceš koupit, a polohu přetáhni na půdorysu.',

    'help.apCable.t': 'Přístupový bod po kabelu',
    'help.apCable.b': 'Přístupový bod (AP) připojený síťovým kabelem k routeru. Je to nejspolehlivější řešení: plná rychlost i ve vzdálené místnosti. Vyžaduje ale natažený kabel.',

    'help.meshCable.t': 'Mesh po kabelu',
    'help.meshCable.b': 'Mesh uzel propojený s hlavním routerem kabelem. Wi-Fi mezi uzly se pak nespotřebovává na přenos dat, takže zůstane plná rychlost. Zařízení se mezi uzly přepínají samy.',

    'help.meshWifi.t': 'Mesh přes Wi-Fi',
    'help.meshWifi.b': 'Mesh uzel bez kabelu, který se s routerem spojuje bezdrátově. Je pohodlný, ale spojení k routeru spotřebuje část rychlosti (často polovinu) a funguje dobře jen tam, kde je signál od routeru ještě dobrý, zhruba −65 dBm a víc.',

    'help.repeater.t': 'Opakovač',
    'help.repeater.b': 'Zařízení, které signál přijme a vyšle dál. Je to nejlevnější řešení bez kabelu, ale zpravidla nejslabší: rychlost se výrazně sníží a zařízení někdy zůstanou přilepená na horším signálu.',

    'help.backhaul.t': 'Spojení uzlu s routerem',
    'help.backhaul.b': 'Bezdrátové propojení přístupového bodu s routerem (nebo s jiným bodem, přes který se připojuje). Aby mesh nebo opakovač fungoval dobře, musí být na jeho místě ještě dobrý signál od toho, ke komu se připojuje. Mapa šrafuje místa, kde bod sice vysílá, ale dál se spojuje špatně.',

    'help.power.t': 'Výkon vysílače',
    'help.power.b': 'Úprava výkonu uzlu oproti routeru v dB. 0 znamená stejný výkon, −6 dB zhruba čtvrtinový. Větší výkon zvětší dosah, ale zařízení v bytě tím nezrychlíš: telefon pořád vysílá zpátky slabě.',

    // --- floor-plan editor ---------------------------------------------------------------------------------------
    'help.wallMaterial.t': 'Materiál zdi',
    'help.wallMaterial.b': 'Každý materiál tlumí signál jinak, a čím vyšší frekvence, tím víc. Při 2,4 / 5 / 6 GHz: sádrokarton 3 / 4 / 5 dB, dřevo 3 / 5 / 6, sklo 2 / 4 / 5, cihla 7 / 11 / 13, beton 12 / 18 / 21, železobeton 17 / 26 / 30, kov 25 / 30 / 32 dB.',
    'help.wallMaterial.more': 'Vyber nejbližší materiál. Vlastní hodnotu zadáváš pro 5 GHz a pro 2,4 a 6 GHz ji aplikace přepočítá sama (×0,65 a ×1,15). Čísla vycházejí z měření NIST a běžných tabulek útlumu.',

    'help.doorLoss.t': 'Útlum dveří',
    'help.doorLoss.b': 'Otevřený průchod signál netlumí (0 dB). Zavřené dřevěné dveře ubírají zhruba 3 dB. U dveří, které bývají zavřené (ložnice, koupelna), proto nastav asi 3 dB.',

    'help.furnitureLoss.t': 'Útlum nábytku',
    'help.furnitureLoss.b': 'O kolik dB nábytek signál oslabí (při 5 GHz; na 2,4 GHz o něco méně, na 6 GHz o něco víc). Postel nebo gauč zhruba 1 dB, dřevěná skříň 3 dB, plná knihovna 5 dB, lednice či pračka 8 dB, kovová skříň 12 dB.',

    'help.blocksSignal.t': 'Blokuje signál',
    'help.blocksSignal.b': 'Zapnuto: signál při průchodu tímto kusem nábytku slábne. Vypni u nízkých věcí (konferenční stolek, koberec), přes které signál prochází téměř bez ztráty.',

    'help.snap.t': 'Přichytávání',
    'help.snap.b': 'Při kreslení se body samy přichytávají k mřížce a k rohům a koncům zdí, takže se spoje přesně potkají. Přidržením klávesy Alt přichytávání na chvíli vypneš.',

    'help.trace.t': 'Podklad k obkreslení',
    'help.trace.b': 'Obrázek nebo plánek (třeba z inzerátu), který se zobrazí pod kreslením a ty ho obkreslíš místnostmi a zdmi. Podklad je jen vodítko, do výpočtu nevstupuje. Klávesou T ho skryješ.',

    'help.opacity.t': 'Průhlednost podkladu',
    'help.opacity.b': 'Posuvníkem podklad zesvětlíš nebo ztmavíš, aby bylo kreslení přes něj dobře vidět.',

    'help.autoWalls.t': 'Obtáhnout zdi kolem místností',
    'help.autoWalls.b': 'Doplní zeď kolem každé hrany místnosti, kde ještě žádná není. Existující zdi nemění ani nemaže a společné hrany sousedních místností vloží jen jednou. Potom stačí upravit materiál tlustých zdí.',

    // --- Help panel -> "Jak změřit signál": Wi-Fi details from a computer (SPEC 8 / 8.2) ----------------------------
    'helpPanel.cmd.t': 'Wi-Fi údaje z počítače jedním příkazem',
    'helpPanel.cmd.lead': 'Prohlížeč název sítě ani sílu signálu nevidí. Na počítači je zjistíš jedním příkazem – výsledek se rovnou zkopíruje do schránky. V aplikaci ho pak vložíš: okno měření → Info o zařízení → Vložit výsledek. Nejjednodušší je pak tlačítko Změřit vše.',
    'helpPanel.helper.t': 'Pomocník pro Wi-Fi (bez kopírování)',
    'helpPanel.helper.b': 'Ještě pohodlnější: stáhni pomocníka pro svůj systém a spusť ho dvojklikem (Windows: „Spustit pomocníka.cmd“, při modrém varování „Další informace“ → „Přesto spustit“; macOS: pravým tlačítkem → Otevřít). Dokud jeho okno běží, Změřit vše si Wi-Fi údaje vezme samo (u aplikace z internetu ho jednou připoj: Info o zařízení → Připojit pomocníka → v prohlížeči Povolit). Webová stránka program sama spustit nesmí, proto ten jeden dvojklik.',
  });

  I.add('en', {
    'ui.hint.about': 'Explanation: {topic}',

    // --- general -------------------------------------------------------------------------------------------------
    'help.estimate.t': 'Approximate estimate',
    'help.estimate.b': 'The map comes from a mathematical model, not from measurements in every corner of your home. The real signal can differ by 5 to 10 dB, which is roughly one step on the quality scale.',
    'help.estimate.more': 'The more places you measure with a phone and enter here, the more accurate the map gets. Before you really move the router or buy extra equipment, always check the result with a measurement.',

    'help.mode.t': 'Two modes',
    'help.mode.b': 'Floor plan is for drawing your home (rooms, walls, doors, furniture). Wi-Fi shows the signal map and looks for the best router spot.',
    'help.mode.more': 'Switch with the keys 1 and 2. Changes in the floor plan show up in the signal map right away, there is nothing to confirm.',

    'help.dbm.t': 'dBm (signal strength)',
    'help.dbm.b': 'dBm is the unit of signal strength. It is a negative number: the closer to zero, the better. For example −50 dBm is excellent, −67 dBm is still good and −80 dBm is weak and often drops out.',
    'help.dbm.more': 'A difference of 3 dB means roughly double or half the power, 10 dB is ten times.',

    'help.quality.t': 'Signal quality words',
    'help.quality.b': 'The words are just a friendly translation of dBm: Excellent from −50, Very good −50 to −60, Good −60 to −67, Weak −67 to −75, Very weak −75 to −85. Below −85 dBm the signal is unusable.',

    'help.palette.t': 'Colour palette',
    'help.palette.b': 'The default palette runs from red (poor signal) through yellow to teal (excellent). If you are colour-blind, switch on the alternative palette from dark purple to yellow, which can be told apart without seeing red and green.',

    // --- bands ---------------------------------------------------------------------------------------------------
    'help.band.t': 'Band (2.4 / 5 / 6 GHz)',
    'help.band.b': 'Wi-Fi uses different frequencies. 2.4 GHz reaches farthest and gets through walls best, but is the slowest. 5 GHz is faster, but walls weaken it more. 6 GHz is the fastest and has the shortest range.',
    'help.band.more': 'The same wall takes off roughly a third less at 2.4 GHz than at 5 GHz, and about a sixth more at 6 GHz: a brick wall for example 7 / 11 / 13 dB, a concrete one 12 / 18 / 21 dB. Switch the band to see how coverage changes. Auto shows, at every spot, the band a phone or laptop would most likely pick there by itself.',

    'help.band24.t': '2.4 GHz',
    'help.band24.b': 'The longest range, because it gets through walls best (brick takes off about 7 dB, 11 dB at 5 GHz). But the speed is the lowest (about 50 to 150 Mbps in practice) and there is lots of interference from neighbours, microwave ovens or Bluetooth. Good for smart plugs, cameras and distant rooms.',

    'help.band5.t': '5 GHz',
    'help.band5.b': 'A good compromise: several times faster than 2.4 GHz (hundreds of Mbps in practice), but walls weaken it more (brick about 11 dB, concrete 18 dB). Most laptops and phones use it most of the time, so it is the default band in the app.',

    'help.band6.t': '6 GHz (Wi-Fi 6E / 7)',
    'help.band6.b': 'The fastest and least crowded band, but with the shortest range: walls weaken it most (brick about 13 dB, concrete 21 dB), so even one wall is clearly felt. It only works if both the router and the device support 6 GHz (Wi-Fi 6E or 7).',

    'help.bandSteering.t': 'Wi-Fi 7 and automatic band switching',
    'help.bandSteering.b': 'Modern routers (Wi-Fi 6, 6E and above all Wi-Fi 7) have one network for all bands and each device picks the band by itself: 6 or 5 GHz near the router, 2.4 GHz further away behind walls. Wi-Fi 7 (MLO) even uses two bands at once. Do not switch or turn anything off, just measure the way you normally use the network.',
    'help.bandSteering.more': 'With every measurement the app notes the band you were on at that moment (on a computer the helper finds it out, on a phone you pick it, or choose “I don’t know” and the app estimates it). The model is then tuned for each band separately. The Auto band on the map shows where you will most likely be on 6, 5 or 2.4 GHz.',

    // --- results -------------------------------------------------------------------------------------------------
    'help.threshold.t': 'Good-signal threshold',
    'help.threshold.b': 'From what signal strength a spot counts as covered. The default of −67 dBm is enough for smooth video and calls. Raising it to, say, −60 makes the map stricter and coverage lower; lowering it to −72 is more forgiving.',

    'help.coverage.t': 'Coverage',
    'help.coverage.b': 'The share of floor area whose signal is at least the good-signal threshold. For example 80% means a fifth of your home (say the bathroom and the pantry) has a weaker signal than you want.',
    'help.coverage.more': 'It is calculated by area, not by number of rooms: a big living room counts for more than a small pantry.',

    'help.avgSignal.t': 'Average signal',
    'help.avgSignal.b': 'The average signal strength over the whole selected area. Handy for comparing two router positions: an average 3 dB better is already a noticeable improvement. A single weak spot will not show in an average, so also look at coverage and the worst 10%.',

    'help.p10.t': 'Weakest 10%',
    'help.p10.b': 'The value below which only the weakest 10% of the area falls. An average can look fine even with a dead spot in your home, and this number reveals it.',

    'help.target.t': 'Goal: whole flat or one room',
    'help.target.b': 'Decides what coverage is calculated for and what we search for. "Whole flat" uses every room you have not excluded under Advanced. If you pick a room, the search finds the router position that is best mainly for that room, for example the study with your computer.',

    'help.roomsCount.t': 'Rooms in "Whole flat"',
    'help.roomsCount.b': 'Choose which rooms count towards the whole-flat result. Leave out a balcony, cellar or garage where you do not need Wi-Fi, so they do not drag coverage down.',

    'help.viewSwitch.t': 'What the map shows',
    'help.viewSwitch.b': 'Signal shows how strong the Wi-Fi is at each spot. Speed estimates Mbps (it needs measurements that include speed). Change shows the difference against the router\'s position today.',
    'help.viewSwitch.more': 'Cycle through the views with the V key.',

    'help.speedView.t': 'Speed view',
    'help.speedView.b': 'Instead of signal strength it shows the internet speed you will probably get in each part of your home. For that the app needs download and upload (Mbps) from a speed test with each measurement, in at least two places with clearly different signal strength.',

    'help.diffView.t': 'Change vs. today',
    'help.diffView.b': 'Shows in colour the difference between the trial and today\'s router position: green where the signal improves, red where it gets worse, grey where it stays the same. A quick way to see whether a move is worth it.',

    'help.layers.t': 'Map layers',
    'help.layers.b': 'Turn on or off what you see on the map: range lines, the signal source (which access point is strongest where), walls, furniture, room names, dBm numbers, measurement points and the prediction at them. None of it changes the calculation, only the look.',

    'help.ranges.t': 'Range lines',
    'help.ranges.b': 'Thin lines on the map join places with the same signal strength, like contour lines on a hiking map. They show how far the signal reaches at the chosen threshold. Switch the band: at 2.4 GHz the lines reach further through walls than at 5 or 6 GHz.',

    'help.rangeThreshold.t': 'Range-line threshold',
    'help.rangeThreshold.b': 'The signal strength at which a range line is drawn. The default −60 dBm is a "comfortable" reach; −75 dBm shows where the signal still barely gets to.',

    // --- positions -----------------------------------------------------------------------------------------------
    'help.today.t': 'Today\'s position',
    'help.today.b': 'Where the router really stands right now. Every result is compared with it, so you see how much things improve or get worse. Signal measurements always belong to this position.',

    'help.trial.t': 'Trial position',
    'help.trial.b': 'Here you only try the router out, nothing happens for real. Drag the red router around the floor plan and the map recalculates immediately. When you find a better spot, move the real router there too.',

    'help.baseline.t': 'Basis for measurements',
    'help.baseline.b': 'All measurements you enter apply to the router at today\'s position. If you really move it and mark the new position as today\'s, the old measurements are deleted because they would no longer match.',

    'help.inlet.t': 'Internet inlet',
    'help.inlet.b': 'The place where internet enters your home (wall socket, modem or optical box). The router has to reach it by cable, which is why the app shows the distance.',

    'help.cable.t': 'Cable length to the inlet',
    'help.cable.b': 'A rough cable length between the inlet and the router. Cable follows walls and corners, so it is usually a third to a half longer than the straight line: 5 m in a straight line is about 7 m of cable. Measure it with a tape before you buy.',

    'help.optimize.t': 'Find the best spot',
    'help.optimize.b': 'The app tries hundreds of positions across your home (about every half metre) and picks the one with the best coverage and average signal for your goal. It takes a few seconds. Treat the result as a tip and check that the router can practically be placed there.',

    'help.allowedArea.t': 'Where can I put it?',
    'help.allowedArea.b': 'Limits the search to one room, for example the hallway where the socket and the power outlet are. "Anywhere" searches the whole home, which gives the best signal but may not be a place where a router can go.',

    // --- model ---------------------------------------------------------------------------------------------------
    'help.nearSignal.t': 'Signal at 1 m',
    'help.nearSignal.b': 'How strong the signal is one metre from the router (for 5 GHz). Typically −40 dBm; a weaker router or heavily attenuated signal gives, say, −45. Normally leave it alone: it tunes itself once you enter measurements.',

    'help.decay.t': 'Fading with distance',
    'help.decay.b': 'A number that says how fast the signal fades with distance from the router. 2 is free space, in a flat it is usually 2.2 to 3, in a house with many partitions more. A higher number means faster fading.',

    'help.wallLoss.t': 'Default wall loss',
    'help.wallLoss.b': 'How many dB the signal loses passing through one wall when that wall has no setting of its own. The value is for 5 GHz; at 2.4 GHz the app uses about two thirds of it (×0.65) and at 6 GHz a little more (×1.15), so 8 dB is about 5 dB at 2.4 GHz and 9 dB at 6 GHz.',
    'help.wallLoss.more': 'Every extra 3 dB halves the power. At 5 GHz plasterboard takes off about 4 dB, brick 11 dB, concrete 18 dB.',

    'help.scale.t': 'Scale',
    'help.scale.b': 'The app needs to know how many metres one piece of the drawing is. The easiest is to type the floor area in m² (it is in your lease or the listing). Otherwise mark two points in Floor plan whose distance you know (a door is about 80 cm wide), or enter the real width of the whole plan. A wrong scale skews the whole estimate.',

    // --- measurements --------------------------------------------------------------------------------------------
    'help.calibration.t': 'Calibration from measurements',
    'help.calibration.b': 'From your measured values the app works out how much stronger or weaker your router is than the model expected (“4 dB stronger”) and adjusts the whole map. With 4 or more measurements in different rooms it also tunes the wall losses and how fast the signal fades with distance.',
    'help.calibration.more': '“Fits within ±3 dB” is an honest accuracy estimate: each measurement is predicted without itself. Switch it off to see the default model.',

    'help.measurement.t': 'Measurement',
    'help.measurement.b': 'A really measured signal at a specific place in your home (with a phone or laptop, see Help → How to measure signal). The router must stand at today\'s position while you measure. The more places and rooms, the more faithful the map.',

    'help.residual.t': 'Deviation from the model',
    'help.residual.b': 'The difference between what you measured and what the model predicted for that spot after calibration. Within ±3 dB is excellent; above ±8 dB check the walls between the router and the measured spot, or the position of the measurement.',

    'help.unitPct.t': 'dBm or % (Windows)',
    'help.unitPct.b': 'Windows shows signal in percent. The app converts it with dBm ≈ % ÷ 2 − 100, for example 70% is about −65 dBm. That is a rough conversion, so a tool that shows dBm directly is more accurate.',

    'help.device.t': 'Device',
    'help.device.b': 'Speed depends on what you measure with (an old phone behaves differently from a new laptop). Pick the device from the list or type your own name. The speed estimate is learned separately for each device, so measurements do not get mixed up.',

    // --- speed ---------------------------------------------------------------------------------------------------
    'help.speedTarget.t': 'Target speed',
    'help.speedTarget.b': 'The speed you want in a room, say 50 Mbps for 4K video or 20 Mbps for video calls. The app highlights where you will probably reach it. It cannot be higher than the speed of your internet connection.',

    'help.reserve.t': 'Reserve',
    'help.reserve.b': 'How many percent of speed you set aside because you rarely use it all (interference, other devices, peaks). With a 30% reserve the network has to deliver about 71 Mbps to reach a 50 Mbps target.',

    'help.plan.t': 'Plan (connection speed)',
    'help.plan.b': 'The speed you pay your provider for, say 500 Mbps down and 500 Mbps up. Wi-Fi cannot be faster than the connection, so it acts as a ceiling for the estimate.',

    'help.wan.t': 'Internet input (WAN)',
    'help.wan.b': 'WAN is the "entrance to the internet": the cable or fibre from your provider. If its speed is lower than your Wi-Fi speed, it is the part that slows the whole network down.',

    'help.wanPort.t': 'Router WAN port',
    'help.wanPort.b': 'The speed of the router socket that internet plugs into. 1000 Mbps (1 Gbps) is the most common. Older routers have only 100 Mbps, which slows down even a faster plan.',

    'help.ontPort.t': 'Optical box (ONT) port',
    'help.ontPort.b': 'With fibre there is a small box (ONT) between the wall socket and the router, with its own network port. If it only does 1 Gbps you cannot use a faster plan such as 2 Gbps. The speed is on its label or in the manual.',

    'help.link.t': 'Negotiated link speed',
    'help.link.b': 'The speed at which the router and the box or modem agreed over the cable (the router admin page shows it, e.g. 1000 Mbps). If it is lower than you expect, a faulty cable or connector is the usual culprit.',

    'help.cableCategory.t': 'Cable category',
    'help.cableCategory.b': 'The category is printed on the cable jacket (Cat5e, Cat6, ...). Cat5e handles 1 Gbps, Cat6 up to 10 Gbps over shorter runs, Cat6a over a full 100 m. Old Cat5 or a very long cable can limit the speed.',

    // --- access points, mesh, repeaters ----------------------------------------------------------------------------
    'help.secondAp.t': 'Why another access point',
    'help.secondAp.b': 'Another device that broadcasts Wi-Fi covers a distant part of your flat or house that the router does not reach. Best connected to the router by cable. Add as many as you need (up to 8), pick the type that matches what you have or plan to buy, and drag it into place on the floor plan.',

    'help.apCable.t': 'Access point by cable',
    'help.apCable.b': 'An access point (AP) connected to the router with a network cable. It is the most reliable option: full speed even in a distant room. It does require a cable run.',

    'help.meshCable.t': 'Mesh by cable',
    'help.meshCable.b': 'A mesh node linked to the main router by cable. Wi-Fi between nodes is then not used up carrying data, so full speed remains. Devices switch between nodes on their own.',

    'help.meshWifi.t': 'Mesh over Wi-Fi',
    'help.meshWifi.b': 'A mesh node without a cable, linked to the router wirelessly. It is convenient, but the link to the router uses up part of the speed (often half) and works well only where the signal from the router is still good, about −65 dBm or better.',

    'help.repeater.t': 'Repeater',
    'help.repeater.b': 'A device that receives the signal and sends it on. It is the cheapest cable-free option but usually the weakest: speed drops a lot and devices sometimes stay stuck on the poorer signal.',

    'help.backhaul.t': 'Node-to-router link',
    'help.backhaul.b': 'The wireless link from an access point to the router (or to another point it connects through). For a mesh node or repeater to work well, the signal from whatever it connects to must still be good where it stands. The map hatches places where the point transmits but connects onward poorly.',

    'help.power.t': 'Transmit power',
    'help.power.b': 'Adjusts the node\'s power relative to the router, in dB. 0 means the same power, −6 dB about a quarter. More power extends the reach but does not make your devices faster: a phone still transmits weakly back.',

    // --- floor-plan editor ---------------------------------------------------------------------------------------
    'help.wallMaterial.t': 'Wall material',
    'help.wallMaterial.b': 'Each material weakens the signal differently, and the higher the frequency, the more. At 2.4 / 5 / 6 GHz: plasterboard 3 / 4 / 5 dB, wood 3 / 5 / 6, glass 2 / 4 / 5, brick 7 / 11 / 13, concrete 12 / 18 / 21, reinforced concrete 17 / 26 / 30, metal 25 / 30 / 32 dB.',
    'help.wallMaterial.more': 'Pick the nearest material. A custom value is entered for 5 GHz and the app converts it for 2.4 and 6 GHz itself (×0.65 and ×1.15). The numbers come from NIST measurements and common attenuation tables.',

    'help.doorLoss.t': 'Door loss',
    'help.doorLoss.b': 'An open doorway does not weaken the signal (0 dB). A closed wooden door takes about 3 dB. For doors that are usually shut (bedroom, bathroom) set about 3 dB.',

    'help.furnitureLoss.t': 'Furniture loss',
    'help.furnitureLoss.b': 'How many dB a piece of furniture takes off the signal (at 5 GHz; a bit less at 2.4 GHz, a bit more at 6 GHz). A bed or sofa about 1 dB, a wooden wardrobe 3 dB, a full bookcase 5 dB, a fridge or washing machine 8 dB, a metal cabinet 12 dB.',

    'help.blocksSignal.t': 'Blocks signal',
    'help.blocksSignal.b': 'On: the signal weakens when it passes through this piece. Turn it off for low things (coffee table, rug) that the signal passes through almost unharmed.',

    'help.snap.t': 'Snapping',
    'help.snap.b': 'While drawing, points snap to the grid and to the corners and ends of walls, so joints meet exactly. Hold the Alt key to turn snapping off for a moment.',

    'help.trace.t': 'Tracing background',
    'help.trace.b': 'An image or floor plan (say from a property listing) shown beneath your drawing so you can trace it with rooms and walls. It is only a guide and is not used in the calculation. Press T to hide it.',

    'help.opacity.t': 'Background opacity',
    'help.opacity.b': 'Use the slider to fade the background out or bring it back so your drawing stays easy to see on top of it.',

    'help.autoWalls.t': 'Outline the rooms with walls',
    'help.autoWalls.b': 'Adds a wall along every room edge that has none yet. It never changes or deletes existing walls, and an edge shared by two neighbouring rooms gets just one wall. Then you only need to set the material of the thick walls.',

    // --- Help panel -> "How to measure signal": Wi-Fi details from a computer (SPEC 8 / 8.2) -----------------------
    'helpPanel.cmd.t': 'Wi-Fi details from a computer with one command',
    'helpPanel.cmd.lead': 'The browser cannot see the network name or the signal strength. On a computer one command tells you – and copies the result to the clipboard. Paste it into the app: measurement window → Device info → Paste the result. After that, Measure everything is the easiest way.',
    'helpPanel.helper.t': 'Wi-Fi helper (no copying)',
    'helpPanel.helper.b': 'Even easier: download the helper for your system and start it with a double-click (Windows: “Spustit pomocníka.cmd”, on the blue warning “More info” → “Run anyway”; macOS: right-click → Open). While its window is open, Measure everything takes the Wi-Fi details by itself (on the web version connect it once: Device info → Connect the helper → Allow in the browser). A web page may not start a program on its own – hence that one double-click.',
  });
})();
