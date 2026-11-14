/* Rises — przewijanie palcem (v3.43.3).
 *
 * Powód (zgłoszenie ze screena): „nie da się przewijać" oraz „masz tylko pasek
 * do przewijania jak na laptopie, ja jestem na telefonie".
 *
 * Co było nie tak: listy w aplikacji są elastyczne (flex:1 + overflow-y:auto),
 * a taki element domyślnie NIE kurczy się poniżej wysokości swojej treści.
 * Kiedy wierszy przybywa, lista rośnie w dół zamiast się przewijać — dolne
 * wiersze są obcięte i palec nie ma czego przesuwać. Wystarczy `min-height:0`.
 * Dodatkowo <html>/<body> mają `touch-action:none`, co przeglądarka stosuje
 * też do elementów w środku — trzeba wyraźnie pozwolić na ruch w pionie.
 *
 * Poprawka v3.43.2 (zgłoszenie: „dalej nie mogę przewijać"):
 * wersja 3.43.1 naprawiała TYLKO listy, które już miały co przewijać
 * (sprawdzała `scrollHeight > clientHeight`). A zepsuta lista to dokładnie ta
 * odwrotność: urosła do wysokości swojej treści, więc formalnie „nie ma czego
 * przewijać", a jej dolne wiersze są obcięte przez rodzica z `overflow:hidden`.
 * Teraz `min-height:0` dostaje KAŻDA lista z tej rodziny, niezależnie od tego,
 * jak wysoka jest w danej chwili. Do tego zakładka „Czaty" sama może się
 * przewijać (tak jak już robią to Ustawienia i Profil), a nagłówek zostaje
 * przyklejony u góry — więc jeśli jedna warstwa zawiedzie, zadziała druga.
 *
 * Ten moduł nie tworzy własnego interfejsu i nie zmienia wyglądu:
 *  - ustawia listom `min-height:0` tam, gdzie układ faktycznie je ściska,
 *  - pozwala przesuwać je palcem w pionie (pan-y) i kończy przewinięcie
 *    na liście (bez przeskakiwania na inne ekrany),
 *  - chowa pasek przewijania WYŁĄCZNIE na ekranie dotykowym — na komputerze
 *    zostaje normalny, bo tam jest potrzebny,
 *  - nic nie przypina i nie przemalowuje. Wersja 3.43.2 przyklejała nagłówek
 *    „Czaty" u góry i przez półprzezroczyste tło aplikacji wiersze prześwitywały
 *    pod nim. Teraz nagłówek przewija się razem z listą — dokładnie tak, jak
 *    już zachowują się zakładki Ustawienia i Profil. Zero nowych elementów
 *    i zero zmiany wyglądu,
 *  - nie rusza niczego, dopóki palec jest na ekranie.
 */
(function (root) {
  'use strict';

  var STYLE_ID = 'rise-scroll-touch';
  var touch = false;
  var timer = null;

  var LISTS = [
    '.contacts-list', '.messages-list', '.profile-content', '.settings-content',
    '.directory-list', '.modal-list', '.tab-view', '.settings-tab',
    '.rs-clist', '.rs-live-list', '.rs-share-list', '.rs-live-chat',
    '.rm-body', '.rs-ads-body', '.rs-sheet-box', '.rise-panel',
    '.update-modal', '.rs-invite-people'
  ];
  var SEL = LISTS.join(',');

  function doc() { return root.document; }

  function isTouch() {
    try {
      if (root.matchMedia && root.matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) {}
    return ('ontouchstart' in root) && (root.navigator && root.navigator.maxTouchPoints > 0);
  }

  /* Arkusz: pasek przewijania schowany tylko na dotyku, listy przewijane palcem. */
  function ensureStyle() {
    var d = doc();
    if (!d || !d.createElement || d.getElementById(STYLE_ID)) return;
    var head = d.head || d.getElementsByTagName('head')[0];
    if (!head) return;
    var hideBar = SEL.split(',').map(function (s) { return s + '::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}'; }).join('');
    var st = d.createElement('style');
    st.id = STYLE_ID;
    st.textContent = '@media (pointer:coarse){' +
      'html,body{touch-action:pan-y!important}' +
      SEL + '{min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;' +
      'touch-action:pan-y!important;scrollbar-width:none;-ms-overflow-style:none}' +
      /* zakładka czatów może się przewijać sama — tak jak Ustawienia i Profil */
      '.tab-view.chats-tab{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;' +
      '-webkit-overflow-scrolling:touch;touch-action:pan-y!important;' +
      'overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none;' +
      'padding-bottom:calc(72px + env(safe-area-inset-bottom,8px))}' +
      '.tab-view.chats-tab::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +

      '.tab-view.chats-tab>.contacts-list{min-height:0;overflow-y:auto;' +
      '-webkit-overflow-scrolling:touch;touch-action:pan-y!important;overscroll-behavior:contain}' +
      hideBar + '}';
    head.appendChild(st);
  }

  /* Wszystkie listy z rodziny — BEZ sprawdzania, czy „jest co przewijać".
     Wersja 3.43.1 sprawdzała `scrollHeight > clientHeight` i właśnie dlatego
     nie naprawiła listy czatów: zepsuta lista urosła do wysokości treści
     i formalnie nie miała czego przewijać, choć jej dolne wiersze były obcięte. */
  function scrollableLists() {
    var d = doc();
    if (!d || !d.querySelectorAll) return [];
    var out = [];
    var nodes = d.querySelectorAll(SEL);
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
    return out;
  }

  function sweep() {
    if (touch) return;                 /* palec na ekranie: nie ruszamy układu */
    var lists = scrollableLists();
    for (var i = 0; i < lists.length; i++) {
      var n = lists[i];
      var s = null;
      try { s = root.getComputedStyle(n); } catch (e) { s = null; }
      if (!s) continue;
      if (s.minHeight !== '0px') n.style.minHeight = '0';
      if (s.touchAction !== 'pan-y') n.style.touchAction = 'pan-y';
      n.style.overscrollBehavior = 'contain';
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; sweep(); }, 700);
  }

  function boot() {
    var d = doc();
    if (!d || !d.body) { setTimeout(boot, 300); return; }
    if (!isTouch()) return;            /* komputer: zostaje jak jest */
    ensureStyle();
    sweep();
    try {
      var mo = new root.MutationObserver(schedule);
      mo.observe(d.body, { childList: true, subtree: true });
    } catch (e) {
      setInterval(sweep, 2500);
    }
    if (d.addEventListener) {
      d.addEventListener('touchstart', function () { touch = true; }, { passive: true, capture: true });
      d.addEventListener('touchend', function () { touch = false; schedule(); }, { passive: true, capture: true });
      d.addEventListener('touchcancel', function () { touch = false; }, { passive: true, capture: true });
    }
  }

  root.RISE_SCROLL = {
    boot: boot,
    sweep: sweep,
    lists: function () { return scrollableLists().length; },
    isTouch: isTouch
  };

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
