/* Rises — znak wodny przypisany do osoby (v3.40.0).
 *
 * Po co: zaszyfrowana wiadomość jest nieczytelna dla postronnych, ale jeśli
 * odbiorca ją komuś pokaże, nie ma śladu, od kogo pochodzi. Znak wodny to
 * rozwiązuje: każda wiadomość nosi niewidoczny podpis powiązany z konkretną
 * parą osób — i tylko z nią.
 *
 * Co jest w znaku:
 *  - numer seryjny koperty (żeby rozpoznać tę jedną wiadomość),
 *  - odcisk odbiorcy (żeby znak nie pasował do nikogo innego),
 *  - odcisk nadawcy,
 *  - numer kolejny wiadomości w tej rozmowie.
 *
 * Gdzie siedzi: wewnątrz zaszyfrowanej treści, na końcu, jako niewidoczna
 * sekcja. Nie zmienia tego, co widzi człowiek — po odszyfrowaniu jest usuwana
 * przed pokazaniem tekstu.
 *
 * Czego to nie robi: nie śledzi odbiorcy i nie dzwoni do domu. Znak jest
 * liczony lokalnie z danych, które już są w wiadomości. Jeśli odbiorca
 * rozpowszechni tekst, ten sam znak da się policzyć u niego — i tylko tam.
 */
(function (root) {
  var OPEN = '\u2063\u2063';      // separator: niewidoczny, ale odtwarzalny
  var CLOSE = '\u2063\u2064';
  var PREFIX = 'WM1';

  function bytesToHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return s;
  }

  async function digest(text) {
    var sub = root.crypto && root.crypto.subtle;
    if (!sub) return '0';
    var buf = await sub.digest('SHA-256', new TextEncoder().encode(String(text)));
    return bytesToHex(new Uint8Array(buf).slice(0, 8));
  }

  /* Odcisk osoby: 8 bajtów z identyfikatora i klucza. Nie da się go odwrócić. */
  async function personTag(node, keyB64) {
    return digest('osoba|' + String(node || '') + '|' + String(keyB64 || ''));
  }

  /* Znak wodny: seria|odbiorca|nadawca|numer */
  async function markFor(opts) {
    var o = opts || {};
    var toTag = await personTag(o.toNode, o.toKey);
    var fromTag = await personTag(o.fromNode, o.fromKey);
    var serial = (o.serial || '');
    var seq = (o.seq === undefined || o.seq === null) ? '' : String(o.seq);
    return PREFIX + '|' + serial + '|' + toTag + '|' + fromTag + '|' + seq;
  }

  /* Wkłada znak do tekstu — na końcu, w niewidocznych znakach. */
  async function stamp(text, opts) {
    var mark = await markFor(opts);
    return String(text) + OPEN + mark + CLOSE;
  }

  /* Wyciąga znak i zwraca czysty tekst + dane znaku. */
  function read(text) {
    var s = String(text || '');
    var a = s.indexOf(OPEN);
    if (a < 0) return { text: s, mark: null, clean: true };
    var b = s.indexOf(CLOSE, a + OPEN.length);
    if (b < 0) return { text: s, mark: null, clean: true };
    var mark = s.slice(a + OPEN.length, b);
    var clean = s.slice(0, a) + s.slice(b + CLOSE.length);
    var parts = mark.split('|');
    if (parts[0] !== PREFIX) return { text: clean, mark: null, clean: false };
    return {
      text: clean,
      mark: {
        serial: parts[1] || '',
        toTag: parts[2] || '',
        fromTag: parts[3] || '',
        seq: parts[4] || ''
      },
      clean: true
    };
  }

  /* Czy znak pasuje do tej osoby i tego nadawcy? Zwraca {ok, reason}. */
  async function check(text, opts) {
    var r = read(text);
    if (!r.mark) return { ok: false, reason: 'brak znaku wodnego' };
    var o = opts || {};
    var toTag = await personTag(o.toNode, o.toKey);
    var fromTag = await personTag(o.fromNode, o.fromKey);
    if (r.mark.toTag !== toTag) return { ok: false, reason: 'znak należy do innego odbiorcy' };
    if (r.mark.fromTag !== fromTag) return { ok: false, reason: 'znak należy do innego nadawcy' };
    return { ok: true, mark: r.mark };
  }

  var api = {
    markFor: markFor,
    stamp: stamp,
    read: read,
    check: check,
    personTag: personTag,
    OPEN: OPEN,
    CLOSE: CLOSE
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_MARK = api;
})(typeof window !== 'undefined' ? window : globalThis);
