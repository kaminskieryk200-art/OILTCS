/* Rises — warstwa JavaScript nad PRAWDZIWYM radiem Bluetooth (v3.33.0).
 *
 * Aplikacja ma natywny mostek `RisesRadio` (klasa RisesRadioBridge), który
 * wystawia radio RFCOMM do JavaScript. Ten moduł:
 *  - sprawdza, czy radio jest dostępne i włączone,
 *  - wysyła wiadomość na adres MAC drugiego telefonu,
 *  - ODBIERA w kółko (mostek nasłuchuje w tle, tu tylko zbieramy bajty),
 *  - składa strumień bajtów w kompletne wiadomości (RFCOMM to strumień —
 *    jedna porcja nie musi być jedną wiadomością),
 *  - pokazuje sparowane telefony, żeby nie wpisywać MAC-ów ręcznie.
 *
 * ZASIĘG: klasyczny Bluetooth (RFCOMM), nie BLE. W terenie realnie 10–30 m,
 * w mieszkaniu przez ściany kilka metrów. Jedna wiadomość to milisekundy.
 * Zasięg rośnie tylko przez liczbę stacji, nie przez moc nadawania.
 */
(function (root) {
  var MAGIC = 'RBT2';        // początek wiadomości na drucie
  var END = '\n';            // koniec wiadomości
  var MAX_BUFFER = 512 * 1024;

  function bridge() {
    return (typeof root.RisesRadio !== 'undefined') ? root.RisesRadio : null;
  }

  function hasBridge() {
    var b = bridge();
    return !!(b && b.isAvailable);
  }

  /* Wersja 2 mostka ma poll() i send(mac, tekst). Starsza nie ma. */
  function bridgeVersion() {
    var b = bridge();
    try {
      if (b && b.version) return String(b.version());
      if (b && b.poll) return '2';
    } catch (e) {}
    return hasBridge() ? '1' : '0';
  }

  function available() {
    if (!hasBridge()) return false;
    try { return !!bridge().isAvailable(); } catch (e) { return false; }
  }

  function enabled() {
    var b = bridge();
    if (!b || !b.isEnabled) return false;
    try { return !!b.isEnabled(); } catch (e) { return false; }
  }

  function myAddress() {
    var b = bridge();
    if (!b || !b.myAddress) return '';
    try { return b.myAddress() || ''; } catch (e) { return ''; }
  }

  function hasConnect() {
    var b = bridge();
    if (!b || !b.hasConnect) return true;
    try { return !!b.hasConnect(); } catch (e) { return true; }
  }

  /* Włącza radio JEDNYM oknem systemowym — bez szukania w ustawieniach.
   * Android sam zapyta „czy włączyć Bluetooth?", użytkownik dotyka „Zezwól". */
  function ensureOn() {
    var b = bridge();
    if (!b || !b.ensureOn) return false;
    try { b.ensureOn(); return true; } catch (e) { return false; }
  }

  /* Ustawienia Bluetooth — jedyne miejsce, gdzie paruje się drugi telefon. */
  function openSettings() {
    var b = bridge();
    if (!b || !b.openSettings) return false;
    try { b.openSettings(); return true; } catch (e) { return false; }
  }

  function askPermissions() {
    var b = bridge();
    if (!b || !b.askPermissions) return false;
    try { b.askPermissions(); return true; } catch (e) { return false; }
  }

  /* Sparowane telefony jako lista {name, address}. To jedyne urządzenia,
   * do których klasyczny Bluetooth może się połączyć bez pytania użytkownika. */
  function paired() {
    var b = bridge();
    if (!b || !b.paired) return [];
    var out = [];
    try {
      var raw = b.paired() || '';
      var lines = String(raw).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line) continue;
        var cut = line.indexOf('\t');
        if (cut < 0) continue;
        var name = line.slice(0, cut) || 'telefon';
        var mac = line.slice(cut + 1).trim();
        if (!mac) continue;
        out.push({ name: name, address: mac });
      }
    } catch (e) {}
    return out;
  }

  /* --- bajty <-> tekst, w którym każdy bajt to jeden znak (ISO-8859-1).
   * Mostek wysyła i odbiera dokładnie to, co podamy — bez gubienia znaków
   * i bez problemów z kodowaniem. --- */
  function latin1FromBytes(bytes) {
    var parts = [];
    var step = 4096;
    for (var i = 0; i < bytes.length; i += step) {
      var end = Math.min(i + step, bytes.length);
      var piece = '';
      for (var k = i; k < end; k++) piece += String.fromCharCode(bytes[k] & 0xff);
      parts.push(piece);
    }
    return parts.join('');
  }

  function bytesFromLatin1(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  /* Tekst (UTF-8) -> bajty -> tekst jednego bajtu na znak. */
  function encode(text) {
    return latin1FromBytes(new TextEncoder().encode(String(text)));
  }

  function decode(latin1) {
    return new TextDecoder().decode(bytesFromLatin1(String(latin1)));
  }

  /* Wysyła jedną wiadomość na adres MAC. Zwraca true, gdy radio potwierdziło. */
  function sendText(mac, text) {
    var b = bridge();
    if (!b || !b.send || !mac) return false;
    var payload = MAGIC + encode(text) + END;
    try { return !!b.send(mac, payload); } catch (e) { return false; }
  }

  /* Uruchamia nasłuch w tle. Zwraca true, gdy wątek ruszył. */
  function listen() {
    var b = bridge();
    if (!b || !b.start) return false;
    if (!enabled()) {
      // nikt nie musi nic wiedzieć o radiu: pokazujemy jedno okno systemowe
      ensureOn();
      return false;
    }
    try { b.start(); return true; } catch (e) { return false; }
  }

  function isListening() {
    var b = bridge();
    if (!b || !b.isRunning) return false;
    try { return !!b.isRunning(); } catch (e) { return false; }
  }

  function stopListening() {
    var b = bridge();
    if (!b || !b.stop) return false;
    try { b.stop(); return true; } catch (e) { return false; }
  }

  /* Zbiera wszystko, co przyszło od ostatniego wywołania, i zwraca gotowe
   * wiadomości. Niepełny koniec strumienia czeka na następną porcję. */
  var pending = '';
  function pollText() {
    var b = bridge();
    var out = [];
    if (!b || !b.poll) return out;

    var raw = '';
    try { raw = b.poll() || ''; } catch (e) { return out; }
    if (raw) pending += raw;
    if (pending.length > MAX_BUFFER) pending = pending.slice(-MAX_BUFFER);

    var start = pending.indexOf(MAGIC);
    if (start < 0) {
      // śmieci przed pierwszym nagłówkiem — wyrzucamy, żeby bufor nie puchł
      if (pending.length > 4) pending = '';
      return out;
    }
    if (start > 0) pending = pending.slice(start);

    // tniemy na kompletne wiadomości
    for (;;) {
      var from = pending.indexOf(MAGIC);
      if (from < 0) break;
      var end = pending.indexOf(END, from + MAGIC.length);
      if (end < 0) break;                       // jeszcze nie cała
      var body = pending.slice(from + MAGIC.length, end);
      pending = pending.slice(end + 1);
      if (!body) continue;
      try { out.push(decode(body)); } catch (e) {}
    }
    return out;
  }

  /* Ile realnie idzie przez radio (RFCOMM, kilobajty na sekundę). */
  function estimateSeconds(bytes) {
    var kbps = 150;
    return (bytes || 200) / (kbps * 1024);
  }

  /* --- zgodność ze starszym API: dzielenie na kawałki zostaje,
   * ale na drucie już go nie używamy (mostek pisze całość jednym zapisem). --- */
  function chunk(bytes, size) {
    var step = size || 900;
    var total = Math.max(1, Math.ceil(bytes.length / step));
    var out = [];
    for (var i = 0; i < total; i++) {
      var slice = bytes.slice(i * step, (i + 1) * step);
      var frame = new Uint8Array(slice.length + 5);
      frame[0] = 1;
      frame[1] = i;
      frame[2] = total;
      frame[3] = (bytes.length >> 8) & 0xff;
      frame[4] = bytes.length & 0xff;
      frame.set(slice, 5);
      out.push(frame);
    }
    return out;
  }

  function assemble(frames) {
    if (!frames || !frames.length) return null;
    var total = frames[0][2];
    var length = (frames[0][3] << 8) | frames[0][4];
    var parts = new Array(total);
    var have = 0;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (!f || f[0] !== 1) continue;
      if (f[2] !== total) continue;
      var idx = f[1];
      if (idx >= total || parts[idx]) continue;
      parts[idx] = f.slice(5);
      have++;
    }
    if (have !== total) return null;
    var out = new Uint8Array(length);
    var pos = 0;
    for (var k = 0; k < total; k++) { out.set(parts[k], pos); pos += parts[k].length; }
    return out;
  }

  var api = {
    available: available,
    enabled: enabled,
    myAddress: myAddress,
    bridgeVersion: bridgeVersion,
    askPermissions: askPermissions,
    hasConnect: hasConnect,
    ensureOn: ensureOn,
    openSettings: openSettings,
    paired: paired,
    sendText: sendText,
    listen: listen,
    isListening: isListening,
    stopListening: stopListening,
    pollText: pollText,
    encode: encode,
    decode: decode,
    chunk: chunk,
    assemble: assemble,
    estimateSeconds: estimateSeconds,
    MAGIC: MAGIC
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_BT = api;
})(typeof window !== 'undefined' ? window : globalThis);
