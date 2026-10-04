#!/bin/bash
# WiFi Heatmap Architect - jednorázové zjištění Wi-Fi (macOS). MIT License, © 2026 Zizlik
# Jednou zjistí Wi-Fi, výpis dá do schránky a otevře aplikaci s údaji; server se nespouští.
# One-shot: reads the Wi-Fi details once, copies them to the clipboard and opens the app with them.
exec /bin/bash "$(dirname "$0")/Spustit pomocníka.command" --once "$@"
