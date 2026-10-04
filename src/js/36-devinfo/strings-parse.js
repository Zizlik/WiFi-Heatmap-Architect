/* WiFi Heatmap Architect - strings of the Wi-Fi details parser (WH.devinfo.parse / fromHash warnings and errors). */
(function () {
  'use strict';
  globalThis.WH = globalThis.WH || {};
  const WH = globalThis.WH;
  WH.i18n.add('cs', {
    'devinfo.warn.empty': 'Vlož sem text, který vypsal příkaz.',
    'devinfo.warn.unknown': 'Tomuhle textu nerozumím. Zkopíruj celý výpis příkazu, od prvního do posledního řádku.',
    'devinfo.warn.noWifi': 'Ve výpisu není žádný Wi-Fi adaptér. Nejsi připojený kabelem, nebo nemáš Wi-Fi vypnutou?',
    'devinfo.warn.location': 'Windows teď údaje o Wi-Fi nepustí: zapni Nastavení › Soukromí a zabezpečení › Poloha (i pro desktopové aplikace) a příkaz spusť znovu.',
    'devinfo.warn.notConnected': 'Wi-Fi adaptér jsem našel, ale není připojený k žádné síti.',
    'devinfo.warn.multiple': 'Připojených Wi-Fi adaptérů je víc, beru ten se silnějším signálem.',
    'devinfo.warn.ssidHidden': 'Systém skryl název sítě (na Macu nemá Terminál povolenou polohu). Ostatní údaje platí.',
    'devinfo.warn.rssiFromPct': 'Výpis udává signál jen v procentech, takže hodnota v dBm je přepočtená a jen přibližná.',
    'devinfo.warn.noSignal': 'Ve výpisu chybí síla signálu. Doplň ji ručně, nebo ji změř aplikací WiFiman.',
    'devinfo.warn.truncated': 'Text je moc dlouhý, přečetl jsem jen jeho začátek.',
    'devinfo.hash.none': 'V odkazu nejsou žádné údaje o Wi-Fi.',
    'devinfo.hash.tooBig': 'Údaje od pomocníka jsou moc velké, nedají se načíst.',
    'devinfo.hash.invalid': 'Údaje od pomocníka jsou poškozené. Spusť pomocníka znovu.',
  });
  WH.i18n.add('en', {
    'devinfo.warn.empty': 'Paste the text the command printed.',
    'devinfo.warn.unknown': "I can't read this text. Copy the whole output of the command, from the first line to the last.",
    'devinfo.warn.noWifi': 'The output shows no Wi-Fi adapter. Are you on a cable, or is Wi-Fi turned off?',
    'devinfo.warn.location': 'Windows is holding back the Wi-Fi details: turn on Settings › Privacy & security › Location (for desktop apps too) and run the command again.',
    'devinfo.warn.notConnected': "I found the Wi-Fi adapter, but it isn't connected to any network.",
    'devinfo.warn.multiple': 'More than one Wi-Fi adapter is connected; I am using the one with the stronger signal.',
    'devinfo.warn.ssidHidden': 'The system hid the network name (on a Mac, Terminal has no location permission). The other details are fine.',
    'devinfo.warn.rssiFromPct': 'The output gives the signal in percent only, so the dBm value is converted and approximate.',
    'devinfo.warn.noSignal': 'The output has no signal strength. Type it in yourself or measure it with the WiFiman app.',
    'devinfo.warn.truncated': 'The text is very long, I only read the beginning.',
    'devinfo.hash.none': 'The link carries no Wi-Fi details.',
    'devinfo.hash.tooBig': "The helper's data is too large to load.",
    'devinfo.hash.invalid': "The helper's data is damaged. Run the helper again.",
  });
})();
