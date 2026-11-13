/* Rises — czaty bez internetu W ŚRODKU zwykłych czatów (v3.42.0).
 *
 * Problem z v3.41.0: czaty offline były osobnym widokiem (własny ekran,
 * pływający przycisk „Czaty offline (N)", przechwytywanie „+"). Efekt: dwa
 * interfejsy do tej samej rzeczy i lista, która nie znała historii z serwera.
 *
 * Tu nie ma żadnego dodatkowego widoku. Moduł wchodzi w istniejące czaty:
 *  - lista rozmów i wyszukiwarka działają z pamięci telefonu, więc bez
 *    internetu nic nie znika,
 *  - dotknięcie rozmowy otwiera ją w tym samym miejscu (na liście), a nie
 *    w nakładce na cały ekran,
 *  - wiadomość napisana bez internetu zostaje w rozmowie ze statusem
 *    „czeka na zasięg", jedzie radiem (OILTCS) i wysyła się z serwera, gdy
 *    zasięg wróci — bez pytania i bez przycisku,
 *  - gdy aplikacja ma otwartą prawdziwą rozmowę, wysyłka idzie jej własnym
 *    polem tekstowym, więc wiadomość jest normalną wiadomością aplikacji.
 *
 * GRANICE: nie znamy wewnętrznego stanu aplikacji, więc chwytamy się tego,
 * co jest na ekranie (lista, wyszukiwarka, pole tekstowe). Klucz do serwera
 * (anon/public) jest publiczny z natury — to nie jest sekret.
 */
(function (root) {
  if (root.RISE_NATIVE_CHAT) return;

  var STORE = 'rise-oiltcs-chats-v1';
  var MAX_PER_THREAD = 400;
  var MAX_THREADS = 150;
  var FLUSH_MS = 6000;

  var state = { me: null, meNode: null, dir: [], threads: {}, lastSync: 0, online: true };
  var ui = { mode: 'list', peer: null, listPath: null, pollId: null, ticking: false };

  var doc = root.document || null;

  /* ------------------------------------------------------------------ */
  /* pamięć telefonu                                                     */
  /* ------------------------------------------------------------------ */
  function storage() { try { return root.localStorage; } catch (e) { return null; } }

  function load() {
    var ls = storage();
    if (!ls) return;
    try {
      var raw = JSON.parse(ls.getItem(STORE) || '{}') || {};
      state.threads = raw.threads && typeof raw.threads === 'object' ? raw.threads : {};
      state.dir = Array.isArray(raw.dir) ? raw.dir : [];
      state.me = raw.me || null;
      state.lastSync = raw.lastSync || 0;
    } catch (e) { state.threads = {}; state.dir = []; }
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try {
      var keys = Object.keys(state.threads);
      if (keys.length > MAX_THREADS) {
        keys.sort(function (a, b) { return (state.threads[b].at || 0) - (state.threads[a].at || 0); });
        keys.slice(MAX_THREADS).forEach(function (k) { delete state.threads[k]; });
      }
      ls.setItem(STORE, JSON.stringify({
        threads: state.threads, dir: state.dir.slice(0, 400),
        me: state.me, lastSync: state.lastSync
      }));
    } catch (e) {}
  }

  function nowId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function thread(id, label, avatar) {
    if (!id) return null;
    var t = state.threads[id];
    if (!t) {
      t = state.threads[id] = { id: id, label: label || short(id), avatar: avatar || '', msgs: [], at: Date.now() };
    }
    if (label && (!t.label || t.label === short(id))) t.label = label;
    if (avatar && !t.avatar) t.avatar = avatar;
    return t;
  }

  function short(id) {
    var s = String(id || '');
    if (!s) return '?';
    if (/^[0-9a-f-]{20,}$/i.test(s)) return 'Osoba ' + s.slice(0, 4);
    return s.length > 16 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
  }

  function addMsg(id, label, msg) {
    var t = thread(id, label);
    if (!t) return null;
    if (msg.sid && t.msgs.some(function (m) { return m.sid && m.sid === msg.sid; })) return t;
    // ta sama treść w krótkim odstępie = ta sama wiadomość (serwer + radio)
    if (msg.sender === 'them' && t.msgs.some(function (m) {
      return m.sender === 'them' && m.text === msg.text && Math.abs((m.at || 0) - (msg.at || 0)) < 120000;
    })) return t;

    var m = {
      id: msg.id || nowId(),
      sid: msg.sid || null,
      sender: msg.sender === 'me' ? 'me' : 'them',
      text: String(msg.text == null ? '' : msg.text),
      at: msg.at || Date.now(),
      st: msg.st || (msg.sender === 'me' ? 'sent' : '')
    };
    t.msgs.push(m);
    if (t.msgs.length > MAX_PER_THREAD) t.msgs = t.msgs.slice(-MAX_PER_THREAD);
    t.at = Math.max(t.at || 0, m.at);
    save();
    return t;
  }

  function sortedThreads() {
    return Object.keys(state.threads)
      .map(function (k) { return state.threads[k]; })
      .filter(function (t) { return t && t.msgs && t.msgs.length; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  function lastOf(t) { return t && t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1] : null; }

  /* ------------------------------------------------------------------ */
  /* konto: identyfikator, klucz publiczny serwera, token                */
  /* ------------------------------------------------------------------ */
  function readAuth() {
    var ls = storage();
    if (!ls) return null;
    var names = [];
    try {
      if (typeof ls.length === 'number') {
        for (var i = 0; i < ls.length; i++) names.push(ls.key(i));
      } else {
        names = Object.keys(ls);
      }
    } catch (e) { return null; }
    var key = null;
    for (var j = 0; j < names.length; j++) {
      if (/^sb-.*-auth-token(\.0)?$/.test(names[j])) { key = names[j]; break; }
    }
    if (!key) return null;
    var raw = ls.getItem(key) || '';
    if (raw.charAt(0) !== '{') {
      var extra = ls.getItem(key + '.0');
      if (extra) raw = extra;
    }
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    var ses = obj && (obj.access_token ? obj : (obj.currentSession || null));
    if (!ses || !ses.access_token) return null;
    var payload = null;
    try {
      var b64 = ses.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      payload = JSON.parse(atob(b64));
    } catch (e) { payload = null; }
    return {
      token: ses.access_token,
      userId: (payload && payload.sub) || (ses.user && ses.user.id) || null,
      expires: (payload && payload.exp ? payload.exp * 1000 : 0)
    };
  }

  function myId() {
    var a = readAuth();
    if (a && a.userId) return a.userId;
    var ls = storage();
    try {
      var saved = ls && ls.getItem('rise-my-id');
      if (saved) return saved;
      var appKey = ls && ls.getItem('rise-account-id');
      if (appKey) return appKey;
    } catch (e) {}
    return null;
  }

  function myNode() {
    var O = root.RISE_AUTO_OILTCS;
    if (O && O.nodeId) { try { return O.nodeId(); } catch (e) {} }
    var ls = storage();
    try {
      var id = ls && ls.getItem('rise-node-id');
      if (id) return id;
      id = 'node-' + Math.random().toString(36).slice(2, 10);
      if (ls) ls.setItem('rise-node-id', id);
      return id;
    } catch (e) { return 'node'; }
  }

  /* Klucz publiczny Supabase (anon/publishable) jest w bundlu aplikacji — to
   * plik, nie treść strony, więc trzeba go stamtąd przeczytać. Raz przeczytany
   * zostaje w pamięci telefonu. To klucz publiczny z natury: tak samo leży
   * w każdej przeglądarkowej wersji aplikacji. */
  var KEY_CACHE = 'rise-net-key';

  function readPageKey() {
    if (!doc || !doc.querySelectorAll) return '';
    var scripts = doc.querySelectorAll('script');
    var all = '';
    for (var i = 0; i < scripts.length; i++) {
      all += ' ' + (scripts[i].textContent || scripts[i].innerHTML || '');
    }
    var m = /(sb_publishable_[A-Za-z0-9_\-]+|eyJhbGciOiJIUzI1Ni[A-Za-z0-9_.\-]{20,})/.exec(all);
    return m ? m[1] : '';
  }

  function bundleUrl() {
    if (!doc || !doc.querySelectorAll) return '';
    var scripts = doc.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || (scripts[i].getAttribute ? scripts[i].getAttribute('src') : '') || '';
      if (/(^|\/)assets\/index-[^\/]*\.js$/.test(src)) {
        try { return new URL(src, (root.location && root.location.href) || 'https://localhost/').href; }
        catch (e) { return src; }
      }
    }
    return '';
  }

  function ensureKey() {
    var cfg = state.cfg || serverConfig();
    if (cfg.key) return Promise.resolve(cfg.key);
    var ls = storage();
    try {
      var saved = ls && ls.getItem(KEY_CACHE);
      if (saved) { cfg.key = saved; return Promise.resolve(saved); }
    } catch (e) {}
    var inline = readPageKey();
    if (inline) {
      cfg.key = inline;
      try { if (ls) ls.setItem(KEY_CACHE, inline); } catch (e) {}
      return Promise.resolve(inline);
    }
    var src = bundleUrl();
    if (!src || !root.fetch) return Promise.resolve('');
    return root.fetch(src).then(function (r) {
      return r && r.ok ? r.text() : '';
    }).then(function (txt) {
      var m = /(sb_publishable_[A-Za-z0-9_\-]+|eyJhbGciOiJIUzI1Ni[A-Za-z0-9_.\-]{20,})/.exec(String(txt || '').slice(0, 2000000));
      if (m) {
        cfg.key = m[1];
        try { if (ls) ls.setItem(KEY_CACHE, m[1]); } catch (e) {}
      }
      return cfg.key || '';
    }).catch(function () { return ''; });
  }

  function serverConfig() {
    if (state.cfg) return state.cfg;
    var url = '', key = '';
    try {
      var scripts = doc ? doc.querySelectorAll('script') : [];
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || (scripts[i].getAttribute ? scripts[i].getAttribute('src') : '') || '';
        var m = /(https?:\/\/[a-z0-9-]+\.supabase\.co)/i.exec(src);
        if (m && !url) url = m[1];
      }
      if (!url) {
        var html = doc && doc.documentElement ? String(doc.documentElement.innerHTML || '') : '';
        var m2 = /(https?:\/\/[a-z0-9-]+\.supabase\.co)/i.exec(html);
        if (m2) url = m2[1];
      }
      if (!url) { url = 'https://zxmnhbkqhupoaaocwzhw.supabase.co'; }
      var all = '';
      for (var s = 0; s < scripts.length; s++) all += ' ' + (scripts[s].textContent || scripts[s].innerHTML || '');
      if (!/sb_publishable_|eyJhbGciOiJIUzI1Ni/.test(all) && doc) {
        try {
          all += ' ' + String((doc.documentElement && doc.documentElement.innerHTML) || '').slice(0, 400000);
        } catch (e) {}
      }
      var km = /(sb_publishable_[A-Za-z0-9_\-]+|eyJhbGciOiJIUzI1Ni[A-Za-z0-9_.\-]{20,})/.exec(all);
      if (km) key = km[1];
    } catch (e) {}
    state.cfg = { url: url, key: key };
    return state.cfg;
  }

  /* navigator.onLine potrafi kłamać w obie strony (Wi-Fi bez internetu).
   * Dlatego wysyłkę próbujemy zawsze, a „bez internetu" to wynik nieudanej
   * próby. Bezpiecznik: po błędzie sieci nie dobijamy się co sekundę. */
  function online() {
    try { return root.navigator ? root.navigator.onLine !== false : true; } catch (e) { return true; }
  }

  var netFailAt = 0;
  function netCooling() { return netFailAt && (Date.now() - netFailAt) < 20000; }
  function netFailed() { netFailAt = Date.now(); }
  function netWorks() { netFailAt = 0; }

  /* Minimalny klient REST Supabase — tylko to, czego potrzebujemy. */
  function rest(table, query, opts) {
    var cfg = serverConfig();
    return ensureKey().then(function (key) {
      if (!key) throw new Error('brak klucza publicznego');
      return call(key);
    });

    function call(key) {
      var auth = readAuth();
      var headers = {
        'apikey': key,
        'Authorization': 'Bearer ' + (auth && auth.token ? auth.token : key),
        'Content-Type': 'application/json'
      };
      var o = opts || {};
      headers['Prefer'] = o.prefer || 'return=representation';
      return root.fetch(cfg.url + '/rest/v1/' + table + (query || ''), {
        method: o.method || 'GET',
        headers: headers,
        body: o.body ? JSON.stringify(o.body) : undefined
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function (txt) {
        try { return txt ? JSON.parse(txt) : []; } catch (e) { return []; }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* synchronizacja: to, co przyszło z serwera, wchodzi do pamięci        */
  /* ------------------------------------------------------------------ */
  function mergeRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    var me = state.me || myId();
    var changed = 0;
    rows.forEach(function (r) {
      if (!r || !r.id) return;
      var mine = r.sender_id && r.sender_id === me;
      var other = mine ? r.receiver_id : r.sender_id;
      if (!other) return;
      var meta = dirOf(other);
      var text = bodyText(r.text);
      if (!text) return;
      var before = state.threads[other] ? state.threads[other].msgs.length : 0;
      addMsg(other, meta ? meta.name : null, {
        sid: r.id, sender: mine ? 'me' : 'them', text: text,
        at: r.created_at ? new Date(r.created_at).getTime() : Date.now(), st: mine ? 'sent' : ''
      });
      if (meta && meta.avatar) {
        var t = state.threads[other];
        if (t && !t.avatar) t.avatar = meta.avatar;
      }
      var after = state.threads[other] ? state.threads[other].msgs.length : 0;
      if (after !== before) changed++;
    });
    if (changed) { state.lastSync = Date.now(); save(); }
    return changed;
  }

  function bodyText(raw) {
    var text = raw == null ? '' : String(raw);
    if (!text) return '';
    if (text.charAt(0) === '{') {
      try {
        var obj = JSON.parse(text);
        if (obj && obj.version === 'ecdh-v1') return '🔒 Wiadomość zaszyfrowana — czytelna w aplikacji';
      } catch (e) {}
    }
    return text;
  }

  function syncFromServer() {
    var me = state.me || myId();
    if (!me || !root.fetch || netCooling()) return Promise.resolve(0);
    var q = '?select=id,sender_id,receiver_id,text,type,created_at' +
      '&or=(sender_id.eq.' + encodeURIComponent(me) + ',receiver_id.eq.' + encodeURIComponent(me) + ')' +
      '&order=created_at.desc&limit=300';
    return rest('messages', q).then(function (rows) {
      return mergeRows(rows);
    }).then(function (n) { netWorks(); return n; }).catch(function () { netFailed(); return 0; });
  }

  function syncDirectory() {
    var me = state.me || myId();
    if (!me || !root.fetch || netCooling()) return Promise.resolve(0);
    return rest('profiles', '?select=id,username,avatar_class,status,bio&neq=id.' + encodeURIComponent(me) + '&limit=400')
      .then(function (rows) {
        if (!Array.isArray(rows)) return 0;
        state.dir = rows.map(function (p) {
          return {
            id: p.id, name: p.username || short(p.id),
            avatar: p.avatar_class || '', status: p.status || '', bio: p.bio || ''
          };
        });
        save();
        return state.dir.length;
      }).catch(function () { return 0; });
  }

  function dirOf(id) {
    for (var i = 0; i < state.dir.length; i++) if (state.dir[i].id === id) return state.dir[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* wysyłka                                                             */
  /* ------------------------------------------------------------------ */
  /* 1) Jeśli aplikacja ma otwartą prawdziwą rozmowę z tą osobą — piszemy
   *    w jej polu tekstowym. To najlepszy przypadek: wiadomość jest zwykłą
   *    wiadomością aplikacji (szyfrowanie, podpis, kolejka, radio). */
  function nativeInput() {
    if (!doc || !doc.querySelector) return null;
    var areas = doc.querySelectorAll('form.chat-input-bar, .chat-input-bar');
    for (var i = 0; i < areas.length; i++) {
      var area = areas[i];
      if (!area || !area.querySelector) continue;
      var input = area.querySelector('input[type="text"]');
      if (!input) continue;
      var btn = area.querySelector('button.send-btn');
      return { area: area, input: input, send: btn };
    }
    return null;
  }

  function nativeSend(text) {
    var f = nativeInput();
    if (!f) return false;
    var proto = root.HTMLInputElement && root.HTMLInputElement.prototype;
    var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    try {
      f.input.focus();
      if (desc && desc.set) desc.set.call(f.input, text);
      else f.input.value = text;
      f.input.dispatchEvent(new root.Event('input', { bubbles: true }));
      f.input.dispatchEvent(new root.Event('change', { bubbles: true }));
    } catch (e) { return false; }
    // przycisk „Wyślij" pojawia się dopiero po odświeżeniu stanu aplikacji
    var tries = 0;
    (function clickWhenReady() {
      var cur = nativeInput();
      var btn = cur && cur.send;
      if (!btn) {
        if (++tries < 8) return setTimeout(clickWhenReady, 60);
        try { if (cur && cur.area && cur.area.requestSubmit) { cur.area.requestSubmit(); return; } } catch (e) {}
        return;
      }
      try { btn.click(); } catch (e) {}
    })();
    return true;
  }

  /* 2) Bez internetu: ta sama droga co reszta aplikacji — radio (OILTCS). */
  function radioSend(peerNode, text) {
    var O = root.RISE_AUTO_OILTCS;
    if (!O || !O.relay || !peerNode) return Promise.resolve(false);
    return Promise.resolve(O.relay(myNode(), peerNode, text)).then(function (ok) { return !!ok; })
      .catch(function () { return false; });
  }

  /* 3) Serwer: wiadomość trafia do zwykłej tabeli `messages`, więc druga
   *    strona widzi ją w swojej normalnej liście czatów. */
  function pushToServer(peerId, msg) {
    var me = state.me || myId();
    if (!me || !peerId) return Promise.resolve(false);
    if (!root.fetch) return Promise.resolve(false);
    if (!online() || netCooling()) return Promise.resolve(false);
    return rest('messages', '', {
      method: 'POST',
      body: { sender_id: me, receiver_id: peerId, text: msg.text, type: 'text' }
    }).then(function (rows) {
      netWorks();
      var row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.id) { msg.sid = row.id; save(); }
      return true;
    }).catch(function () { netFailed(); return false; });
  }

  /* Wysyła wiadomość do osoby: aplikacja → radio → kolejka. */
  function deliver(peerId, text, label) {
    var t = addMsg(peerId, label, { sender: 'me', text: text, st: 'sending' });
    var msg = lastOf(t);
    return Promise.resolve()
      .then(function () {
        if (online() && nativeSend(text)) { msg.st = 'sent'; save(); return 'app'; }
        return false;
      })
      .then(function (how) {
        if (how) { render(); return how; }
        return pushToServer(peerId, msg).then(function (ok) {
          if (ok) { msg.st = 'sent'; save(); render(); return 'serwer'; }
          return radioSend(peerId, text).then(function (radio) {
            msg.st = radio ? 'sent' : 'queued';
            save(); render();
            return radio ? 'radio' : 'kolejka';
          });
        });
      })
      .catch(function () { msg.st = 'queued'; save(); render(); return 'kolejka'; });
  }

  /* Kolejka: wszystko, co „czeka na zasięg", próbujemy wysłać przy każdej
   * okazji. Bez przycisku, bez pytania. */
  function flush() {
    if (ui.ticking) return Promise.resolve(0);
    if (!root.fetch || !online() || netCooling()) return Promise.resolve(0);
    var pending = [];
    Object.keys(state.threads).forEach(function (k) {
      var t = state.threads[k];
      (t.msgs || []).forEach(function (m) { if (m.sender === 'me' && m.st === 'queued') pending.push({ t: t, m: m }); });
    });
    if (!pending.length) return Promise.resolve(0);
    ui.ticking = true;
    var done = 0;
    return pending.reduce(function (chain, item) {
      return chain.then(function () {
        return pushToServer(item.t.id, item.m).then(function (ok) {
          if (ok) { item.m.st = 'sent'; done++; save(); }
        });
      });
    }, Promise.resolve()).then(function () {
      ui.ticking = false;
      if (done) render();
      return done;
    }).catch(function () { ui.ticking = false; return done; });
  }

  /* ------------------------------------------------------------------ */
  /* wygląd: wszystko w stylu aplikacji, w miejscu listy                  */
  /* ------------------------------------------------------------------ */
  function el(tag, cls, text) {
    var d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  function timeText(ts) {
    try {
      var d = new Date(ts);
      var today = new Date();
      if (d.toDateString() === today.toDateString()) {
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      }
      return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
    } catch (e) { return ''; }
  }

  function statusText(m) {
    if (m.st === 'queued') return 'czeka na zasięg';
    if (m.st === 'sending') return 'wysyłam';
    if (m.st === 'sent') return 'wysłane';
    return '';
  }

  /* Znajduje prawdziwą listę czatów. Nasze wiersze stawiamy w osobnym
   * kontenerze ZARAZ ZA listą, w tym samym widoku — drzewo React-a zostaje
   * nietknięte, więc nic się nie wysypuje, a wygląda jak jedna lista. */
  function findList() {
    if (!doc || !doc.querySelector) return null;
    var list = doc.querySelector('.contacts-list');
    if (!list) return null;
    var host = list.parentNode;
    if (!host) return null;
    return { list: list, host: host, view: host };
  }

  function rowsBox(found) {
    var box = found.host.querySelector(':scope > .rise-thread-rows');
    if (!box) {
      box = el('div', 'rise-thread-rows');
      if (found.list.nextSibling) found.host.insertBefore(box, found.list.nextSibling);
      else found.host.appendChild(box);
    }
    return box;
  }

  /* Ekran rozmowy: ta sama powierzchnia co treść zakładki, żeby pasek
   * zakładek został na dole — bez nowego, osobnego widoku. */
  function screenHost() {
    if (!doc || !doc.querySelector) return null;
    return doc.querySelector('.screen-content') || doc.querySelector('.phone-screen') || doc.body;
  }

  /* Nasze wiersze mają kształt natywnych (`.contact-item`), żeby lista
   * wyglądała jak jedna lista, a nie jak druga aplikacja. */
  function renderList() {
    var found = findList();
    if (!found) {
      /* jesteśmy na innej zakładce — nasz ekran rozmowy nie może jej zasłaniać */
      var open1 = doc.querySelector('.rise-chat');
      if (open1) open1.parentNode.removeChild(open1);
      return false;
    }
    ui.listPath = found;
    var box = rowsBox(found);

    var old = box.querySelectorAll('[data-rise-thread]');
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);

    var rows = sortedThreads();
    rows.forEach(function (t) {
      var last = lastOf(t);
      var row = el('div', 'contact-item rise-thread-row');
      row.setAttribute('data-rise-thread', t.id);
      row.setAttribute('data-rise-search', (t.label || '') + ' ' + (last ? last.text : '') + ' ' + t.id);

      var wrap = el('div', 'avatar-wrapper');
      var av = el('div', 'avatar rise-avatar', (t.label || '?').slice(0, 1).toUpperCase());
      if (t.avatar && /^(https?:|data:)/.test(t.avatar)) {
        var img = el('img', 'rise-avatar-img');
        img.setAttribute('src', t.avatar);
        av.appendChild(img);
      }
      wrap.appendChild(av);
      row.appendChild(wrap);

      var det = el('div', 'contact-details');
      var meta = el('div', 'contact-meta');
      meta.appendChild(el('h4', '', t.label || short(t.id)));
      meta.appendChild(el('span', 'msg-time', timeText(t.at)));
      det.appendChild(meta);

      var prev = el('p', 'last-message', last
        ? ((last.sender === 'me' ? 'Ty: ' : '') + last.text)
        : 'brak wiadomości');
      det.appendChild(prev);
      row.appendChild(det);

      if (last && last.st === 'queued') {
        var badge = el('span', 'rise-pending', 'czeka na zasięg');
        row.appendChild(badge);
      }

      row.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        open(t.id);
      }, true);

      box.appendChild(row);
    });
    applySearchFilter(box);
    return true;
  }

  /* Wyszukiwarka aplikacji filtruje swoje wiersze; nasze filtrujemy tak samo,
   * żeby wpisanie „kam" nie zostawiało na liście niepasujących rozmów. */
  function applySearchFilter(box) {
    var boxEl = box || (doc && doc.querySelector('.rise-thread-rows'));
    if (!boxEl) return;
    var needle = '';
    var input = doc.querySelector('.search-bar input[type="text"]');
    if (input && input.value) needle = String(input.value).toLowerCase().trim();
    var rows = boxEl.querySelectorAll('[data-rise-thread]');
    for (var i = 0; i < rows.length; i++) {
      var hay = (rows[i].getAttribute('data-rise-search') || '').toLowerCase();
      var show = !needle || hay.indexOf(needle) >= 0 || needle.indexOf('ty:') >= 0;
      rows[i].style.display = show ? '' : 'none';
    }
  }

  /* Rozmowa otwiera się W MIEJSCU listy (bez nakładki na cały ekran). */
  function open(peerId) {
    var found = findList();
    if (!found) return false;
    ui.listPath = found;
    ui.mode = 'thread';
    ui.peer = peerId;

    var host = screenHost();
    var old = host.querySelector('.rise-chat');
    if (old) old.parentNode.removeChild(old);

    var wrap = el('div', 'rise-chat');
    wrap.setAttribute('data-rise-peer', peerId);

    var head = el('div', 'rise-chat-head');
    var back = el('button', 'rise-back', '←');
    back.setAttribute('aria-label', 'Wróć do listy czatów');
    back.addEventListener('click', function () {
      wrap.parentNode.removeChild(wrap);
      ui.mode = 'list'; ui.peer = null;
      render();
    });
    head.appendChild(back);
    var t0 = state.threads[peerId];
    head.appendChild(el('h3', 'rise-chat-title', t0 ? t0.label : short(peerId)));
    wrap.appendChild(head);

    var body = el('div', 'rise-msgs');
    body.setAttribute('data-rise-msglist', peerId);
    wrap.appendChild(body);

    var bar = el('form', 'rise-input-bar');
    var input = el('input', 'rise-input');
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', 'Napisz wiadomość — wyjdzie także bez internetu');
    var sendBtn = el('button', 'rise-send', 'Wyślij');
    sendBtn.setAttribute('type', 'submit');
    bar.appendChild(input);
    bar.appendChild(sendBtn);
    bar.addEventListener('submit', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      var text = (input.value || '').trim();
      if (!text) return;
      input.value = '';
      deliver(peerId, text, t0 ? t0.label : null).then(function () { drawMessages(peerId); });
    });
    wrap.appendChild(bar);

    host.appendChild(wrap);
    drawMessages(peerId);
    try { input.focus(); } catch (e) {}
    return true;
  }

  function drawMessages(peerId) {
    if (!doc || !doc.querySelector) return false;
    var body = doc.querySelector('[data-rise-msglist="' + cssEsc(peerId) + '"]');
    if (!body) return false;
    while (body.firstChild) body.removeChild(body.firstChild);
    var t = state.threads[peerId];
    var msgs = (t && t.msgs) || [];
    if (!msgs.length) {
      body.appendChild(el('div', 'rise-empty', 'Napisz pierwszą wiadomość. Bez internetu też dojdzie — radiem, przez inne telefony.'));
    }
    msgs.forEach(function (m) {
      var row = el('div', 'rise-row ' + (m.sender === 'me' ? 'rise-me' : 'rise-them'));
      row.appendChild(el('div', 'rise-bubble', m.text));
      var meta = el('div', 'rise-meta', timeText(m.at) + (statusText(m) ? ' · ' + statusText(m) : ''));
      row.appendChild(meta);
      body.appendChild(row);
    });
    try { body.scrollTop = body.scrollHeight; } catch (e) {}
    return true;
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function render() {
    if (!doc) return;
    renderList();
    if (ui.mode === 'thread' && ui.peer) drawMessages(ui.peer);
    var rows = sortedThreads().length;
    try { doc.title = 'Rises'; } catch (e) {}
    void rows;
  }

  /* ------------------------------------------------------------------ */
  /* odbieranie: radio + serwer                                          */
  /* ------------------------------------------------------------------ */
  function onMesh(ev) {
    var d = ev && ev.detail;
    if (!d || !d.text) return;
    var from = d.from || 'radio';
    var meta = dirOf(from);
    addMsg(from, meta ? meta.name : null, { sender: 'them', text: String(d.text), at: d.at || Date.now() });
    if (ui.mode === 'thread' && ui.peer === from) drawMessages(from);
    render();
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */
  var styleInjected = false;
  function injectStyle() {
    if (styleInjected || !doc || !doc.head) return;
    styleInjected = true;
    var css = '' +
      '.rise-thread-rows{order:-1;display:flex;flex-direction:column}' +
      '.rise-avatar{background:rgba(16,185,129,.18);color:#6EE7B7;font-weight:800}' +
      '.rise-avatar-img{width:100%;height:100%;border-radius:50%;object-fit:cover}' +
      '.rise-pending{font-size:.62rem;color:#F59E0B;border:1px solid rgba(245,158,11,.4);' +
        'border-radius:8px;padding:1px 6px;white-space:nowrap;align-self:center}' +
      '.rise-chat{display:flex;flex-direction:column;position:absolute;top:0;left:0;right:0;bottom:0;' +
        'background:var(--bg-main,#090D1A);z-index:5}' +
      '.rise-chat-head{display:flex;align-items:center;gap:10px;padding:12px 14px;' +
        'border-bottom:1px solid rgba(255,255,255,.06)}' +
      '.rise-chat-title{font-size:1rem;font-weight:700;margin:0;color:var(--text-primary,#e6edf5)}' +
      '.rise-back{background:none;border:0;color:var(--text-primary,#e6edf5);font-size:1.3rem;' +
        'cursor:pointer;padding:0 6px;line-height:1}' +
      '.rise-msgs{flex:1 1 auto;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}' +
      '.rise-row{display:flex;flex-direction:column;max-width:82%}' +
      '.rise-me{align-self:flex-end;align-items:flex-end}' +
      '.rise-them{align-self:flex-start;align-items:flex-start}' +
      '.rise-bubble{padding:9px 12px;border-radius:14px;font-size:.9rem;line-height:1.35;' +
        'word-break:break-word;background:rgba(255,255,255,.07);color:var(--text-primary,#e6edf5)}' +
      '.rise-me .rise-bubble{background:var(--color-emerald,#10B981);color:#fff}' +
      '.rise-meta{font-size:.66rem;color:var(--text-muted,#8b9bb4);margin-top:2px}' +
      '.rise-empty{color:var(--text-secondary,#9aa8bd);font-size:.85rem;text-align:center;margin-top:22px}' +
      '.rise-input-bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.06)}' +
      '.rise-input{flex:1 1 auto;min-width:0;padding:12px 14px;border-radius:14px;' +
        'border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);' +
        'color:var(--text-primary,#e6edf5);font-size:.92rem;outline:none}' +
      '.rise-send{padding:12px 16px;border-radius:14px;border:0;background:var(--color-emerald,#10B981);' +
        'color:#fff;font-weight:700;font-size:.85rem;cursor:pointer}';
    var st = doc.createElement('style');
    st.setAttribute('data-rise-native-chat', '1');
    st.textContent = css;
    doc.head.appendChild(st);
  }

  function boot() {
    if (!doc) return;
    load();
    state.me = myId();
    state.meNode = myNode();
    injectStyle();

    doc.addEventListener('input', function (ev) {
      var t = ev && ev.target;
      if (t && t.type === 'text' && t.closest && t.closest('.search-bar')) applySearchFilter();
    }, true);

    if (root.addEventListener) {
      root.addEventListener('rise-mesh-message', onMesh);
      root.addEventListener('online', function () {
        netFailAt = 0;              /* system mówi: sieć wróciła — próbujemy od razu */
        flush(); syncFromServer().then(render);
      });
      root.addEventListener('offline', function () { render(); });
    }

    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try { render(); } catch (e) {}
      if (tries === 2) { syncDirectory().then(render); }
      if (tries > 20) clearInterval(iv);
    }, 1200);

    setTimeout(function () {
      syncDirectory().then(function () { return syncFromServer(); }).then(render);
    }, 2500);

    ui.pollId = setInterval(function () {
      if (!doc || (doc.visibilityState && doc.visibilityState !== 'visible')) return;
      if (ui.mode === 'thread') flush();
      render();
    }, FLUSH_MS);

    setInterval(function () {
      if (!doc || (doc.visibilityState && doc.visibilityState !== 'visible')) return;
      syncFromServer().then(function (n) { if (n) render(); });
    }, 45000);
  }

  /* ------------------------------------------------------------------ */
  /* API (dla testów i dla innych modułów)                               */
  /* ------------------------------------------------------------------ */
  root.RISE_NATIVE_CHAT = {
    boot: boot,
    ensureKey: ensureKey,
    render: render,
    open: open,
    deliver: deliver,
    flush: flush,
    mergeRows: mergeRows,
    syncFromServer: syncFromServer,
    syncDirectory: syncDirectory,
    threads: function () { return sortedThreads().map(function (t) {
      return { id: t.id, label: t.label, at: t.at, msgs: t.msgs.length, last: lastOf(t) };
    }); },
    thread: function (id) { var t = state.threads[id]; return t ? { id: t.id, label: t.label, msgs: t.msgs.slice() } : null; },
    myId: myId,
    myNode: myNode,
    serverConfig: serverConfig,
    online: online,
    state: function () {
      return {
        me: state.me, mode: ui.mode, peer: ui.peer,
        threads: sortedThreads().length,
        messages: sortedThreads().reduce(function (n, t) { return n + t.msgs.length; }, 0),
        pending: sortedThreads().reduce(function (n, t) {
          return n + t.msgs.filter(function (m) { return m.st === 'queued'; }).length;
        }, 0),
        online: online()
      };
    },
    _reset: function () { state.threads = {}; state.dir = []; state.lastSync = 0; save(); }
  };

  if (doc && doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
