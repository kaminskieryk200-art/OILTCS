/* Rises — czaty offline (v3.41.0).
 *
 * Problem: lista czatów przychodzi z serwera. Bez internetu jest pusta —
 * nie ma gdzie dotknąć, żeby napisać, nawet jeśli sieć lokalna działa.
 *
 * Rozwiązanie: rozmowy trzymamy na telefonie, w całości.
 *  - każda wysłana i odebrana wiadomość ląduje lokalnie,
 *  - lista czatów działa bez serwera i bez internetu,
 *  - „nowa rozmowa" pozwala wybrać osobę, którą telefon już zna
 *    (potwierdzoną, poręczoną, sparowaną albo usłyszaną przez radio),
 *  - wysyłka idzie tą samą drogą co reszta: BLE, klasyczne radio, kolejka.
 *
 * Nic nie znika, gdy internet pada — bo nic z tego nie przyszło z internetu.
 */
(function (root) {
  var THREADS = 'rise-local-threads-v1';
  var CACHE = 'rise-cached-chats-v1';
  var MAX_PER_THREAD = 300;
  var MAX_THREADS = 120;

  var threads = {};
  var cached = [];
  var ui = null;

  function storage() {
    try { return root.localStorage; } catch (e) { return null; }
  }

  function load() {
    var ls = storage();
    if (!ls) return;
    try { threads = JSON.parse(ls.getItem(THREADS) || '{}') || {}; } catch (e) { threads = {}; }
    try { cached = JSON.parse(ls.getItem(CACHE) || '[]') || []; } catch (e) { cached = []; }
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try {
      var keys = Object.keys(threads);
      if (keys.length > MAX_THREADS) {
        keys.sort(function (a, b) { return (threads[b].at || 0) - (threads[a].at || 0); });
        keys.slice(MAX_THREADS).forEach(function (k) { delete threads[k]; });
      }
      ls.setItem(THREADS, JSON.stringify(threads));
    } catch (e) {}
  }

  function ensureThread(node, label) {
    if (!node) return null;
    if (!threads[node]) threads[node] = { node: node, label: label || short(node), msgs: [], at: Date.now() };
    if (label) threads[node].label = label;
    return threads[node];
  }

  function short(node) {
    var s = String(node || '');
    return s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
  }

  /* Zapisuje wiadomość w rozmowie. me=true znaczy „wysłana przeze mnie". */
  function put(node, text, me, status, label) {
    var t = ensureThread(node, label);
    if (!t) return null;
    t.msgs.push({ me: !!me, text: String(text), at: Date.now(), status: status || '' });
    if (t.msgs.length > MAX_PER_THREAD) t.msgs = t.msgs.slice(-MAX_PER_THREAD);
    t.at = Date.now();
    save();
    return t;
  }

  function list() {
    return Object.keys(threads)
      .map(function (k) { return threads[k]; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  function get(node) { return threads[node] || null; }

  function isOffline() {
    try {
      if (root.navigator && root.navigator.onLine === false) return true;
    } catch (e) {}
    return false;
  }

  /* --- wysyłka: ta sama droga, którą idą wiadomości --- */
  async function send(node, text, label) {
    if (!node || !text) return { ok: false, reason: 'brak odbiorcy' };
    put(node, text, true, 'wysyłam', label);

    var O = root.RISE_AUTO_OILTCS;
    var poszlo = false;
    if (O) {
      try {
        var me = O.nodeId ? O.nodeId() : 'node';
        if (O.relay) poszlo = await O.relay(me, node, text);
      } catch (e) { poszlo = false; }
    }
    var t = threads[node];
    if (t && t.msgs.length) t.msgs[t.msgs.length - 1].status = poszlo ? 'wysłane' : 'czeka na zasięg';
    save();
    return { ok: true, sent: poszlo };
  }

  /* --- osoby, do których można napisać bez internetu --- */
  function knownPeople() {
    var out = [];
    var seen = {};

    function add(node, label, how) {
      if (!node || seen[node]) return;
      seen[node] = true;
      out.push({ node: node, label: label || short(node), how: how });
    }

    var V = root.RISE_VERIFY;
    if (V && V.list) {
      V.list().forEach(function (p) { add(p.node, p.label, 'potwierdzony'); });
    }
    if (V && V.vouchList) {
      V.vouchList().forEach(function (p) { add(p.node, p.label, 'poręczony przez ' + p.by); });
    }
    list().forEach(function (t) { add(t.node, t.label, 'rozmowa'); });

    var B = root.RISE_BLE;
    if (B && B.peers) {
      try {
        (B.peers() || []).forEach(function (p) { add(p.mac, 'telefon w pobliżu', 'widziany'); });
      } catch (e) {}
    }
    var BT = root.RISE_BT;
    if (BT && BT.paired) {
      try {
        (BT.paired() || []).forEach(function (p) { add(p.address, p.name, 'sparowany'); });
      } catch (e) {}
    }
    return out;
  }

  /* --- wygląd --- */
  function el(tag, style, text) {
    var d = root.document.createElement(tag);
    if (style) d.style.cssText = style;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function sheet(title, onClose) {
    var wrap = el('div',
      'position:fixed;inset:0;background:#0b0f14;color:#e6edf5;z-index:2147483500;' +
      'display:flex;flex-direction:column;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
    var head = el('div',
      'display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #1e2733;');
    var back = el('button',
      'background:#1f2a37;color:#e6edf5;border:1px solid #31415a;border-radius:10px;padding:8px 12px;' +
      'font-size:.85rem;cursor:pointer;', 'Wróć');
    back.onclick = function () { wrap.remove(); if (onClose) onClose(); };
    head.appendChild(back);
    head.appendChild(el('div', 'font-weight:700;font-size:1rem;flex:1 1 auto;', title));
    wrap.appendChild(head);
    root.document.body.appendChild(wrap);
    return wrap;
  }

  function fmt(ts) {
    try {
      var d = new Date(ts);
      var dzis = new Date();
      if (d.toDateString() === dzis.toDateString()) {
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      }
      return d.toLocaleDateString('pl-PL');
    } catch (e) { return ''; }
  }

  /* Lista rozmów — działa bez internetu, bo wszystko jest na telefonie. */
  function showList() {
    if (!root.document || !root.document.body) return false;
    var wrap = sheet('Czaty (offline)');
    var body = el('div', 'flex:1 1 auto;overflow:auto;padding:8px 0;');
    wrap.appendChild(body);

    var rows = list();
    if (!rows.length) {
      body.appendChild(el('div', 'padding:18px 16px;color:#8fa39a;font-size:.9rem;line-height:1.5;',
        'Nie ma tu jeszcze żadnej rozmowy. Dotknij „Nowa rozmowa" i wybierz osobę — ' +
        'telefon wyśle wiadomość siecią lokalną, bez internetu.'));
    }

    rows.forEach(function (t) {
      var r = el('div',
        'display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #161e28;cursor:pointer;');
      var av = el('div',
        'width:42px;height:42px;border-radius:50%;background:#243040;color:#cfe9d9;display:flex;' +
        'align-items:center;justify-content:center;font-weight:700;flex:0 0 auto;',
        (t.label || '?').slice(0, 1).toUpperCase());
      var mid = el('div', 'flex:1 1 auto;min-width:0;');
      mid.appendChild(el('div', 'font-weight:600;font-size:.95rem;', t.label || short(t.node)));
      var last = t.msgs.length ? t.msgs[t.msgs.length - 1] : null;
      mid.appendChild(el('div', 'color:#8fa39a;font-size:.82rem;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;', last ? ((last.me ? 'Ty: ' : '') + last.text) : 'brak wiadomości'));
      var right = el('div', 'color:#6f837c;font-size:.72rem;text-align:right;', fmt(t.at));
      r.appendChild(av);
      r.appendChild(mid);
      r.appendChild(right);
      r.onclick = function () { wrap.remove(); showThread(t.node, t.label); };
      body.appendChild(r);
    });

    var nowa = el('button',
      'position:sticky;bottom:0;margin:14px 16px;padding:14px;border-radius:14px;border:0;' +
      'background:#1f9d63;color:#fff;font-weight:700;font-size:.95rem;cursor:pointer;', 'Nowa rozmowa');
    nowa.onclick = function () { wrap.remove(); showPicker(); };
    wrap.appendChild(nowa);
    return true;
  }

  /* Wybór osoby: tylko ci, których telefon zna. */
  function showPicker() {
    var wrap = sheet('Do kogo chcesz napisać?');
    var body = el('div', 'flex:1 1 auto;overflow:auto;');
    wrap.appendChild(body);

    var people = knownPeople();
    if (!people.length) {
      body.appendChild(el('div', 'padding:18px 16px;color:#8fa39a;font-size:.9rem;line-height:1.5;',
        'Telefon nie zna jeszcze nikogo. Sparuj drugi telefon raz (albo zeskanuj kod QR) — ' +
        'potem ta osoba będzie tutaj na zawsze, także bez internetu.'));
    }

    people.forEach(function (p) {
      var r = el('div', 'padding:14px 16px;border-bottom:1px solid #161e28;cursor:pointer;');
      r.appendChild(el('div', 'font-weight:600;font-size:.95rem;', p.label || short(p.node)));
      r.appendChild(el('div', 'color:#8fa39a;font-size:.78rem;margin-top:2px;', p.how + ' · ' + short(p.node)));
      r.onclick = function () { wrap.remove(); showThread(p.node, p.label); };
      body.appendChild(r);
    });
    return true;
  }

  /* Rozmowa: historia lokalna + pisanie. */
  function showThread(node, label) {
    var t = ensureThread(node, label);
    var wrap = sheet(t.label || short(node), function () { save(); });
    var body = el('div', 'flex:1 1 auto;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;');
    wrap.appendChild(body);

    function draw() {
      while (body.firstChild) body.removeChild(body.firstChild);
      var msgs = (threads[node] || { msgs: [] }).msgs;
      if (!msgs.length) {
        body.appendChild(el('div', 'color:#8fa39a;font-size:.85rem;text-align:center;margin-top:20px;',
          'Pierwsza wiadomość w tej rozmowie.'));
      }
      msgs.forEach(function (m) {
        var b = el('div',
          'max-width:78%;padding:9px 12px;border-radius:14px;font-size:.9rem;line-height:1.35;' +
          (m.me
            ? 'align-self:flex-end;background:#1f9d63;color:#fff;'
            : 'align-self:flex-start;background:#1f2a37;color:#e6edf5;'),
          m.text);
        body.appendChild(b);
        if (m.me && m.status) {
          body.appendChild(el('div', 'align-self:flex-end;color:#6f837c;font-size:.68rem;',
            m.status + ' · ' + fmt(m.at)));
        }
      });
      try { body.scrollTop = body.scrollHeight; } catch (e) {}
    }
    draw();

    var bar = el('div', 'display:flex;gap:8px;padding:10px 12px;border-top:1px solid #1e2733;');
    var input = el('input',
      'flex:1 1 auto;min-width:0;padding:12px 14px;border-radius:14px;border:1px solid #31415a;' +
      'background:#121821;color:#e6edf5;font-size:.95rem;');
    input.setAttribute('placeholder', 'Napisz wiadomość — wyjdzie bez internetu');
    var sendBtn = el('button',
      'padding:12px 16px;border-radius:14px;border:0;background:#1f9d63;color:#fff;font-weight:700;' +
      'font-size:.9rem;cursor:pointer;', 'Wyślij');
    var busy = false;
    sendBtn.onclick = async function () {
      var text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = '';
      put(node, text, true, 'wysyłam');
      draw();
      try { await send(node, text, t.label); } catch (e) {}
      busy = false;
      draw();
    };
    input.addEventListener('keydown', function (e) {
      if (e && e.key === 'Enter') sendBtn.click();
    });
    bar.appendChild(input);
    bar.appendChild(sendBtn);
    wrap.appendChild(bar);

    // nowa wiadomość w tej rozmowie — odśwież widok
    timeline[node] = draw;
    return true;
  }

  var timeline = {};

  /* --- nasłuch: odebrane wiadomości lądują w rozmowach --- */
  function installIncoming() {
    if (!root.addEventListener) return;
    root.addEventListener('rise-mesh-message', function (ev) {
      var d = ev && ev.detail;
      if (!d || !d.from) return;
      var label = (threads[d.from] && threads[d.from].label) || short(d.from);
      put(d.from, d.text, false, '', label);
      if (timeline[d.from]) { try { timeline[d.from](); } catch (e) {} }
      else if (ui && ui.auto) { try { showList(); ui.auto = false; } catch (e) {} }
    });
  }

  /* --- przycisk „+" przy braku internetu otwiera naszą listę --- */
  function installPlusHook() {
    var doc = root.document;
    if (!doc || !doc.addEventListener) return;
    doc.addEventListener('click', function (ev) {
      if (!isOffline()) return;
      var n = ev.target;
      for (var i = 0; i < 6 && n; i++) {
        var txt = (n.textContent || '').trim();
        if (txt === '+' || txt === '＋') {
          ev.preventDefault();
          ev.stopPropagation();
          showList();
          return;
        }
        n = n.parentNode;
      }
    }, true);
  }

  /* --- automatycznie pokaż lokalne czaty, gdy serwer nic nie dał --- */
  function looksEmpty() {
    var doc = root.document;
    if (!doc || !doc.querySelectorAll) return false;
    var rows = doc.querySelectorAll('div');
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = (rows[i].textContent || '');
      if (t.length > 8 && t.length < 120 && rows[i].children && rows[i].children.length >= 2) count++;
      if (count > 6) return false;
    }
    return count <= 1;
  }

  function maybeAutoShow() {
    if (!isOffline()) return;
    if (!list().length) return;
    if (!looksEmpty()) return;
    ui = ui || {};
    ui.auto = true;
    var btn = el('div',
      'position:fixed;right:12px;bottom:12px;z-index:2147483400;padding:12px 16px;border-radius:999px;' +
      'background:#1f9d63;color:#fff;font:700 13px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.4);' +
      'cursor:pointer;', 'Czaty offline (' + list().length + ')');
    btn.onclick = function () { btn.remove(); showList(); };
    try { root.document.body.appendChild(btn); } catch (e) {}
  }

  function boot() {
    load();
    installIncoming();
    installPlusHook();
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try { maybeAutoShow(); } catch (e) {}
      if (tries > 40) clearInterval(iv);
    }, 1000);
    if (root.addEventListener) {
      root.addEventListener('offline', function () { try { maybeAutoShow(); } catch (e) {} });
    }
  }

  root.RISE_OFFLINE_CHATS = {
    boot: boot,
    list: list,
    get: get,
    put: put,
    send: send,
    showList: showList,
    showPicker: showPicker,
    showThread: showThread,
    knownPeople: knownPeople,
    isOffline: isOffline,
    state: function () {
      return {
        threads: list().length,
        messages: list().reduce(function (n, t) { return n + t.msgs.length; }, 0),
        people: knownPeople().length,
        offline: isOffline()
      };
    }
  };

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
