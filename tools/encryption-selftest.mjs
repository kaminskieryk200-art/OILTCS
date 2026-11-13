// Test referencyjny: szyfrowanie bez hasła + znak wodny dla konkretnej pary osób.
// Uruchomienie: node tools/encryption-selftest.mjs
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
    createElement: () => ({ style: {}, appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null,
      set textContent(v) { this._t = v; }, get textContent() { return this._t; }, id: '', value: '', setAttribute() {} }),
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
  for (const f of ['rise-mesh-relay.js', 'rise-stations.js', 'rise-sign.js', 'rise-crypto.js', 'rise-mark.js', 'rise-auto-oiltcs.js', 'rise-verify.js']) {
    vm.runInContext(fs.readFileSync(TOOLS + f, 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const alice = phone('node-A');
const bob = phone('node-B');
const eve = phone('node-C');
for (const p of [alice, bob, eve]) { await p.RISE_SIGN.init(); await p.RISE_CRYPTO.init(); p.RISE_AUTO_OILTCS.boot(); }

// 1. Klucze szyfrowania są osobne dla każdego telefonu.
check('każdy telefon ma własny klucz szyfrowania',
  alice.RISE_CRYPTO.myKey() !== bob.RISE_CRYPTO.myKey());

// 2. Wymiana kluczy kodem QR przenosi OBA klucze.
const codeA = await alice.RISE_VERIFY.myCode();
check('kod QR niesie klucz podpisów i szyfrowania', /^RVS2\|node-A\|[^|]+\|[^|]+$/.test(codeA));
const parsed = bob.RISE_VERIFY.parseCode(codeA);
bob.RISE_VERIFY.confirm(parsed.node, parsed.key, 'Ala', parsed.encKey);
check('odbiorca zna klucz szyfrowania nadawcy', !!bob.RISE_CRYPTO.peerKey('node-A'));

// 3. Wiadomość jest szyfrowana kluczem odbiorcy — bez hasła.
alice.RISE_CRYPTO.learnPeer('node-B', bob.RISE_CRYPTO.myKey());
const secret = 'Hasło do bramy: 7781';
const wire = await alice.RISE_AUTO_OILTCS.prepareBody('node-A', 'node-B', secret);
check('na drucie jest szyfrogram', wire.startsWith('RSX1:'), wire.slice(0, 12));
check('na drucie nie ma jawnej treści', wire.indexOf('7781') < 0);

// 4. Odbiorca czyta, postronny nie.
const readByBob = await bob.RISE_AUTO_OILTCS.odbierz(wire, 'node-A');
const readByEve = await eve.RISE_AUTO_OILTCS.odbierz(wire, 'node-A');
check('odbiorca odczytuje treść', readByBob === secret, readByBob);
check('postronny nie odczytuje', readByEve === null);

// 5. Znak wodny jest w środku i nie zmienia tekstu dla człowieka.
const M = alice.RISE_MARK;
const stamped = await M.stamp('Tajna treść', {
  serial: 'S1', toNode: 'node-B', toKey: bob.RISE_CRYPTO.myKey(),
  fromNode: 'node-A', fromKey: alice.RISE_CRYPTO.myKey(), seq: 7
});
const parsedMark = M.read(stamped);
check('znak wodny da się odczytać', !!parsedMark.mark);
check('człowiek widzi czysty tekst', parsedMark.text === 'Tajna treść');
check('znak pasuje do pary A→B', (await M.check(stamped, {
  toNode: 'node-B', toKey: bob.RISE_CRYPTO.myKey(),
  fromNode: 'node-A', fromKey: alice.RISE_CRYPTO.myKey()
})).ok === true);
check('ten sam znak nie pasuje do innego odbiorcy', (await M.check(stamped, {
  toNode: 'node-C', toKey: eve.RISE_CRYPTO.myKey(),
  fromNode: 'node-A', fromKey: alice.RISE_CRYPTO.myKey()
})).ok === false);
check('ten sam znak nie pasuje do innego nadawcy', (await M.check(stamped, {
  toNode: 'node-B', toKey: bob.RISE_CRYPTO.myKey(),
  fromNode: 'node-C', fromKey: eve.RISE_CRYPTO.myKey()
})).ok === false);

// 6. Bez klucza odbiorcy wiadomość idzie jawnie (i jest liczona jako taka).
const noKey = await alice.RISE_AUTO_OILTCS.prepareBody('node-A', 'node-Z', 'brak klucza');
check('brak klucza = wiadomość jawna', !noKey.startsWith('RSX1:'));

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
console.log('Uwaga: klucz prywatny leży w pamięci aplikacji. Kto ma odblokowany telefon,');
console.log('ten ma klucz. Znak wodny pozwala rozpoznać wyciek, nie zapobiega mu.');
if (failed > 0) process.exit(1);
