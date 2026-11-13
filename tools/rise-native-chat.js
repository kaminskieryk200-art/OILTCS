/* Rises — OILTCS pod zwykłym interfejsem (v3.43.0).
 *
 * Zasada: NIE MA własnego okna ani własnej listy. Rozmowa to ta sama rozmowa,
 * ten sam nagłówek, to samo pole tekstowe, ten sam przycisk „Wyślij". OILTCS
 * jest niewidzialną drogą pod spodem:
 *
 *   wysyłka  → aplikacja zapisuje wiadomość normalnie (serwer); gdy serwer
 *              nie odpowie, ta sama treść idzie radiem, a bez radia czeka
 *              w kolejce i wysyła się sama, gdy zasięg wróci,
 *   odbiór   → wiadomość z radia ląduje w tej samej rozmowie, jako zwykła
 *              wiadomość od drugiej osoby,
 *   lista    → osoby, do których pisaliśmy przez OILTCS, są na liście czatów
 *              razem z kontami z serwera (nazwa, awatar, ostatnia wiadomość),
 *   historia → to, co przeszło przez OILTCS, jest w pamięci telefonu i nie
 *              znika po zamknięciu aplikacji ani po powrocie internetu.
 *
 * Ten plik nie tworzy żadnego elementu na ekranie. Dostarcza tylko dane
 * natywnym widokom aplikacji (patrz tools/patch-native-chat.py).
 */
(function (root) {
  if (root.RISE_OFFLINE_CHAT) return;

  var STORE = 'rise-oiltcs-chats-v1';   /* wątki, ludzie, kolejka */
  var KEY_CACHE = 'rise-net-key';       /* publiczny klucz serwera (nie sekret) */
  var MAX_PER_THREAD = 400;
  var MAX_THREADS = 150;
  var SYNC_MS = 45000;                  /* lustro historii z serwera */
  var DRAIN_MS = 6000;                  /* kolejka: próba wysyłki */
  var TICK_MS = 3000;                   /* doklejanie historii do otwartej rozmowy */

  var state = {
    me: null, dir: [], threads: {}, lastSync: 0, cfg: null,
    offlineAt: 0, booted: false, timer: null
  };
  var api = null;            /* most do aplikacji (ustawia bundle) */
  var injected = {};         /* id wiadomości już wstawionych do otwartej rozmowy */
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

  function newId() { return 'offline-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function short(id) {
    var s = String(id || '');
    if (/^[0-9a-f-]{20,}$/i.test(s)) return 'Osoba ' + s.slice(0, 4);
    return s.length > 16 ? s.slice(0, 6) + '…' + s.slice(-4) : s || 'Osoba';
  }

  function thread(id, seed) {
    if (!id) return null;
    var t = state.threads[id];
    if (!t) t = state.threads[id] = { id: id, label: '', avatar: '', msgs: [], at: Date.now() };
    if (seed) {
      if (seed.label) t.label = seed.label;
      if (seed.avatar) t.avatar = seed.avatar;
    }
    return t;
  }

  function push(id, msg, seed) {
    var t = thread(id, seed);
    if (!t) return null;
    if (msg.sid && t.msgs.some(function (m) { return m.sid === msg.sid; })) return t;
    var same = function (m) {
      return m.text === msg.text && m.sender === msg.sender &&
        Math.abs((m.at || 0) - (msg.at || 0)) < 120000;
    };
    if (t.msgs.some(same)) return t;
    t.msgs.push({
      id: msg.id || newId(), sid: msg.sid || null,
      sender: msg.sender === 'me' ? 'me' : 'them',
      text: String(msg.text == null ? '' : msg.text),
      at: msg.at || Date.now(),
      st: msg.st || (msg.sender === 'me' ? 'sent' : 'radio')
    });
    if (t.msgs.length > MAX_PER_THREAD) t.msgs = t.msgs.slice(-MAX_PER_THREAD);
    t.at = Math.max(t.at || 0, msg.at || Date.now());
    save();
    return t;
  }

  function lastOf(t) { return t && t.msgs && t.msgs.length ? t.msgs[t.msgs.length - 1] : null; }

  function people() {
    return Object.keys(state.threads)
      .map(function (k) { return state.threads[k]; })
      .filter(function (t) { return t && t.msgs && t.msgs.length; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  /* ------------------------------------------------------------------ */
  /* konto, klucz publiczny serwera, adres                              */
  /* ------------------------------------------------------------------ */
  function readAuth() {
    var ls = storage();
    if (!ls) return null;
    var names = [];
    try {
      if (typeof ls.length === 'number') { for (var i = 0; i < ls.length; i++) names.push(ls.key(i)); }
      else names = Object.keys(ls);
    } catch (e) { return null; }
    var key = null;
    for (var j = 0; j < names.length; j++) if (/^sb-.*-auth-token(\.0)?$/.test(names[j])) { key = names[j]; break; }
    if (!key) return null;
    var raw = ls.getItem(key) || '';
    if (raw.charAt(0) !== '{') { var extra = ls.getItem(key + '.0'); if (extra) raw = extra; }
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
    return { token: ses.access_token, userId: (payload && payload.sub) || null };
  }

  function myId() {
    if (state.me) return state.me;
    var a = readAuth();
    if (a && a.userId) { state.me = a.userId; save(); return a.userId; }
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

  function serverUrl() {
    if (state.cfg && state.cfg.url) return state.cfg.url;
    var url = '';
    try {
      var scripts = doc ? doc.querySelectorAll('script') : [];
      for (var i = 0; i < scripts.length; i++) {
        var src = scripts[i].src || (scripts[i].getAttribute ? scripts[i].getAttribute('src') : '') || '';
        var m = /(https?:\/\/[a-z0-9-]+\.supabase\.co)/i.exec(src);
        if (m) { url = m[1]; break; }
      }
    } catch (e) {}
    if (!url) url = 'https://zxmnhbkqhupoaaocwzhw.supabase.co';
    state.cfg = state.cfg || {};
    state.cfg.url = url;
    return url;
  }

  /* Klucz publiczny (anon/publishable) jest w bundlu aplikacji, nie w HTML. */
  function ensureKey() {
    if (state.cfg && state.cfg.key) return Promise.resolve(state.cfg.key);
    var ls = storage();
    try {
      var saved = ls && ls.getItem(KEY_CACHE);
      if (saved) { state.cfg = state.cfg || {}; state.cfg.key = saved; return Promise.resolve(saved); }
    } catch (e) {}
    var inline = '';
    try {
      var scripts = doc ? doc.querySelectorAll('script') : [];
      var all = '';
      for (var i = 0; i < scripts.length; i++) all += ' ' + (scripts[i].textContent || scripts[i].innerHTML || '');
      var m = /(sb_publishable_[A-Za-z0-9_\-]+|eyJhbGciOiJIUzI1Ni[A-Za-z0-9_.\-]{20,})/.exec(all);
      if (m) inline = m[1];
    } catch (e) {}
    if (inline) {
      state.cfg = state.cfg || {};
      state.cfg.key = inline;
      try { if (ls) ls.setItem(KEY_CACHE, inline); } catch (e) {}
      return Promise.resolve(inline);
    }
    var bundle = '';
    try {
      var list = doc ? doc.querySelectorAll('script') : [];
      for (var k = 0; k < list.length; k++) {
        var src2 = list[k].src || (list[k].getAttribute ? list[k].getAttribute('src') : '') || '';
        if (/(^|\/)assets\/index-[^\/]*\.js$/.test(src2)) {
          bundle = new URL(src2, (root.location && root.location.href) || 'https://localhost/').href;
          break;
        }
      }
    } catch (e) {}
    if (!bundle || !root.fetch) return Promise.resolve('');
    return root.fetch(bundle).then(function (r) {
      return r && r.ok ? r.text() : '';
    }).then(function (txt) {
      var mm = /(sb_publishable_[A-Za-z0-9_\-]+|eyJhbGciOiJIUzI1Ni[A-Za-z0-9_.\-]{20,})/.exec(String(txt || '').slice(0, 2000000));
      if (mm) {
        state.cfg = state.cfg || {};
        state.cfg.key = mm[1];
        try { if (ls) ls.setItem(KEY_CACHE, mm[1]); } catch (e) {}
      }
      return (state.cfg && state.cfg.key) || '';
    }).catch(function () { return ''; });
  }

  function online() {
    try { return root.navigator ? root.navigator.onLine !== false : true; } catch (e) { return true; }
  }

  var failedAt = 0;
  function cooling() { return failedAt && (Date.now() - failedAt) < 20000; }
  function noteOffline() { failedAt = Date.now(); state.offlineAt = failedAt; }
  function noteOnline() { failedAt = 0; state.offlineAt = 0; }
  function isOffline() { return !online() || !!failedAt; }

  function rest(table, query, opts) {
    var url = serverUrl();
    return ensureKey().then(function (key) {
      if (!key) throw new Error('brak klucza publicznego');
      var auth = readAuth();
      var headers = {
        'apikey': key,
        'Authorization': 'Bearer ' + (auth && auth.token ? auth.token : key),
        'Content-Type': 'application/json',
        'Prefer': (opts && opts.prefer) || 'return=representation'
      };
      var o = opts || {};
      return root.fetch(url + '/rest/v1/' + table + (query || ''), {
        method: o.method || 'GET',
        headers: headers,
        body: o.body ? JSON.stringify(o.body) : undefined
      }).then(function (r) {
        if (!r.ok) { noteOffline(); throw new Error('HTTP ' + r.status); }
        return r.text();
      }).then(function (txt) {
        noteOnline();
        try { return txt ? JSON.parse(txt) : []; } catch (e) { return []; }
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* lustro historii z serwera (żeby lista i rozmowa nie były krótsze)   */
  /* ------------------------------------------------------------------ */
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

  function mergeRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return 0;
    var me = myId();
    var changed = 0;
    rows.forEach(function (r) {
      if (!r || !r.id) return;
      var mine = r.sender_id && r.sender_id === me;
      var other = mine ? r.receiver_id : r.sender_id;
      if (!other) return;
      var text = bodyText(r.text);
      if (!text) return;
      var before = state.threads[other] ? state.threads[other].msgs.length : 0;
      push(other, {
        sid: r.id, sender: mine ? 'me' : 'them', text: text,
        at: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
        st: mine ? 'server' : 'server'
      }, personSeed(other));
      if ((state.threads[other] ? state.threads[other].msgs.length : 0) !== before) changed++;
    });
    if (changed) { state.lastSync = Date.now(); save(); }
    return changed;
  }

  function personSeed(id) {
    var d = byId(id);
    if (!d) return null;
    return { label: d.name || '', avatar: d.avatarClass || '' };
  }

  function syncFromServer() {
    var me = myId();
    if (!me || !root.fetch || cooling()) return Promise.resolve(0);
    return rest('messages', '?select=id,sender_id,receiver_id,text,type,created_at' +
      '&or=(sender_id.eq.' + encodeURIComponent(me) + ',receiver_id.eq.' + encodeURIComponent(me) + ')' +
      '&order=created_at.desc&limit=300')
      .then(function (rows) { return mergeRows(rows); })
      .catch(function () { return 0; });
  }

  function syncDirectory() {
    var me = myId();
    if (!me || !root.fetch || cooling()) return Promise.resolve(0);
    return rest('profiles', '?select=id,username,avatar_class,status,bio&neq=id.' + encodeURIComponent(me) + '&limit=400')
      .then(function (rows) {
        if (!Array.isArray(rows)) return 0;
        state.dir = rows.map(function (p) {
          return {
            id: p.id, name: p.username || short(p.id),
            avatarClass: p.avatar_class || 'avatar-blue',
            status: p.status || '', bio: p.bio || ''
          };
        });
        save();
        return state.dir.length;
      }).catch(function () { return 0; });
  }

  function byId(id) {
    for (var i = 0; i < state.dir.length; i++) if (state.dir[i].id === id) return state.dir[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* wysyłka i kolejka                                                   */
  /* ------------------------------------------------------------------ */
  function radioSend(peer, text) {
    var O = root.RISE_AUTO_OILTCS;
    if (!O || !O.relay || !peer) return Promise.resolve(false);
    return Promise.resolve(O.relay(myNode(), peer, text)).then(function (ok) { return !!ok; })
      .catch(function () { return false; });
  }

  function pushServer(peer, msg) {
    var me = myId();
    if (!me || !peer || !root.fetch || cooling()) return Promise.resolve(false);
    return rest('messages', '', {
      method: 'POST',
      body: { sender_id: me, receiver_id: peer, text: msg.text, type: 'text' }
    }).then(function (rows) {
      var row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.id) { msg.sid = row.id; msg.st = 'server'; save(); }
      return true;
    }).catch(function () { noteOffline(); return false; });
  }

  /* Kolejka: wszystko, co nie wyszło, próbujemy przy każdej okazji. */
  function drain() {
    if (!root.fetch || cooling()) return Promise.resolve(0);
    var waiting = [];
    Object.keys(state.threads).forEach(function (k) {
      (state.threads[k].msgs || []).forEach(function (m) {
        if (m.sender === 'me' && m.st === 'queued') waiting.push({ peer: k, m: m });
      });
    });
    if (!waiting.length) return Promise.resolve(0);
    var done = 0;
    return waiting.reduce(function (chain, item) {
      return chain.then(function () {
        return pushServer(item.peer, item.m).then(function (ok) { if (ok) done++; });
      });
    }, Promise.resolve()).then(function () {
      if (done) refresh();
      return done;
    }).catch(function () { return done; });
  }

  /* Wiadomość napisana w normalnym oknie czatu. Aplikacja próbuje serwera;
   * gdy się nie uda, ta funkcja dorzuca radiem i kolejką — bez okien, bez
   * przycisków, bez pytania. */
  function offer(peer, text) {
    if (!peer || !text) return Promise.resolve(false);
    return radioSend(peer, text).then(function (ok) {
      var t = push(peer, { sender: 'me', text: text, st: ok ? 'radio' : 'queued' }, personSeed(peer));
      void t;
      refresh();
      if (!ok) drain();
      return ok;
    });
  }

  /* Wiadomość potwierdzona przez serwer — zapisujemy w pamięci telefonu,
   * żeby po powrocie internetu i restarcie była w tej samej rozmowie. */
  function remember(peer, text, sid) {
    if (!peer || !text) return false;
    push(peer, { sender: 'me', text: text, sid: sid || null, st: 'server' }, personSeed(peer));
    return true;
  }

  function noteQueued(peer) {
    var t = state.threads[peer];
    if (!t) return;
    var last = lastOf(t);
    if (last && last.sender === 'me' && last.st !== 'queued') { last.st = 'queued'; save(); }
  }

  /* ------------------------------------------------------------------ */
  /* dane dla natywnych widoków                                          */
  /* ------------------------------------------------------------------ */
  /* Osoba do nagłówka rozmowy, gdy nie ma jej w katalogu z serwera. */
  function person(id) {
    var d = byId(id);
    if (d) return d;
    var t = state.threads[id];
    return {
      id: id,
      name: (t && t.label) || short(id),
      avatarClass: (t && t.avatar) || 'avatar-blue',
      status: isOffline() ? 'Bez internetu — przez OILTCS' : 'Aktywny'
    };
  }

  function preview(t) {
    var last = lastOf(t);
    if (!last) return 'Brak wiadomości';
    var prefix = last.sender === 'me' ? 'Ty: ' : '';
    var text = prefix + last.text;
    return text.length > 90 ? text.slice(0, 90) + '…' : text;
  }

  /* Lista czatów: dopełniamy ją osobami, do których pisaliśmy przez OILTCS,
   * tylko wtedy, gdy aplikacja ich jeszcze nie ma (bez duplikatów). */
  function merge(list, directory) {
    if (!Array.isArray(list)) return list;
    var have = {};
    list.forEach(function (e) { if (e && e.id) have[e.id] = true; });
    var extra = [];
    people().forEach(function (t) {
      if (!t || !t.id || have[t.id]) return;
      if (!t.msgs || !t.msgs.length) return;
      var d = byId(t.id) || null;
      var down = false;
      if (Array.isArray(directory)) {
        for (var i = 0; i < directory.length; i++) if (directory[i] && directory[i].id === t.id && directory[i].online) { down = true; break; }
      }
      have[t.id] = true;
      extra.push({
        id: t.id,
        name: (d && d.name) || t.label || short(t.id),
        avatarClass: (d && d.avatarClass) || t.avatar || 'avatar-blue',
        online: down,
        status: preview(t),
        bio: 'Rozmowa przez OILTCS',
        publicKey: (d && d.publicKey) || null
      });
    });
    return extra.length ? list.concat(extra) : list;
  }

  /* Historia lokalna doklejana do otwartej rozmowy: to, co przyszło radiem
   * albo zaczekało w kolejce, musi być widać w tym samym oknie. */
  function cachedFor(peer) {
    var t = state.threads[peer];
    if (!t || !t.msgs) return [];
    return t.msgs.filter(function (m) { return m.st === 'radio' || m.st === 'queued'; });
  }

  function syncConversation() {
    if (!api || !api.current || !api.setMessages) return 0;
    var peer = api.current();
    if (!peer) return 0;
    var mine = cachedFor(peer);
    if (!mine.length) return 0;
    var added = 0;
    api.setMessages(function (all) {
      var have = all[peer] || [];
      var next = have.slice();
      var seen = {};
      have.forEach(function (m) {
        if (m && m.text) seen[m.text + '|' + m.sender] = true;
      });
      mine.forEach(function (m) {
        var key = m.text + '|' + (m.sender === 'me' ? 'me' : 'them');
        if (seen[key] || injected[m.id]) return;
        seen[key] = true;
        injected[m.id] = true;
        added++;
        next.push({
          id: m.id, sender: m.sender === 'me' ? 'me' : 'them', text: m.text,
          time: timeText(m.at), type: 'text', reactions: {}, deleted_for: [],
          sender_id: m.sender === 'me' ? (myId() || 'me') : peer,
          localSendStatus: m.st === 'queued' ? 'queued' : null
        });
      });
      if (!added) return all;
      var out = Object.assign({}, all);
      out[peer] = next;
      return out;
    });
    return added;
  }

  function notify() {
    /* aplikacja wczytała historię z serwera — odświeżamy podglądy na liście */
    if (api && api.renderList) { try { api.renderList(); } catch (e) {} }
    syncConversation();
  }

  function timeText(ts) {
    try {
      var d = new Date(ts);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (e) { return ''; }
  }

  var lastRefresh = 0;
  function refresh(force) {
    if (!api || !api.renderList) return;
    var now = Date.now();
    if (!force && now - lastRefresh < 800) return;   /* bez młócenia renderów */
    lastRefresh = now;
    try { api.renderList(); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* odbiór radiem                                                       */
  /* ------------------------------------------------------------------ */
  function onMesh(ev) {
    var d = ev && ev.detail;
    if (!d || !d.text) return;
    var from = d.from || 'radio';
    push(from, { sender: 'them', text: String(d.text), at: d.at || Date.now(), st: 'radio' }, personSeed(from));
    noteOnline();
    syncConversation();
    refresh(true);   /* przyszła wiadomość — lista ma to pokazać od razu */
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */
  function boot() {
    if (state.booted) return true;
    state.booted = true;
    load();
    myId();

    if (root.addEventListener) {
      root.addEventListener('rise-mesh-message', onMesh);
      root.addEventListener('online', function () {
        noteOnline();
        syncDirectory().then(syncFromServer).then(function () { refresh(); });
        drain();
      });
      root.addEventListener('offline', function () { noteOffline(); refresh(); });
    }

    setTimeout(function () {
      syncDirectory().then(function () { return syncFromServer(); }).then(function () {
        syncConversation();
        refresh();
      });
    }, 1200);

    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      if (!doc || (doc.visibilityState && doc.visibilityState !== 'visible')) return;
      drain();
      syncConversation();
    }, DRAIN_MS);

    setInterval(function () {
      if (!doc || (doc.visibilityState && doc.visibilityState !== 'visible')) return;
      syncFromServer().then(function (n) {
        if (n) { syncConversation(); refresh(); }
      });
    }, SYNC_MS);

    setInterval(function () { if (api && api.current && api.current()) syncConversation(); }, TICK_MS);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* most do aplikacji: ustawia go łatka w bundlu                        */
  /* ------------------------------------------------------------------ */
  root.RISE_OFFLINE_CHAT = {
    boot: boot,
    /* aplikacja podaje swoje funkcje — moduł nic sam nie rysuje */
    useBridge: function (bridge) { api = bridge || null; return !!api; },
    merge: merge,
    person: person,
    preview: preview,
    notify: notify,
    refresh: refresh,
    syncConversation: syncConversation,
    offer: offer,
    remember: remember,
    drain: drain,
    noteOffline: noteOffline,
    noteQueued: noteQueued,
    isOffline: isOffline,
    peerId: function (id) { return id || null; },
    state: function () {
      var list = people();
      return {
        threads: list.length,
        messages: list.reduce(function (n, t) { return n + t.msgs.length; }, 0),
        pending: list.reduce(function (n, t) {
          return n + t.msgs.filter(function (m) { return m.st === 'queued'; }).length;
        }, 0),
        offline: isOffline(),
        me: state.me,
        bridged: !!api
      };
    },
    threads: function () {
      return people().map(function (t) {
        return { id: t.id, label: t.label, at: t.at, msgs: t.msgs.length, last: lastOf(t) };
      });
    },
    thread: function (id) {
      var t = state.threads[id];
      return t ? { id: t.id, label: t.label, msgs: t.msgs.slice() } : null;
    },
    mergeRows: mergeRows,
    syncFromServer: syncFromServer,
    syncDirectory: syncDirectory,
    ensureKey: ensureKey,
    _reset: function () { state.threads = {}; state.dir = []; state.lastSync = 0; save(); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
