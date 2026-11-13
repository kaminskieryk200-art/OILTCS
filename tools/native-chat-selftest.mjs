// Test referencyjny: OILTCS pod zwykłym interfejsem, bez własnego okna (v3.43.0).
// Uruchomienie: node tools/native-chat-selftest.mjs
//
// Nie ma tu Androida, radia ani prawdziwych kont. Sprawdzamy zachowanie modułu:
// czy nie tworzy żadnego widoku, czy dopisuje osoby do natywnej listy, czy
// wiadomość bez zasięgu idzie radiem i kolejką, czy kolejka wysyła się sama
// i czy to, co przyszło radiem, trafia do tej samej rozmowy w aplikacji.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const SRC = fs.readFileSync(new URL('./rise-native-chat.js', import.meta.url), 'utf8');
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

function jwt(sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256' }) + '.' + b({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.x';
}

/* Telefon: pamięć, strona (do odczytu klucza z bundla), atrapa serwera i radia.
 * `created` liczy, ile elementów moduł próbował utworzyć — musi być zero. */
function phone(opts = {}) {
  const ls = Object.assign({}, opts.storage || {});
  const listeners = {};
  const requests = [];
  const created = [];
  const defaultScripts = [{ text: 'var cfg={key:`sb_publishable_wZDLcF79U5_urQcXmUneOw_eykEZ5Sb`};' }];
  const scripts = (opts.scripts || defaultScripts).map((s) => ({
    src: s.src || '',
    textContent: s.text || '',
    getAttribute(k) { return k === 'src' ? (s.src || '') : null; }
  }));
  let clock = 0;

  const ctx = {
    crypto: { subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, String, Number, Object, Array, Error,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: { onLine: opts.online !== false },
    location: { href: 'https://localhost/' },
    URL, URLSearchParams,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
      get length() { return Object.keys(ls).length; },
      key: (i) => Object.keys(ls)[i] || null
    },
    document: {
      readyState: 'complete', visibilityState: 'visible',
      querySelectorAll: (sel) => (String(sel).indexOf('script') >= 0 ? scripts : []),
      querySelector: () => null,
      createElement: (t) => { created.push(t); return { style: {}, appendChild() {}, setAttribute() {} }; },
      addEventListener() {}, body: null, head: null
    }
  };
  ctx.window = ctx;
  ctx.window.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  ctx.window.dispatchEvent = (e) => { (listeners[e.type] || []).forEach((f) => f(e)); };
  ctx.fetch = (url, init) => {
    requests.push({ url: String(url), init: init || {} });
    if (opts.offline) return Promise.reject(new Error('offline'));
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (init && init.method === 'POST') {
      return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve(JSON.stringify([Object.assign({ id: 'srv-' + requests.length }, body)])) });
    }
    if (String(url).indexOf('/profiles') >= 0) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(opts.directory || [])) });
    }
    if (String(url).indexOf('index-') >= 0 && !String(url).includes('/rest/')) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(opts.bundle || '') });
    }
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(opts.history || [])) });
  };
  if (opts.radio) {
    ctx.window.RISE_AUTO_OILTCS = { nodeId: () => 'node-test', relay: opts.radio };
  }
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  /* tak samo jak aplikacja: most woła boot() przy pierwszym renderze */
  ctx.window.RISE_OFFLINE_CHAT.boot();
  return { ctx, ls, listeners, requests, created, api: ctx.window.RISE_OFFLINE_CHAT };
}

const ME = 'me-1';
const PEER = 'peer-1';
const auth = { 'sb-zxmnhbkqhupoaaocwzhw-auth-token': JSON.stringify({ access_token: jwt(ME) }) };
const history = [
  { id: 'h1', sender_id: ME, receiver_id: PEER, text: 'starsza wiadomość z serwera', type: 'text', created_at: new Date(Date.now() - 7200000).toISOString() },
  { id: 'h2', sender_id: PEER, receiver_id: ME, text: 'odpowiedź z serwera', type: 'text', created_at: new Date(Date.now() - 3600000).toISOString() }
];
const directory = [{ id: PEER, username: 'Kaminski', avatar_class: 'avatar-blue', status: 'Aktywny' }];

(async () => {
  /* --- 1. żadnego własnego widoku --- */
  const p1 = phone({ storage: auth, history, directory });
  await p1.api.syncDirectory();
  await p1.api.syncFromServer();
  p1.api.refresh();
  check('moduł nie tworzy żadnego elementu na ekranie', p1.created.length === 0, 'utworzył: ' + p1.created.join(','));
  check('nie ma klasy własnego okna w kodzie', !/rise-chat|rise-thread-row|rise-input-bar/.test(SRC));

  /* --- 2. historia z serwera jest w pamięci telefonu --- */
  const t1 = p1.api.thread(PEER);
  check('rozmowa z serwera w pamięci', !!t1 && t1.msgs.length === 2, t1 ? 'wiadomości: ' + t1.msgs.length : 'brak');

  /* --- 3. lista czatów: dopisujemy tylko brakujące osoby --- */
  const nativeList = [{ id: 'personal_notes', name: 'My Notepad' }, { id: 'other', name: 'Ktoś inny' }];
  const merged = p1.api.merge(nativeList, directory);
  check('lista bez duplikatów', merged.filter((e) => e.id === PEER).length === 1);
  const added = merged.find((e) => e.id === PEER);
  check('osoba z OILTCS jest na liście', !!added);
  check('z nazwą z katalogu', added && added.name === 'Kaminski', added && added.name);
  check('z podglądem ostatniej wiadomości', added && /odpowiedź z serwera/.test(added.status), added && added.status);
  check('natywne wpisy zostają nietknięte', merged.slice(0, 2).every((e, i) => e.id === nativeList[i].id));
  const merged2 = p1.api.merge(merged, directory);
  check('drugie scalenie nie dubluje', merged2.length === merged.length, merged2.length + ' vs ' + merged.length);

  /* --- 4. nagłówek rozmowy dla osoby spoza katalogu --- */
  p1.api.mergeRows([{ id: 'x1', sender_id: 'ghost-1', receiver_id: ME, text: 'jestem spoza katalogu', type: 'text', created_at: new Date().toISOString() }]);
  const ghost = p1.api.person('ghost-1');
  check('osoba spoza katalogu ma nagłówek', !!ghost && ghost.id === 'ghost-1');
  check('nazwa zamiast „Chat Partner"', ghost && ghost.name !== 'Chat Partner', ghost && ghost.name);

  /* --- 5. wysyłka bez internetu: radio --- */
  const sentRadio = [];
  const p2 = phone({ storage: auth, offline: true, radio: (from, to, text) => { sentRadio.push(text); return Promise.resolve(true); } });
  await p2.api.syncFromServer();
  const ok2 = await p2.api.offer(PEER, 'bez internetu, radiem');
  check('radio dostało treść', sentRadio.indexOf('bez internetu, radiem') >= 0);
  check('oznaczone jako wysłane radiem', p2.api.thread(PEER).msgs.some((m) => m.text === 'bez internetu, radiem' && m.st === 'radio'));

  /* --- 6. bez radia i bez sieci: kolejka, potem samo --- */
  const p3 = phone({ storage: auth, offline: true });
  await p3.api.syncFromServer();
  await p3.api.offer(PEER, 'czeka na zasięg');
  check('trafiła do kolejki', p3.api.state().pending === 1, 'czeka: ' + p3.api.state().pending);
  p3.ctx.fetch = (url, init) => {
    p3.requests.push({ url: String(url), init: init || {} });
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve(JSON.stringify([{ id: 'new-1', ...body }])) });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('[]') });
  };
  p3.ctx.window.dispatchEvent({ type: 'online' });
  await new Promise((r) => setTimeout(r, 40));
  check('kolejka opróżniona bez przycisku', p3.api.state().pending === 0, 'czeka: ' + p3.api.state().pending);
  check('serwer dostał wiadomość', p3.requests.some((r) => r.init.method === 'POST' && String(r.init.body).indexOf('czeka na zasięg') >= 0));

  /* --- 7. potwierdzony zapis trafia do pamięci --- */
  p3.api.remember(PEER, 'zapisane na serwerze', 'srv-9');
  check('potwierdzona wiadomość jest w pamięci', p3.api.thread(PEER).msgs.some((m) => m.text === 'zapisane na serwerze' && m.st === 'server'));

  /* --- 8. odbiór radiem + doklejenie do otwartej rozmowy --- */
  const nativeState = { [PEER]: [] };
  let renders = 0;
  p3.api.useBridge({
    current: () => PEER,
    setMessages: (fn) => { Object.assign(nativeState, fn(nativeState)); },
    renderList: () => { renders++; }
  });
  p3.ctx.window.dispatchEvent(new p3.ctx.CustomEvent('rise-mesh-message', { detail: { from: PEER, text: 'odpowiedź radiem', at: Date.now() } }));
  check('wiadomość z radia w tej samej rozmowie (pamięć)', p3.api.thread(PEER).msgs.some((m) => m.text === 'odpowiedź radiem'));
  check('doklejona do otwartej rozmowy w aplikacji', nativeState[PEER].some((m) => m.text === 'odpowiedź radiem'));
  check('jako wiadomość od drugiej osoby', nativeState[PEER].some((m) => m.text === 'odpowiedź radiem' && m.sender === 'them'));
  check('lista odświeżona przez aplikację', renders >= 1);
  const before = nativeState[PEER].length;
  p3.api.syncConversation();
  check('drugie doklejenie nic nie dubluje', nativeState[PEER].length === before, before + ' -> ' + nativeState[PEER].length);

  /* --- 8b. lista nie jest przerysowywana bez powodu (v3.43.1) ---
     Zgłoszenie: „nie da się przewijać". Moduł kazał aplikacji przerysować
     listę czatów co kilka sekund, a przy trzymanym palcu przeglądarka
     przerywa wtedy przewijanie. Teraz render idzie tylko przy zmianie treści. */
  p3.api.syncConversation();
  if (p3.api.refresh) p3.api.refresh(true);          // pierwsze odświeżenie może coś dopisać
  const rendersBefore = renders;
  p3.api.syncConversation();
  if (p3.api.refresh) { p3.api.refresh(); p3.api.refresh(true); }
  check('bez zmian w treści lista nie jest przerysowywana', renders === rendersBefore, rendersBefore + ' -> ' + renders);
  await new Promise((r) => setTimeout(r, 1600));      // moduł ma 1,5 s odstępu między przerysowaniami
  p3.ctx.window.dispatchEvent(new p3.ctx.CustomEvent('rise-mesh-message', { detail: { from: PEER, text: 'nowa przez radio', at: Date.now() } }));
  check('ale nowa wiadomość odświeża listę (nowy podgląd)', renders > rendersBefore, rendersBefore + ' -> ' + renders);

  /* --- 9. wiadomość czekająca pokazuje się w rozmowie jako „czeka" --- */
  p3.ctx.navigator.onLine = false;
  p3.ctx.fetch = () => Promise.reject(new Error('offline'));
  await p3.api.offer(PEER, 'jeszcze nie wyszła');
  await p3.api.syncConversation();
  const queued = nativeState[PEER].filter((m) => m.text === 'jeszcze nie wyszła');
  check('oczekująca wiadomość jest w oknie czatu', queued.length === 1);
  check('z etykietą „czeka na zasięg"', queued[0] && queued[0].localSendStatus === 'queued', queued[0] && queued[0].localSendStatus);

  /* --- 10. klucz publiczny z bundla (tak wygląda prawdziwy APK) --- */
  const bundleKey = 'sb_publishable_wZDLcF79U5_urQcXmUneOw_eykEZ5Sb';
  const p4 = phone({ storage: auth, scripts: [{ src: '/assets/index-abc.js' }], bundle: 'var cfg={key:`' + bundleKey + '`};' });
  check('klucz publiczny czytany z bundla', (await p4.api.ensureKey()) === bundleKey);
  check('klucz zostaje w pamięci telefonu', p4.ls['rise-net-key'] === bundleKey);
  const p5 = phone({ storage: Object.assign({}, auth, { 'rise-net-key': bundleKey }) });
  p5.ctx.fetch = () => Promise.reject(new Error('offline'));
  check('drugi start nie potrzebuje bundla', (await p5.api.ensureKey()) === bundleKey);

  /* --- 11. brak duplikatów i szyfrogram --- */
  p1.api.mergeRows([{ id: 'h2', sender_id: PEER, receiver_id: ME, text: 'odpowiedź z serwera', created_at: new Date().toISOString() }]);
  check('ta sama wiadomość z serwera nie dubluje się', p1.api.thread(PEER).msgs.filter((m) => m.text === 'odpowiedź z serwera').length === 1);
  p1.api.mergeRows([{ id: 'enc1', sender_id: PEER, receiver_id: ME, text: JSON.stringify({ version: 'ecdh-v1', iv: 'x', data: 'y' }), created_at: new Date().toISOString() }]);
  check('szyfrogram jest oznaczony, nie zmyślony', p1.api.thread(PEER).msgs.some((m) => m.text.indexOf('🔒') === 0));

  console.log('\n' + passed + ' OK, ' + failed + ' FAIL');
  process.exit(failed ? 1 : 0);
})();
