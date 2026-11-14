/* Rises Spaces (v3.44.0) — kanały publiczne, jak na Discordzie.
 *
 * Zasada ta sama, co przy OILTCS: ZERO własnego okna. Kanał publiczny to
 * zwykły czat w aplikacji — ta sama lista, ten sam nagłówek, to samo pole
 * tekstowe, ten sam przycisk „Wyślij". Ten moduł tylko:
 *
 *   1. pokazuje kanały publiczne na liście czatów (te, do których nie należysz),
 *   2. przy wejściu dopisuje Cię do kanału, żebyś mógł w nim pisać,
 *   3. dla kanałów publicznych wyłącza szyfrowanie — kanał jest publiczny
 *      z założenia, a szyfrogram psułby podgląd na liście i historię,
 *   4. oznacza autora wiadomości w kanale (wiadomość od „R" nie wygląda jak
 *      od rozmówcy),
 *   5. daje aplikacji sekundę na wczytanie historii zaraz po wejściu — bez
 *      tego pierwsze wejście w kanał pokazywałoby pusty ekran do odświeżenia.
 *
 * Nie rysuje żadnego elementu: RISE_SPACES nie tworzy DOM-u, dostaje stan
 * aplikacji przez useBridge() (tak samo jak RISE_OFFLINE_CHAT).
 */
(function (root) {
  'use strict';
  if (root.RISE_SPACES) return;

  var CACHE = 'rise-spaces-v1';        /* publiczne kanały: id, nazwa, temat */
  var SYNC_MS = 120000;                /* odświeżanie listy kanałów */
  var api = null;                      /* most do aplikacji */
  var booted = false;
  var channels = [];                   /* [{id,name,slug,topic,avatarClass}] */
  var joined = {};                     /* id kanału -> true (już dopisany) */
  var activeId = null;
  var doc = root.document || null;

  function storage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function load() {
    var ls = storage();
    if (!ls) return;
    try {
      var raw = JSON.parse(ls.getItem(CACHE) || '[]');
      if (Array.isArray(raw)) channels = raw;
    } catch (e) {}
  }

  function save() {
    var ls = storage();
    if (!ls) return;
    try { ls.setItem(CACHE, JSON.stringify(channels.slice(0, 80))); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* dostęp do serwera — ten sam, którego używa reszta aplikacji          */
  /* ------------------------------------------------------------------ */
  function client() {
    var c = root.__riseSupabase || root.supabaseClient || null;
    if (c && c.from) return c;
    return null;
  }

  function myId() {
    try {
      if (api && api.myId) return api.myId() || null;
    } catch (e) {}
    var ls = storage();
    if (!ls) return null;
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (!k) continue;
      if (k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0) {
        try {
          var v = JSON.parse(ls.getItem(k));
          var u = v && (v.user || (v.currentSession && v.currentSession.user));
          if (u && u.id) return u.id;
        } catch (e) {}
      }
    }
    return null;
  }

  function isSpace(id) {
    if (!id) return false;
    for (var i = 0; i < channels.length; i++) if (channels[i].id === id) return true;
    return false;
  }

  function byId(id) {
    for (var i = 0; i < channels.length; i++) if (channels[i].id === id) return channels[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* lista kanałów z serwera                                             */
  /* ------------------------------------------------------------------ */
  function syncChannels() {
    var q = client();
    if (!q) return Promise.resolve(0);
    return q.from('spaces_channels')
      .select('group_id, slug, topic, is_public')
      .eq('is_public', true)
      .limit(60)
      .then(function (res) {
        var rows = (res && res.data) || [];
        if (!rows.length) return 0;
        var ids = rows.map(function (r) { return r.group_id; });
        return q.from('groups').select('id, name, description, avatar_class').in('id', ids).then(function (g) {
          var info = {};
          ((g && g.data) || []).forEach(function (x) { info[x.id] = x; });
          var next = rows.map(function (r) {
            var meta = info[r.group_id] || {};
            return {
              id: r.group_id,
              slug: r.slug,
              name: meta.name || ('#' + r.slug),
              topic: r.topic || meta.description || '',
              avatarClass: meta.avatar_class || 'avatar-blue',
              public: true
            };
          });
          var changed = JSON.stringify(next) !== JSON.stringify(channels);
          channels = next;
          save();
          return changed ? next.length : 0;
        });
      })
      .then(function (n) { if (n) refreshList(); return n; })
      .catch(function () { return 0; });
  }

  /* ------------------------------------------------------------------ */
  /* dopisanie siebie do kanału publicznego                              */
  /* ------------------------------------------------------------------ */
  function join(channelId) {
    var q = client(), me = myId();
    if (!q || !me || !channelId) return Promise.resolve(false);
    if (joined[channelId]) return Promise.resolve(true);
    joined[channelId] = true;
    return q.from('group_members')
      .insert({ group_id: channelId, user_id: me, role: 'member' })
      .then(function (res) {
        if (res && res.error && res.error.code !== '23505') {
          joined[channelId] = false;                       /* spróbujemy następnym razem */
          return false;
        }
        return true;
      })
      .catch(function () { joined[channelId] = false; return false; });
  }

  /* ------------------------------------------------------------------ */
  /* wkład do listy czatów i do rozmowy                                  */
  /* ------------------------------------------------------------------ */
  function merge(list) {
    if (!Array.isArray(list)) return list;
    var have = {};
    list.forEach(function (e) { if (e && e.id) have[e.id] = true; });
    var extra = [];
    channels.forEach(function (c) {
      if (!c || !c.id || have[c.id] || !c.public) return;
      have[c.id] = true;
      extra.push({
        id: c.id,
        name: '#' + c.name.replace(/^#/, ''),
        avatarClass: c.avatarClass || 'avatar-blue',
        online: true,
        status: c.topic || 'Kanał publiczny',
        type: 'group',
        topic: c.topic || ''
      });
    });
    return extra.length ? list.concat(extra) : list;
  }

  /* Osoba w nagłówku rozmowy: dla kanału — nazwa kanału. */
  function person(id) {
    var c = byId(id);
    if (!c) return null;
    return {
      id: c.id,
      name: '#' + c.name.replace(/^#/, ''),
      avatarClass: c.avatarClass || 'avatar-blue',
      online: true,
      status: c.topic || 'Kanał publiczny'
    };
  }

  /* Szyfrowanie: kanał publiczny nie jest szyfrowany. Aplikacja pyta tym
     mostem, czy dla danego czatu ma szyfrować. */
  function plain(id) { return isSpace(id); }

  /* Autor wiadomości w kanale — żeby nie wyglądała jak od rozmówcy. */
  var names = {};
  function authorName(senderId) {
    if (!senderId) return '';
    if (names[senderId] !== undefined) return names[senderId];
    var q = client();
    if (!q) return '';
    names[senderId] = '';
    q.from('profiles').select('id, username').eq('id', senderId).then(function (r) {
      var row = r && r.data && r.data[0];
      names[senderId] = (row && row.username) || '';
    }).catch(function () {});
    return '';
  }

  function senderOf(msg) {
    if (!msg) return '';
    return authorName(msg.sender_id);
  }


  /* ------------------------------------------------------------------ */
  /* historia kanału                                                     */
  /* ------------------------------------------------------------------ */
  /* Aplikacja wczytuje historię w efekcie uruchamianym przy zmianie
     rozmowy — ale w chwili kliknięcia w kanał nie jesteśmy jeszcze jego
     członkiem, więc serwer nic nie zwraca. Dlatego po dopisaniu wczytujemy
     historię sami i podajemy ją aplikacji tym samym setterem, którego
     używa. Bez tego pierwsze wejście w kanał było puste do odświeżenia. */
  function looksEncrypted(t) {
    if (typeof t !== 'string' || t.charAt(0) !== '{') return false;
    try {
      var o = JSON.parse(t);
      return !!(o && (o.version === 'ecdh-v1' || o.ciphertext));
    } catch (e) { return false; }
  }

  function timeOf(ts) {
    try {
      var d = new Date(ts);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (e) { return ''; }
  }

  function toAppMsg(row, me) {
    return {
      id: row.id,
      sender: row.sender_id === me ? 'me' : 'them',
      text: looksEncrypted(row.text) ? '\ud83d\udd12 Wiadomo\u015b\u0107 zaszyfrowana' : row.text,
      time: timeOf(row.created_at),
      type: row.type || 'text',
      duration: row.duration || null,
      reactions: row.reactions || {},
      deleted_for: row.deleted_for || [],
      sender_id: row.sender_id,
      reply_to: row.reply_to || null,
      reply_to_text: row.reply_to_text || null,
      reply_to_sender: row.reply_to_sender || null,
      thread_id: row.thread_id || null
    };
  }

  function loadHistory(id) {
    var q = client(), me = myId();
    if (!q || !id || !api || !api.setMessages) return Promise.resolve(0);
    return q.from('messages').select('*').eq('group_id', id)
      .order('created_at', { ascending: true }).limit(300)
      .then(function (res) {
        var rows = ((res && res.data) || []).filter(function (r) { return r && r.id != null; });
        if (!rows.length) return 0;
        var fresh = rows.map(function (r) { return toAppMsg(r, me); });
        api.setMessages(function (all) {
          var have = (all && all[id]) || [];
          var seen = {};
          have.forEach(function (m) { if (m && m.id != null) seen[String(m.id)] = true; });
          var add = fresh.filter(function (m) { return !seen[String(m.id)]; });
          if (!add.length) return all;
          return Object.assign({}, all, (function () {
            var o = {};
            o[id] = have.concat(add);
            return o;
          })());
        });
        return fresh.length;
      })
      .catch(function () { return 0; });
  }

  /* ------------------------------------------------------------------ */
  /* odświeżanie listy czatów                                            */
  /* ------------------------------------------------------------------ */
  var lastSig = '', lastAt = 0;

  function signature() {
    return channels.map(function (c) { return c.id + '|' + c.name + '|' + (c.topic || ''); }).join('\n');
  }

  function refreshList(force) {
    if (!api || !api.renderList || !channels.length) return false;
    var sig = signature();
    if (sig === lastSig) return false;
    if (!force && Date.now() - lastAt < 1200) return false;
    lastSig = sig;
    lastAt = Date.now();
    try { api.renderList(); } catch (e) {}
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* wejście w kanał                                                     */
  /* ------------------------------------------------------------------ */
  function onOpen(id) {
    if (!id || !isSpace(id)) return;
    activeId = id;
    join(id).then(function () { loadHistory(id); });
    setTimeout(function () { loadHistory(id); }, 1200);
    /* Aplikacja wczytuje historię w efekcie zależnym od wybranej rozmowy.
       Po dopisaniu do kanału musi wczytać ją jeszcze raz — inaczej pierwsze
       wejście pokazuje pusty ekran do następnego odświeżenia. */
    var again = function () {
      try { if (api && api.reloadMessages) api.reloadMessages(id); } catch (e) {}
    };
    setTimeout(again, 350);
    setTimeout(again, 1600);
  }

  /* ------------------------------------------------------------------ */
  /* start                                                               */
  /* ------------------------------------------------------------------ */
  function boot() {
    if (booted) return true;
    booted = true;
    load();
    syncChannels();
    setInterval(function () { syncChannels(); }, SYNC_MS);
    if (root.addEventListener) {
      root.addEventListener('online', function () { syncChannels(); });
    }
    return true;
  }

  root.RISE_SPACES = {
    boot: boot,
    useBridge: function (bridge) { api = bridge || null; return !!api; },
    /* dla patchera w bundlu */
    merge: merge,
    person: person,
    plain: plain,
    isSpace: isSpace,
    onOpen: onOpen,
    open: onOpen,
    senderOf: senderOf,
    loadHistory: loadHistory,
    channels: function () { return channels.slice(); },
    sync: syncChannels,
    refresh: refreshList,
    joined: function (id) { return !!joined[id]; },
    active: function () { return activeId; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
