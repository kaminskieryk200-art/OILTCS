/* Rises — weryfikacja tożsamości (v3.37.0).
 *
 * Po co: podpisy (v3.36.0) odrzucają podmienioną treść i obcy klucz, ALE pierwszy
 * kontakt jest zaufany „na wiarę" (TOFU). Ktoś, kto pierwszy przedstawi się jako
 * Twój znajomy, zostanie przyjęty. To jest dokładnie ten przypadek, w którym
 * potrzebna jest weryfikacja poza siecią.
 *
 * Jak: dwa telefony, które są obok siebie, pokazują sobie kody QR.
 *  - ekran „Pokaż mój kod": QR z identyfikatorem węzła i kluczem publicznym,
 *  - ekran „Sprawdź znajomego": kamera czyta QR, klucz zostaje przypięty na stałe
 *    (już nie „na wiarę", tylko z potwierdzeniem, że byłeś przy tym telefonie).
 *
 * Co to daje: znikają wszystkie wezwania do weryfikacji dla tej osoby. Jeśli
 * później pojawi się wiadomość podpisana innym kluczem — jest odrzucana, bo wiemy,
 * że prawdziwy klucz był inny. To jest jedyne miejsce w całej aplikacji, gdzie
 * tożsamość jest potwierdzona, a nie założona.
 *
 * Czego nie daje: nie zabezpiecza przed kimś, kto ma Twoją odblokowaną aplikację.
 * Nie zastępuje spotkania twarzą w twarz — potwierdza tylko, że ten telefon
 * w Twojej ręce zeskanował tamten telefon w tamtej ręce.
 */
(function (root) {
  var VERIFIED_KEY = 'rise-verified-v1';   // nodeId -> { key, at, label }

  var verified = {};
  var ui = null;
  var scanState = null;

  function storage() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function load() {
    var ls = storage();
    if (!ls) return;
    try { verified = JSON.parse(ls.getItem(VERIFIED_KEY) || '{}') || {}; } catch (e) { verified = {}; }
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(VERIFIED_KEY, JSON.stringify(verified)); } catch (e) {}
  }

  function S() { return root.RISE_SIGN; }
  function O() { return root.RISE_AUTO_OILTCS; }

  function nodeId() {
    var o = O();
    if (o && o.nodeId) { try { return o.nodeId(); } catch (e) {} }
    return 'node';
  }

  /* Zawartość kodu QR: RVS2|<nodeId>|<klucz podpisów>|<klucz szyfrowania> */
  async function myCode() {
    var s = S();
    if (!s) return '';
    if (!s.ready()) { try { await s.init(); } catch (e) {} }
    var key = s.publicKeyRaw ? await s.publicKeyRaw() : '';
    if (!key) return '';
    var C = root.RISE_CRYPTO;
    if (C) { try { if (!C.ready()) await C.init(); } catch (e) {} }
    var encKey = (C && C.myKey) ? C.myKey() : '';
    return 'RVS2|' + nodeId() + '|' + key + '|' + encKey;
  }

  /* Krótki kod do przeczytania przez telefon albo wysłania SMS-em.
   * 12 znaków = 60 bitów: za dużo, żeby ktoś „wygenerował" pasujący klucz,
   * dość krótko, żeby przeczytać przez słuchawkę. */
  var ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // bez 0/O/1/I, żeby się nie myliło

  function base32(bytes, count) {
    var out = '';
    var bits = 0, buf = 0;
    for (var i = 0; i < bytes.length && out.length < count; i++) {
      buf = (buf << 8) | bytes[i];
      bits += 8;
      while (bits >= 5 && out.length < count) {
        out += ALFABET[(buf >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    return out;
  }

  /* Kod bezpieczeństwa: 12 znaków, zawsze w grupach po 4 — ABCDEF-GHJKLM-NPQRST */
  async function fingerprint(node, keyB64) {
    var sub = root.crypto && root.crypto.subtle;
    if (!sub) return '';
    try {
      var raw = keyB64 ? (S() && S().unb64 ? S().unb64(keyB64) : null) : null;
      var material = raw || new TextEncoder().encode(String(keyB64 || ''));
      var digest = await sub.digest('SHA-256', material);
      var bytes = new Uint8Array(digest);
      var code = base32(bytes, 12);
      return code.slice(0, 4) + '-' + code.slice(4, 8) + '-' + code.slice(8, 12);
    } catch (e) { return ''; }
  }

  /* Mój kod bezpieczeństwa — do przeczytania przez telefon. */
  async function myFingerprint() {
    var s = S();
    if (!s) return '';
    if (!s.ready()) { try { await s.init(); } catch (e) {} }
    var key = s.publicKeyRaw ? await s.publicKeyRaw() : '';
    if (!key) return '';
    return fingerprint(nodeId(), key);
  }

  /* Sprawdzenie kodu wpisanego przez użytkownika: kod musi pasować do podanej osoby. */
  async function checkFingerprint(node, keyB64, typed) {
    var want = await fingerprint(node, keyB64);
    var got = String(typed || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var expect = want.replace(/-/g, '');
    if (!expect) return { ok: false, reason: 'nie udało się policzyć kodu' };
    if (got.length !== expect.length) return { ok: false, reason: 'kod ma ' + expect.length + ' znaków' };
    if (got !== expect) return { ok: false, reason: 'kod się nie zgadza — to inny klucz' };
    return { ok: true };
  }

  function parseCode(text) {
    var t = String(text || '').trim();
    var m3 = /^RVS2\|([^|]{1,120})\|([A-Za-z0-9+/=]{20,})\|([A-Za-z0-9+/=]{20,})$/.exec(t);
    if (m3) return { node: m3[1], key: m3[2], encKey: m3[3] };
    var m2 = /^RVS1\|([^|]{1,120})\|([A-Za-z0-9+/=]{20,})$/.exec(t);
    if (m2) return { node: m2[1], key: m2[2], encKey: '' };
    return null;
  }

  /* Zapisuje potwierdzoną tożsamość. Od tej chwili ten klucz jest jedyny słuszny. */
  function confirm(node, keyHex, label, encKey) {
    if (!node || !keyHex) return { ok: false, reason: 'brak danych' };
    if (encKey && root.RISE_CRYPTO && root.RISE_CRYPTO.learnPeer) {
      try { root.RISE_CRYPTO.learnPeer(node, encKey); } catch (e) {}
    }
    var s = S();
    if (s && s.pin) {
      // podmieniamy przypięcie na potwierdzony klucz (nadpisujemy TOFU)
      var before = s.pinnedKey ? s.pinnedKey(node) : null;
      var res = s.pin(node, keyHex);
      if (!res.ok && before && before !== keyHex) {
        // to jest właśnie ten przypadek: mieliśmy inny klucz dla tej osoby
        return { ok: false, reason: 'ta osoba miała już inny klucz — nie nadpisuję bez ostrzeżenia', before: before };
      }
    }
    verified[node] = { key: keyHex, at: Date.now(), label: label || '' };
    save();
    return { ok: true };
  }

  function isVerified(node) { return !!verified[node]; }
  function verifiedKey(node) { return verified[node] ? verified[node].key : null; }
  function list() {
    return Object.keys(verified).map(function (k) {
      return { node: k, key: verified[k].key, at: verified[k].at, label: verified[k].label };
    });
  }

  function remove(node) {
    delete verified[node];
    save();
  }

  /* Czy wiadomość od tego nadawcy jest potwierdzona (klucz się zgadza). */
  function checkSender(node, keyHex) {
    if (!verified[node]) return { verified: false, known: false };
    return { verified: verified[node].key === keyHex, known: true };
  }

  /* --- poręczenia (działa na odległość) ---
   * Skoro nie da się zeskanować kogoś, kto jest 300 km dalej, robi to ktoś,
   * kto go widział: „potwierdzam, że ten klucz należy do tej osoby".
   * Poręczenie jedzie przez sieć jak zwykła wiadomość i jest podpisane. */

  var VOUCH_KEY = 'rise-vouches-v1';     // nodeId -> { key, by, at, hops }
  var vouches = {};

  function loadVouches() {
    var ls = storage();
    if (!ls) return;
    try { vouches = JSON.parse(ls.getItem(VOUCH_KEY) || '{}') || {}; } catch (e) { vouches = {}; }
  }

  function saveVouches() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(VOUCH_KEY, JSON.stringify(vouches)); } catch (e) {}
  }

  /* Treść poręczenia — podpisywana tym samym kluczem co wiadomości. */
  function vouchBody(targetNode, targetKey, targetEncKey) {
    return 'POREKA|' + targetNode + '|' + targetKey + '|' + String(targetEncKey || '');
  }

  async function makeVouch(targetNode, targetKey, hops, targetEncKey) {
    var s = S();
    if (!s) return null;
    if (!s.ready()) { try { await s.init(); } catch (e) {} }
    var body = vouchBody(targetNode, targetKey, targetEncKey);
    var sig = await s.sign(body);
    if (!sig) return null;
    return 'V1|' + nodeId() + '|' + body + '|' + sig.sig + '|' + (hops || 0);
  }

  /* Przyjmuje poręczenie od kogoś, kogo znamy. Zwraca {ok, reason}. */
  async function acceptVouch(text) {
    var parts = String(text || '').split('|');
    if (parts.length < 6 || parts[0] !== 'V1') return { ok: false, reason: 'nie poręczenie' };
    var by = parts[1];
    var body = parts.slice(2, parts.length - 2).join('|');
    var sigB64 = parts[parts.length - 2];
    var hops = parseInt(parts[parts.length - 1], 10) || 0;

    var m = /^POREKA\|([^|]+)\|([A-Za-z0-9+/=]+)(?:\|([A-Za-z0-9+/=]*))?$/.exec(body);
    if (!m) return { ok: false, reason: 'zła treść poręczenia' };
    var targetNode = m[1], targetKey = m[2], targetEnc = m[3] || '';

    // poręczać może tylko ktoś, kogo sami potwierdziliśmy
    if (!verified[by]) return { ok: false, reason: 'poręczyciel nie jest potwierdzony' };

    var s = S();
    if (!s || !s.verify) return { ok: false, reason: 'brak modułu podpisów' };
    var keyOfBy = verified[by].key;
    if (!s.learnKey || !s.verify) return { ok: false, reason: 'brak weryfikacji' };
    s.learnKey(keyOfBy, s.unb64(keyOfBy));
    var ok = await s.verify(keyOfBy, body, sigB64);
    if (!ok) return { ok: false, reason: 'podpis poręczyciela nie pasuje' };

    // nie nadpisujemy potwierdzenia zdobytego osobiście
    if (verified[targetNode] && verified[targetNode].key !== targetKey) {
      return { ok: false, reason: 'ta osoba jest już potwierdzona innym kluczem' };
    }
    if (vouches[targetNode] && vouches[targetNode].key !== targetKey) {
      return { ok: false, reason: 'sprzeczne poręczenia dla tej osoby' };
    }
    if (targetEnc && root.RISE_CRYPTO && root.RISE_CRYPTO.learnPeer) {
      try { root.RISE_CRYPTO.learnPeer(targetNode, targetEnc); } catch (e) {}
    }
    vouches[targetNode] = { key: targetKey, by: by, at: Date.now(), hops: hops };
    saveVouches();
    if (s.pin) s.pin(targetNode, targetKey);
    return { ok: true, target: targetNode, by: by };
  }

  /* Poziom zaufania dla nadawcy wiadomości. */
  function trustOf(node, keyB64) {
    if (verified[node]) {
      return verified[node].key === keyB64
        ? { level: 'potwierdzony', ok: true }
        : { level: 'sprzeczny', ok: false };
    }
    if (vouches[node]) {
      if (vouches[node].key !== keyB64) return { level: 'sprzeczny', ok: false };
      return { level: 'poręczony', ok: true, by: vouches[node].by, hops: vouches[node].hops };
    }
    return { level: 'nieznany', ok: true };
  }

  function vouchList() {
    return Object.keys(vouches).map(function (k) {
      return { node: k, key: vouches[k].key, by: vouches[k].by, at: vouches[k].at, hops: vouches[k].hops };
    });
  }

  /* --- rysowanie i czytanie kodów --- */
  function el(tag, style, text) {
    var d = root.document.createElement(tag);
    if (style) d.style.cssText = style;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function drawQR(canvas, text) {
    if (!root.qrcode) return false;
    var qr = root.qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    var count = qr.getModuleCount();
    var scale = 6;
    canvas.width = canvas.height = count * scale + 32;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(16 + c * scale, 16 + r * scale, scale, scale);
      }
    }
    return true;
  }

  function sheet(title) {
    var wrap = el('div',
      'position:fixed;inset:0;background:#0b0f14;color:#e6edf5;z-index:2147483400;' +
      'display:flex;flex-direction:column;padding:16px;gap:12px;overflow:auto;' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
    var head = el('div', 'display:flex;align-items:center;justify-content:space-between;');
    head.appendChild(el('div', 'font-size:1.05rem;font-weight:700;', title));
    var close = el('button',
      'background:#1f2a37;color:#e6edf5;border:1px solid #31415a;border-radius:10px;' +
      'padding:8px 14px;font-size:.9rem;', 'Zamknij');
    close.onclick = function () {
      if (scanState && scanState.stop) { try { scanState.stop(); } catch (e) {} }
      scanState = null;
      wrap.remove();
    };
    head.appendChild(close);
    wrap.appendChild(head);
    root.document.body.appendChild(wrap);
    return wrap;
  }

  function button(text, primary) {
    return el('button',
      'padding:12px 16px;border-radius:12px;font-size:.95rem;font-weight:600;cursor:pointer;' +
      (primary ? 'background:#1f9d63;color:#fff;border:0;' : 'background:#1f2a37;color:#e6edf5;border:1px solid #31415a;'),
      text);
  }

  /* Ekran „Pokaż mój kod" — do pokazania drugiemu telefonowi. */
  async function showMyCode() {
    if (!root.document || !root.document.body) return false;
    var wrap = sheet('Pokaż mój kod');
    var info = el('div', 'color:#9fb0a8;font-size:.85rem;line-height:1.5;',
      'Niech druga osoba otworzy u siebie „Sprawdź znajomego" i zeskanuje ten kod. ' +
      'Od tej chwili wasze wiadomości są potwierdzone — nikt nie podszyje się pod żadne z was.');
    wrap.appendChild(info);

    var canvas = root.document.createElement('canvas');
    canvas.style.cssText = 'align-self:center;background:#fff;border-radius:14px;padding:0';
    wrap.appendChild(canvas);

    var code = await myCode();
    if (!code) {
      wrap.appendChild(el('div', 'color:#e0a33a;', 'Nie udało się utworzyć klucza w tym telefonie.'));
      return false;
    }
    if (!drawQR(canvas, code)) {
      wrap.appendChild(el('div', 'color:#e0a33a;', 'Brak modułu kodów QR w tej wersji.'));
      return false;
    }
    var idText = el('div', 'align-self:center;color:#8fa39a;font-size:.75rem;',
      'Twój identyfikator: ' + nodeId());
    wrap.appendChild(idText);
    return true;
  }

  /* Ekran „Sprawdź znajomego" — czyta QR drugiego telefonu. */
  function scanFriend() {
    if (!root.document || !root.document.body) return;
    var wrap = sheet('Sprawdź znajomego');
    var info = el('div', 'color:#9fb0a8;font-size:.85rem;line-height:1.5;',
      'Skieruj kamerę na kod QR z telefonu drugiej osoby. Potwierdzasz w ten sposób, ' +
      'że ten telefon jest naprawdę jej — i że nikt nie może się pod nią podszyć.');
    var video = root.document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.style.cssText = 'width:100%;max-height:52vh;background:#000;border-radius:14px;object-fit:cover';
    var status = el('div', 'color:#8fa39a;font-size:.85rem;', 'Uruchamiam kamerę…');

    var stopBtn = button('Przerwij', false);
    wrap.appendChild(info);
    wrap.appendChild(video);
    wrap.appendChild(status);
    wrap.appendChild(stopBtn);

    var stop = function () {
      if (scanState && scanState.stream) {
        scanState.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      }
      if (scanState && scanState.raf && root.cancelAnimationFrame) root.cancelAnimationFrame(scanState.raf);
      scanState = null;
    };
    stopBtn.onclick = function () { stop(); wrap.remove(); };
    scanState = { stop: stop };

    (async function () {
      try {
        var stream = await root.navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
        scanState.stream = stream;
        video.srcObject = stream;
        await video.play();
        status.textContent = 'Szukam kodu…';

        var decode = root.jsQR || (typeof jsQR !== 'undefined' ? jsQR : null);
        if (!decode) { status.textContent = 'Brak dekodera QR w tej wersji.'; return; }

        var canvas = root.document.createElement('canvas');
        var ctx = canvas.getContext('2d', { willReadFrequently: true });

        var tick = function () {
          if (!scanState) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var code = null;
            try { code = decode(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); } catch (e) { code = null; }
            if (code && code.data) {
              var parsed = parseCode(code.data);
              if (parsed) {
                stop();
                var res = confirm(parsed.node, parsed.key, '', parsed.encKey);
                if (res.ok) {
                  status.textContent = 'Potwierdzone: ' + parsed.node + '. Od teraz ta osoba jest zweryfikowana.';
                  var ok = el('div', 'color:#39d98a;font-weight:600;', '✔ Zaufany kontakt');
                  wrap.appendChild(ok);
                } else {
                  status.textContent = 'Uwaga: ' + res.reason;
                }
                return;
              }
            }
          }
          scanState.raf = root.requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        status.textContent = 'Kamera niedostępna: ' + (e && e.message ? e.message : e);
      }
    })();
  }

  /* Sekcja w Opcjach: lista potwierdzonych osób + dwa przyciski. */
  function buildSection() {
    var card = el('div',
      'margin:16px 12px;padding:14px;border-radius:14px;background:rgba(255,255,255,0.55);' +
      'border:1px solid rgba(0,0,0,0.08);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#14202b');
    card.appendChild(el('div', 'font-weight:700;font-size:14px;margin-bottom:4px;', 'Weryfikacja tożsamości'));
    card.appendChild(el('div', 'color:#5a6b78;font-size:12px;margin-bottom:10px;',
      'Zeskanujcie sobie nawzajem kody QR. Wtedy wiadomości są potwierdzone i nikt nie może się pod nikogo podszyć.'));

    var rows = list();
    if (!rows.length) {
      card.appendChild(el('div', 'color:#8a6a2f;font-size:12px;padding:8px 0;',
        'Nie potwierdzono jeszcze nikogo. Dopóki tego nie zrobisz, pierwsza wiadomość od nowej osoby jest przyjmowana na wiarę.'));
    } else {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var line = el('div', 'display:flex;justify-content:space-between;gap:10px;padding:7px 0;' +
          'border-bottom:1px solid rgba(0,0,0,0.07);font-size:13px;');
        line.appendChild(el('span', '', '✔ ' + (r.label || r.node)));
        line.appendChild(el('span', 'color:#5a6b78;font-size:11px;',
          new Date(r.at).toLocaleDateString('pl-PL')));
        card.appendChild(line);
      }
    }

    var kodBox = el('div', 'margin-top:6px;padding:10px 12px;border-radius:10px;background:rgba(31,157,99,0.10);' +
      'font-size:12px;color:#14202b;line-height:1.5;',
      'Daleko? Nie musicie się widzieć. Odczytajcie sobie kod bezpieczeństwa przez telefon albo wyślijcie SMS-em.');
    card.appendChild(kodBox);

    var kodLine = el('div', 'margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:16px;' +
      'font-weight:700;letter-spacing:1px;color:#14202b;', 'Kod: …');
    card.appendChild(kodLine);
    myFingerprint().then(function (code) {
      kodLine.textContent = 'Twój kod: ' + (code || '—');
      kodLine.title = 'Odczytaj ten kod drugiej osobie przez telefon lub wyślij SMS-em.';
    });

    var input = el('input', 'margin-top:8px;width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;' +
      'border:1px solid rgba(0,0,0,0.18);font-size:14px;font-family:ui-monospace,Menlo,monospace;');
    input.setAttribute('placeholder', 'Wpisz kod drugiej osoby (XXXX-XXXX-XXXX)');
    input.setAttribute('autocapitalize', 'characters');
    card.appendChild(input);

    var wynik = el('div', 'margin-top:6px;font-size:12px;color:#5a6b78;', '');
    card.appendChild(wynik);

    var bKod = el('button',
      'margin-top:8px;width:100%;padding:11px 14px;border-radius:12px;background:transparent;' +
      'border:1px solid rgba(0,0,0,0.18);color:#14202b;font-weight:600;font-size:13px;cursor:pointer;',
      'Sprawdź kod od drugiej osoby');
    bKod.onclick = function () {
      wynik.textContent = 'Sprawdzam…';
      var wpisany = input.value;
      // kod sprawdzamy wobec klucza, który znamy z ostatniej wiadomości tej osoby
      var kandydaci = Object.keys(verified).concat(Object.keys(vouches));
      var s = S();
      var proba = null;
      for (var i = 0; i < kandydaci.length; i++) {
        var k = s && s.pinnedKey ? s.pinnedKey(kandydaci[i]) : null;
        if (k) { proba = { node: kandydaci[i], key: k }; break; }
      }
      if (!proba) { wynik.textContent = 'Najpierw musi dojść od niej wiadomość, żeby znać jej klucz.'; return; }
      checkFingerprint(proba.node, proba.key, wpisany).then(function (r) {
        if (r.ok) {
          var conf = confirm(proba.node, proba.key, '');
          wynik.textContent = conf.ok ? '✔ Kod się zgadza — ' + proba.node + ' potwierdzony.' : 'Kod zgodny, ale: ' + conf.reason;
        } else {
          wynik.textContent = '✖ ' + r.reason;
        }
      });
    };
    card.appendChild(bKod);

    var por = vouchList();
    if (por.length) {
      card.appendChild(el('div', 'margin-top:12px;font-weight:600;font-size:12px;', 'Poręczeni przez znajomych:'));
      for (var j = 0; j < por.length; j++) {
        card.appendChild(el('div', 'font-size:12px;color:#5a6b78;padding:3px 0;',
          '• ' + por[j].node + ' — poręczył ' + por[j].by));
      }
    }

    var b1 = el('button',
      'margin-top:12px;width:100%;padding:11px 14px;border-radius:12px;border:0;background:#1f9d63;' +
      'color:#fff;font-weight:600;font-size:13px;cursor:pointer;', 'Pokaż mój kod');
    b1.onclick = function () { showMyCode(); };

    var b2 = el('button',
      'margin-top:8px;width:100%;padding:11px 14px;border-radius:12px;background:transparent;' +
      'border:1px solid rgba(0,0,0,0.18);color:#14202b;font-weight:600;font-size:13px;cursor:pointer;',
      'Sprawdź znajomego (skanuj kod)');
    b2.onclick = function () { scanFriend(); };

    card.appendChild(b1);
    card.appendChild(b2);
    return card;
  }

  /* Wstawia sekcję tam, gdzie jest ekran Opcji aplikacji. */
  function installSection() {
    var doc = root.document;
    if (!doc || !doc.body) return false;
    if (doc.getElementById('rise-verify-section')) return true;

    var host = findOptionsScreen(doc);
    if (!host) return false;

    var card = buildSection();
    card.id = 'rise-verify-section';
    host.parentNode.insertBefore(card, host.nextSibling);
    return true;
  }

  /* Szukamy ekranu Opcji po treści — etykiety w aplikacji są po polsku. */
  function findOptionsScreen(doc) {
    var nodes = doc.querySelectorAll('div,section,main');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = (n.textContent || '');
      if (t.length > 4000) continue;
      if (t.indexOf('Blokada PIN') >= 0 || t.indexOf('Status konta') >= 0) return n;
    }
    return null;
  }

  function boot() {
    load();
    loadVouches();
    if (root.document && root.document.body) {
      installSection();
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (installSection() || tries > 60) clearInterval(iv);
      }, 1000);
    }
  }

  root.RISE_VERIFY = {
    boot: boot,
    /* Poręczenie z kluczem szyfrowania — wygodne wywołanie dla aplikacji. */
    vouchFor: async function (targetNode, targetSignKey, targetEncKey, hops) {
      return makeVouch(targetNode, targetSignKey, hops || 1, targetEncKey || '');
    },
    fingerprint: fingerprint,
    myFingerprint: myFingerprint,
    checkFingerprint: checkFingerprint,
    makeVouch: makeVouch,
    acceptVouch: acceptVouch,
    trustOf: trustOf,
    vouchList: vouchList,
    myCode: myCode,
    parseCode: parseCode,
    confirm: confirm,
    isVerified: isVerified,
    verifiedKey: verifiedKey,
    checkSender: checkSender,
    list: list,
    remove: remove,
    showMyCode: showMyCode,
    scanFriend: scanFriend,
    installSection: installSection,
    state: function () {
      return { verified: Object.keys(verified).length, people: list().map(function (p) { return p.node; }) };
    }
  };

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
