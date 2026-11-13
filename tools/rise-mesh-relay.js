/* Rises — przekazywanie wiadomości przez inne telefony (store-and-forward).
 *
 * Sedno pomysłu: wiadomość nie leci jednym skokiem. Telefon nadawcy przekazuje
 * ją telefonowi w zasięgu, ten zapisuje ją u siebie, a gdy w jego zasięgu
 * pojawi się kolejny telefon, przekazuje ją dalej. Każdy przystanek to kilka
 * sekund przerwy — nie milisekund — i wymaga, żeby w tym miejscu był jakiś
 * telefon. Bez telefonów pomiędzy nadawcą a odbiorcą nie ma czego przekazywać:
 * to ograniczenie liczby urządzeń, nie częstotliwości.
 *
 * Ten moduł nie zna warstwy radiowej. Robi to, co musi być zrobione niezależnie
 * od tego, czy skok odbywa się przez Bluetooth, czy przez dźwięk: kopertę
 * wiadomości, identyfikator (żeby ta sama wiadomość nie krążyła w kółko),
 * limit skoków, termin ważności, decyzję „bezpośrednio czy przez pośrednika”
 * oraz rozliczenie nagród dla przekaźników (suma nigdy nie przekracza opłaty).
 */
(function (root) {
  var MAX_TTL = 64;
  var DEFAULT_TTL = 12;
  var DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;   // dzień
  var SEEN_LIMIT = 2000;

  function randomId() {
    var bytes = new Uint8Array(8);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < bytes.length; j++) out += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    return out;
  }

  /* Koperta: to, co naprawdę wędruje między telefonami. */
  function createEnvelope(body, opts) {
    opts = opts || {};
    var now = opts.now || Date.now();
    var ttl = opts.ttl === undefined ? DEFAULT_TTL : opts.ttl;
    if (ttl < 0 || ttl > MAX_TTL) throw new Error('zły limit skoków');
    if (!body || !String(body).length) throw new Error('pusta wiadomość');
    return {
      v: 1,
      id: opts.id || randomId(),
      to: opts.to || null,                 // znacznik odbiorcy (null = do wszystkich w zasięgu)
      from: opts.from || null,
      ttl: ttl,
      hops: 0,
      created: now,
      expires: opts.expires || (now + (opts.lifetimeMs || DEFAULT_LIFETIME_MS)),
      fee: opts.fee === undefined ? 0 : opts.fee,
      body: String(body)
    };
  }

  function isExpired(env, now) { return (now || Date.now()) >= env.expires; }

  /* Czy ten telefon ma przekazać wiadomość dalej. */
  function shouldForward(env, seen, now) {
    if (!env || env.v !== 1) return false;
    if (env.ttl <= 0) return false;
    if (isExpired(env, now)) return false;
    if (seen && seen.has(env.id)) return false;   // już ją widziałem — nie powielam
    return true;
  }

  /* Każdy przystanek zmniejsza limit skoków. */
  function forward(env) {
    var copy = {};
    for (var k in env) if (Object.prototype.hasOwnProperty.call(env, k)) copy[k] = env[k];
    copy.ttl = env.ttl - 1;
    copy.hops = env.hops + 1;
    return copy;
  }

  /* Zbiór widzianych identyfikatorów z ograniczeniem pamięci. */
  function createSeenStore(limit) {
    var order = [];
    var set = new Set();
    return {
      has: function (id) { return set.has(id); },
      add: function (id) {
        if (set.has(id)) return;
        set.add(id); order.push(id);
        if (order.length > (limit || SEEN_LIMIT)) { set.delete(order.shift()); }
      },
      size: function () { return set.size; }
    };
  }

  /* Wybór trasy: bezpośrednio, gdy odbiorca jest w zasięgu; inaczej przez
   * pośrednika; gdy nie ma nikogo — do kolejki (poczeka na następny telefon). */
  function planRoute(opts) {
    var peers = opts.peers || [];
    var target = opts.to || null;
    if (target) {
      for (var i = 0; i < peers.length; i++) if (peers[i].id === target) return 'direct';
    }
    if (peers.length) return 'relay';
    return 'queue';
  }

  /* Nagrody dla przekaźników: suma zawsze równa się opłacie nadawcy, nigdy
   * większa. Reszta z dzielenia idzie do ostatniego przekaźnika. */
  function splitReward(fee, hops) {
    fee = Math.max(0, Math.floor(fee || 0));
    hops = Math.max(0, Math.floor(hops || 0));
    if (!fee || !hops) return [];
    var each = Math.floor(fee / hops);
    var rest = fee - each * hops;
    var out = [];
    for (var i = 0; i < hops; i++) out.push(i === hops - 1 ? each + rest : each);
    return out;
  }

  /* --- model czasu: ile realnie trwa skok każdym nośnikiem --- */
  var CARRIERS = {
    // dźwięk: 100 bit/s, więc 200-bajtowa koperta to ~16 s nadawania + 2 s przerwy
    sound: { rangeM: 20, setupMs: 2000, bytesPerSecond: 12.5, note: 'metry, wymaga ciszy' },
    // Bluetooth (BLE): ~50 m na zewnątrz, ~2 s na połączenie i przesłanie
    ble: { rangeM: 50, setupMs: 1800, bytesPerSecond: 2000, note: 'dziesiątki metrów' },
    // Wi-Fi Direct: najdalej i najszybciej z bezpośrednich
    wifi: { rangeM: 120, setupMs: 2500, bytesPerSecond: 100000, note: 'do ~100 m' }
  };

  function hopTime(carrierName, bytes) {
    var c = CARRIERS[carrierName];
    if (!c) throw new Error('nieznany nośnik');
    return (c.setupMs + ((bytes || 200) / c.bytesPerSecond) * 1000) / 1000;  // sekundy
  }

  /* Ile skoków i ile czasu potrzeba na dystans — przy założeniu, że w każdym
   * miejscu po drodze stoi telefon. */
  function estimate(distanceM, carrierName, bytes) {
    var c = CARRIERS[carrierName];
    if (!c) throw new Error('nieznany nośnik');
    var hops = Math.ceil(distanceM / c.rangeM);
    var perHop = hopTime(carrierName, bytes);
    return { hops: hops, secondsPerHop: perHop, totalSeconds: hops * perHop, carrier: carrierName };
  }

  function formatDuration(sec) {
    if (sec < 90) return Math.round(sec) + ' s';
    if (sec < 5400) return (sec / 60).toFixed(1) + ' min';
    if (sec < 172800) return (sec / 3600).toFixed(1) + ' h';
    return (sec / 86400).toFixed(1) + ' dni';
  }


  /* --- nosiciel („kurier”): telefon zabiera wiadomość ze sobą ---
   * To jest sposób na odległość bez internetu: wiadomość nie musi przebyć
   * całej drogi falami — wystarczy, że kolejni ludzie noszą ją w kieszeni
   * i co jakiś czas ją rozgłaszają. Zasięg rośnie więc z liczbą osób,
   * a nie z częstotliwością tonu. */
  var CARRIER_TTL_MS = 72 * 60 * 60 * 1000;      // 3 doby
  var REBROADCAST_MIN_MS = 5 * 60 * 1000;        // nie częściej niż co 5 min
  var REBROADCAST_MAX_MS = 60 * 60 * 1000;       // maksymalnie raz na godzinę
  var MAX_CARRY_HOPS = 16;

  function createCarrier(opts) {
    opts = opts || {};
    var items = [];                                 // {env, firstSeen, lastSent, sends, gps}
    var seen = new Set();

    function add(envelope, gps) {
      if (!envelope || seen.has(envelope.id)) return false;
      if (envelope.hops >= MAX_CARRY_HOPS) return false;
      seen.add(envelope.id);
      items.push({
        env: envelope,
        firstSeen: Date.now(),
        lastSent: 0,
        sends: 0,
        gps: gps || null,
        expiresAt: Date.now() + (opts.ttlMs || CARRIER_TTL_MS)
      });
      return true;
    }

    /* Które wiadomości teraz rozgłosić: z odstępami rosnącymi w czasie,
     * żeby nie zamęczać eteru i baterii. */
    function due(now) {
      now = now || Date.now();
      var out = [];
      items = items.filter(function (it) { return now < it.expiresAt; });
      items.forEach(function (it) {
        var gap = Math.min(REBROADCAST_MAX_MS, REBROADCAST_MIN_MS * Math.pow(2, it.sends));
        if (now - it.lastSent >= gap) out.push(it);
      });
      return out;
    }

    function markSent(item, now) {
      item.lastSent = now || Date.now();
      item.sends++;
    }

    function remove(id) {
      items = items.filter(function (it) { return it.env.id !== id; });
    }

    function stats(now) {
      now = now || Date.now();
      var live = items.filter(function (it) { return now < it.expiresAt; });
      var maxHops = live.reduce(function (a, it) { return Math.max(a, it.env.hops); }, 0);
      return {
        carried: live.length,
        maxHops: maxHops,
        oldestMinutes: live.length ? Math.round((now - Math.min.apply(null, live.map(function (i) { return i.firstSeen; }))) / 60000) : 0
      };
    }

    return { add: add, due: due, markSent: markSent, remove: remove, stats: stats, items: function () { return items.slice(); } };
  }

  /* Ile osób potrzeba, żeby pokonać dystans: zasięg × liczba przekaźników.
   * Czas = skoki × (nadanie + oczekiwanie na kolejną osobę). */
  function carrierEstimate(distanceM, rangeM, transmitSec, waitSec) {
    var hops = Math.max(1, Math.ceil(distanceM / Math.max(1, rangeM)));
    var perHop = (transmitSec || 15) + (waitSec || 300);
    return { hops: hops, secondsPerHop: perHop, totalSeconds: hops * perHop, withWait: true };
  }

  var api = {
    createCarrier: createCarrier,
    carrierEstimate: carrierEstimate,
    createEnvelope: createEnvelope,
    shouldForward: shouldForward,
    forward: forward,
    isExpired: isExpired,
    createSeenStore: createSeenStore,
    planRoute: planRoute,
    splitReward: splitReward,
    hopTime: hopTime,
    estimate: estimate,
    formatDuration: formatDuration,
    CARRIERS: CARRIERS,
    randomId: randomId,
    MAX_TTL: MAX_TTL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_MESH_RELAY = api;
})(typeof window !== 'undefined' ? window : globalThis);
