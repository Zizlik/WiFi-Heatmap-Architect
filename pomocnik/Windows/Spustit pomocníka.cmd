@echo off
rem WiFi Heatmap Architect - pomocnik pro Wi-Fi (Windows). MIT License, © 2026 Zizlik
rem Dvojklik = pomocnik bezi, dokud je okno otevrene; aplikace si od nej pri "Zmerit vse" vezme udaje o Wi-Fi.
rem Double-click: the helper runs while this window is open. All the work is done by wifi-helper.ps1 next to this file.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0wifi-helper.ps1" %*
if errorlevel 1 pause
