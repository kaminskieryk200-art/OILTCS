// Test referencyjny: weryfikacja tożsamości kodem QR (bez kamery, bez radia).
// Uruchomienie: node tools/verify-selftest.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TOOLS = new URL('.', import.meta.url).pathname;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

function phone(nodeId) {
  const ls = { 'rise-node-id': nodeId };
  const ctx = {
    crypto: { subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, String, Number, Object, Array, Error, Buffer,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
      get length() { return Object.keys(ls).length; },
      key: (i) => Object.keys(ls)[i] || null
    },
    setTimeout: (fn) => { if (fn) { try { fn(); } catch (e) {} } return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    navigator: { onLine: false },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    Uint8ClampedArray, Float32Array, Set, Map
  };
  ctx.window = ctx;
  // minimalny ekran: moduły aplikacji rejestrują się przy starcie
  ctx.document = {
    readyState: 'complete',
    body: { appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {}, appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null,
      set textContent(v) { this._t = v; }, get textContent() { return this._t; }, id: ''
    }),
    addEventListener() {}
  };
  ctx.window.RisesBle = {
    isSupported: () => true, isEnabled: () => true, hasPermissions: () => true,
    askPermissions: () => {}, ensureOn: () => {}, start: () => {}, stop: () => {},
    isRunning: () => false, status: () => '', poll: () => '', peers: () => '',
    nearCount: () => 0, heardCount: () => 0, send: () => true
  };
  vm.createContext(ctx);
  /* rise-crypto.js MUSI być przed rise-verify.js: kod QR od v3.40.0 niesie
     dwa klucze (podpisów i szyfrowania), a bez tego modułu drugi jest pusty
     i parseCode odrzuca cały kod. */
  for (const f of ['rise-mesh-relay.js', 'rise-stations.js', 'rise-sign.js', 'rise-crypto.js', 'rise-auto-oiltcs.js', 'rise-verify.js']) {
    vm.runInContext(fs.readFileSync(TOOLS + f, 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const alice = phone('node-A');
const bob = phone('node-B');
const mallory = phone('node-C');

await alice.RISE_SIGN.init();
await bob.RISE_SIGN.init();
await mallory.RISE_SIGN.init();

// 1. Kod QR powstaje i daje się odczytać.
const code = await alice.RISE_VERIFY.myCode();
/* Od v3.40.0 kod niesie OBA klucze (podpisów i szyfrowania) — RVS2.
   Wcześniej test sprawdzał stary format RVS1 i przechodził tylko dlatego,
   że nikt go nie uruchamiał po zmianie. */
check('kod QR powstaje', /^RVS2\|node-A\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+$/.test(code), code.slice(0, 24));
const parsed = alice.RISE_VERIFY.parseCode(code);
check('kod QR daje się odczytać', !!parsed && parsed.node === 'node-A');
check('kod QR niesie też klucz szyfrowania', !!parsed && !!parsed.encKey);

// 2. Potwierdzenie zapisuje się u drugiej strony.
const res = bob.RISE_VERIFY.confirm(parsed.node, parsed.key, 'Ala');
check('potwierdzenie zapisane', res.ok === true);
check('osoba widnieje jako potwierdzona', bob.RISE_VERIFY.isVerified('node-A') === true);
check('nieznana osoba nie jest potwierdzona', bob.RISE_VERIFY.isVerified('node-Z') === false);

// 3. Wiadomość od potwierdzonego nadawcy przechodzi.
bob.RISE_AUTO_OILTCS.boot();
const payload = ['node-A', 'node-B', '16', '', 'Cześć'].join('\u0001');
const sig = await alice.RISE_SIGN.sign(payload);
const keyA = await alice.RISE_SIGN.publicKeyRaw();
const good = 'R2|node-A|node-B|16||' + keyA + '|' + sig.sig + '|Cześć';
check('wiadomość od potwierdzonego przechodzi', (await bob.RISE_AUTO_OILTCS.handleRadioText(good, null)) === true);

// 4. Oszust podający się za potwierdzonego jest odrzucany.
const fakePayload = ['node-A', 'node-B', '16', '', 'To nie ja'].join('\u0001');
const fakeSig = await mallory.RISE_SIGN.sign(fakePayload);
const keyM = await mallory.RISE_SIGN.publicKeyRaw();
const fake = 'R2|node-A|node-B|16||' + keyM + '|' + fakeSig.sig + '|To nie ja';
const inboxBefore = bob.RISE_AUTO_OILTCS.inbox().length;
const taken = await bob.RISE_AUTO_OILTCS.handleRadioText(fake, null);
check('oszust odrzucony', taken === false);
check('skrzynka bez zmian', bob.RISE_AUTO_OILTCS.inbox().length === inboxBefore);

// 5. Nie da się po cichu nadpisać potwierdzonej tożsamości.
const overwrite = bob.RISE_VERIFY.confirm('node-A', keyM, 'podmiana');
check('nadpisanie potwierdzonego klucza zablokowane', overwrite.ok === false, overwrite.reason);

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
console.log('Uwaga: potwierdza się telefon, nie osobę. Ktoś z odblokowaną aplikacją');
console.log('może pokazać cudzy kod QR — to ograniczenie każdej weryfikacji ekranowej.');
if (failed > 0) process.exit(1);
