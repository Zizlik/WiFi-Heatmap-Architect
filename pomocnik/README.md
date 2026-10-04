# Wi-Fi helper (pomocník) for WiFi Heatmap Architect

Browsers do not let a web page read the Wi-Fi details of the device it runs on: the network name (SSID), the access
point (BSSID), the signal in dBm, the channel, the band or the link rate are not exposed by any browser on any system,
phones included. A web page also cannot start a program on your computer.

These small scripts fill that gap on a PC. **You start one yourself (double-click)**; while it runs, the app's
**"Změřit vše" / "Measure everything"** button picks up the Wi-Fi details automatically. The app works fully without
it (manual entry, or paste the output of a command).

The helper only **reads** Wi-Fi information. It changes nothing, installs nothing, needs no administrator rights,
listens only on this computer (`127.0.0.1:47823`), answers only the app's pages, and sends nothing to the internet.

Czech quick guide for users: [CTI-ME.txt](CTI-ME.txt).

## Files

| Folder | Start this | One-shot variant | Does the work |
|---|---|---|---|
| `Windows/` | `Spustit pomocníka.cmd` | `Jednorázově zjistit Wi-Fi.cmd` | `wifi-helper.ps1` (Windows PowerShell 5.1+, built in) |
| `macOS/` | `Spustit pomocníka.command` | `Jednorázově zjistit Wi-Fi.command` | `wifi-helper.py` (Python 3, standard library only) |
| `Linux/` | `spustit-pomocnika.sh` | `jednorazove-zjistit-wifi.sh` | `wifi-helper.py` (same file as in `macOS/`) |

Each OS folder is self-contained, so downloading just that folder is enough. If the whole project is downloaded
(so `index.cs.html` sits two levels up, next to `pomocnik/`), the one-shot mode opens that local copy of the app;
otherwise it opens <https://zizlik.github.io/WiFi-Heatmap-Architect/index.cs.html>.

## Starting it

**Windows 10/11.** Double-click `Spustit pomocníka.cmd`. On the blue SmartScreen dialog choose *More info → Run
anyway* (Czech: *Další informace → Přesto spustit*); on the "Open file - security warning" choose *Run*. If Windows
blocks the files outright: right-click each file → *Properties* → tick *Unblock* → *OK*. A console window says the
helper is running; keep it open. Windows 11 (24H2 and later) only gives Wi-Fi details to programs when *Settings →
Privacy & security → Location* is on, including *Let desktop apps access your location*; the helper detects this and
says so.

**macOS.** Double-click `Spustit pomocníka.command`. Gatekeeper blocks downloaded scripts the first time:
right-click → *Open* → *Open* (macOS 14 and older), or *System Settings → Privacy & Security → Open Anyway*
(macOS 15+). If macOS says you lack permission (the executable bit is lost when a single file is downloaded), run it
from Terminal: type `sh `, drag the file into the window, press Enter. The helper needs Python 3. A fresh macOS only
has a stub that offers to install the Command Line Tools; in that case the launcher copies the Wi-Fi details to the
clipboard instead (use *Vložit výsledek / Paste result* in the app) and explains `xcode-select --install`.

**Linux.** In a terminal inside `Linux/`: `sh spustit-pomocnika.sh` (one-shot: `sh jednorazove-zjistit-wifi.sh`).
Needs `python3` and `nmcli` (NetworkManager) or `iw`; clipboard via `wl-copy`, `xclip` or `xsel` when present.

**Stopping.** Close the window or press Ctrl+C. Nothing is left behind (no files, no services, no settings).

**Phones.** Not possible: Android and iOS browsers cannot start programs. Use the WiFiman app (Ubiquiti) to read the
signal in dBm and type it into the measurement.

## Modes and options

| Option | Meaning |
|---|---|
| *(none)* | Server mode: answers the app on `http://127.0.0.1:47823/` until the window is closed. |
| `--once` | Reads the Wi-Fi details once, copies the raw command output to the clipboard and opens the app with `#wifi=<data>`. |
| `--no-open` | With `--once`: do not open a browser, just print `url: …` (Windows also prints `browser: …`). For tests. |
| `--fake <file>` | Test aid: read the command output from a UTF-8 file instead of running the command. |
| `--os macos\|linux` | Python only, with `--fake`: which system the fake output comes from. |

## HTTP API (server mode)

`GET /health` → `{"ok":true,"v":1,"app":"wifi-heatmap-helper"}` (cheap; the app probes it with a short timeout).

`GET /wifi` → runs the fixed command and returns, for example:

```json
{
  "app": "wifi-heatmap-helper", "v": 1, "os": "windows", "at": "2026-10-03T14:31:28Z",
  "source": "netsh wlan show interfaces",
  "raw": "There is 1 interface on the system:\n\n    Name : Wi-Fi\n    State : connected\n    SSID : MyWiFi\n    …",
  "error": null, "hostname": null
}
```

* `os`: `windows` | `macos` | `linux`. `source`: `netsh wlan show interfaces` | `system_profiler -json SPAirPortDataType` |
  `system_profiler SPAirPortDataType` | `nmcli` | `iw`. `hostname` is always `null` (neither the computer nor the
  user name is ever sent). Query strings are ignored (`/wifi?t=…` works).
* `raw` is the command output for the app's parser (LF line endings, trailing spaces trimmed), with private or
  irrelevant lines removed:
  * **Windows** `netsh wlan show interfaces`, any language. Lines whose value is the adapter's own MAC address or GUID
    are dropped (BSSID lines are kept). netsh writes UTF-8 or the OEM code page (CP852 on Czech systems) depending on
    the Windows build; the helper reads raw bytes and decodes strict UTF-8 first, OEM otherwise, so Czech labels such
    as `Signál` or `Rychlost příjmu (Mb/s)` arrive intact. Wi-Fi 7 adapters print `MLD AP BSSID` plus a
    `LinkID: 0, Local: …, AP: …, RSSI: -70, Channel: 100, Band: 5 GHz, BW: 80` line instead of separate
    `Channel`/`Band` lines.
  * **macOS** `system_profiler -json SPAirPortDataType` (its keys do not depend on the system language) rewritten into
    the familiar text form: `Current Network Information:` → `<SSID>:` → `PHY Mode`, `Channel: 44 (5GHz, 80MHz)`,
    `Security: WPA2 PERSONAL`, `Signal / Noise: -54 dBm / -92 dBm`, `Transmit Rate: 1200`, `MCS Index`. Without
    `-json` the text output is used with *Other Local Wi-Fi Networks*, *Supported Channels* and MAC lines removed.
  * **Linux** `nmcli -f IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY dev wifi` reduced to the header and the
    in-use (`*`) row; `SIGNAL` is NetworkManager's 0–100 quality, which maps −100…−40 dBm linearly
    (dBm ≈ 0.6 × SIGNAL − 100), not the Windows formula (SIGNAL / 2 − 100).
    Fallback: `iw dev <if> link` (`signal: -54 dBm`, `rx bitrate`, `tx bitrate`, `freq`).
* `error`: `null` when connected, else `not-connected`, `no-wifi` (no adapter / tool), or `location` (Windows refuses
  without Location services). `raw` is still included.

Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Vary: Origin` and
`Connection: close`; bodies are `application/json; charset=utf-8`.

## The band of a measurement (2.4 / 5 / 6 GHz)

The helper reports the band, channel and signal **at the moment of the measurement**; the app stores them with that
measurement and computes calibration and speed per band. Users never have to pin their device to one band: band
steering and Wi-Fi 7 multi-link (MLO) switch bands by themselves, and every measurement simply counts for the band it
was taken on. With MLO the strongest link is the measurement's band and the other links are listed
("5 GHz (+6 GHz MLO)"). On a PC the app never saves a measurement without a band: when the helper cannot be reached it
asks to connect the helper, to paste the command output, or to pick the band by hand (2.4 / 5 / 6 / Not sure). Phones
cannot run the helper; their users pick the band or "Not sure", and the app estimates it from the signal.

## Security model

* **Loopback only.** Windows uses `HttpListener` with the prefix `http://127.0.0.1:47823/`: http.sys then listens on
  127.0.0.1 only (verified with `netstat`; no admin needed on Windows 11). Should an older Windows refuse it ("access
  denied"), the helper prints the one-time admin command `netsh http add urlacl url=http://127.0.0.1:47823/ user=<you>`
  instead of falling back to a wider binding. Python binds `127.0.0.1`. Other computers cannot connect, and requests
  whose remote address is not loopback are refused as well.
* **Host check** (DNS-rebinding protection): only `Host: 127.0.0.1:47823` or `localhost:47823`; anything else → 403.
* **CORS allow-list.** `Access-Control-Allow-Origin` echoes only `https://zizlik.github.io`, `null` and `file://` (pages
  opened from disk; browsers send `null`, some test setups `file://`), `http://127.0.0.1[:port]` and
  `http://localhost[:port]`. Any other `Origin` → 403 with no CORS
  headers, logged in the window as *Odmítnuto (cizí stránka)*. Requests without `Origin` (curl, typing the URL) are served.
* **Preflight.** `OPTIONS /wifi|/health` from an allowed origin with `Access-Control-Request-Method: GET` → 204 with
  `Access-Control-Allow-Methods: GET`; `Access-Control-Request-Private-Network: true` is answered with
  `Access-Control-Allow-Private-Network: true` (Chrome Private Network Access). Other methods → 405, other paths → 404.
* **Chrome / Edge Local Network Access** (Chrome 142+): a page served from the internet (GitHub Pages) must get the
  user's permission before it may contact `127.0.0.1`; the browser asks once (a box under the address bar: "… wants to
  look for and connect to any device on your local network" / "access other apps and services on this device",
  *Allow* / *Block*). Pages from `file://` or `localhost` are not asked. Safari may refuse `http://127.0.0.1` from an
  https page; use another browser or the one-shot mode there.
* **Fixed commands.** Nothing from a request is ever passed to a command; the command list is fixed per OS and is run
  without a shell. No writes, no persistence, no elevation.
* **The app asks first.** On an https page the app never contacts the helper while the browser's permission is still
  undecided (that would pop up the browser's question for people who never started a helper); it waits until the user
  presses *Připojit pomocníka / Connect the helper* - in *Info o zařízení / Device info*, and in the Wi-Fi row of
  *Změřit vše* when that step was skipped. The app then queries the permission, shows an inline explainer while the
  browser's box is open ("Chrome will now ask about access to devices on your local network – click Allow. It is only
  for the helper on this computer"), waits up to 30 s and retries at once when the permission flips. Its requests carry
  `fetch(…, {targetAddressSpace: 'loopback'})` on https pages (Chrome 142+; other browsers ignore it). After that one
  *Allow*, every *Změřit vše* finds the helper by itself (one probe per measurement, only on a user action). A blocked
  permission is explained with the way back (*lock icon → Site settings → Local network → Allow*, reload) and the
  paste-a-command fallback; none of these cases ends in a generic error. `file://` and `localhost` pages probe directly.
* **Residual risk.** The `null` origin is also what sandboxed iframes have, so while the helper runs, a hostile page
  could read the Wi-Fi details through such an iframe if the browser lets it reach `127.0.0.1` (current Chrome/Edge ask
  the user first, see above). The data is the same as `netsh wlan show interfaces` shows; the adapter's own MAC address
  is removed. Keep the window open only while measuring.

## One-shot mode (`--once`)

1. Runs the same command as `/wifi`.
2. Copies `raw` to the clipboard (Windows `Set-Clipboard`; macOS `pbcopy` with `LANG=en_US.UTF-8`; Linux `wl-copy`,
   `xclip` or `xsel`).
3. Opens `<app>#wifi=<base64url(JSON {"v":1,"os":…,"raw":…})>` (UTF-8 JSON, URL-safe alphabet, no `=` padding). The
   hash never leaves the browser. If the URL would exceed 8000 characters it opens the plain app URL and tells the
   user to use *Vložit výsledek / Paste result* (the data is in the clipboard).
   Windows drops everything after `#` when it opens a *file* through its file association, so for a local
   `index.cs.html` the helper starts the default browser from the registry (`UrlAssociations\https\UserChoice`) with
   the full URL.

## For maintainers

* Each script stays under 200 lines and carries the MIT header "© 2026 Zizlik".
* `macOS/wifi-helper.py` and `Linux/wifi-helper.py` must stay byte-identical; Python 3.8+ syntax, standard library only.
* `wifi-helper.ps1` is UTF-8 **with BOM** (Windows PowerShell 5.1 reads BOM-less files as ANSI and breaks Czech text)
  and CRLF; `.cmd` files are CRLF; shell and Python files are LF. `pomocnik/.gitattributes` keeps it that way.
* In PowerShell, typographic quotes `„“` act as string delimiters inside `"…"`, so Czech quotes only go in `'…'` strings.
* Executable bits in git: `git update-index --chmod=+x` for `macOS/*.command`, `macOS/wifi-helper.py`, `Linux/*.sh`
  and `Linux/wifi-helper.py`.
* Test without Wi-Fi: `python3 wifi-helper.py --fake sample.txt --os linux`, then `curl -i http://127.0.0.1:47823/wifi`
  (add `-H "Origin: https://zizlik.github.io"`); `powershell -File wifi-helper.ps1 --once --no-open --fake netsh.txt`.

## License

MIT, © 2026 Zizlik (see [../LICENSE](../LICENSE)).
