# WiFi Heatmap Architect - pomocník pro Wi-Fi (Windows) / local Wi-Fi helper
# MIT License, © 2026 Zizlik - https://github.com/Zizlik/WiFi-Heatmap-Architect
#
# Prohlížeč nesmí zjistit, ke které Wi-Fi je počítač připojený (SSID, signál, kanál, rychlost linky); tenhle skript to
# aplikaci řekne. Spouští se dvojklikem na "Spustit pomocníka.cmd" (server) nebo "Jednorázově zjistit Wi-Fi.cmd" (--once).
#   (výchozí)        server: poslouchá JEN na http://127.0.0.1:47823/ (tento počítač), dokud je okno otevřené.
#                    GET /wifi -> JSON s výpisem `netsh wlan show interfaces`; GET /health -> {ok:true}; nic jiného.
#   --once           jednou zjistí Wi-Fi, výpis dá do schránky a otevře aplikaci s údaji v adrese (#wifi=<base64url JSON>)
#   --no-open        (s --once) nic neotvírá, jen vypíše adresu    --fake <soubor>  (test) místo netsh čte text ze souboru
# Bezpečnost: jen čte, nic neukládá ani neinstaluje, nepotřebuje správce; spouští jen pevný příkaz netsh (nic z webu);
# odpovídá jen na 127.0.0.1/localhost (kontrola Host) a jen stránkám aplikace (CORS allow-list). Název počítače ani
# uživatele neposílá; MAC adresu a GUID samotné karty z výpisu vynechá. Windows PowerShell 5.1+, bez modulů.
# Soubor je uložený jako UTF-8 s BOM - jinak by PS 5.1 rozbil češtinu.

$ErrorActionPreference = 'Stop'
$Port = 47823
$Prefix = "http://127.0.0.1:$Port/"                 # jen loopback: http.sys pak naslouchá pouze na 127.0.0.1
$PagesUrl = 'https://zizlik.github.io/WiFi-Heatmap-Architect/index.cs.html'
$LocalApp = Join-Path $PSScriptRoot '..\..\index.cs.html'   # aplikace vedle složky pomocnik (stažený celý projekt)
$MaxUrl = 8000                                       # delší adresu by systém/prohlížeč mohl oříznout -> pak jen schránka
$AllowedHosts = @("127.0.0.1:$Port", "localhost:$Port")    # kontrola Host = ochrana proti DNS rebindingu
$OriginRe = '^(https://zizlik\.github\.io|null|file://|http://(127\.0\.0\.1|localhost)(:\d{1,5})?)$'   # null, file:// = stránka z disku
$Interactive = -not [Console]::IsInputRedirected

# --- parametry (jen z příkazové řádky, nikdy z webu) -----------------------------------------------------------------
$Once = $false; $NoOpen = $false; $Fake = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  switch -regex ($args[$i]) {
    '^[-/]+once$'     { $Once = $true }
    '^[-/]+no-?open$' { $NoOpen = $true }
    '^[-/]+fake$'     { $i++; $Fake = $args[$i] }
    default           { Write-Host "Neznámý parametr / unknown option: $($args[$i])" -ForegroundColor Yellow }
  }
}
function Write-Log([string]$msg) { Write-Host ('[{0:HH:mm:ss}] {1}' -f (Get-Date), $msg) }

# Pevný program s pevnými parametry, bez okna. netsh píše do roury podle verze Windows buď UTF-8, nebo v kódové stránce
# OEM (CP852 v české instalaci) - čteme proto bajty a dekódujeme sami, jinak by ze "Signál" bylo "Sign├íl".
function Invoke-Fixed([string]$exe, [string]$arguments) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = $arguments
  $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $ms = New-Object System.IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms); [void]$p.WaitForExit(15000)
  $b = $ms.ToArray()
  try { (New-Object System.Text.UTF8Encoding($false, $true)).GetString($b).TrimStart([char]0xFEFF) }   # přísné UTF-8
  catch { [Text.Encoding]::GetEncoding([int](Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage').OEMCP).GetString($b) }
}

# Soukromí: vynechá řádky s GUID a s MAC adresou samotné karty (v každém jazyce); BSSID (adresa routeru) zůstává.
function Remove-Private([string]$raw) {
  $out = foreach ($l in (($raw -replace "`r", '') -split "`n")) {
    if ($l -match '^\s*([^:]+?)\s*:\s*(\S.*?)\s*$') {
      if ($Matches[2] -match '^\{?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?$') { continue }
      # the access point's address stays (it tells roaming apart); French Windows calls it "Point d'acces d'identificateur SSID"
      if ($Matches[1] -notmatch 'BSSID|^Point d.acc' -and $Matches[2] -match '^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$') { continue }
    }
    $l.TrimEnd()
  }
  ($out -join "`n").Trim()
}

# null = v pořádku; jinak krátký kód, podle kterého aplikace ukáže radu
function Get-WifiError([string]$raw) {
  if ($raw -match '(?m)^\s*SSID\s*:\s*\S') { return $null }
  if ($raw -match 'location|poloh|poloz') { return 'location' }           # Windows 11 24H2+: netsh chce zapnutou Polohu
  if ($raw -match '(?m)^\s*[^:\n]+:\s*\S') { return 'not-connected' }     # karta je, ale není připojená
  'no-wifi'
}
function Get-Payload {
  if ($Fake) { $raw = [IO.File]::ReadAllText([IO.Path]::GetFullPath($Fake), [Text.Encoding]::UTF8) }
  else { $raw = Invoke-Fixed "$env:SystemRoot\System32\netsh.exe" 'wlan show interfaces' }
  $raw = Remove-Private $raw
  [ordered]@{ app = 'wifi-heatmap-helper'; v = 1; os = 'windows'; at = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
              source = 'netsh wlan show interfaces'; raw = $raw; error = (Get-WifiError $raw); hostname = $null }
}
function Write-Status($p) {                          # jedna srozumitelná věta o tom, co pomocník vidí
  $y = 'Yellow'
  switch ($p.error) {
    'location' { Write-Host 'Windows teď údaje o Wi-Fi nepouští: zapni Nastavení > Soukromí a zabezpečení > Poloha (i pro desktopové aplikace).' -ForegroundColor $y
                 Write-Host 'Windows blocks Wi-Fi details: turn on Settings > Privacy & security > Location.  (start ms-settings:privacy-location)' -ForegroundColor $y }
    'not-connected' { Write-Host 'Počítač teď není připojený k žádné Wi-Fi. / This PC is not connected to Wi-Fi.' -ForegroundColor $y }
    'no-wifi'  { Write-Host 'Nenašel jsem Wi-Fi kartu (nebo neběží služba WLAN). / No Wi-Fi adapter found.' -ForegroundColor $y }
    default    { $ssid = if ($p.raw -match '(?m)^\s*SSID\s*:\s*(.+)$') { $Matches[1].Trim() } else { '?' }
                 $sig = if ($p.raw -match '(?m)^\s*Sign\S*\s*:\s*(\d+)\s*%') { ", signál $($Matches[1]) %" } else { '' }
                 Write-Host ('Vidím Wi-Fi „{0}“{1}. / Wi-Fi found.' -f $ssid, $sig) -ForegroundColor Green }   # „“ jen v '…'
  }
}
function ConvertTo-JsonBytes($obj) { , [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -Depth 3 -InputObject $obj)) }   # "," = celé pole
function Send-Reply($ctx, [int]$code, $body, [string]$origin, [hashtable]$extra) {
  $res = $ctx.Response
  $res.StatusCode = $code; $res.KeepAlive = $false
  $res.AddHeader('Cache-Control', 'no-store'); $res.AddHeader('Pragma', 'no-cache')
  $res.AddHeader('X-Content-Type-Options', 'nosniff'); $res.AddHeader('Vary', 'Origin')
  if ($origin) { $res.AddHeader('Access-Control-Allow-Origin', $origin) }
  if ($extra) { foreach ($k in $extra.Keys) { $res.AddHeader($k, $extra[$k]) } }
  [byte[]]$bytes = @()
  if ($null -ne $body) { $bytes = ConvertTo-JsonBytes $body; $res.ContentType = 'application/json; charset=utf-8' }
  $res.ContentLength64 = $bytes.Length
  if ($bytes.Length -and $ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.Close()
}
function Invoke-Request($ctx) {
  $req = $ctx.Request
  $origin = $req.Headers['Origin']
  if (-not [Net.IPAddress]::IsLoopback($req.RemoteEndPoint.Address) -or $AllowedHosts -notcontains "$($req.UserHostName)".ToLowerInvariant()) {
    Send-Reply $ctx 403 @{ error = 'forbidden-host' } $null; Write-Log "Odmítnuto (cizí Host): $($req.UserHostName)"; return
  }
  $ok = $null                                        # povolený Origin -> vrátíme ho v Access-Control-Allow-Origin
  if ($origin) {
    if ($origin -cmatch $OriginRe) { $ok = $origin }
    else { Send-Reply $ctx 403 @{ error = 'forbidden-origin' } $null; Write-Log "Odmítnuto (cizí stránka): $origin"; return }
  }
  $path = $req.Url.AbsolutePath
  if ($req.HttpMethod -eq 'OPTIONS') {               # CORS + Private Network Access preflight (Chrome)
    $m = $req.Headers['Access-Control-Request-Method']
    if (-not $ok -or ($m -and $m -ne 'GET') -or $path -notin '/wifi', '/health') { Send-Reply $ctx 403 @{ error = 'forbidden-preflight' } $null; return }
    $h = @{ 'Access-Control-Allow-Methods' = 'GET'; 'Access-Control-Max-Age' = '600' }
    if ($req.Headers['Access-Control-Request-Private-Network'] -eq 'true') { $h['Access-Control-Allow-Private-Network'] = 'true' }
    Send-Reply $ctx 204 $null $ok $h; return
  }
  if ($req.HttpMethod -ne 'GET') { Send-Reply $ctx 405 @{ error = 'method-not-allowed' } $ok @{ Allow = 'GET, OPTIONS' }; return }
  switch -exact -casesensitive ($path) {
    '/wifi'   { Send-Reply $ctx 200 (Get-Payload) $ok; Write-Log "Aplikace si načetla údaje o Wi-Fi. / App read the Wi-Fi info. ($(if ($ok) { $ok } else { '-' }))" }
    '/health' { Send-Reply $ctx 200 ([ordered]@{ ok = $true; v = 1; app = 'wifi-heatmap-helper' }) $ok }
    default   { Send-Reply $ctx 404 @{ error = 'not-found' } $ok }
  }
}
function Test-QuitKey {                              # Ctrl+C čteme jako klávesu -> čisté vypnutí bez "Ukončit dávkovou úlohu?"
  if (-not $Interactive) { return $false }
  try { while ([Console]::KeyAvailable) { $k = [Console]::ReadKey($true)
        if (($k.Modifiers -band [ConsoleModifiers]::Control) -and $k.Key -eq 'C') { return $true } } } catch {}
  $false
}
function Start-Server {
  $l = New-Object System.Net.HttpListener; $l.Prefixes.Add($Prefix)
  try { $l.Start() } catch {
    if ($_.Exception.InnerException.ErrorCode -eq 5) {   # starší Windows: bez jednorázové rezervace adresy nepustí
      Write-Host "Windows nedovolil naslouchat na $Prefix. Jednou jako správce spusť / once as admin run:  netsh http add urlacl url=$Prefix user=$env:USERNAME" -ForegroundColor Red
    } else { Write-Host "Port $Port je obsazený - pomocník už asi běží v jiném okně. / Port $Port is busy - the helper is probably already running." -ForegroundColor Red }
    exit 1
  }
  try { $Host.UI.RawUI.WindowTitle = 'Pomocník pro Wi-Fi - WiFi Heatmap Architect' } catch {}
  $app = if (Test-Path -LiteralPath $LocalApp) { [IO.Path]::GetFullPath($LocalApp) } else { $PagesUrl }
  Write-Host "`n  WiFi Heatmap Architect - pomocník pro Wi-Fi" -ForegroundColor Cyan
  Write-Host '  Pomocník běží – nech toto okno otevřené. Zavřením ho vypneš (nebo Ctrl+C).'
  Write-Host "  Adresa aplikace: $app"
  Write-Host '  V aplikaci klikni na „Změřit vše“ – údaje o Wi-Fi si vezme odsud. Nic se nikam neposílá.'
  Write-Host '  The helper is running – keep this window open; close it (or press Ctrl+C) to stop it.'
  Write-Host "  It only reads Wi-Fi details and answers only this computer ($Prefix).`n" -ForegroundColor DarkGray
  Write-Status (Get-Payload)
  if ($Interactive) { try { [Console]::TreatControlCAsInput = $true } catch {} }
  try {
    while ($l.IsListening) {
      $t = $l.GetContextAsync()
      while (-not $t.AsyncWaitHandle.WaitOne(200)) { if (Test-QuitKey) { return } }
      $ctx = $t.Result
      try { Invoke-Request $ctx } catch {
        Write-Log "Chyba / error: $($_.Exception.Message)"
        try { Send-Reply $ctx 500 @{ error = 'internal' } $null } catch { try { $ctx.Response.Abort() } catch {} }
      }
    }
  } finally {
    $l.Stop(); $l.Close()
    if ($Interactive) { try { [Console]::TreatControlCAsInput = $false } catch {} }
    Write-Host 'Pomocník je vypnutý. / Helper stopped.'
  }
}
function Get-BrowserCommand {                        # výchozí prohlížeč z registru -> @(exe, argumenty s %1)
  try {
    $id = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice').ProgId
    $c = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$id\shell\open\command").'(default)'
    if ($c -match '^\s*"([^"]+)"\s*(.*)$' -or $c -match '^\s*(\S+)\s*(.*)$') {
      $exe = $Matches[1]; $rest = $Matches[2]
      if ($rest -notmatch '%1') { $rest = "$rest `"%1`"".Trim() }
      return @($exe, $rest)
    }
  } catch {}
  $null
}
function Invoke-Once {
  $p = Get-Payload
  Write-Status $p
  try { Set-Clipboard -Value $p.raw; Write-Host 'Výpis je ve schránce. / The output is in the clipboard.' }
  catch { Write-Host 'Schránku se nepodařilo naplnit. / Could not copy to the clipboard.' -ForegroundColor Yellow }
  $b64 = [Convert]::ToBase64String((ConvertTo-JsonBytes ([ordered]@{ v = 1; os = 'windows'; raw = $p.raw }))).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $base = if (Test-Path -LiteralPath $LocalApp) { ([Uri][IO.Path]::GetFullPath($LocalApp)).AbsoluteUri } else { $PagesUrl }
  $url = "$base#wifi=$b64"
  if ($url.Length -gt $MaxUrl) { $url = $base
    Write-Host 'Údaje se nevešly do adresy – v aplikaci klikni na „Vložit výsledek“ (jsou ve schránce). / Too long for the URL: use "Paste result".' -ForegroundColor Yellow }
  # Windows při otevírání souboru zahodí část adresy za "#" -> soubor otevřeme přímo výchozím prohlížečem
  $cmd = if ($url -like 'file:*') { Get-BrowserCommand } else { $null }
  if ($NoOpen) { Write-Output "url: $url"; if ($cmd) { Write-Output "browser: $($cmd[0]) $($cmd[1].Replace('%1', $url))" }; return }
  if ($cmd) { Start-Process -FilePath $cmd[0] -ArgumentList $cmd[1].Replace('%1', $url) } else { Start-Process $url }
  Write-Host 'Otevírám aplikaci… Okno se za chvíli samo zavře. / Opening the app… this window closes in a moment.'
}
if ($MyInvocation.InvocationName -eq '.') { return }   # načteno přes ". soubor" (testy): jen funkce, nic nespouštět
if ($Once) { Invoke-Once } else { Start-Server }
