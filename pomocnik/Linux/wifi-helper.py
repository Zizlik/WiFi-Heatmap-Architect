#!/usr/bin/env python3
# WiFi Heatmap Architect - pomocník pro Wi-Fi (macOS / Linux; stejný soubor je v obou složkách) / local Wi-Fi helper
# MIT License, © 2026 Zizlik - https://github.com/Zizlik/WiFi-Heatmap-Architect
# Prohlížeč nesmí zjistit, ke které Wi-Fi je počítač připojený (SSID, signál, kanál, linka); tenhle skript to aplikaci
# řekne. Spouští ho "Spustit pomocníka.command" (macOS) / spustit-pomocnika.sh (Linux). Jen Python 3 stdlib.
#   (výchozí)   server JEN na http://127.0.0.1:47823/ (tento počítač), dokud běží (Ctrl+C ho vypne): GET /wifi -> JSON
#               {app, v, os, at, source, raw, error, hostname:null}; GET /health -> {ok:true}; nic jiného
#   --once      jednou zjistí Wi-Fi, výpis dá do schránky a otevře aplikaci s údaji v adrese (#wifi=<base64url JSON>)
#   --no-open   (s --once) jen vypíše adresu  ·  --fake SOUBOR [--os macos|linux]  test: výstup příkazu ze souboru
# Zdroje: macOS system_profiler SPAirPortDataType (-json: nezávisí na jazyce systému), Linux nmcli, jinak iw.
# Bezpečnost: jen čte, nic neukládá, bez správce; pevné příkazy bez shellu; odpovídá jen na 127.0.0.1/localhost (Host)
# a jen stránkám aplikace (CORS); neposílá název počítače ani uživatele, MAC adresu karty ani okolní sítě.
import base64, json, os, re, shutil, subprocess, sys, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
PORT, APP = 47823, 'wifi-heatmap-helper'
APP_URL = 'https://zizlik.github.io/WiFi-Heatmap-Architect/index.cs.html'
LOCAL_APP = Path(__file__).resolve().parent.parent.parent / 'index.cs.html'   # aplikace vedle složky pomocnik
MAX_URL = 8000                     # delší adresu by systém/prohlížeč mohl oříznout -> pak jen schránka
HOSTS = ('127.0.0.1:%d' % PORT, 'localhost:%d' % PORT)                        # kontrola Host = ochrana proti DNS rebindingu
ORIGIN_RE = re.compile(r'(https://zizlik\.github\.io|null|file://|http://(127\.0\.0\.1|localhost)(:\d{1,5})?)\Z')   # null, file:// = stránka z disku
MAC_RE = re.compile(r'([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\Z', re.I)
MAC_FIELDS = (('spairport_network_phymode', 'PHY Mode'), ('spairport_network_channel', 'Channel'),
              ('spairport_security_mode', 'Security'), ('spairport_signal_noise', 'Signal / Noise'),
              ('spairport_network_rate', 'Transmit Rate'), ('spairport_network_mcs', 'MCS Index'))
ARGV = sys.argv[1:]
OPT = lambda name: ARGV[ARGV.index(name) + 1] if name in ARGV[:-1] else None   # hodnota parametru (--fake, --os)
def say(msg): print('[%s] %s' % (time.strftime('%H:%M:%S'), msg), flush=True)
def run(cmd):
    """Pevný příkaz bez shellu, anglické hlášky (LC_MESSAGES=C, LC_ALL pryč), výstup jako UTF-8 text; při chybě ''."""
    env = dict({k: v for k, v in os.environ.items() if k != 'LC_ALL'}, LC_MESSAGES='C')
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, env=env).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return ''
def tool(name):                                   # iw bývá v /usr/sbin, který běžný uživatel nemá v PATH
    return shutil.which(name) or next((p for p in ('/usr/sbin/' + name, '/sbin/' + name) if os.path.exists(p)), name)
def drop_private(text):                           # pryč s řádky "popis: MAC adresa" (kromě BSSID = router), v každém jazyce
    pair = lambda line: re.match(r'\s*([^:]+?)\s*:\s*(\S.*?)\s*$', line) or re.match('()()', '')
    return '\n'.join(l.rstrip() for l in text.replace('\r', '').split('\n')
                     if 'BSSID' in pair(l).group(1) or not MAC_RE.match(pair(l).group(2))).strip()
def mac_from_json(text):
    """system_profiler -json -> stejné řádky "Popis: hodnota" jako textový výstup, jen připojená síť."""
    try:
        data = json.loads(text)
    except ValueError:
        return ''
    out = []
    for item in data.get('SPAirPortDataType', []):
        for itf in item.get('spairport_airport_interfaces', []):
            cur = itf.get('spairport_current_network_information')
            if isinstance(cur, dict):              # 'spairport_security_mode_wpa2_personal' -> 'WPA2 PERSONAL'
                val = lambda v: str(v).replace('spairport_security_mode_', '').replace('_', ' ').upper() if 'spairport_' in str(v) else str(v)
                out += ['Wi-Fi:', '  Interfaces:', '    %s:' % itf.get('_name', 'en0'), '      Status: Connected',
                        '      Current Network Information:', '        %s:' % cur.get('_name', '?')]
                out += ['          %s: %s' % (label, val(cur[key])) for key, label in MAC_FIELDS if key in cur]
    return '\n'.join(out)
def mac_filter_text(text):                        # textový výstup bez okolních sítí (soukromí sousedů) a seznamu kanálů
    return re.sub(r'(?m)^( *)(Other Local Wi-Fi Networks|Supported Channels):.*\n(?:\1 .*\n|[ \t]*\n)*', '', text.replace('\r', '') + '\n').rstrip()
def gather():
    """-> (os, source, raw). Pevné příkazy podle systému; s --fake čte jejich výstup ze souboru (testy)."""
    osname = OPT('--os') or ('macos' if sys.platform == 'darwin' else 'linux')
    fake = Path(OPT('--fake')).read_text(encoding='utf-8') if OPT('--fake') else None
    if osname == 'macos':
        text = fake if fake is not None else run(['system_profiler', '-json', 'SPAirPortDataType'])
        if text.lstrip().startswith('{') and (mac_from_json(text) or fake is not None):
            return osname, 'system_profiler -json SPAirPortDataType', mac_from_json(text)
        text = fake if fake is not None else run(['system_profiler', 'SPAirPortDataType'])
        return osname, 'system_profiler SPAirPortDataType', mac_filter_text(text)
    text = fake if fake is not None else run([tool('nmcli'), '-f', 'IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY', 'dev', 'wifi'])
    if re.search(r'^\s*IN-USE', text, re.M):     # hlavička + jen řádek připojené sítě (IN-USE = *)
        rows = [l.rstrip() for l in text.replace('\r', '').split('\n') if l.strip()]
        return osname, 'nmcli', '\n'.join(rows[:1] + [l for l in rows[1:] if l.lstrip().startswith('*')])
    link = fake.strip() if fake is not None else ''
    for itf in ([] if fake is not None else re.findall(r'^\s*Interface\s+(\S+)', run([tool('iw'), 'dev']), re.M)):
        link = run([tool('iw'), 'dev', itf, 'link']).strip()
        if link.startswith('Connected'):
            break
    return osname, 'iw', link
def payload():
    osname, source, raw = gather()
    raw = drop_private(raw)
    if source.startswith('system_profiler'):    # error: None = v pořádku, jinak kód pro radu v aplikaci
        ok, seen = 'Current Network Information' in raw, 'Wi-Fi' in raw
    elif source == 'nmcli':
        ok, seen = any(l.lstrip().startswith('*') for l in raw.split('\n')), True
    else:
        ok, seen = raw.startswith('Connected'), 'Not connected' in raw
    return {'app': APP, 'v': 1, 'os': osname, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': source,
            'raw': raw, 'error': None if ok else ('not-connected' if seen else 'no-wifi'), 'hostname': None}
def status(p):                                    # jedna srozumitelná věta o tom, co pomocník vidí
    print({None: 'Vidím připojenou Wi-Fi (%s). / Wi-Fi found.' % p['source'],
           'not-connected': 'Počítač teď není připojený k žádné Wi-Fi. / Not connected to Wi-Fi.',
           'no-wifi': 'Nenašel jsem Wi-Fi kartu ani potřebný příkaz. / No Wi-Fi adapter or tool found.'}[p['error']], flush=True)

class Handler(BaseHTTPRequestHandler):
    protocol_version, timeout = 'HTTP/1.1', 10    # nečinný klient po 10 s odpadne
    def version_string(self): return APP
    def log_message(self, *args): pass            # místo technického logu vlastní srozumitelné hlášky (say)
    def reply(self, code, body=None, origin=None, extra=()):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else b''
        self.send_response(code)
        head = [('Cache-Control', 'no-store'), ('Pragma', 'no-cache'), ('X-Content-Type-Options', 'nosniff'), ('Vary', 'Origin'),
                ('Content-Length', str(len(data))), ('Connection', 'close')] + list(extra)
        head += [('Access-Control-Allow-Origin', origin)] if origin else []
        head += [('Content-Type', 'application/json; charset=utf-8')] if data else []
        for k, v in head: self.send_header(k, v)
        self.end_headers()
        if data and self.command != 'HEAD':
            self.wfile.write(data)
    def gate(self):
        """Kontrola Host a Origin -> (True, povolený Origin nebo None), nebo (False, None) a už odpovězeno 403."""
        host, origin = (self.headers.get('Host') or '').lower(), self.headers.get('Origin')
        if host not in HOSTS or not self.client_address[0].startswith('127.'):
            self.reply(403, {'error': 'forbidden-host'}); say('Odmítnuto (cizí Host): %s' % host)
        elif origin is not None and not ORIGIN_RE.match(origin):
            self.reply(403, {'error': 'forbidden-origin'}); say('Odmítnuto (cizí stránka): %s' % origin)
        else:
            return True, origin
        return False, None
    def do_OPTIONS(self):                         # CORS + Private Network Access preflight (Chrome)
        ok, origin = self.gate()
        method, path = self.headers.get('Access-Control-Request-Method'), self.path.split('?')[0]
        if not ok: return
        if not origin or (method and method != 'GET') or path not in ('/wifi', '/health'):
            return self.reply(403, {'error': 'forbidden-preflight'})
        pna = self.headers.get('Access-Control-Request-Private-Network') == 'true'
        self.reply(204, None, origin, [('Access-Control-Allow-Methods', 'GET'), ('Access-Control-Max-Age', '600')]
                   + ([('Access-Control-Allow-Private-Network', 'true')] if pna else []))
    def do_GET(self):
        ok, origin = self.gate()
        path = self.path.split('?')[0]
        if ok and path == '/wifi':
            self.reply(200, payload(), origin)
            say('Aplikace si načetla údaje o Wi-Fi. / App read the Wi-Fi info. (%s)' % (origin or '-'))
        elif ok:
            self.reply(*((200, {'ok': True, 'v': 1, 'app': APP}) if path == '/health' else (404, {'error': 'not-found'})), origin=origin)
    def deny(self):                               # jen GET (a preflight OPTIONS)
        ok, origin = self.gate()
        if ok:
            self.reply(405, {'error': 'method-not-allowed'}, origin, [('Allow', 'GET, OPTIONS')])
    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = deny

# vlákna: nečinné spojení prohlížeče nezdrží ostatní; SO_REUSEADDR ve Windows by pustil dva pomocníky na jeden port
Server = type('Server', (ThreadingHTTPServer,), {'daemon_threads': True, 'allow_reuse_address': os.name != 'nt'})

def serve():
    try:
        server = Server(('127.0.0.1', PORT), Handler)   # jen loopback - z jiných počítačů nedostupné
    except OSError:
        print('Port %d je obsazený - pomocník už asi běží. / Port %d is busy - the helper is probably already running.' % (PORT, PORT))
        return 1
    print('\n  WiFi Heatmap Architect - pomocník pro Wi-Fi\n'
          '  Pomocník běží – nech toto okno otevřené. Zavřením ho vypneš (nebo Ctrl+C).\n  Adresa aplikace: %s\n'
          '  V aplikaci klikni na „Změřit vše“ – údaje o Wi-Fi si vezme odsud. Nic se nikam neposílá.\n'
          '  The helper is running – keep this window open; close it (or press Ctrl+C) to stop it.\n'
          '  It only reads Wi-Fi details and answers only this computer (http://127.0.0.1:%d/).\n'
          % (LOCAL_APP if LOCAL_APP.is_file() else APP_URL, PORT), flush=True)
    try:
        status(payload())
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print('\nPomocník je vypnutý. / Helper stopped.', flush=True)
    return 0
def copy(text):
    """Do schránky: pbcopy (macOS), wl-copy / xclip / xsel (Linux), clip (Windows - jen pro testy)."""
    cmds = [['pbcopy']] if sys.platform == 'darwin' else [['clip']] if os.name == 'nt' else \
        ([['wl-copy']] if os.environ.get('WAYLAND_DISPLAY') else []) + [['xclip', '-selection', 'clipboard'], ['xsel', '-b', '-i']]
    data = text.encode('utf-16-le' if os.name == 'nt' else 'utf-8')   # clip.exe pozná UTF-16 sám (BOM by vložil jako znak)
    for cmd in (c for c in cmds if shutil.which(c[0])):
        try:                                      # LANG: pbcopy jinak bere vstup jako MacRoman a rozbije češtinu
            return subprocess.run(cmd, input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                                  env=dict(os.environ, LANG='en_US.UTF-8')).returncode == 0
        except (OSError, subprocess.SubprocessError):
            pass
    return False

def once():
    p = payload()
    status(p)
    print('Výpis je ve schránce. / The output is in the clipboard.' if copy(p['raw']) else 'Schránku se nepodařilo naplnit. / Could not copy to the clipboard.')
    data = json.dumps({'v': 1, 'os': p['os'], 'raw': p['raw']}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    base = LOCAL_APP.as_uri() if LOCAL_APP.is_file() else APP_URL
    url = base + '#wifi=' + base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')
    if len(url) > MAX_URL:                        # příliš dlouhé -> jen schránka
        url = base; print('Údaje se nevešly do adresy – v aplikaci klikni na „Vložit výsledek“ (jsou ve schránce). / Use "Paste result" in the app.')
    if '--no-open' in ARGV:
        print('url: ' + url)
    elif not webbrowser.open(url):
        print('Otevři aplikaci ručně / open the app: ' + base)
    return 0

if __name__ == '__main__':
    getattr(sys.stdout, 'reconfigure', lambda **kw: None)(errors='replace')   # terminál bez UTF-8 nesmí pomocníka shodit
    sys.exit(once() if '--once' in ARGV else serve())
