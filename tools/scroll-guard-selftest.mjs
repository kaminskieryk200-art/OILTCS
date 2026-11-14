// Test „przewijanie palcem" (v3.43.2).
// Uruchomienie: node tools/scroll-guard-selftest.mjs
//
// Sprawdza na atrapie ekranu telefonu, że po zgłoszeniu „nie da się przewijać"
// i „pasek jak na laptopie":
//  1. lista, której treść jest wyższa niż ona sama, dostaje min-height:0
//     i pozwolenie na przesuwanie palcem w pionie,
//  2. pasek przewijania jest schowany tylko na dotyku (na komputerze zostaje),
//  3. dopóki palec jest na ekranie, moduł nie rusza układu,
//  4. moduł nie tworzy żadnego własnego widoku.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('./rise-scroll-guard.js', import.meta.url), 'utf8');
const SEL = '.contacts-list,.messages-list,.profile-content,.settings-content,.directory-list,.modal-list,.tab-view,.settings-tab,.rs-clist,.rs-live-list,.rs-share-list,.rs-live-chat,.rm-body,.rs-ads-body,.rs-sheet-box,.rise-panel,.update-modal,.rs-invite-people';
// Lista czatów bywa „zepsuta" nie tym, że nie ma co przewijać, tylko tym, że
// urosła do wysokości treści (scrollHeight === clientHeight) i rodzic ją obciął.
// Wersja 3.43.1 takie listy pomijała — stąd drugie zgłoszenie użytkownika.

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

function makeEnv({ coarse = true } = {}) {
  const styles = [];
  const lists = [];
  const listeners = {};
  let observed = null;

  function addList(name, { content, visible }) {
    const el = {
      nodeType: 1, selName: name, scrollHeight: content, clientHeight: visible,
      style: {}, attrs: {},
      matches: (s) => SEL.indexOf(s) >= 0
    };
    lists.push(el);
    return el;
  }

  const stubs = {
    console, setTimeout, clearTimeout, setInterval, String, Object, Array, Math, JSON,
    navigator: { maxTouchPoints: coarse ? 5 : 0 },
    ontouchstart: coarse ? null : undefined,
    matchMedia: (q) => ({ matches: coarse && q.indexOf('coarse') >= 0 }),
    getComputedStyle: (n) => ({
      minHeight: n.style.minHeight || 'none',
      touchAction: n.style.touchAction || 'none'
    }),
    MutationObserver: function (cb) { this.observe = () => { observed = cb; }; },
    document: {
      readyState: 'complete',
      body: { childList: true },
      head: { appendChild: (s) => styles.push(s) },
      getElementById: (id) => styles.find((s) => s.id === id) || null,
      createElement: () => ({ id: '', textContent: '' }),
      getElementsByTagName: () => [stubs.document.head],
      querySelectorAll: (sel) => lists.filter((l) => sel.indexOf(l.selName) >= 0),
      listeners,
      addEventListener: (ev, fn, opts) => { (listeners[ev] = listeners[ev] || []).push(fn); }
    }
  };
  stubs.window = stubs;
  stubs.addEventListener = () => {};
  return { ctx: vm.createContext(stubs), styles, lists, addList, listeners, stubs };
}

/* --- 1. telefon: długa lista ma się przewijać --- */
{
  const env = makeEnv({ coarse: true });
  env.addList('.contacts-list', { content: 3000, visible: 400 });
  env.addList('.messages-list', { content: 120, visible: 600 });   // krótka: nie ruszamy
  vm.runInContext(SRC, env.ctx);
  const long = env.lists[0], short = env.lists[1];

  check('długa lista dostaje min-height:0 (może się kurczyć i przewijać)',
        long.style.minHeight === '0', long.style.minHeight);
  check('długa lista pozwala przesuwać palcem w pionie',
        long.style.touchAction === 'pan-y', long.style.touchAction);
  check('przewinięcie kończy się na liście (bez przeskoków na inne ekrany)',
        long.style.overscrollBehavior === 'contain');
  check('wysokość listy nie ma znaczenia — każda z rodziny dostaje to samo',
        short.style.minHeight === '0' && short.style.touchAction === 'pan-y',
        'minH=' + short.style.minHeight);

  const css = env.styles.map((s) => s.textContent).join('\n');
  check('pasek przewijania schowany tylko na ekranie dotykowym',
        css.indexOf('@media (pointer:coarse)') === 0, css.slice(0, 40));
  check('pasek schowany dla listy czatów',
        css.indexOf('.contacts-list::-webkit-scrollbar{display:none') > 0);
  check('strona nadal pozwala na ruch w pionie (html, body)',
        css.indexOf('html,body{touch-action:pan-y!important}') > 0);
}

/* --- 2. komputer: pasek przewijania zostaje --- */
{
  const env = makeEnv({ coarse: false });
  const long = env.addList('.settings-content', { content: 2000, visible: 500 });
  vm.runInContext(SRC, env.ctx);
  check('na komputerze moduł nic nie zmienia',
        env.styles.length === 0 && !long.style.minHeight,
        'style=' + env.styles.length + ' minH=' + long.style.minHeight);
}

/* --- 3. palec na ekranie: nie ruszamy układu --- */
{
  const env = makeEnv({ coarse: true });
  const long = env.addList('.contacts-list', { content: 3000, visible: 400 });
  vm.runInContext(SRC, env.ctx);
  long.style = {};                       // „aplikacja przerysowała listę”
  env.listeners.touchstart.forEach((fn) => fn());
  vm.runInContext('RISE_SCROLL.sweep()', env.ctx);
  check('przy trzymanym palcu moduł nie dotyka listy',
        !long.style.minHeight, long.style.minHeight);
  env.listeners.touchend.forEach((fn) => fn());
  vm.runInContext('RISE_SCROLL.sweep()', env.ctx);
  check('po podniesieniu palca lista znów się przewija',
        long.style.minHeight === '0', long.style.minHeight);
}

/* --- 3b. lista, która UROSŁA do wysokości treści (przypadek ze zgłoszenia) --- */
{
  const env = makeEnv({ coarse: true });
  // lista ma 1800 px treści, ale sama też jest wysoka na 1800 px — bo rodzic jej
  // na to pozwolił; dolne wiersze są obcięte przez rodzica z overflow:hidden.
  const grown = env.addList('.contacts-list', { content: 1800, visible: 1800 });
  vm.runInContext(SRC, env.ctx);
  check('lista, która urosła do treści, też dostaje min-height:0 (3.43.1 ją pomijała)',
        grown.style.minHeight === '0', 'minHeight=' + grown.style.minHeight);
  check('i pozwolenie na ruch palcem', grown.style.touchAction === 'pan-y', grown.style.touchAction);

  const css2 = env.styles.map((s) => s.textContent).join('\n');
  check('zakładka Czaty może się przewijać sama (jak Ustawienia i Profil)',
        css2.indexOf('.tab-view.chats-tab{') > 0);
  check('nagłówek Czatów zostaje przyklejony u góry',
        css2.indexOf('.tab-view.chats-tab>.tab-header{position:sticky') > 0);
  check('lista czatów ma własne przewijanie palcem',
        css2.indexOf('.tab-view.chats-tab>.contacts-list{min-height:0;overflow-y:auto') > 0);
}

/* --- 4. żadnego własnego widoku --- */
{
  const views = (SRC.match(/appendChild/g) || []).length;
  check('moduł nie tworzy widoku (appendChild tylko na <style>)', views === 1, 'appendChild=' + views);
  check('moduł nie dodaje elementów do listy czatów', SRC.indexOf('.append(') === -1);
}

console.log('\n' + passed + ' OK, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
