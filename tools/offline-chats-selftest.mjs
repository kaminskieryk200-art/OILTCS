// Test referencyjny: czaty offline — rozmowy zostają na telefonie, gdy nie ma internetu.
// Uruchomienie: node tools/offline-chats-selftest.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const TOOLS = new URL('.', import.meta.url).pathname;
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const listeners = {};

function phone(nodeId, opts = {}) {
  const ls = { 'rise-node-id': nodeId };
  const ctx = {
    crypto: { subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, String, Number, Object, Array, Error, Buffer,
    Set, Map, Uint8ClampedArray, Float32Array,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout: (fn) => { if (fn) { try { fn(); } catch (e) {} } return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    navigator: { onLine: opts.online === undefined ? false : opts.online },
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
      set textContent(v) { this._t = v; }, get textContent() { return this._t; },
      id: '', value: '', setAttribute() {}, addEventListener() {}, children: []
    }),
    addEventListener() {}
  };
  ctx.window = ctx;
  ctx.window.addEventListener = (t, f) => { (listeners[nodeId] = listeners[nodeId] || {})[t] = f; };
  ctx.window.dispatchEvent = (e) => { const f = (listeners[nodeId] || {})[e.type]; if (f) f(e); };
  ctx.window.RisesBle = {
    isSupported: () => true, isEnabled: () => true, hasPermissions: () => true,
    askPermissions: () => {}, ensureOn: () => {}, start: () => {}, stop: () => {},
    isRunning: () => false, status: () => '', poll: () => '',
    peers: () => opts.peers || '', nearCount: () => 1, heardCount: () => 0, send: () => true
  };
  ctx.window.RisesRadio = {
    isAvailable: () => true, isEnabled: () => true, myAddress: () => nodeId,
    paired: () => opts.paired || '', hasConnect: () => true, askPermissions: () => {},
    ensureOn: () => {}, openSettings: () => {}, start: () => {}, stop: () => {},
    isRunning: () => false, status: () => '', poll: () => '', send: () => true, version: () => '2'
  };
  vm.createContext(ctx);
  for (const f of ['rise-mesh-relay.js', 'rise-stations.js', 'rise-sign.js', 'rise-crypto.js', 'rise-mark.js',
                   'rise-bt.js', 'rise-ble.js', 'rise-auto-oiltcs.js', 'rise-verify.js', 'rise-offline-chats.js']) {
    vm.runInContext(fs.readFileSync(TOOLS + f, 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

const alice = phone('node-A', { peers: 'BB:BB:BB:BB:BB:02|-48', paired: 'Telefon brata\tBB:BB:BB:BB:BB:02' });
await alice.RISE_SIGN.init();
await alice.RISE_CRYPTO.init();
alice.RISE_AUTO_OILTCS.boot();

check('telefon wie, że nie ma internetu', alice.RISE_OFFLINE_CHATS.isOffline() === true);

const people = alice.RISE_OFFLINE_CHATS.knownPeople();
check('lista osób działa bez internetu', people.length > 0, 'osób: ' + people.length);
check('osoba widziana przez BLE jest na liście', people.some((p) => p.node === 'BB:BB:BB:BB:BB:02'));

const sent = await alice.RISE_OFFLINE_CHATS.send('BB:BB:BB:BB:BB:02', 'Cześć bez zasięgu', 'Telefon brata');
check('wiadomość przyjęta do wysyłki', sent.ok === true);
const threads = alice.RISE_OFFLINE_CHATS.list();
check('powstała rozmowa', threads.length === 1);
check('treść zapisana lokalnie', threads[0].msgs[0].text === 'Cześć bez zasięgu');
check('wiadomość wyszła z telefonu', sent.sent === true, threads[0].msgs[0].status);

alice.dispatchEvent({ type: 'rise-mesh-message', detail: { from: 'node-Z', text: 'Odpowiedź', at: Date.now() } });
const after = alice.RISE_OFFLINE_CHATS.list();
check('odebrana wiadomość utworzyła rozmowę', after.length === 2);
check('historia rośnie', alice.RISE_OFFLINE_CHATS.state().messages === 2);
check('rozmowy są w pamięci urządzenia', alice.RISE_OFFLINE_CHATS.state().threads > 0);

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
console.log('Uwaga: to osobny widok czatów offline, nie wpięcie w natywną listę aplikacji.');
console.log('Historia z serwera nie jest kopiowana — lokalna rozmowa zaczyna się od pierwszej');
console.log('wiadomości wysłanej lub odebranej bez internetu.');
if (failed > 0) process.exit(1);
