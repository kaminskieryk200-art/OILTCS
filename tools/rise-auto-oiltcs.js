/* Rises — automatyczny OILTCS w czacie (bez menu, bez przycisków).
 *
 * Zasada działania: moduł podsłuchuje wysyłkę wiadomości w czacie
 * (`POST .../rest/v1/messages`). Gdy sieć zawiedzie, ta sama wiadomość leci
 * automatycznie kanałem dźwiękowym (tarcza częstotliwości) do drugiego telefonu.
 * Klucz do drugiego telefonu jest wyprowadzany z identyfikatorów obu kont, więc
 * nikt nic nie wpisuje i nic nie klika — oba telefony liczą ten sam klucz.
 *
 * Nasłuch działa tylko wtedy, gdy aplikacja jest widoczna, i pracuje cyklicznie
 * (6 s nasłuchu, 6 s przerwy), żeby nie zjadać baterii.
 *
 * UCZCIWIE O BEZPIECZEŃSTWIE: klucz zależy wyłącznie od identyfikatorów kont,
 * więc zna go każdy, kto zna oba identyfikatory (a te są w bazie). To chroni
 * przed przypadkowym podsłuchem w autobusie, ale nie przed kimś, kto ma dostęp
 * do bazy. Prawdziwym hasłem użytkownika można to zastąpić, wpisując je raz
 * w polu „Hasło OILTCS” — wtedy klucz zależy od hasła, nie od identyfikatorów.
 */
(function () {
  if (window.RISE_AUTO_OILTCS) return;

  var STORE_KEY = 'rise-oiltcs-v1';
  var MAX_QUEUE = 30;
  var LISTEN_ON_MS = 6000;
  var LISTEN_OFF_MS = 6000;
  var MAX_HOPS = 2;
  // DŹWIĘK WYŁĄCZONY: był zbyt głośny i wprowadzał pętle. Włączany tylko
  // świadomie: localStorage['rise-sound-enabled'] = '1'.
  function soundEnabled() {
    var ls = storage();
    return !!(ls && ls.getItem('rise-sound-enabled') === '1');
  }

  var CARRY_KEY = 'rise-carrier-v1';
  var carrier = null;      // uzupełniane w boot()
  var carrierTimer = null;

  var STATE = 'rise-node-v1';          // znacznik tego telefonu
  var OWN = 'rise-own-ids';
  var ownIds = {};                      // identyfikatory wiadomości wysłanych z tego telefonu

  var state = {
    queue: [],
    sending: false,                     // trwa nadawanie — nie nasłuchujemy
    busy: false,
    listening: false,
    stopListen: null,
    timer: null,
    lastKey: null,
    sent: 0,
    received: 0
  };

  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function load() {
    var ls = storage();
    if (!ls) return;
    try { ownIds = JSON.parse(ls.getItem(OWN) || '{}'); } catch (e) { ownIds = {}; }
    try {
      var raw = JSON.parse(ls.getItem(STORE_KEY) || '{}');
      state.queue = Array.isArray(raw.queue) ? raw.queue : [];
      state.lastKey = raw.key || null;
    } catch (e) {}
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(STORE_KEY, JSON.stringify({ queue: state.queue.slice(-MAX_QUEUE), key: state.lastKey })); } catch (e) {}
    try { ls.setItem(OWN, JSON.stringify(ownIds)); } catch (e) {}
  }

  /* --- klucz: z identyfikatorów obu kont albo z hasła użytkownika --- */
  async function derivePassphrase(a, b, userPass) {
    var ids = [String(a || ''), String(b || '')].sort().join('|');
    if (userPass) return 'u:' + userPass;
    var data = new TextEncoder().encode('rise-oiltcs|' + ids);
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    var out = '';
    for (var i = 0; i < 16; i++) out += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
    return out;
  }

  /* --- pasek stanu: jedna linijka, znika sama --- */
  var bar = null;
  function status(text, sticky) {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147482000;' +
        'background:rgba(17,24,39,.96);color:#e5e7eb;border:1px solid #374151;border-radius:12px;' +
        'padding:10px 14px;font-size:.82rem;line-height:1.35;box-shadow:0 8px 24px rgba(0,0,0,.4);' +
        'font-family:system-ui,sans-serif;pointer-events:none';
      document.body.appendChild(bar);
    }
    bar.textContent = text;
    bar.style.display = 'block';
    if (bar.timer) clearTimeout(bar.timer);
    if (!sticky) bar.timer = setTimeout(function () { if (bar) bar.style.display = 'none'; }, 4000);
  }


  /* --- STOP: jedna mała kropka na brzegu ekranu, znika po 20 s ciszy.
   * Bez niej nie dało się przerwać nadawania bez restartu aplikacji. --- */
  var stopDot = null;
  var stopHideTimer = null;
  var activeSound = null;      // {ctx, src, stream, proc}

  function showStop() {
    if (!document.body) return;
    if (!stopDot) {
      stopDot = document.createElement('div');
      stopDot.textContent = 'STOP';
      stopDot.style.cssText = 'position:fixed;right:6px;top:50%;transform:translateY(-50%);z-index:2147483000;' +
        'background:rgba(153,27,27,.94);color:#fff;border:1px solid #fca5a5;border-radius:999px;' +
        'padding:8px 10px;font-size:.62rem;font-weight:800;letter-spacing:.06em;font-family:system-ui,sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.4);user-select:none;cursor:pointer';
      stopDot.onclick = function () { stopEverything(); };
      document.body.appendChild(stopDot);
    }
    stopDot.style.display = 'block';
    if (stopHideTimer) clearTimeout(stopHideTimer);
    stopHideTimer = setTimeout(function () { if (stopDot) stopDot.style.display = 'none'; }, 25000);
  }

  function hideStop() {
    if (stopHideTimer) clearTimeout(stopHideTimer);
    if (stopDot) stopDot.style.display = 'none';
  }

  /* Zatrzymuje wszystko: nadawanie, nasłuch, nosiciela i połączenie. */
  function stopEverything() {
    try {
      state.queue = [];
      save();
      if (activeSound) {
        if (activeSound.src) { try { activeSound.src.stop(); } catch (e) {} }
        if (activeSound.proc) { try { activeSound.proc.onaudioprocess = null; } catch (e) {} }
        if (activeSound.stream) activeSound.stream.getTracks().forEach(function (t) { t.stop(); });
        if (activeSound.ctx) { try { activeSound.ctx.close(); } catch (e) {} }
        activeSound = null;
      }
      if (state.stopListen) state.stopListen();
      if (carrierTimer) { clearInterval(carrierTimer); carrierTimer = null; }
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      if (window.RISE_VISUAL_XFER && window.RISE_VISUAL_XFER.endCall) window.RISE_VISUAL_XFER.endCall();
      state.busy = false; state.sending = false; state.listening = false;
      hideStop();
      status('Zatrzymane. Wznawiam za chwilę od nowa.', false);
      setTimeout(function () { bootCarrier(); scheduleListening(); }, 3000);
    } catch (e) {
      status('Błąd zatrzymywania: ' + (e && e.message ? e.message : e), false);
    }
  }

  /* --- wysyłka: ta sama wiadomość drugi raz, tym razem dźwiękiem --- */
  async function transmitOverSound(item) {
    var S = window.RISE_SOUND_XFER;
    if (!S) return false;
    if (!soundEnabled()) return false;      // domyślnie nie nadajemy dźwiękiem
    var pass = item.key || state.lastKey;
    if (!pass) return false;
    var msgId = item.id || (String(item.from || '') + '|' + String(item.at || '') + '|' + String(item.text || '').slice(0, 32));
    ownIds[msgId] = Date.now();
    // porządek w znacznikach: trzymamy tylko ostatnie 60
    var keys = Object.keys(ownIds);
    if (keys.length > 60) keys.sort(function (a, b) { return ownIds[a] - ownIds[b]; }).slice(0, keys.length - 60).forEach(function (k) { delete ownIds[k]; });
    save();
    var packet = S.packMessage(JSON.stringify({ t: 'chat', to: item.to, from: item.from, x: item.text, id: msgId }), item.hops || 0);
    var blob = await S.encrypt(packet, pass);
    if (blob.length > S.maxPayload) {
      // Nie mieści się w dźwięku — pokazujemy kody QR sami, bez pytania.
      if (window.RISE_VISUAL_XFER && window.RISE_VISUAL_XFER.showQRFor) {
        status('Za długa na dźwięk — pokazuję kody QR do odczytania kamerą.', false);
        window.RISE_VISUAL_XFER.showQRFor(item.text, pass);
        return true;   // pozycja zużyta, ale obsłużona
      }
      status('Wiadomość za długa dla kanału dźwiękowego (' + blob.length + ' B).', false);
      return false;
    }
    var pcm = S.encodeShield(blob);
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { if (ctx.state === 'suspended') await ctx.resume(); } catch (e) {}
    var buf;
    if (Math.abs(ctx.sampleRate - S.SAMPLE_RATE) < 1) {
      buf = ctx.createBuffer(1, pcm.length, S.SAMPLE_RATE);
      buf.copyToChannel(pcm, 0);
    } else {
      var alt = S.resampleTo(pcm, S.SAMPLE_RATE, ctx.sampleRate);
      buf = ctx.createBuffer(1, alt.length, ctx.sampleRate);
      buf.copyToChannel(alt, 0);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    activeSound = { ctx: ctx, src: src };
    showStop();
    status('Bez internetu — nadaję wiadomość dźwiękiem… (' + (pcm.length / S.SAMPLE_RATE).toFixed(1) + ' s). STOP = przerwij.', true);
    await new Promise(function (res) { src.onended = res; src.start(); });
    activeSound = null;
    try { ctx.close(); } catch (e) {}
    return true;
  }

  async function drain() {
    if (state.busy || !state.queue.length) return;
    state.busy = true;
    state.sending = true;
    try {
      while (state.queue.length) {
        var item = state.queue[0];
        if (Date.now() > (item.expires || 0)) { state.queue.shift(); save(); continue; }
        // najpierw radio: cicho, w milisekundach, bez internetu
        if (await tryBluetooth(item.to || '', item.text)) {
          state.queue.shift();
          state.sent++;
          save();
          continue;
        }
        var ok = await transmitOverSound(item);
        if (!ok) {
          // dźwięk wyłączony: pokaż kody QR zamiast piszczeć
          if (window.RISE_VISUAL_XFER && window.RISE_VISUAL_XFER.showQRFor && state.lastKey) {
            window.RISE_VISUAL_XFER.showQRFor(item.text, state.lastKey);
            status('Pokazuję kody QR — bez dźwięku.', false);
            state.queue.shift();
            save();
            continue;
          }
          break;
        }
        state.queue.shift();
        state.sent++;
        save();
        await new Promise(function (r) { setTimeout(r, 1200); });
      }
      if (!state.queue.length) status('Wysłane dźwiękiem.', false);
    } catch (e) {
      status('Błąd nadawania dźwiękiem — ' + (e && e.message ? e.message : e), false);
    } finally {
      state.busy = false;
      state.sending = false;
      // po zakończeniu nadawania od razu wracamy do nasłuchu
      setTimeout(function () { if (!state.listening) listenOnce(); }, 1500);
    }
  }

  /* --- odbiór: cykliczny nasłuch, gdy aplikacja jest widoczna --- */
  async function listenOnce() {
    var S = window.RISE_SOUND_XFER;
    if (!S || state.listening || state.sending) return;   // nie słuchamy, gdy nadajemy
    if (!soundEnabled()) return;                          // domyślnie cisza
    if (document.visibilityState !== 'visible') return;
    var pass = state.lastKey;
    if (!pass) return;
    state.listening = true;
    var ctx, stream, src, proc, chunks = [], total = 0, handled = false, lastTry = 0;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
      src = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(4096, 1, 1);
      var rate = ctx.sampleRate;
      var MAX = Math.round(rate * 12);

      proc.onaudioprocess = function (ev) {
        var d = ev.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(d));
        total += d.length;
        var now = Date.now();
        if (handled || now - lastTry < 900 || total < rate * 0.5) return;
        lastTry = now;
        var all = new Float32Array(total);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
        var got = S.decodeAny(all, rate);
        if (!got) return;
        handled = true;
        S.decrypt(got.bytes, pass).then(function (plain) {
          var msg = S.unpackMessage(plain);
          var obj = null;
          try { obj = JSON.parse(msg.text); } catch (e) {}
          if (!obj) return;
          if (obj.id && ownIds[obj.id]) return;      // to moja własna wiadomość
          var V = window.RISE_VISUAL_XFER;

          if (obj.t === 'call-offer') {
            // ktoś dzwoni: dzwonek i automatyczne odebranie bez klikania
            status('Połączenie przychodzi — zestawiam…', false);
            if (V && V.acceptCall) V.acceptCall(obj).then(function () {
              status('Połączono (głos).', false);
            }).catch(function (e) {
              status('Nie udało się odebrać: ' + (e && e.message ? e.message : e), false);
            });
            return;
          }
          if (obj.t === 'call-answer') {
            if (V && V.applyCallAnswer) V.applyCallAnswer(obj).then(function () {
              status('Połączono (głos).', false);
            }).catch(function () {});
            return;
          }
          if (obj.t !== 'chat') return;
          state.received++;
          status('Odebrano dźwiękiem od rozmówcy: „' + String(obj.x).slice(0, 80) + '”', false);
          // jestem stacją: ładuję sygnał do pełna i puszczam dalej
          if (station && window.RISE_MESH_RELAY) {
            var wejscie = window.RISE_MESH_RELAY.createEnvelope(String(obj.x), {
              from: obj.from || null, to: obj.to || null, ttl: window.RISE_STATIONS.FULL_CHARGE
            });
            wejscie.id = obj.id || wejscie.id;
            if (station.accept(wejscie)) {
              var naladowana = station.charge(wejscie);
              station.markRelayed(wejscie.id);
              // jeśli to już do mnie — koniec trasy
              if (naladowana.to && naladowana.to !== stateNodeId()) {
                relayToNextStation(naladowana.body, naladowana.from, naladowana.to, avoidAddress || f.via);
              } else {
                station.markDelivered();
              }
            }
          }
          // niosę ją dalej — może dojść dalej niż mój zasięg
          if (carrier && window.RISE_MESH_RELAY) {
            var env = window.RISE_MESH_RELAY.createEnvelope(String(obj.x), {
              from: obj.from || null, to: obj.to || null, ttl: window.RISE_MESH_RELAY.MAX_TTL - 2
            });
            env.hops = (msg.hops || 0);
            if (carrier.add(env)) saveCarrier();
          }
        }).catch(function () { handled = false; });
        if (total >= MAX) { chunks = []; total = 0; handled = false; }
      };

      var mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      activeSound = { ctx: ctx, stream: stream, proc: proc };
      showStop();

      state.stopListen = function () {
        proc.onaudioprocess = null;
        try { proc.disconnect(); src.disconnect(); } catch (e) {}
        stream.getTracks().forEach(function (t) { t.stop(); });
        try { ctx.close(); } catch (e) {}
        state.listening = false;
        state.stopListen = null;
      };
      setTimeout(function () { if (state.stopListen) state.stopListen(); }, LISTEN_ON_MS);
    } catch (e) {
      state.listening = false;
      try { if (ctx) ctx.close(); } catch (e2) {}
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    }
  }

    /* Automatyczne odbieranie kodów QR: gdy ktoś w pobliżu pokazuje kod,
   * druga strona ma się sama zapytać o zgodę na kamerę. Pytamy raz na sesję,
   * żeby nie zamęczać użytkownika okienkami. */
  function askOnceForCamera() {
    var ls = storage();
    if (!ls) return;
    if (ls.getItem('rise-oiltcs-qr-asked') === '1') return;
    ls.setItem('rise-oiltcs-qr-asked', '1');
    if (!window.RISE_VISUAL_XFER || !window.RISE_VISUAL_XFER.receiveQRNow) return;
    status('W pobliżu może być wiadomość pokazywana jako kod QR.', false);
  }

  /* --- nosiciel: telefon niesie odebrane wiadomości i rozgłasza je dalej --- */
  /* --- stacje: odebrana wiadomość jest „ładowana do pełna” i idzie dalej --- */
  var station = null;
  var registry = null;

  function bootStations() {
    if (!window.RISE_STATIONS) return;
    station = window.RISE_STATIONS.createStation(stateNodeId());
    registry = window.RISE_STATIONS.createRegistry();
    var ls = storage();
    if (ls) {
      try {
        var saved = JSON.parse(ls.getItem('rise-stations') || '[]');
        saved.forEach(function (st) { registry.add(st); });
      } catch (e) {}
    }
  }

  function stateNodeId() {
    var ls = storage();
    var id = ls && ls.getItem('rise-node-id');
    if (!id) {
      id = 'node-' + Math.random().toString(36).slice(2, 10);
      if (ls) { try { ls.setItem('rise-node-id', id); } catch (e) {} }
    }
    return id;
  }

  function addStation(id, address) {
    if (!registry) return;
    registry.add({ id: id, address: address, transport: 'bt', lastSeen: Date.now() });
    var ls = storage();
    if (ls) { try { ls.setItem('rise-stations', JSON.stringify(registry.all())); } catch (e) {} }
  }

  /* --- ramka na drucie: R1|od|do|skoków|treść (bez pionów w treści) --- */
  function packFrameSigned(from, to, hops, body, via, keyB64, sig) {
    var moj = via || (window.RISE_BT && window.RISE_BT.myAddress ? window.RISE_BT.myAddress() : '');
    return 'R2|' + String(from || '').replace(/\|/g, '/') + '|' +
      String(to || '').replace(/\|/g, '/') + '|' + (hops || 0) + '|' +
      String(moj || '') + '|' + String(keyB64 || '') + '|' + String(sig || '') + '|' + String(body || '');
  }

  /* Ramka R2: R2|od|do|skoki|via|klucz|podpis|treść (6 pierwszych pól pozycyjnych). */
  function unpackFrame2(text) {
    var parts = String(text || '').split('|');
    if (parts.length < 8) return null;
    return {
      body: parts.slice(7).join('|'), from: parts[1] || null, to: parts[2] || null,
      hops: parseInt(parts[3], 10) || 0, via: parts[4] || '',
      key: parts[5] || '', sig: parts[6] || '', signed: true
    };
  }

  function packFrame(from, to, hops, body, via) {
    var moj = via || (window.RISE_BT && window.RISE_BT.myAddress ? window.RISE_BT.myAddress() : '');
    return 'R1|' + String(from || '').replace(/\|/g, '/') + '|' +
      String(to || '').replace(/\|/g, '/') + '|' + (hops || 0) + '|' +
      String(moj || '') + '|' + String(body || '');
  }

  /* Ramki wysłane z tego telefonu — gdy wrócą, nie robimy z nich pętli. */
  var sentFrames = {};
  function rememberFrame(frame) {
    sentFrames[frame] = Date.now();
    var keys = Object.keys(sentFrames);
    if (keys.length > 80) {
      keys.sort(function (a, b) { return sentFrames[a] - sentFrames[b]; })
        .slice(0, keys.length - 80)
        .forEach(function (k) { delete sentFrames[k]; });
    }
  }

  function unpackFrame(text) {
    var s = String(text || '');
    if (s.indexOf('R1|') !== 0) return { body: s, from: null, to: null, hops: 0 };
    var parts = s.split('|');
    return {
      body: parts.slice(5).join('|'), from: parts[1] || null, to: parts[2] || null,
      hops: parseInt(parts[3], 10) || 0, via: parts[4] || ''
    };
  }

  /* Odebrana wiadomość z radia (Bluetooth). Woła to warstwa Epicentrum.
   * Każdy telefon jest stacją: przyjmuje, ładuje do pełna i puszcza dalej. */
  async function handleRadioText(text, avoidAddress) {
    var s = String(text || '');
    if (s.indexOf('R2|') === 0) {
      var f2 = unpackFrame2(s);
      if (!f2) return false;
      var sprawdz = await verifySigned(f2);
      if (!sprawdz.ok) { status('Odrzucone: ' + sprawdz.reason, true); return false; }
      return przyjmij(f2, avoidAddress, s);
    }
    var f0 = unpackFrame(s);
    if (f0 && window.RISE_SIGN && window.RISE_SIGN.noteUnsigned) window.RISE_SIGN.noteUnsigned();
    return przyjmij(f0, avoidAddress, s, true);
  }

  /* Sprawdza podpis: klucz z ramki, podpis nad treścią, przypięcie do nadawcy. */
  async function verifySigned(f) {
    var S = window.RISE_SIGN;
    if (!S || !S.verify) return { ok: false, reason: 'brak modułu podpisów' };
    if (!f.key || !f.sig) return { ok: false, reason: 'brak podpisu' };
    try {
      var raw = S.unb64 ? S.unb64(f.key) : null;
      if (!raw) return { ok: false, reason: 'zły klucz' };
      S.learnKey(f.key, raw);
      var payload = [String(f.from || ''), String(f.to || ''), String(f.hops || 0), String(f.via || ''), String(f.body || '')].join('\u0001');
      var ok = await S.verify(f.key, payload, f.sig);
      if (!ok) { S.noteRejected(); return { ok: false, reason: 'podpis nie zgadza się' }; }
      // potwierdzona tożsamość (skan QR) jest mocniejsza niż przypięcie „na wiarę"
      var V = window.RISE_VERIFY;
      if (V && V.checkSender) {
        var chk = V.checkSender(f.from, f.key);
        if (chk.known && !chk.verified) {
          S.noteRejected();
          return { ok: false, reason: 'tożsamość nie zgadza się z potwierdzoną (skan QR)' };
        }
      }
      var pin = S.pin(f.from, f.key);
      if (!pin.ok) { return { ok: false, reason: pin.reason }; }
      S.noteVerified();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'błąd weryfikacji' };
    }
  }

  function przyjmij(f, avoidAddress, rawText, unsigned) {
    if (!f || !f.body) return false;

    // poręczenie tożsamości — obsługujemy je jak wiadomość, ale nie pokazujemy w skrzynce
    if (String(f.body).indexOf('V1|') === 0 && window.RISE_VERIFY && window.RISE_VERIFY.acceptVouch) {
      window.RISE_VERIFY.acceptVouch(f.body).then(function (r) {
        if (r && r.ok) {
          status('Poręczenie przyjęte: ' + r.target + ' (poręczył ' + r.by + ')', true);
          if (window.RISE_VERIFY.state) save();
        }
      }).catch(function () {});
      return true;
    }
    if (!f.body) return false;
    if (sentFrames[String(rawText)]) return false;   // moja własna ramka wróciła — stop
    if (f.from && f.from === stateNodeId()) return false;
    state.received++;
    var env = window.RISE_MESH_RELAY ? window.RISE_MESH_RELAY.createEnvelope(f.body, {
      from: f.from, to: f.to, ttl: window.RISE_STATIONS ? window.RISE_STATIONS.FULL_CHARGE : 16
    }) : null;

    var moje = !f.to || f.to === stateNodeId();
    if (station && env) {
      if (!station.accept(env)) {
        status('Ta wiadomość już tu była — nie puszczam jej w kółko.', false);
        return false;
      }
      var naladowana = station.charge(env);
      if (!moje) {
        station.markRelayed(env.id);
        relayToNextStation(naladowana.body, naladowana.from, naladowana.to, avoidAddress || f.via);
      } else {
        station.markDelivered();
        dostarcz(naladowana.body, naladowana.from);
      }
      return true;
    }
    if (moje) dostarcz(f.body, f.from);
    return moje;
  }

  /* Wiadomość, która jest dla mnie: pokazujemy ją aplikacji i zapisujemy. */
  var inbox = [];
  function dostarcz(body, from) {
    var zaufanie = null;
    var V = window.RISE_VERIFY;
    if (V && V.trustOf && from) {
      var s = window.RISE_SIGN;
      var k = s && s.pinnedKey ? s.pinnedKey(from) : null;
      try { zaufanie = V.trustOf(from, k); } catch (e) { zaufanie = null; }
    }
    var wpis = { from: from || null, text: String(body), at: Date.now(), trust: zaufanie ? zaufanie.level : 'nieznany' };
    inbox.push(wpis);
    if (inbox.length > 200) inbox.shift();
    status('Wiadomość doszła bez internetu: „' + String(body).slice(0, 70) + '”', true);
    try {
      if (window.dispatchEvent && typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new window.CustomEvent('rise-mesh-message', { detail: wpis }));
      }
    } catch (e) {}
    var E = window.RISE_EPICENTER;
    if (E && E.didRelay) { /* licznik odbioru prowadzi Epicentrum */ }
    save();
  }

  function startStation() {
    if (!station) bootStations();
    if (window.RISE_BT && window.RISE_BT.listen) { try { window.RISE_BT.listen(); } catch (e) {} }
    return !!station;
  }

  function stopStation() {
    if (window.RISE_BT && window.RISE_BT.stopListening) { try { window.RISE_BT.stopListening(); } catch (e) {} }
    return true;
  }

  /* Podpisuje ramkę i dopiero wtedy ją wysyła. Bez klucza wysyła niepodpisaną
   * (starsze wersje ją przyjmą), ale licznik pokaże, że jest niepodpisana. */
  async function signFrame(from, to, hops, body, via) {
    var S = window.RISE_SIGN;
    if (!S || !S.init) return packFrame(from, to, hops, body, via);
    var ok = await S.init();
    if (!ok) return packFrame(from, to, hops, body, via);
    var moj = via || (window.RISE_BT && window.RISE_BT.myAddress ? window.RISE_BT.myAddress() : '');
    var payload = [String(from || ''), String(to || ''), String(hops || 0), String(moj || ''), String(body || '')].join('\u0001');
    var podpis = await S.sign(payload);
    if (!podpis) return packFrame(from, to, hops, body, via);
    var sub = window.crypto && window.crypto.subtle;
    var keyB64 = '';
    try {
      // klucz publiczny jedzie w ramce, żeby odbiorca miał czym sprawdzić podpis
      var rawKey = await S.publicKeyRaw();
      keyB64 = rawKey || '';
    } catch (e) { keyB64 = ''; }
    return packFrameSigned(from, to, hops, body, via, keyB64, podpis.sig);
  }

  /* Przekazanie dalej: najpierw do znanej stacji po Bluetooth, potem kolejka. */
  async function relayToNextStation(text, from, to, avoidAddress) {
    var R = window.RISE_MESH_RELAY;
    if (!R) return false;
    var frame = await signFrame(from, to, (R.MAX_TTL || 16), text, null);

    // 1) BLE: najbliższy obcy telefon z Rises — bez parowania, bez pytania
    var B = window.RISE_BLE;
    if (B && B.state && B.state() === 'gra') {
      var bliski = B.best(avoidAddress);
      if (bliski) {
        try {
          rememberFrame(frame);
          if (B.send(bliski.mac, frame)) {
            status('Przekazane dalej (' + (bliski.rssi || '?') + ' dBm) — bez parowania.', false);
            if (window.RISE_EPICENTER && window.RISE_EPICENTER.didRelay) window.RISE_EPICENTER.didRelay();
            return true;
          }
        } catch (e) {}
      }
    }

    var next = registry ? registry.best(stateNodeId(), avoidAddress) : null;
    if (next && next.address && window.RISE_BT) {
      try {
        var frame = await signFrame(from, to, (R.MAX_TTL || 16), text, null);
        rememberFrame(frame);
        if (window.RISE_BT.sendText(next.address, frame)) {
          status('Przekazane do stacji ' + next.id + ' — sygnał naładowany do pełna.', false);
          if (window.RISE_EPICENTER && window.RISE_EPICENTER.didRelay) window.RISE_EPICENTER.didRelay();
          return true;
        }
      } catch (e) {}
    }
    // brak stacji pod ręką: wiadomość czeka w kolejce i pojedzie, gdy stacja się pojawi
    enqueue({ from: from, to: to, text: text, hops: 1, key: state.lastKey });
    drain();
    return false;
  }

  function bootCarrier() {
    if (!window.RISE_MESH_RELAY) return;
    carrier = window.RISE_MESH_RELAY.createCarrier();
    var ls = storage();
    if (ls) {
      try {
        var saved = JSON.parse(ls.getItem(CARRY_KEY) || '[]');
        saved.forEach(function (it) {
          if (it && it.env) {
            carrier.add(it.env);
            var added = carrier.items().filter(function (x) { return x.env.id === it.env.id; })[0];
            if (added) { added.firstSeen = it.firstSeen || added.firstSeen; added.sends = it.sends || 0; added.lastSent = it.lastSent || 0; }
          }
        });
      } catch (e) {}
    }
    if (carrierTimer) clearInterval(carrierTimer);
    // sprawdzamy co minutę, ale realnie rozgłaszamy coraz rzadziej (5 min → 60 min)
    carrierTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (!carrier) return;
      var due = carrier.due();
      if (!due.length) return;
      due.forEach(function (it) {
        enqueue({
          from: it.env.from, to: it.env.to, text: it.env.body,
          hops: it.env.hops + 1, key: state.lastKey
        });
        carrier.markSent(it);
      });
      saveCarrier();
      drain();
      status('Niosę ' + carrier.stats().carried + ' wiadomość(i) dalej — rozgłaszam.', false);
    }, 60000);
  }

  function saveCarrier() {
    if (!carrier) return;
    var ls = storage();
    if (!ls) return;
    try {
      ls.setItem(CARRY_KEY, JSON.stringify(carrier.items().map(function (it) {
        return { env: it.env, firstSeen: it.firstSeen, sends: it.sends, lastSent: it.lastSent };
      })));
    } catch (e) {}
  }

  function scheduleListening() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (state.listening) return;
      listenOnce();
    }, LISTEN_ON_MS + LISTEN_OFF_MS);
    listenOnce();
  }

  /* --- podsłuch wysyłki wiadomości w czacie --- */
  function installFetchHook(userPass) {
    if (!window.fetch || window.fetch.__riseHooked) return;
    var original = window.fetch.bind(window);
    var hooked = function (input, init) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var isSend = /\/rest\/v1\/messages(\?|$)/.test(url) && init && String(init.method || 'GET').toUpperCase() === 'POST';
      var body = null;
      if (isSend) {
        try { body = JSON.parse(init.body); } catch (e) { body = null; }
      }
      var promise = original(input, init);
      if (!isSend || !body) return promise;
      return promise.catch(function (err) {
        // sieć zawiodła — najpierw prawdziwe radio Bluetooth (szybkie, ciche)
        if (tryBluetooth(body.receiver_id, body.text)) {
          status('Brak internetu — wysłane przez Bluetooth.', false);
          throw err;
        }
        enqueue({
          from: body.sender_id,
          to: body.receiver_id,
          text: body.text,
          key: state.lastKey
        }).then(function () {
          status('Brak internetu — wysyłam dźwiękiem.', false);
          drain();
        });
        throw err;
      });
    };
    hooked.__riseHooked = true;
    window.fetch = hooked;
    return function () { window.fetch = original; };
  }

  /* Wysyłka przez radio Bluetooth, jeśli znamy adres drugiego telefonu. */
  var peerMacs = {};
  function loadPeerMacs() {
    var ls = storage();
    if (!ls) return;
    try { peerMacs = JSON.parse(ls.getItem('rise-peer-macs') || '{}'); } catch (e) { peerMacs = {}; }
  }
  function setPeerMac(userId, mac) {
    peerMacs[userId] = mac;
    var ls = storage();
    if (ls) { try { ls.setItem('rise-peer-macs', JSON.stringify(peerMacs)); } catch (e) {} }
  }
  async function tryBluetooth(userId, text) {
    if (!window.RISE_BT || !window.RISE_BT.available || !window.RISE_BT.available()) return false;
    var mac = peerMacs[userId];
    if (!mac) return false;
    try {
      var frame = await signFrame(null, null, 0, text, null);
      rememberFrame(frame);
      var ok = window.RISE_BT.sendText(mac, frame);
      if (ok) {
        state.sent++;
        if (window.RISE_EPICENTER && window.RISE_EPICENTER.didSend) window.RISE_EPICENTER.didSend();
      }
      return ok;
    } catch (e) { return false; }
  }

  /* Wypycha kolejkę radiem — cicho i szybko. Zwraca ile wyszło. */
  async function drainRadio() {
    if (!state.queue.length) return 0;
    if (!window.RISE_BT || !window.RISE_BT.enabled || !window.RISE_BT.enabled()) return 0;
    var wyslane = 0;
    for (var i = 0; i < state.queue.length;) {
      var item = state.queue[i];
      if (Date.now() > (item.expires || 0)) { state.queue.splice(i, 1); continue; }
      var poszlo = false;
      var B = window.RISE_BLE;
      if (B && B.state && B.state() === 'gra') {
        var bliski = B.best(null);
        if (bliski) {
          try {
            var frb = await signFrame(item.from, item.to, (window.RISE_MESH_RELAY ? window.RISE_MESH_RELAY.MAX_TTL : 16), item.text, null);
            rememberFrame(frb);
            poszlo = B.send(bliski.mac, frb);
          } catch (e) { poszlo = false; }
        }
      }
      if (!poszlo) poszlo = await tryBluetooth(item.to || '', item.text);
      if (!poszlo) {
        // nie znam adresu odbiorcy — idzie do najlepszej stacji, ona popchnie dalej
        var nastepna = registry ? registry.best(stateNodeId()) : null;
        if (nastepna && nastepna.address && window.RISE_BT) {
          try {
            var fr = await signFrame(item.from, item.to, (window.RISE_MESH_RELAY ? window.RISE_MESH_RELAY.MAX_TTL : 16), item.text, null);
            rememberFrame(fr);
            poszlo = !!window.RISE_BT.sendText(nastepna.address, fr);
          } catch (e) { poszlo = false; }
        }
      }
      if (poszlo) {
        state.queue.splice(i, 1);
        state.sent++;
        wyslane++;
        if (window.RISE_EPICENTER && window.RISE_EPICENTER.didSend) window.RISE_EPICENTER.didSend();
      } else {
        i++;
      }
    }
    if (wyslane) { save(); status('Wysłane radiem bez internetu (' + wyslane + ').', false); }
    return wyslane;
  }

  async function enqueue(item) {
    if (!item.text) return;
    var pass = await derivePassphrase(item.from, item.to, currentUserPass);
    state.lastKey = pass;
    state.queue.push({
      from: item.from, to: item.to, text: String(item.text).slice(0, 2000),
      hops: item.hops || 0, key: pass, at: Date.now(),
      expires: Date.now() + 24 * 60 * 60 * 1000
    });
    if (state.queue.length > MAX_QUEUE) state.queue.shift();
    save();
  }

  var currentUserPass = null;

  /* --- start --- */
  function boot() {
    if (!document.body) { setTimeout(boot, 80); return; }
    load();
    loadPeerMacs();
    if (state.lastKey) currentUserPass = state.lastKey.indexOf('u:') === 0 ? state.lastKey.slice(2) : null;
    installFetchHook();
    bootStations();
    bootCarrier();
    scheduleListening();
  }

  window.RISE_AUTO_OILTCS = {
    boot: boot,
    enqueue: enqueue,
    drain: drain,
    derivePassphrase: derivePassphrase,
    setPassword: function (pass) {
      currentUserPass = pass || null;
      state.lastKey = pass ? 'u:' + pass : null;
      save();
    },
    status: function () {
      return { queued: state.queue.length, sent: state.sent, received: state.received, listening: state.listening, sending: !!state.sending };
    },
    /* Klucz bieżącej rozmowy — używany przez warstwę połączeń głosowych. */
    currentKey: function () { return state.lastKey; },
    carrierStats: function () { return carrier ? carrier.stats() : null; },
    stopEverything: stopEverything,
    bluetoothStatus: function () {
      return {
        available: !!(window.RISE_BT && window.RISE_BT.available && window.RISE_BT.available()),
        enabled: !!(window.RISE_BT && window.RISE_BT.enabled && window.RISE_BT.enabled()),
        myAddress: (window.RISE_BT && window.RISE_BT.myAddress) ? window.RISE_BT.myAddress() : '',
        peers: Object.keys(peerMacs).length
      };
    },
    setPeerMac: setPeerMac,
    handleRadioText: handleRadioText,
    drainRadio: drainRadio,
    relay: relayToNextStation,
    packFrame: packFrame,
    unpackFrame: unpackFrame,
    inbox: function () { return inbox.slice(); },
    startStation: startStation,
    stopStation: stopStation,
    addStation: addStation,
    trustOf: function (node) {
      if (!window.RISE_VERIFY || !window.RISE_VERIFY.trustOf) return null;
      var k = window.RISE_SIGN && window.RISE_SIGN.pinnedKey ? window.RISE_SIGN.pinnedKey(node) : null;
      return window.RISE_VERIFY.trustOf(node, k);
    },
    signState: function () {
      var st = window.RISE_SIGN ? window.RISE_SIGN.state() : null;
      var v = window.RISE_VERIFY ? window.RISE_VERIFY.state() : null;
      if (st && v) st.verifiedPeople = v.verified;
      return st;
    },
    stationState: function () { return station ? station.state() : null; },
    stations: function () { return registry ? registry.all() : []; },
    nodeId: stateNodeId,
    /* Zadzwoń do osoby, z którą ostatnio wymieniano wiadomości. */
    call: function (peerId) {
      if (!window.RISE_VISUAL_XFER || !window.RISE_VISUAL_XFER.autoCall) return Promise.reject(new Error('brak modułu połączeń'));
      return window.RISE_VISUAL_XFER.autoCall(peerId);
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
