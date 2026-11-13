// Test referencyjny: weryfikacja NA ODLEGŁOŚĆ bez internetu.
//  1. krótki kod bezpieczeństwa (do przeczytania przez telefon / SMS),
//  2. poręczenia od zaufanych znajomych, jadące przez sieć.
// Uruchomienie: node tools/distance-verify-selftest.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

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
    Set, Map, Uint8ClampedArray, Float32Array,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: (fn) => { if (fn) { try { fn(); } catch (e) {} } return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    cancelAnimationFrame: () => {}, requestAnimationFrame: () => 0,
    navigator: { onLine: false },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
      get length() { return Object.keys(ls).length; },
      key: (i) => Object.keys(ls)[i] || null
    }
  };
  ctx.document = {
    readyState: 'complete',
    body: { appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({
      style: {}, appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null,
      set textContent(v) { this._t = v; }, get textContent() { return this._t; }, id: '', value: '', setAttribute() {}
    }),
    addEventListener() {}
  };
  ctx.window = ctx;
  ctx.window.RisesBle = {
    isSupported: () => true, isEnabled: () => true, hasPermissions: () => true,
    askPermissions: () => {}, ensureOn: () => {}, start: () => {}, stop: () => {},
    isRunning: () => false, status: () => '', poll: () => '', peers: () => '',
    nearCount: () => 0, heardCount: () => 0, send: () => true
  };
  vm.createContext(ctx);
  for (const f of ['rise-mesh-relay.js', 'rise-stations.js', 'rise-sign.js', 'rise-auto-oiltcs.js', 'rise-verify.js']) {
    vm.runInContext(fs.readFileSync(TOOLS + f, 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const alice = phone('node-A');   // daleko, ale zna Dawida
const bob = phone('node-B');     // nie zna Dawida
const david = phone('node-D');   // daleko od Boba
const eve = phone('node-E');     // nieznajoma

for (const p of [alice, bob, david, eve]) await p.RISE_SIGN.init();

// 1. Kod bezpieczeństwa da się przeczytać przez telefon.
const codeA = await alice.RISE_VERIFY.myFingerprint();
check('kod ma 12 znaków w trzech grupach', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codeA), codeA);
check('kod jest stały', codeA === (await alice.RISE_VERIFY.myFingerprint()));
check('różne osoby mają różne kody', codeA !== (await bob.RISE_VERIFY.myFingerprint()));

// 2. Sprawdzenie przepisanego kodu.
const keyA = await alice.RISE_SIGN.publicKeyRaw();
check('właściwy kod przechodzi', (await bob.RISE_VERIFY.checkFingerprint('node-A', keyA, codeA)).ok === true);
check('zły kod odrzucony', (await bob.RISE_VERIFY.checkFingerprint('node-A', keyA, 'AAAA-BBBB-CCCC')).ok === false);

// 3. Potwierdzenie kodem działa na odległość.
check('potwierdzenie kodem zapisane', bob.RISE_VERIFY.confirm('node-A', keyA, 'Ala').ok === true);

// 4. Poręczenie: Ala zna Dawida, Bob nie — Ala poręcza przez sieć.
const keyD = await david.RISE_SIGN.publicKeyRaw();
const vouch = await alice.RISE_VERIFY.makeVouch('node-D', keyD, 3);
check('poręczenie powstało', typeof vouch === 'string' && vouch.startsWith('V1|'));
const accepted = await bob.RISE_VERIFY.acceptVouch(vouch);
check('poręczenie przyjęte', accepted.ok === true, accepted.reason);
check('Dawid ma poziom „poręczony"', bob.RISE_VERIFY.trustOf('node-D', keyD).level === 'poręczony');

// 5. Poręczenie od nieznajomej jest odrzucane.
const vouchEve = await eve.RISE_VERIFY.makeVouch('node-D', keyD, 1);
const rejected = await bob.RISE_VERIFY.acceptVouch(vouchEve);
check('poręczenie od nieznajomej odrzucone', rejected.ok === false, rejected.reason);

// 6. Sprzeczne poręczenie o tej samej osobie jest odrzucane.
const otherKey = await eve.RISE_SIGN.publicKeyRaw();
const conflicting = await alice.RISE_VERIFY.makeVouch('node-D', otherKey, 3);
const conflict = await bob.RISE_VERIFY.acceptVouch(conflicting);
check('sprzeczne poręczenie odrzucone', conflict.ok === false, conflict.reason);

// 7. Zaufanie jest widoczne przy wiadomości.
check('potwierdzony nadawca', bob.RISE_VERIFY.trustOf('node-A', keyA).level === 'potwierdzony');
check('nieznany nadawca', bob.RISE_VERIFY.trustOf('node-Z', keyA).level === 'nieznany');

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
console.log('Uwaga: poręczenie przenosi zaufanie — jeśli poręczyciel się myli, błąd idzie dalej.');
console.log('Kod przeczytany przez telefon można podsłuchać. To nie jest kryptograficzne');
console.log('uwierzytelnienie bez wspólnego kanału, tylko jego najbliższy praktyczny zamiennik.');
if (failed > 0) process.exit(1);
