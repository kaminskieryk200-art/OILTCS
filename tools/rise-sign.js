/* Rises — podpisy nadawcy (v3.36.0).
 *
 * Problem: w sieci bez serwera każdy, kto potrafi pisać do charakterystyki BLE,
 * może wysłać ramkę „od Ciebie". Bez podpisu nie ma sposobu, żeby to odróżnić.
 *
 * Rozwiązanie: każdy telefon ma własną parę kluczy (ECDSA P-256, generowana raz
 * i trzymana w pamięci aplikacji). Każda wiadomość jest podpisana, a odbiorca
 * sprawdza podpis i zapamiętuje pierwszy widziany klucz dla danego nadawcy
 * (zaufanie przy pierwszym kontakcie). Gdy klucz się zmieni — wiadomość jest
 * odrzucana, bo to znaczy, że ktoś próbuje się podszyć.
 *
 * Uczciwie: to NIE jest pełne uwierzytelnianie tożsamości. Pierwszy kontakt
 * jest zaufany „na wiarę" (TOFU). Ktoś, kto pierwszy przedstawi się jako Twój
 * znajomy, zostanie przyjęty. Prawdziwe uwierzytelnianie wymaga wymiany kluczy
 * poza siecią (np. kodem QR przy pierwszym spotkaniu).
 */
(function (root) {
  var STORE_KEY = 'rise-identity-v1';      // nasza para kluczy
  var PIN_KEY = 'rise-pins-v1';            // komu zaufaliśmy: nodeId -> keyId
  var curve = { name: 'ECDSA', namedCurve: 'P-256' };
  var algo = { name: 'ECDSA', hash: { name: 'SHA-256' } };

  var identity = null;                     // { privateKey, publicKey, keyId, ready }
  var pins = {};
  var verifying = {};                      // cache: keyId|podpis -> bool
  var stats = { signed: 0, verified: 0, rejected: 0, unsigned: 0, pinned: 0 };

  function cryptoApi() {
    return (root.crypto && root.crypto.subtle) ? root.crypto.subtle : null;
  }

  function storage() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function b64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    if (root.btoa) return root.btoa(s);
    return Buffer.from(s, 'binary').toString('base64');
  }

  function unb64(str) {
    var bin = root.atob ? root.atob(str) : Buffer.from(str, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function hex(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  async function sha8(text) {
    var sub = cryptoApi();
    if (!sub) return 'brak';
    var digest = await sub.digest('SHA-256', new TextEncoder().encode(String(text)));
    return hex(new Uint8Array(digest).slice(0, 8));
  }

  function loadPins() {
    var ls = storage();
    if (!ls) return;
    try { pins = JSON.parse(ls.getItem(PIN_KEY) || '{}') || {}; } catch (e) { pins = {}; }
  }

  function savePins() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(PIN_KEY, JSON.stringify(pins)); } catch (e) {}
  }

  /* Wczytuje albo tworzy naszą parę kluczy. Zwraca true, gdy gotowa. */
  async function init() {
    if (identity && identity.ready) return true;
    var sub = cryptoApi();
    if (!sub) return false;
    loadPins();

    var ls = storage();
    var saved = null;
    try { saved = JSON.parse((ls && ls.getItem(STORE_KEY)) || 'null'); } catch (e) { saved = null; }

    try {
      if (saved && saved.privateJwk && saved.publicJwk) {
        identity = {
          privateKey: await sub.importKey('jwk', saved.privateJwk, curve, false, ['sign']),
          publicKey: await sub.importKey('jwk', saved.publicJwk, curve, true, ['verify']),
          ready: true
        };
      } else {
        var pair = await sub.generateKey(curve, true, ['sign', 'verify']);
        var priv = await sub.exportKey('jwk', pair.privateKey);
        var pub = await sub.exportKey('jwk', pair.publicKey);
        identity = { privateKey: pair.privateKey, publicKey: pair.publicKey, ready: true };
        if (ls) { try { ls.setItem(STORE_KEY, JSON.stringify({ privateJwk: priv, publicJwk: pub })); } catch (e) {} }
      }
      // identyfikator klucza = 8 bajtów skrótu klucza publicznego
      var raw = await sub.exportKey('raw', identity.publicKey);
      identity.keyId = await sha8(hex(raw));
      return true;
    } catch (e) {
      identity = null;
      return false;
    }
  }

  /* Klucz publiczny jako base64 (jedzie w każdej ramce, żeby odbiorca miał czym sprawdzić). */
  async function publicKeyRaw() {
    if (!ready() && !(await init())) return '';
    var sub = cryptoApi();
    if (!sub) return '';
    try {
      var raw = await sub.exportKey('raw', identity.publicKey);
      return b64(raw);
    } catch (e) { return ''; }
  }

  function ready() { return !!(identity && identity.ready); }
  function keyId() { return (identity && identity.keyId) || 'brak'; }

  /* Podpisuje tekst. Zwraca { keyId, sig } albo null, gdy kryptografia nie działa. */
  async function sign(text) {
    if (!ready() && !(await init())) return null;
    var sub = cryptoApi();
    if (!sub) return null;
    try {
      var sig = await sub.sign(algo, identity.privateKey, new TextEncoder().encode(String(text)));
      stats.signed++;
      return { keyId: identity.keyId, sig: b64(sig) };
    } catch (e) {
      return null;
    }
  }

  /* Tani skrót treści — tylko do klucza cache, nie do bezpieczeństwa. */
  function cheapHash(text) {
    var h = 5381;
    var s = String(text);
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16) + ':' + s.length;
  }

  /* Weryfikuje podpis wskazanym kluczem (klucz publiczny trzymamy w pamięci).
   * UWAGA: klucz cache MUSI zawierać treść — inaczej podmieniona wiadomość
   * z tym samym podpisem zostałaby przyjęta jako już sprawdzona. */
  async function verify(keyHex, text, sigB64) {
    var sub = cryptoApi();
    if (!sub) return false;
    var cacheKey = keyHex + '|' + sigB64 + '|' + cheapHash(text);
    if (verifying[cacheKey] !== undefined) return verifying[cacheKey];
    try {
      var raw = null;
      if (publicKeys[keyHex]) {
        raw = publicKeys[keyHex];
      } else {
        return false;   // nie znamy tego klucza — nie mamy czym sprawdzić
      }
      var key = await sub.importKey('raw', raw, curve, false, ['verify']);
      var ok = await sub.verify(algo, key, unb64(sigB64), new TextEncoder().encode(String(text)));
      verifying[cacheKey] = !!ok;
      return !!ok;
    } catch (e) {
      verifying[cacheKey] = false;
      return false;
    }
  }

  /* Znane klucze publiczne: keyId -> raw bytes. Uczą się z podpisanych ramek (TOFU). */
  var publicKeys = {};

  function learnKey(keyHex, rawBytes) {
    if (!keyHex || !rawBytes) return;
    publicKeys[keyHex] = rawBytes;
  }

  /* Zaufanie przy pierwszym kontakcie: pierwszy klucz danego nadawcy wygrywa. */
  function pin(nodeId, keyHex) {
    if (!nodeId || !keyHex) return { ok: false, reason: 'brak danych' };
    var known = pins[nodeId];
    if (!known) {
      pins[nodeId] = keyHex;
      savePins();
      stats.pinned++;
      return { ok: true, first: true };
    }
    if (known === keyHex) return { ok: true, first: false };
    stats.rejected++;
    return { ok: false, reason: 'klucz nadawcy się zmienił — możliwe podszywanie się' };
  }

  function pinnedKey(nodeId) { return pins[nodeId] || null; }

  function state() {
    return {
      ready: ready(), keyId: keyId(),
      pins: Object.keys(pins).length,
      signed: stats.signed, verified: stats.verified,
      rejected: stats.rejected, unsigned: stats.unsigned
    };
  }

  function noteVerified() { stats.verified++; }
  function noteUnsigned() { stats.unsigned++; }
  function noteRejected() { stats.rejected++; }

  var api = {
    init: init,
    ready: ready,
    keyId: keyId,
    publicKeyRaw: publicKeyRaw,
    sign: sign,
    verify: verify,
    learnKey: learnKey,
    pin: pin,
    pinnedKey: pinnedKey,
    state: state,
    noteVerified: noteVerified,
    noteUnsigned: noteUnsigned,
    noteRejected: noteRejected,
    b64: b64,
    unb64: unb64
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_SIGN = api;
})(typeof window !== 'undefined' ? window : globalThis);
