/* Rises — stacje przekaźnikowe („stacje ładowania sygnału").
 *
 * Pomysł: każde urządzenie z Rises, które wiadomość napotka, ma ją przyjąć,
 * „naładować sygnał do pełna" (czyli nadać ją od nowa z pełną mocą) i puścić
 * dalej do następnej stacji, aż dojdzie do celu. To dokładnie tak działa
 * prawdziwa sieć opóźnieniowa: każdy przystanek odnawia sygnał, więc jego
 * osłabienie nie sumuje się na całej trasie.
 *
 * Ten moduł opisuje samą logikę stacji — niezależnie od tego, czym sygnał
 * jedzie (Bluetooth, Wi-Fi, dźwięk). Warstwa radia jest osobno.
 *
 * WAŻNE OGRANICZENIE: „każde napotkane urządzenie" wymaga BLE (rozgłaszanie
 * do nieznanych telefonów). Klasyczny Bluetooth, który ma ta aplikacja,
 * wymaga WCZEŚNIEJSZEGO SPAROWANIA — czyli stacją może być tylko urządzenie
 * znane: własny drugi telefon, telefon rodziny, wcześniej sparowany znajomy.
 */
(function (root) {
  var FULL_CHARGE = 16;          // pełny zasięg w skokach
  var DEDUP_LIMIT = 500;

  /* Stacja: przyjmuje, ładuje i przekazuje dalej. */
  function createStation(id, opts) {
    opts = opts || {};
    var inbox = [];                       // odebrane, jeszcze nieprzekazane
    var seen = new Map();                 // id -> czas pierwszego przyjęcia
    var stats = { accepted: 0, relayed: 0, dropped: 0, delivered: 0 };

    function isDuplicate(env) {
      return seen.has(env.id);
    }

    /* Przyjęcie wiadomości. Zwraca true, gdy stacja ją zabrała
     * (nowa, nie duplikat, nie wygasła). */
    function accept(env, now) {
      now = now || Date.now();
      if (!env || !env.id) return false;
      if (isDuplicate(env)) { stats.dropped++; return false; }
      if (env.expires && now >= env.expires) { stats.dropped++; return false; }
      seen.set(env.id, now);
      if (seen.size > DEDUP_LIMIT) {
        // usuwamy najstarszy wpis, żeby pamięć nie rosła bez końca
        var oldestKey = null, oldestTime = Infinity;
        seen.forEach(function (t, k) { if (t < oldestTime) { oldestTime = t; oldestKey = k; } });
        if (oldestKey) seen.delete(oldestKey);
      }
      stats.accepted++;
      inbox.push({ env: env, at: now });
      return true;
    }

    /* „Naładowanie do pełna": kopia z pełnym zasięgiem, licznikiem skoków
     * i nowym czasem ważności. Sygnał nie słabnie na trasie — odnawia się
     * na każdej stacji, dokładnie jak w Twoim pomyśle. */
    function charge(env, now) {
      now = now || Date.now();
      var copy = {};
      for (var k in env) if (Object.prototype.hasOwnProperty.call(env, k)) copy[k] = env[k];
      copy.ttl = FULL_CHARGE;
      copy.hops = (env.hops || 0) + 1;
      copy.chargedAt = now;
      copy.chargedBy = id;
      copy.expires = now + (opts.lifetimeMs || 72 * 60 * 60 * 1000);
      return copy;
    }

    /* Co wysłać dalej: dla każdej przyjętej wiadomości naładowana kopia. */
    function outbox(now) {
      return inbox.map(function (item) { return charge(item.env, now); });
    }

    /* Czy ta wiadomość jest już dla mnie — czyli czy jestem celem. */
    function isForMe(env) {
      return !!(env.to && env.to === id) || env.to === null;
    }

    function markRelayed(envId) {
      inbox = inbox.filter(function (it) { return it.env.id !== envId; });
      stats.relayed++;
    }

    function markDelivered() { stats.delivered++; }

    function state() {
      return {
        id: id,
        inbox: inbox.length,
        seen: seen.size,
        accepted: stats.accepted,
        relayed: stats.relayed,
        dropped: stats.dropped,
        delivered: stats.delivered
      };
    }

    return {
      id: id,
      accept: accept,
      charge: charge,
      outbox: outbox,
      isForMe: isForMe,
      markRelayed: markRelayed,
      markDelivered: markDelivered,
      state: state,
      chargeLevel: function () { return FULL_CHARGE; }
    };
  }

  /* Rejestr stacji: które znamy, jak dawno je widzieliśmy, jak są pewne. */
  function createRegistry() {
    var stations = {};
    function add(entry) {
      if (!entry || !entry.id) return;
      stations[entry.id] = {
        id: entry.id,
        address: entry.address || null,       // adres MAC (Bluetooth)
        transport: entry.transport || 'bt',
        lastSeen: entry.lastSeen || Date.now(),
        reliability: entry.reliability === undefined ? 1 : entry.reliability
      };
    }
    function best(excludeId, avoidAddress) {
      var list = Object.keys(stations).map(function (k) { return stations[k]; })
        .filter(function (s) {
          return s.id !== excludeId && s.address &&
            String(s.address) !== String(avoidAddress || '') &&
            /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(String(s.address));
        });
      if (!list.length) return null;
      list.sort(function (a, b) {
        if (b.reliability !== a.reliability) return b.reliability - a.reliability;
        return b.lastSeen - a.lastSeen;
      });
      return list[0];
    }
    function all() { return Object.keys(stations).map(function (k) { return stations[k]; }); }
    return { add: add, best: best, all: all };
  }

  /* Ile stacji i ile czasu na dystans, gdy każda stacja ładuje sygnał do pełna. */
  function routeLength(distanceM, rangeM) {
    var hops = Math.max(1, Math.ceil(distanceM / Math.max(1, rangeM)));
    return { hops: hops, perStation: rangeM };
  }

  var api = {
    createStation: createStation,
    createRegistry: createRegistry,
    routeLength: routeLength,
    FULL_CHARGE: FULL_CHARGE
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RISE_STATIONS = api;
})(typeof window !== 'undefined' ? window : globalThis);
