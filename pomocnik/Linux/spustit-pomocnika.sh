#!/bin/sh
# WiFi Heatmap Architect - pomocník pro Wi-Fi (Linux). MIT License, © 2026 Zizlik
# Spuštění: pravým tlačítkem na složku -> Otevřít v terminálu, pak  sh spustit-pomocnika.sh
# (nebo ve správci souborů -> Spustit jako program). Běží, dokud je okno otevřené; Ctrl+C ho vypne.
#   sh spustit-pomocnika.sh --once   jednou zjistí Wi-Fi, dá ji do schránky a otevře aplikaci
# Run: sh spustit-pomocnika.sh  (server until Ctrl+C)  |  sh spustit-pomocnika.sh --once  (one-shot)
# Práci dělá wifi-helper.py vedle tohoto souboru (python3, nmcli nebo iw; schránka přes wl-copy / xclip / xsel).
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Pomocník potřebuje python3 (např. sudo apt install python3). / The helper needs python3."
  exit 1
fi
python3 ./wifi-helper.py "$@"
rc=$?
if [ "$rc" -ne 0 ] && [ -t 0 ]; then printf 'Stiskni Enter… / Press Enter… '; read -r _; fi
exit "$rc"
