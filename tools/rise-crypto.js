/* Rises — szyfrowanie bez hasła (v3.40.0).
 *
 * Zasada: użytkownik NIGDY nie wpisuje hasła do wiadomości. Klucz bierze się
 * z tożsamości: każdy telefon ma parę kluczy do uzgadniania (ECDH P-256),
 * a wiadomość jest szyfrowana kluczem, który zna tylko nadawca i odbiorca.
 *
 * Jak to działa (bez wchodzenia w matematykę):
 *  1. Każdy telefon ma swój klucz publiczny do szyfrowania (obok klucza do podpisów).
 *  2. Nadawca bierze klucz publiczny odbiorcy (z kodu QR, poręczenia albo z jego
 *     pierwszej wiadomości) i liczy z nim wspólny sekret — ten sam, który odbiorca
 *     policzy ze swoim kluczem prywatnym.
 *  3. Z tego sekretu powstaje klucz AES-256-GCM. Wiadomość jest nim szyfrowana.
 *  4. Odbiorca odszyfrowuje automatycznie, bo ma swój klucz prywatny.
 *
 * Efekt: wiadomość jest nieczytelna dla każdego innego telefonu, także dla
 * przekaźników, przez które przechodzi. Nikt nic nie wpisuje.
 *
 * Czego to NIE robi: nie chroni przed kimś, kto ma odblokowany Twój telefon.
 * Klucz prywatny leży w pamięci aplikacji — tak samo jak klucz do podpisów.
 */
(function (root) {
  var STORE = 'rise-pubkey-v1';        // nasza para do szyfrowania
  var PEERS = 'rise-enckeys-v1';       // klucze publiczne znajomych: nodeId -> base64
  var curve = { name: 'ECDH', namedCurve: 'P-256' };

  var me = null;                       // { privateKey, publicKey, raw, ready }
  var peers = {};
  var stats = { sealed: 0, opened: 0, failed: 0, noKey: 0 };

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
    return root.btoa ? root.btoa(s) : Buffer.from(s, 'binary').toString('base64');
  }

  function unb64(str) {
    var bin = root.atob ? root.atob(str) : Buffer.from(str, 'base64').toString('binary');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function loadPeers() {
    var ls = storage();
    if (!ls) return;
    try { peers = JSON.parse(ls.getItem(PEERS) || '{}') || {}; } catch (e) { peers = {}; }
  }

  function savePeers() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(PEERS, JSON.stringify(peers)); } catch (e) {}
  }

  /* Nasza para kluczy do szyfrowania. Tworzona raz i trzymana w pamięci aplikacji. */
  async function init() {
    if (me && me.ready) return true;
    var sub = cryptoApi();
    if (!sub) return false;
    loadPeers();

    var ls = storage();
    var saved = null;
    try { saved = JSON.parse((ls && ls.getItem(STORE)) || 'null'); } catch (e) { saved = null; }

    try {
      if (saved && saved.privateJwk && saved.publicJwk) {
        me = {
          privateKey: await sub.importKey('jwk', saved.privateJwk, curve, false, ['deriveBits']),
          publicKey: await sub.importKey('jwk', saved.publicJwk, curve, true, []),
          ready: true
        };
      } else {
        var pair = await sub.generateKey(curve, true, ['deriveBits']);
        var priv = await sub.exportKey('jwk', pair.privateKey);
        var pub = await sub.exportKey('jwk', pair.publicKey);
        me = { privateKey: pair.privateKey, publicKey: pair.publicKey, ready: true };
        if (ls) { try { ls.setItem(STORE, JSON.stringify({ privateJwk: priv, publicJwk: pub })); } catch (e) {} }
      }
      me.raw = b64(await sub.exportKey('raw', me.publicKey));
      return true;
    } catch (e) {
      me = null;
      return false;
    }
  }

  function ready() { return !!(me && me.ready); }
  function myKey() { return (me && me.raw) || ''; }

  /* Zapisuje klucz publiczny znajomego (z QR, poręczenia albo z jego wiadomości). */
  function learnPeer(node, keyB64) {
    if (!node || !keyB64) return false;
    if (peers[node] && peers[node] !== keyB64) return false;   // nie podmieniamy po cichu
    if (!peers[node]) { peers[node] = keyB64; savePeers(); }
    return true;
  }

  function peerKey(node) { return peers[node] || null; }

  /* Wspólny sekret + klucz AES. Ten sam wynik u nadawcy i odbiorcy. */
  async function deriveKey(myPriv, theirPubRaw) {
    var sub = cryptoApi();
    if (!sub) return null;
    var theirKey = await sub.importKey('raw', theirPubRaw, curve, false, []);
    var shared = await sub.deriveBits({ name: 'ECDH', public: theirKey }, myPriv, 256);
    var hkdfBase = await sub.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return sub.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info: new TextEncoder().encode('rise-msg-v1') },
      hkdfBase,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* Szyfruje wiadomość dla konkretnej osoby. Zwraca "RSX1:<iv>:<dane>" albo null. */
  async function sealFor(node, text) {
    if (!ready() && !(await init())) return null;
    var theirKey = peerKey(node);
    if (!theirKey) { stats.noKey++; return null; }
    var sub = cryptoApi();
    if (!sub) return null;
    try {
      var key = await deriveKey(me.privateKey, unb64(theirKey));
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      var ct = await sub.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(text)));
      stats.sealed++;
      return 'RSX1:' + b64(iv) + ':' + b64(ct);
    } catch (e) {
      stats.failed++;
      return null;
    }
  }

  /* Odszyfrowuje wiadomość od konkretnej osoby. Zwraca tekst albo null. */
  async function openFrom(node, blob) {
    if (!ready() && !(await init())) return null;
    if (String(blob || '').indexOf('RSX1:') !== 0) return null;
    var theirKey = peerKey(node);
    if (!theirKey) { stats.noKey++; return null; }
    var sub = cryptoApi();
    if (!sub) return null;
    try {
      var parts = String(blob).split(':');
      var iv = unb64(parts[1]);
      var ct = unb64(parts[2]);
      var key = await deriveKey(me.privateKey, unb64(theirKey));
      var plain = await sub.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      stats.opened++;
      return new TextDecoder().decode(plain);
    } catch (e) {
      stats.failed++;
      return null;
    }
  }

  function isSealed(text) { return String(text || '').indexOf('RSX1:') === 0; }

  function state() {
    return {
      ready: ready(),
      myKey: myKey() ? myKey().slice(0, 12) + '…' : '',
      peers: Object.keys(peers).length,
      sealed: stats.sealed, opened: stats.opened,
      failed: stats.failed, noKey: stats.noKey
    };
  }

  var api = {
    init: init,
    ready: ready,
    myKey: myKey,
    learnPeer: learnPeer,
    peerKey: peerKey,
    sealFor: sealFor,
    openFrom: openFrom,
    isSealed: isSealed,
    state: state,
    b64: b64,
    unb64: unb64
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_CRYPTO = api;
})(typeof window !== 'undefined' ? window : globalThis);
