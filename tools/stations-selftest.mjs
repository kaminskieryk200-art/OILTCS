// Test referencyjny: stacje ładujące sygnał, deduplikacja, brak pętli.
// Uruchomienie: node tools/stations-selftest.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ST = require('./rise-stations.js');
const RELAY = require('./rise-mesh-relay.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

// 1. Stacja przyjmuje wiadomość i ładuje ją do pełna.
const station = ST.createStation('stacja-1');
const env = RELAY.createEnvelope('treść', { from: 'a', to: 'b', ttl: 4 });
const accepted = station.accept(env);
check('stacja przyjmuje nową wiadomość', accepted === true);
const charged = station.charge(env);
check('naładowanie przywraca pełny zasięg', charged.ttl === ST.FULL_CHARGE, 'ttl=' + charged.ttl);
check('naładowanie liczy skok', charged.hops === 1, 'hops=' + charged.hops);
check('naładowanie ustawia nowy termin ważności', charged.expires > Date.now());

// 2. Ta sama wiadomość drugi raz nie krąży.
check('duplikat odrzucony', station.accept(env) === false);
check('duplikat policzony', station.state().dropped === 1);

// 3. Sygnał nie słabnie na trasie — pięć RÓŻNYCH stacji pod rząd.
let e = RELAY.createEnvelope('długa trasa', { from: 'a', to: 'b', ttl: ST.FULL_CHARGE });
for (let i = 1; i <= 5; i++) {
  const s = ST.createStation('trasa-' + i);
  if (!s.accept(e)) { check('stacja ' + i + ' przyjmuje wiadomość', false); break; }
  e = s.charge(e);
}
check('po 5 skokach zasięg nadal pełny', e.ttl === ST.FULL_CHARGE, 'ttl=' + e.ttl);
check('po 5 skokach licznik skoków = 5', e.hops === 5, 'hops=' + e.hops);

// 3b. Ta sama stacja nie przyjmie tej samej wiadomości drugi raz (brak pętli).
const loop = ST.createStation('petla');
const e2 = RELAY.createEnvelope('pętla', { ttl: ST.FULL_CHARGE });
loop.accept(e2);
check('ta sama stacja odrzuca powrót tej samej wiadomości', loop.accept(e2) === false);

// 4. Wygaśnięcie.
const old = RELAY.createEnvelope('stara', { ttl: ST.FULL_CHARGE });
old.expires = Date.now() - 1000;
check('wygasła wiadomość odrzucona', ST.createStation('wygasla').accept(old) === false);

// 5. Rejestr wybiera stację z prawdziwym adresem MAC.
const reg = ST.createRegistry();
reg.add({ id: 'bez-adresu', lastSeen: Date.now(), reliability: 1 });
reg.add({ id: 'z-adresem', address: 'AA:BB:CC:DD:EE:FF', lastSeen: Date.now(), reliability: 1 });
const best = reg.best('ja');
check('rejestr wybiera stację z adresem', best && best.id === 'z-adresem');
check('rejestr pomija wskazany adres', reg.best('ja', 'AA:BB:CC:DD:EE:FF') === null);

// 6. Ile stacji na dystans.
check('100 m = 5 stacji po 20 m', ST.routeLength(100, 20).hops === 5);
check('1 km = 50 stacji po 20 m', ST.routeLength(1000, 20).hops === 50);

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
if (failed > 0) process.exit(1);
