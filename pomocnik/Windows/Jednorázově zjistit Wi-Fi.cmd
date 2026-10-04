@echo off
rem WiFi Heatmap Architect - jednorazove zjisteni Wi-Fi (Windows). MIT License, © 2026 Zizlik
rem Jednou zjisti Wi-Fi, vypis zkopiruje do schranky a otevre aplikaci s udaji. Server se nespousti.
rem One-shot: reads the Wi-Fi details once, copies them to the clipboard and opens the app with them.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0wifi-helper.ps1" --once %*
if errorlevel 1 (pause) else (timeout /t 10 >nul 2>&1 & exit /b 0)
