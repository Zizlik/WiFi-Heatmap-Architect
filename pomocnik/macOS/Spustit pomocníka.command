#!/bin/bash
# WiFi Heatmap Architect - pomocník pro Wi-Fi (macOS). MIT License, © 2026 Zizlik
# Dvojklik otevře Terminál a spustí pomocníka; běží, dokud je okno otevřené (Ctrl+C nebo zavření okna ho vypne).
# Práci dělá wifi-helper.py vedle tohoto souboru. S parametrem --once jen jednou zjistí Wi-Fi, dá ji do schránky
# a otevře aplikaci (to dělá "Jednorázově zjistit Wi-Fi.command").
# Double-click: opens Terminal and runs the helper while the window stays open. --once = one-shot mode.
cd "$(dirname "$0")" || exit 1
APP_URL="https://zizlik.github.io/WiFi-Heatmap-Architect/index.cs.html"

# Na čistém macOS je /usr/bin/python3 jen zástupce, který nabízí instalaci vývojářských nástrojů (Command Line Tools).
PY="$(command -v python3)"
if [ -z "$PY" ] || { [ "$PY" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; }; then
  echo "Pomocník potřebuje Python 3, který tu zatím není. / The helper needs Python 3, which is not installed."
  echo "Aspoň jsem zkopíroval údaje o Wi-Fi do schránky – v aplikaci klikni na „Vložit výsledek“."
  echo "I copied the Wi-Fi details to the clipboard instead – click \"Paste result\" in the app."
  echo "Plný pomocník: v Terminálu spusť  xcode-select --install  a pak mě spusť znovu."
  # bez okolních sítí a bez MAC adresy karty (stejně jako wifi-helper.py)
  system_profiler SPAirPortDataType | sed -e '/Other Local Wi-Fi Networks:/,$d' -e '/MAC Address:/d' -e '/Supported Channels:/d' \
    | LANG=en_US.UTF-8 pbcopy
  if [ -f ../../index.cs.html ]; then open ../../index.cs.html; else open "$APP_URL"; fi
  exit 0
fi

"$PY" ./wifi-helper.py "$@"
rc=$?
if [ "$rc" -ne 0 ]; then read -r -p "Stiskni Enter… / Press Enter… " _; fi
exit "$rc"
