/* Rises — BLE: łączność bez parowania (v3.35.0).
 *
 * Do tej pory Rises umiał tylko klasyczny Bluetooth, a ten wymaga WCZEŚNIEJ
 * SPAROWANEGO telefonu. To była prawdziwa dziura: „losowe urządzenie w pobliżu"
 * nie mogło się nigdy połączyć.
 *
 * BLE to zmienia: telefon OGŁASZA się w eterze, SKANUJE innych i PRZESYŁA
 * wiadomości przez GATT — bez parowania, bez pytania użytkownika, bez internetu.
 * Każde urządzenie z Rises w zasięgu staje się stacją.
 *
 * Mostek natywny: `RisesBle` (klasa RisesBleBridge).
 * Zasięg: 10–50 m w terenie (BLE 5), mniej przez ściany. Nie ma BLE = zostaje
 * klasyczne radio i sparowane telefony.
 */
(function (root) {
  var MAGIC = 'RS';

  function bridge() {
    return (typeof root.RisesBle !== 'undefined') ? root.RisesBle : null;
  }

  function has() { return !!bridge(); }

  function supported() {
    var b = bridge();
    if (!b || !b.isSupported) return false;
    try { return !!b.isSupported(); } catch (e) { return false; }
  }

  function enabled() {
    var b = bridge();
    if (!b || !b.isEnabled) return false;
    try { return !!b.isEnabled(); } catch (e) { return false; }
  }

  function hasPermissions() {
    var b = bridge();
    if (!b || !b.hasPermissions) return true;
    try { return !!b.hasPermissions(); } catch (e) { return true; }
  }

  function askPermissions() {
    var b = bridge();
    if (!b || !b.askPermissions) return false;
    try { b.askPermissions(); return true; } catch (e) { return false; }
  }

  function ensureOn() {
    var b = bridge();
    if (!b || !b.ensureOn) return false;
    try { b.ensureOn(); return true; } catch (e) { return false; }
  }

  function start(nodeId) {
    var b = bridge();
    if (!b || !b.start) return false;
    try { b.start(String(nodeId || '')); return true; } catch (e) { return false; }
  }

  function stop() {
    var b = bridge();
    if (!b || !b.stop) return false;
    try { b.stop(); return true; } catch (e) { return false; }
  }

  function isRunning() {
    var b = bridge();
    if (!b || !b.isRunning) return false;
    try { return !!b.isRunning(); } catch (e) { return false; }
  }

  function status() {
    var b = bridge();
    if (!b || !b.status) return '';
    try { return String(b.status()); } catch (e) { return ''; }
  }

  /* Stan, w którym trzeba coś zrobić — nazwany po ludzku. */
  function state() {
    if (!has()) return 'brak';
    if (!supported()) return 'nierozglasza';
    if (!enabled()) return 'off';
    if (!hasPermissions()) return 'zgoda';
    if (!isRunning()) return 'gotowe';
    return 'gra';
  }

  function decodeBase64(str) {
    try {
      var bin = root.atob ? root.atob(str) : Buffer.from(str, 'base64').toString('binary');
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      return new TextDecoder().decode(bytes);
    } catch (e) { return null; }
  }

  /* Odebrane wiadomości (już jako tekst). */
  function poll() {
    var b = bridge();
    var out = [];
    if (!b || !b.poll) return out;
    var raw = '';
    try { raw = b.poll() || ''; } catch (e) { return out; }
    if (!raw) return out;
    var lines = String(raw).split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      var text = decodeBase64(lines[i]);
      if (text) out.push(text);
    }
    return out;
  }

  /* Kto jest w pobliżu: [{mac, rssi}] — z siłą sygnału, więc wiadomo kto bliżej. */
  function peers() {
    var b = bridge();
    var out = [];
    if (!b || !b.peers) return out;
    var raw = '';
    try { raw = b.peers() || ''; } catch (e) { return out; }
    if (!raw) return out;
    var lines = String(raw).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      var cut = line.indexOf('|');
      if (cut < 0) continue;
      out.push({ mac: line.slice(0, cut), rssi: parseInt(line.slice(cut + 1), 10) || -127 });
    }
    out.sort(function (a, b2) { return b2.rssi - a.rssi; });  // najbliższy pierwszy
    return out;
  }

  function nearCount() {
    var b = bridge();
    if (!b || !b.nearCount) return peers().length;
    try { return b.nearCount() | 0; } catch (e) { return peers().length; }
  }

  function heardCount() {
    var b = bridge();
    if (!b || !b.heardCount) return 0;
    try { return b.heardCount() | 0; } catch (e) { return 0; }
  }

  /* Wysyła wiadomość do obcego telefonu — bez parowania. */
  function send(mac, text) {
    var b = bridge();
    if (!b || !b.send || !mac) return false;
    try { b.send(mac, String(text)); return true; } catch (e) { return false; }
  }

  /* Najbliższy telefon z Rises, do którego można wysłać (pomijając nadawcę tej ramki). */
  function best(excludeMac) {
    var list = peers();
    for (var i = 0; i < list.length; i++) {
      if (!excludeMac || list[i].mac !== excludeMac) return list[i];
    }
    return null;
  }

  var api = {
    has: has,
    supported: supported,
    enabled: enabled,
    hasPermissions: hasPermissions,
    askPermissions: askPermissions,
    ensureOn: ensureOn,
    start: start,
    stop: stop,
    isRunning: isRunning,
    status: status,
    state: state,
    poll: poll,
    peers: peers,
    nearCount: nearCount,
    heardCount: heardCount,
    send: send,
    best: best,
    MAGIC: MAGIC
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_BLE = api;
})(typeof window !== 'undefined' ? window : globalThis);
