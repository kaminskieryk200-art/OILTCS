// Test referencyjny: czaty bez internetu w zwykłych czatach (v3.42.0).
// Uruchomienie: node tools/native-chat-selftest.mjs
//
// Nie ma tu Androida, radia ani prawdziwych kont — jest drzewo DOM (te same
// klasy, których używa aplikacja) i atrapa serwera. Sprawdzamy zachowanie
// modułu, nie wygląd: czy rozmowy są w istniejącej liście, czy historia
// z serwera trafia do pamięci telefonu, czy wiadomość bez zasięgu czeka
// i wysyła się sama, i czy nic nie tworzy drugiego interfejsu.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const SRC = fs.readFileSync(new URL('./rise-native-chat.js', import.meta.url), 'utf8');
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

/* --- minimalne drzewo DOM: tyle, ile moduł naprawdę używa --- */
function makeDom() {
  function node(tag) {
    const n = {
      tagName: String(tag || 'div').toUpperCase(), className: '', style: {}, dataset: {},
      childNodes: [], parentNode: null, attrs: {}, _text: '', value: '', type: '',
      set textContent(v) { this._text = String(v); this.childNodes = []; },
      get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(' '); },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
      insertBefore(c, ref) {
        c.parentNode = this;
        const i = this.childNodes.indexOf(ref);
        if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
        return c;
      },
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) this.childNodes.splice(i, 1);
        return c;
      },
      addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
      dispatchEvent() { return true; }, requestSubmit() {},
      closest(sel) { return this._matches(sel) ? this : (this.parentNode && this.parentNode.closest ? this.parentNode.closest(sel) : null); },
      querySelectorAll(sel) { return findAll(this, sel); },
      querySelector(sel) { return findAll(this, sel)[0] || null; },
      _matches(sel) {
        const want = String(sel).trim();
        const compound2 = /^([a-zA-Z]+)\.([\w-]+)$/.exec(want);
        if (compound2) {
          return this.tagName === compound2[1].toUpperCase() && (' ' + this.className + ' ').indexOf(' ' + compound2[2] + ' ') >= 0;
        }
        const compound = /^([a-zA-Z]+)\[([^\]]+)\]$/.exec(want);
        if (compound) {
          return this.tagName === compound[1].toUpperCase() && this._matches('[' + compound[2] + ']');
        }
        if (want.startsWith('.')) return (' ' + this.className + ' ').indexOf(' ' + want.slice(1) + ' ') >= 0;
        if (want.startsWith('[')) {
          const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(want);
          if (!m) return false;
          if (!(m[1] in this.attrs)) return false;
          return m[2] === undefined || this.attrs[m[1]] === m[2];
        }
        return this.tagName === want.toUpperCase();
      }
    };
    n.setAttribute = (function (orig) {
      return function (k, v) {
        orig.call(n, k, v);
        if (k === 'class') n.className = String(v);
        if (k === 'type') n.type = String(v);
        if (k === 'src') n.src = String(v);
      };
    })(n.setAttribute);
    /* prototyp: imitacja HTMLInputElement.prototype (aplikacja używa wartości setera) */
    Object.defineProperty(n, 'value', {
      get() { return this._value || ''; },
      set(v) { this._value = String(v); },
      configurable: true
    });
    return n;
  }
  function findAll(root, sel) {
    const text = String(sel).trim();
    if (text.indexOf(',') >= 0) {
      const seen = new Set();
      const out = [];
      text.split(',').forEach((part) => {
        findAll(root, part.trim()).forEach((n) => { if (!seen.has(n)) { seen.add(n); out.push(n); } });
      });
      return out;
    }
    const out = [];
    const parts = String(sel).trim().split(/\s+/);
    const walk = (n) => {
      n.childNodes.forEach((c) => {
        if (matchesChain(c, parts)) out.push(c);
        walk(c);
      });
    };
    walk(root);
    return out;
  }
  function matchesChain(n, parts) {
    let i = parts.length - 1;
    let cur = n;
    while (i >= 0) {
      if (!cur || !cur._matches) return false;
      if (cur._matches(parts[i])) { i--; cur = cur.parentNode; }
      else if (i === parts.length - 1) return false;
      else cur = cur.parentNode;
    }
    return true;
  }
  return { node, findAll };
}

function makePhone(opts = {}) {
  const { node, findAll } = makeDom();
  const body = node('body');
  const head = node('head');
  const phoneScreen = node('div'); phoneScreen.className = 'phone-screen';
  const screenContent = node('div'); screenContent.className = 'screen-content';
  const tabView = node('div'); tabView.className = 'tab-view chats-tab';
  const tabHeader = node('div'); tabHeader.className = 'tab-header';
  const list = node('div'); list.className = 'contacts-list';
  tabView.appendChild(tabHeader); tabView.appendChild(list);
  screenContent.appendChild(tabView);
  phoneScreen.appendChild(screenContent);
  body.appendChild(phoneScreen);

  if (!opts.noKeyInPage) {
    const cfgScript = node('script');
    cfgScript.textContent = 'var cfg={key:\`sb_publishable_wZDLcF79U5_urQcXmUneOw_eykEZ5Sb\`};';
    head.appendChild(cfgScript);
  }

  const searchInput = node('input');
  searchInput.type = 'text'; searchInput.className = 'search-input';
  tabHeader.appendChild(searchInput);

  const doc = {
    readyState: 'complete', title: '', body, head,
    createElement: (t) => node(t),
    documentElement: body,
    querySelector: (s) => (s === '.contacts-list' ? list : findAll(body, s)[0] || findAll(head, s)[0] || null),
    querySelectorAll: (s) => findAll(body, s).concat(findAll(head, s)),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible'
  };
  /* nasze własne selektory (moduł szuka po klasach i atrybutach) */
  const origQuery = doc.querySelector;
  doc.querySelector = (s) => {
    if (s === '.search-bar input[type="text"]') return searchInput;
    const m = /^\[data-rise-msglist="(.*)"\]$/.exec(s);
    if (m) return findAll(body, '[data-rise-msglist]').filter((n) => n.attrs['data-rise-msglist'] === m[1])[0] || null;
    return origQuery(s);
  };

  const ls = Object.assign({}, opts.storage || {});
  const listeners = {};
  const requests = [];

  const ctx = {
    crypto: { subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, String, Number, Object, Array, Error,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    document: doc,
    navigator: { onLine: opts.online !== false },
    URLSearchParams,
    Event: function (t) { this.type = t; },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; },
      get length() { return Object.keys(ls).length; },
      key: (i) => Object.keys(ls)[i] || null
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
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(opts.history || [])) });
  };
  if (opts.radio) ctx.window.RISE_AUTO_OILTCS = { nodeId: () => 'node-test', relay: opts.radio };
  return { ctx, doc, list, tabView, screenContent, searchInput, ls, listeners, requests, findAll, body };
}

function jwt(sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256' }) + '.' + b({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.x';
}

function load(phone) {
  vm.createContext(phone.ctx);
  vm.runInContext(SRC, phone.ctx);
  return phone.ctx.window.RISE_NATIVE_CHAT;
}

/* ===================================================================== */
const ME = 'me-1';
const PEER = 'peer-1';
const auth = { 'sb-zxmnhbkqhupoaaocwzhw-auth-token': JSON.stringify({ access_token: jwt(ME) }) };

const history = [
  { id: 'h1', sender_id: ME, receiver_id: PEER, text: 'starsza wiadomość z serwera', type: 'text', created_at: new Date(Date.now() - 7200000).toISOString() },
  { id: 'h2', sender_id: PEER, receiver_id: ME, text: 'odpowiedź z serwera', type: 'text', created_at: new Date(Date.now() - 3600000).toISOString() }
];
const directory = [{ id: PEER, username: 'Kaminski', avatar_class: 'avatar-blue' }];

/* --- 1. historia z serwera i wiersze w istniejącej liście --- */
const p1 = makePhone({ history, directory, storage: auth });
const NC1 = load(p1);
check('zna konto z sesji', NC1.myId() === ME, NC1.myId());
check('nośnik wiadomości nie jest pusty (mimo braku localStorage())', typeof NC1.thread === 'function');

(async () => {
  await NC1.syncDirectory();
  await NC1.syncFromServer();
  NC1.render();

  const rows = p1.findAll(p1.body, '[data-rise-thread]');
  check('wiersz rozmowy w istniejącej liście', rows.length === 1, 'wierszy: ' + rows.length);
  check('wiersz wygląda jak natywny (.contact-item)', rows[0] && rows[0].className.indexOf('contact-item') >= 0);
  check('wiersze poza drzewem listy React-a (osobny kontener)', p1.findAll(p1.list, '[data-rise-thread]').length === 0);
  check('nazwa z katalogu osób', p1.findAll(p1.body, '.rise-thread-rows')[0].textContent.indexOf('Kaminski') >= 0);
  check('historia z serwera jest w pamięci telefonu', NC1.thread(PEER) && NC1.thread(PEER).msgs.length === 2,
    NC1.thread(PEER) ? 'wiadomości: ' + NC1.thread(PEER).msgs.length : 'brak');
  check('nie ma drugiego ekranu', p1.findAll(p1.body, '.rise-chat').length === 0);
  check('nie ma przycisku „Czaty offline"', p1.body.textContent.indexOf('Czaty offline') < 0);

  /* --- 2. rozmowa otwiera się w miejscu listy --- */
  NC1.open(PEER);
  check('rozmowa jest w treści zakładki', p1.findAll(p1.screenContent, '.rise-chat').length === 1);
  check('widać historię w rozmowie', p1.findAll(p1.body, '.rise-bubble').length >= 2);
  const form = p1.findAll(p1.body, '.rise-input-bar')[0];
  const input = p1.findAll(p1.body, '.rise-input')[0];
  check('jest pole do pisania', !!form && !!input);

  /* --- 3. wysyłka bez internetu i bez radia: czeka, potem sama --- */
  const p2 = makePhone({ history, directory, storage: auth, offline: true });
  const NC2 = load(p2);
  await NC2.syncFromServer();
  const how = await NC2.deliver(PEER, 'piszę bez zasięgu', 'Kaminski');
  check('bez sieci wiadomość trafia do kolejki', how === 'kolejka', how);
  check('zostaje w rozmowie', NC2.thread(PEER).msgs.some((m) => m.text === 'piszę bez zasięgu'));
  check('status „czeka na zasięg"', NC2.state().pending === 1, 'czeka: ' + NC2.state().pending);

  /* sieć wraca — bez przycisku */
  p2.ctx.fetch = (url, init) => {
    p2.requests.push({ url: String(url), init: init || {} });
    const body = init && init.body ? JSON.parse(init.body) : null;
    if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 201, text: () => Promise.resolve(JSON.stringify([{ id: 'new-1', ...body }])) });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('[]') });
  };
  p2.ctx.window.dispatchEvent({ type: 'online' });
  await new Promise((r) => setTimeout(r, 50));
  check('kolejka opróżniona bez przycisku', NC2.state().pending === 0, 'czeka: ' + NC2.state().pending);
  check('serwer dostał wiadomość', p2.requests.some((r) => r.init.method === 'POST' && r.init.body.indexOf('piszę bez zasięgu') >= 0));

  /* --- 4. radio: wiadomość dochodzi i ląduje w tej samej rozmowie --- */
  const sentRadio = [];
  const p3 = makePhone({ history, directory, storage: auth, offline: true, radio: (from, to, text) => { sentRadio.push(text); return Promise.resolve(true); } });
  const NC3 = load(p3);
  await NC3.syncFromServer();
  const how3 = await NC3.deliver(PEER, 'przez radio', 'Kaminski');
  check('bez sieci idzie radiem', how3 === 'radio', how3);
  check('radio dostało treść', sentRadio.indexOf('przez radio') >= 0);
  p3.ctx.window.dispatchEvent(new p3.ctx.CustomEvent('rise-mesh-message', { detail: { from: PEER, text: 'odpowiedź radiem', at: Date.now() } }));
  const t3 = NC3.thread(PEER);
  check('odebrana radiem w tej samej rozmowie', t3.msgs.some((m) => m.text === 'odpowiedź radiem'));
  check('jako odebrana, nie moja', t3.msgs[t3.msgs.length - 1].sender === 'them');

  /* --- 5. prawdziwe pole tekstowe aplikacji ma pierwszeństwo --- */
  const formNative = p3.doc.createElement('form');
  formNative.className = 'chat-input-bar';
  const setholder = { v: '' };
  const inputProto = {
    get value() { return setholder.v; },
    set value(x) { setholder.v = String(x); }
  };
  p3.ctx.HTMLInputElement = { prototype: inputProto };
  p3.ctx.Event = function (t) { this.type = t; };
  const nativeInput = p3.doc.createElement('input');
  nativeInput.setAttribute('type', 'text');
  const nativeBtn = p3.doc.createElement('button');
  nativeBtn.setAttribute('class', 'send-btn');
  let clicked = 0;
  nativeBtn.click = () => { clicked++; };   /* tak samo: konkretny przycisk, nie prototyp */
  formNative.appendChild(nativeInput); formNative.appendChild(nativeBtn);
  p3.tabView.appendChild(formNative);
  const beforeNative = NC3.thread(PEER).msgs.length;
  p3.ctx.window.RISE_NATIVE_CHAT.deliver(PEER, 'przez pole aplikacji', 'Kaminski');
  await new Promise((r) => setTimeout(r, 20));
  check('pole aplikacji dostało treść', setholder.v === 'przez pole aplikacji', setholder.v);
  check('przycisk aplikacji kliknięty', clicked >= 1);
  check('wiadomość zapisana raz', NC3.thread(PEER).msgs.filter((m) => m.text === 'przez pole aplikacji').length === 1,
    'wystąpień: ' + NC3.thread(PEER).msgs.filter((m) => m.text === 'pole aplikacji').length + '/' + beforeNative);

  /* --- 6. brak duplikatów tej samej treści --- */
  NC3.mergeRows([{ id: 'h2', sender_id: PEER, receiver_id: ME, text: 'odpowiedź z serwera', created_at: new Date().toISOString() }]);
  check('ta sama wiadomość z serwera nie dubluje się', NC3.thread(PEER).msgs.filter((m) => m.text === 'odpowiedź z serwera').length === 1);

  /* --- 7. szyfrogram nie udaje treści --- */
  NC3.mergeRows([{ id: 'enc1', sender_id: PEER, receiver_id: ME, text: JSON.stringify({ version: 'ecdh-v1', iv: 'x', data: 'y' }), created_at: new Date().toISOString() }]);
  check('zaszyfrowana wiadomość jest oznaczona, nie zmyślona', NC3.thread(PEER).msgs.some((m) => m.text.indexOf('🔒') === 0));

  /* --- 8. klucz publiczny z bundla (tak wygląda prawdziwy APK) --- */
  const p4 = makePhone({ storage: auth, noKeyInPage: true });
  const NC4 = load(p4);
  const bundleKey = 'sb_publishable_wZDLcF79U5_urQcXmUneOw_eykEZ5Sb';
  const bundleScript = p4.doc.createElement('script');
  bundleScript.setAttribute('src', '/assets/index-C1jXfdpN.js');
  p4.doc.body.appendChild(bundleScript);
  p4.ctx.fetch = (url) => {
    if (String(url).indexOf('index-') >= 0) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve('var cfg={key:`' + bundleKey + '`};') });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve('[]') });
  };
  const gotKey = await NC4.ensureKey();
  check('klucz publiczny czytany z bundla aplikacji', gotKey === bundleKey, gotKey.slice(0, 18));
  check('klucz zostaje w pamięci telefonu (drugi start bez sieci)', p4.ls['rise-net-key'] === bundleKey);
  const p5 = makePhone({ storage: Object.assign({}, auth, { 'rise-net-key': bundleKey }) });
  const NC5 = load(p5);
  p5.ctx.fetch = () => Promise.reject(new Error('offline'));
  check('drugi start nie potrzebuje już bundla', (await NC5.ensureKey()) === bundleKey);

  console.log('\n' + passed + ' OK, ' + failed + ' FAIL');
  process.exit(failed ? 1 : 0);
})();
