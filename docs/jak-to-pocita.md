# Jak WiFi Heatmap Architect počítá signál

Tahle stránka říká, **z čeho se mapa signálu počítá**, odkud jsou čísla v tabulkách a **kde je model nejméně přesný**.
Nic tu není tajné: všechny hodnoty jsou v kódu ([`src/js/10-engine/30-project.js`](../src/js/10-engine/30-project.js),
[`40-model.js`](../src/js/10-engine/40-model.js)) a tabulky níže hlídá test, aby se od kódu nerozešly.

> Model je **odhad**. Dobře ukáže, kde bude signál zhruba silný a kde slabý, a co se změní přesunem routeru. Neumí říct
> „v rohu pokoje bude přesně −63 dBm". Proto je v aplikaci *první měření*: pár vlastních měření model doladí na
> váš byt.

## 1. Základní vzorec

Pro bod `p` a zdroj (router nebo další AP) na pásmu `b` (2,4 / 5 / 6 GHz):

```
signál(p) = nearSignal − 20·log10(b / 5) + výkon[b] − 10·n·log10(max(1 m, vzdálenost))
            − ztráty překážek na cestě + posun z kalibrace
```

| Veličina | Výchozí hodnota | Význam |
|---|---|---|
| `nearSignal` | −40 dBm (5 GHz, 1 m od routeru) | síla signálu hned u routeru |
| `20·log10(b / 5)` | −6,4 dB pro 2,4 GHz; +1,6 dB pro 6 GHz | vyšší frekvence se v prostoru tlumí víc |
| `výkon[b]` | 0 dB | rozdíl výkonu routeru na pásmu (nastavitelné v Pokročilém) |
| `n` | 2,2 | jak rychle signál slábne se vzdáleností (volný prostor 2, byt s nábytkem ~2,2–3) |
| ztráty překážek | viz níže | zdi, dveře, nábytek, stropy |
| posun z kalibrace | 0 dB | z měření (kap. 5) |

Výsledek se ořízne na −110 … −20 dBm. **„Dobrý signál"** je v aplikaci −67 dBm a silnější (nastavitelné). Pokrytí bytu
je podíl plochy místností, kde je signál aspoň dobrý.

## 2. Zdi, dveře a nábytek

Paprsek z routeru do bodu protne překážky; jejich ztráty se sčítají. Pravidla:

- **Stěna** má materiál, a ten má ztrátu **zvlášť pro každé pásmo**: zdivo tlumí na 6 GHz víc než na 2,4 GHz.
- Rohy a T-křižovatky (dvě zdi v jednom místě) se počítají **jednou, tou horší**, ne dvakrát.
- **Dveře** jsou průchod ve zdi s vlastní ztrátou (výchozí 0 dB, tedy otevřený průchod; číslem lze zadat zavřené dveře).
  **Nábytek** přidá svou ztrátu jednou za kus a jeho okraje jsou měkké (stín za rohem se neláme na ostrý klín).
- **Změkčení (0,4 m):** čistý paprskový model dělá ostré stíny; skutečný signál se ohýbá a odráží. Mapa proto
  zobrazuje ztrátu mírně rozmazanou (jen mezi body, které odděluje žádná zeď).
- Uložená ztráta zdi je vždy hodnota pro 5 GHz; ostatní pásma vznikají tabulkou materiálu, u vlastních čísel koeficientem
  0,65 (2,4 GHz) a 1,15 (6 GHz).

### Materiály zdí (dB při průchodu jednou zdí)

<!-- materials:start -->
| Materiál | 2,4 GHz | 5 GHz | 6 GHz |
|---|---|---|---|
| `drywall` | 3 | 4 | 5 |
| `wood` | 3 | 5 | 6 |
| `glass` | 2 | 4 | 5 |
| `brick` | 7 | 11 | 13 |
| `masonry` | 7 | 11 | 13 |
| `solid_guess` | 10 | 15 | 18 |
| `concrete` | 12 | 18 | 21 |
| `reinforced_concrete` | 17 | 26 | 30 |
| `low_e_glass` | 20 | 27 | 29 |
| `metal` | 25 | 30 | 32 |
<!-- materials:end -->

Překlad: `drywall` sádrokarton, `wood` dřevo, `glass` sklo, `brick` cihla, `masonry` zdivo, `solid_guess` masivní zeď (odhad),
`concrete` beton, `reinforced_concrete` železobeton, `low_e_glass` okno s úsporným kovovým povlakem, `metal` kov.

### Nábytek (dB)

<!-- furniture:start -->
| Druh | 2,4 GHz | 5 GHz | 6 GHz |
|---|---|---|---|
| `bed` | 1 | 1 | 1 |
| `wood` | 2 | 3 | 4 |
| `books` | 3 | 5 | 6 |
| `appliance` | 6 | 8 | 9 |
| `metal` | 10 | 12 | 13 |
| `opening` | 0 | 0 | 0 |
<!-- furniture:end -->

`opening` je otvor ve stropě (schodiště), nic netlumí; viz kap. 3.

### Odkud čísla jsou

Hodnoty jsou **typické publikované hodnoty**, ne měření vašeho domu: měření útlumu stavebních materiálů NIST (1997;
cihla 6/15/15 dB, beton 102 mm 15/22/25 dB při 2,4/5/6 GHz), běžně citované tabulky průniku (sádrokarton, sklo, dřevo,
cihla, beton) a zpráva OSTI 1813145 (sádrokarton 3–4/3–5 dB, cihla a beton 6–18/10–30 dB, sklo 2–3/6–8 dB). Skutečná
zeď se od tabulky liší o **±5 dB i víc** (výztuž, izolace s fólií, kovové profily, vlhkost). Proto existuje kalibrace.

Dvě čísla jsou **odhady**:

- `low_e_glass` (okno s povlakem): z jediného publikovaného měření (zhruba 30 dB při 6,75 GHz, Shakya a kol.; stejné
  měření modeluje i projekt SignalPlan, <https://github.com/NC4321/SignalPlan>, MIT). Zaokrouhleno mírně dolů, povlaky
  se liší.
- `solid_guess`: záměrně hrubá hodnota pro „nevím, co je ve zdi".

## 3. Více pater

- **Vzdálenost** se počítá prostorově: vodorovná vzdálenost a výška pater (výchozí 2,7 m na patro) dohromady.
- **Strop** má ztrátu (beton 15, železobeton 20, dřevo 8 dB pro 5 GHz; ostatní pásma stejným koeficientem jako zdi).
  Počítá se jednou za každý strop mezi zdrojem a bodem.
- **Zdi ve vašem patře** se počítají **poloviční**: signál přichází shora nebo zdola, ne vodorovně přes celý byt.
- **Otvor ve stropě (schodiště):** když přímka mezi zdrojem a bodem projde stropem uvnitř otvoru, strop se **nepočítá**.
  Při jednom stropě mezi patry se bere místo, kde přímka leží v polovině cesty; při L stropech leží j-tý v (j + ½)/L cesty.
  Otvor se kreslí nástrojem *Nábytek → Otvor (schodiště)* do **horního** ze dvou pater (je to otvor v jeho podlaze);
  v přízemí (nejnižším patře) znamená otvor ve stropě nad ním. Každý otvor tak otevře právě jeden strop, i ve domě se
  třemi a více patry. Hrana otvoru je ostrý skok (ohyb signálu tam model nezná); schodiště samotné se nemodeluje.

## 4. Pásma a Auto

Router s Wi-Fi 6/6E/7 sám přepíná pásma. Režim **Auto** ukazuje v každém místě pásmo, které by telefon nejspíš použil:
6 GHz od −70 dBm, jinak 5 GHz od −72 dBm, jinak 2,4 GHz (prahy jdou změnit). Hodnoty vycházejí z toho, jak se zařízení
běžně chovají; jsou to **pravidla, ne záruky**: konkrétní router a telefon se mohou rozhodnout jinak.

## 5. Kalibrace z měření

Měření ukáže, o kolik se model mýlí. Postup (soubor [`45-fit.js`](../src/js/10-engine/45-fit.js)):

1. **Síla routeru** (posun v dB na každém pásmu) se dolaďuje vždy; odolně vůči odlehlým bodům (měření dál než 12 dB
   od modelu se vyřadí a označí).
2. Od 4 bodů na pásmu, které se liší vzdáleností a počtem zdí, se doladí i **n** (1,6–4) a **násobek ztrát zdí**
   (0,5–2). Používá se metoda nejmenších čtverců s předpokladem „blízko výchozím hodnotám" (rozptyl 4 dB, nejistota
   n 0,6 a násobku 0,35), takže 4–5 hlučných bodů model jen trochu pootočí, 20 bodů ho už pevně určí.
3. **Kontrola na vynechaných bodech.** Každý bod se jednou vynechá a předpoví se z ostatních. Pokud doladěný tvar
   předpovídá vynechané body **hůř** než tvar, ke kterému by se vrátil (výchozí n a zdi ×1), o víc než 0,3 dB, zahodí se
   a upraví se jen síla routeru
   („přeučení" na šum). Přesnost, kterou aplikace uvádí (±x dB), je právě tato chyba na vynechaných bodech.
4. Když doladěná hodnota skončí **na kraji povoleného rozsahu**, aplikace upozorní: obvykle je špatné měřítko plánu
   nebo materiály zdí, ne fyzika.
5. **Strop mezi patry:** body změřené v patře **přímo nad nebo pod** routerem ukazují, jestli strop mezi nimi pohlcuje víc
   či míň, než plán předpokládá. Síla routeru se přitom bere jen z bodů v jeho patře (aby chybný strop „nezmizel" v síle
   routeru) a porovnávají se body stejného zařízení. Body, jejichž přímka k routeru vede otvorem ve stropě, se nepočítají
   (o stropu nic neříkají). Při aspoň 3 bodech a zřetelném rozdílu (≥ 3 dB a víc než šum) aplikace nabídne nastavit strop;
   použije se jen na vaše kliknutí.

## 6. Rychlost

Žádný převod „dBm → Mb/s" na pevno neexistuje. Rychlost se odhaduje z **vašich vlastních rychlostních testů** v místech
se známým signálem (rostoucí křivka přes naměřené body, zvlášť stahování a odesílání). Bez dvou testů v různé síle
aplikace rychlost neodhaduje. Další AP nebo opakovač se promítne přes kvalitu jeho spoje k routeru (bezdrátový skok zhruba
uberá polovinu rychlosti).

## 7. Kde se model mýlí nejvíc

- **Odrazy a vícecestné šíření** nezná. V chodbách a u kovu (okna s povlakem, lednice, výtahové šachty) může být
  skutečnost lepší i horší.
- **Ohyb signálu** je jen změkčení (0,4 m), ne fyzika.
- **Materiál zdí neznáme.** Panelák, dřevostavba a cihlový dům mají velmi různé zdi; tabulka dává střed, kalibrace
  posouvá.
- **Rušení od sousedů a výběr kanálu** model nepočítá (po měření jen radí o DFS a překrývajících se kanálech).
- **Antény:** všechny zdroje jsou všesměrové; skutečný router i telefon mají směrovost.
- **Pohyb lidí a zařízení**, sezónní změny (vlhké zdi, listí venku) a výkon konkrétního telefonu jsou mimo model.

## 8. Ověření

Model je ověřen **testy proti sobě samému** (syntetické byty se známou pravdou: kalibrace musí pravdu najít zpět)
a proti běžným fyzikálním jistotám (dvojnásobná vzdálenost = −6,6 dB při n = 2,2, stejné číslo na stejném místě a podobně).
**Veřejně dostupné porovnání s mnoha skutečnými byty zatím nemáme.** Pokud svůj byt změříte a výsledek nesedí, napište
(Nápověda → Nahlásit problém): takové případy model nejvíc zlepšují.
