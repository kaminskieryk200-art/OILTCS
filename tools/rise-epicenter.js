/* Rises — Epicentrum sieci (v3.35.0).
 *
 * Zasady, których ten moduł pilnuje:
 *  1. ZERO przycisków do sieci. Nie ma czego włączać — sieć jest częścią aplikacji.
 *  2. ZERO przełącznika w głównym widoku. Wyłączenie jest schowane na ekranie
 *     Opcji (tam, gdzie „Blokada PIN" / „Status konta"), z ostrzeżeniem, że to
 *     service pack aplikacji. Wcześniejsza wersja klikała po tekście
 *     „Zaawansowane" — takiego ekranu w aplikacji nie ma, więc sekcja nigdy
 *     się nie pojawiała. Teraz wstawiamy ją do istniejącego ekranu Opcji.
 *  3. BLE + klasyczne radio: telefon sam ogłasza się obcym urządzeniom z Rises
 *     (bez parowania) i sam je słyszy. Gdy BLE nie ma, zostaje radio klasyczne.
 *  4. Wskaźnik pojawia się TYLKO wtedy, gdy sieć naprawdę działa. Cisza = OK.
 *
 * Uczciwie: wyłączony Bluetooth = brak anteny. Aplikacja sama prosi o zgodę
 * i sama pokazuje systemowe okno włączenia radia, więc użytkownik nie musi
 * nic wiedzieć. Wiadomości napisane w tym czasie czekają i wychodzą same.
 */
(function (root) {
  var STORE = 'rise-epicenter-v2';
  var OFF_KEY = 'rise-mesh-off';          // '1' = użytkownik wyłączył service pack
  var POLL_MS = 2000;

  var state = {
    on: false,
    relayed: 0,
    received: 0,
    sent: 0,
    near: 0,
    ble: 'brak',
    station: true,
    since: 0
  };

  var timer = null;
  var ui = null;
  var busy = false;       // zabezpieczenie: tick nie wchodzi sam w siebie
  var starting = false;

  function storage() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function meshEnabled() {
    var ls = storage();
    if (!ls) return true;
    try { return ls.getItem(OFF_KEY) !== '1'; } catch (e) { return true; }
  }

  function load() {
    var ls = storage();
    if (!ls) return;
    try {
      var raw = JSON.parse(ls.getItem(STORE) || 'null');
      if (raw && typeof raw === 'object') {
        state.relayed = raw.relayed || 0;
        state.received = raw.received || 0;
        state.sent = raw.sent || 0;
        state.since = raw.since || 0;
      }
    } catch (e) {}
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try {
      ls.setItem(STORE, JSON.stringify({
        relayed: state.relayed, received: state.received, sent: state.sent, since: state.since
      }));
    } catch (e) {}
  }

  function BLE() { return root.RISE_BLE; }
  function BT() { return root.RISE_BT; }

  /* --- start sieci: bez pytania, bez przycisku --- */
  function start() {
    if (!meshEnabled()) { paint(); return false; }
    if (starting) return state.on;               // nie wchodzimy rekurencyjnie
    starting = true;
    try { return startNow(); } finally { starting = false; }
  }

  function startNow() {

    var ble = BLE();
    if (ble && ble.has && ble.has()) {
      state.ble = ble.state();
      if (state.ble === 'off' && ble.ensureOn) { ble.ensureOn(); }
      if (state.ble === 'zgoda' && ble.askPermissions) { ble.askPermissions(); }
      if (!ble.isRunning || !ble.isRunning()) ble.start(nodeId());
    }

    var bt = BT();
    if (bt && bt.available && bt.available()) {
      if (!bt.enabled()) { if (bt.ensureOn) bt.ensureOn(); }
      else {
        if (bt.hasConnect && !bt.hasConnect() && bt.askPermissions) bt.askPermissions();
        if (bt.isListening && !bt.isListening()) bt.listen();
      }
    }

    state.on = !!(ble && ble.isRunning && ble.isRunning()) ||
      !!(bt && bt.isListening && bt.isListening());
    if (state.on && !state.since) state.since = Date.now();
    if (timer) clearInterval(timer);
    timer = setInterval(function () { tick(); }, POLL_MS);
    return state.on;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    var ble = BLE();
    if (ble && ble.stop) { try { ble.stop(); } catch (e) {} }
    var bt = BT();
    if (bt && bt.stopListening) { try { bt.stopListening(); } catch (e) {} }
    state.on = false;
    paint();
  }

  function nodeId() {
    var O = root.RISE_AUTO_OILTCS;
    if (O && O.nodeId) { try { return O.nodeId(); } catch (e) {} }
    return 'node';
  }

  /* Jedna runda: zabierz to, co usłyszało radio i BLE, oddaj warstwie OILTCS. */
  async function tick() {
    if (!meshEnabled()) return;
    if (busy) return;
    busy = true;
    try { await tickNow(); } finally { busy = false; }
  }

  async function tickNow() {
    var O = root.RISE_AUTO_OILTCS;
    var odebrane = 0;

    var ble = BLE();
    if (ble && ble.poll) {
      var przezBle = ble.poll() || [];
      for (var i = 0; i < przezBle.length; i++) {
        var t = przezBle[i];
        if (!t) continue;
        odebrane++;
        state.received++;
        if (O && O.handleRadioText) {
          try { await O.handleRadioText(t, null); } catch (e) {}
        }
      }
      state.near = (ble.nearCount && ble.nearCount()) || 0;
      state.ble = ble.state ? ble.state() : 'brak';
    }

    var bt = BT();
    if (bt && bt.pollText) {
      var przezRadio = bt.pollText() || [];
      for (var k = 0; k < przezRadio.length; k++) {
        if (!przezRadio[k]) continue;
        odebrane++;
        state.received++;
        if (O && O.handleRadioText) {
          try { await O.handleRadioText(przezRadio[k], null); } catch (e) {}
        }
      }
      var sparowane = bt.paired ? (bt.paired() || []).length : 0;
      if (!state.near) state.near = sparowane;
    }

    // radio wstało (albo użytkownik zgodził się w okienku) — wznawiamy sami
    if (!state.on && !starting) {
      state.on = !!(ble && ble.isRunning && ble.isRunning()) ||
        !!(bt && bt.isListening && bt.isListening());
    }

    // kolejka czeka tylko na radio — gdy jest, wychodzi sama
    if (state.on && O && O.drainRadio) { try { await O.drainRadio(); } catch (e) {} }

    if (odebrane) { save(); }
    paint();
  }

  function didRelay() { state.relayed++; save(); paint(); }
  function didSend() { state.sent++; save(); paint(); }

  /* --- wyłączenie service packu: tylko z Zaawansowanych, z ostrzeżeniem --- */
  function setMeshEnabled(on) {
    var ls = storage();
    if (ls) { try { ls.setItem(OFF_KEY, on ? '0' : '1'); } catch (e) {} }
    if (on) start(); else stop();
    paint();
    return !!on;
  }

  function warningText() {
    return 'To jest service pack aplikacji. Jeśli go wyłączysz, Rises może przestać działać poprawnie: ' +
      'nie wyślesz ani nie odbierzesz wiadomości offline, nie wykonasz połączeń bez internetu, ' +
      'a wiadomości wysłane bez zasięgu nie dojdą do nikogo. Włącz z powrotem, gdy chcesz mieć łączność.';
  }

  /* --- wygląd: nic nie ma, dopóki sieć nie działa --- */
  function el(tag, style, text) {
    var d = root.document.createElement(tag);
    if (style) d.style.cssText = style;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function mount() {
    if (!root.document || !root.document.body) return;
    if (ui && ui.chip && ui.chip.parentNode) return;

    var chip = el('div',
      'position:fixed;left:10px;bottom:10px;z-index:2147483000;display:none;align-items:center;gap:6px;' +
      'padding:5px 9px;border-radius:999px;background:rgba(12,14,18,0.72);color:#cfe9d9;' +
      'font:600 10.5px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'box-shadow:0 3px 10px rgba(0,0,0,0.28);backdrop-filter:blur(6px);' +
      'border:1px solid rgba(120,255,180,0.16);user-select:none;pointer-events:none;opacity:0.9;');

    var dot = el('span', 'width:6px;height:6px;border-radius:50%;background:#39d98a;box-shadow:0 0 6px #39d98a;flex:0 0 auto;');
    var label = el('span', 'white-space:nowrap;', '');

    chip.appendChild(dot);
    chip.appendChild(label);

    root.document.body.appendChild(chip);
    ui = { chip: chip, label: label, dot: dot };
    paint();
  }

  function paint() {
    if (!ui) return;
    var on = state.on && meshEnabled() && state.near > 0;
    if (!on) { ui.chip.style.display = 'none'; return; }
    ui.chip.style.display = 'flex';
    var n = state.near;
    ui.label.textContent = 'SIEĆ · ' + n + (n === 1 ? ' telefon' : (n < 5 ? ' telefony' : ' telefonów'));
  }

  /* --- Wyłączenie service packu: tam, gdzie są ustawienia aplikacji --- */
  function buildSettingsCard() {
    var card = el('div',
      'margin:16px 12px;padding:14px;border-radius:14px;background:rgba(255,255,255,0.55);' +
      'border:1px solid rgba(0,0,0,0.08);font:400 13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#14202b;');

    card.appendChild(el('div', 'font-weight:700;font-size:14px;margin-bottom:4px;', 'Service pack łączności'));
    card.appendChild(el('div', 'color:#5a6b78;font-size:12px;margin-bottom:10px;',
      'Część aplikacji, działa automatycznie. Nie ma tego w głównym widoku, bo nie wymaga żadnej decyzji.'));

    var row = el('div', 'display:flex;align-items:center;gap:12px;padding:8px 0;');
    row.appendChild(el('div', 'flex:1 1 auto;font-weight:600;', 'Łączność offline (service pack)'));
    var sw = el('div', 'width:46px;height:27px;border-radius:999px;position:relative;cursor:pointer;transition:background .18s;');
    var knob = el('div', 'position:absolute;top:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:left .18s;box-shadow:0 1px 3px rgba(0,0,0,.3);');
    sw.appendChild(knob);
    var on = meshEnabled();
    function draw(v) {
      sw.style.background = v ? '#1f9d63' : 'rgba(0,0,0,0.22)';
      knob.style.left = v ? '22px' : '3px';
    }
    draw(on);
    row.appendChild(sw);

    var warn = el('div',
      'margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(224,163,58,0.16);' +
      'color:#8a5a00;font-size:12px;line-height:1.45;display:none;', warningText());

    sw.onclick = function () {
      on = !on;
      draw(on);
      warn.style.display = on ? 'none' : 'block';
      setMeshEnabled(on);
    };
    if (!on) warn.style.display = 'block';

    card.appendChild(row);
    card.appendChild(warn);
    return card;
  }

  /* Szukamy ekranu ustawień po treści (etykiety aplikacji są po polsku). */
  function findSettingsHost() {
    var doc = root.document;
    if (!doc) return null;
    var nodes = doc.querySelectorAll('div,section,main');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var t = (n.textContent || '');
      if (t.length > 4000) continue;
      if (t.indexOf('Blokada PIN') >= 0 || t.indexOf('Status konta') >= 0) return n;
    }
    return null;
  }

  function installSettingsSection() {
    var doc = root.document;
    if (!doc || !doc.body) return false;
    if (doc.getElementById('rise-service-pack')) return true;
    var host = findSettingsHost();
    if (!host) return false;
    var card = buildSettingsCard();
    card.id = 'rise-service-pack';
    host.parentNode.insertBefore(card, host.nextSibling);
    return true;
  }

  function flash(msg) {
    if (!ui || !ui.chip) return;
    ui.chip.style.display = 'flex';
    ui.label.textContent = msg;
    setTimeout(paint, 3000);
  }

  function inviteText() {
    var bt = BT();
    var addr = (bt && bt.myAddress) ? bt.myAddress() : '';
    var out = 'Piszemy bez internetu i bez zasięgu. Zainstaluj Rises — telefony w pobliżu same przekazują wiadomości dalej.';
    if (addr) out += ' Moje radio: ' + addr;
    return out;
  }

  function boot() {
    load();
    mount();
    start();
    installSettingsSection();

    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'visible') start();
      });
    }
    // dopóki coś nie gra (zgoda, radio, uprawnienia), próbujemy co 2 s — bez pytań
    setInterval(function () { if (meshEnabled() && !state.on) start(); }, 2000);
    setInterval(function () { tick(); }, 2000);
    // sekcja ma się pojawić przy pierwszym wejściu w Opcje, bez czekania
    var proby = 0;
    var iv = setInterval(function () {
      proby++;
      var ok = installSettingsSection();
      if (ok || proby > 60) clearInterval(iv);
    }, 1000);
  }

  root.RISE_EPICENTER = {
    boot: boot,
    start: start,
    stop: stop,
    tick: tick,
    meshEnabled: meshEnabled,
    setMeshEnabled: setMeshEnabled,
    warningText: warningText,
    installSettingsSection: installSettingsSection,
    inviteText: inviteText,
    didRelay: didRelay,
    didSend: didSend,
    stats: function () {
      return {
        on: state.on, ble: state.ble, near: state.near,
        received: state.received, relayed: state.relayed, sent: state.sent,
        enabled: meshEnabled(), since: state.since
      };
    }
  };

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
