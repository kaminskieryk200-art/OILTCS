/* Rises — przewijanie palcem (v3.43.4).
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
      /* Lista czatów jest przewijana, nagłówek zostaje na swoim miejscu.
         Wcześniej przewijaliśmy całą zakładkę i nagłówek uciekał z ekranu
         („działa, ale tylko jak od paska"). Teraz przewija się sama lista,
         dokładnie jak lista wiadomości w rozmowie. */
      '.tab-view.chats-tab{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}' +
      '.tab-view.chats-tab>.tab-header{flex:none}' +
      '.tab-view.chats-tab>.contacts-list{flex:1 1 auto;min-height:0;overflow-y:auto;' +
      'overflow-x:hidden;-webkit-overflow-scrolling:touch;touch-action:pan-y!important;' +
      'overscroll-behavior:contain}' +
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

  /* ------------------------------------------------------------------ */
  /* przewijanie prowadzone palcem                                       */
  /* ------------------------------------------------------------------ */
  /* Dlaczego nie wystarczy CSS: na ekranie Czatów gest zaczęty NA WIERSZU
     bywa zjadany przez reguły z innych modułów (zmierzone: natywne przewijanie
     ruszało tylko wtedy, gdy palec startował na pustym pasku — „działa, ale
     tylko jak od paska"). Skoro nie da się zagwarantować, że przeglądarka
     wykona gest, prowadzimy go sami: przy ruchu w pionie przesuwamy `scrollTop`
     dokładnie o drogę palca, a przeglądarce mówimy „nie ruszaj tego drugi raz".
     Efekt jest ten sam co natywny, a działa niezależnie od cudzych stylów.

     Nie ruszamy: pól tekstowych, gestów poziomych, przycisków (dotknięcie bez
     ruchu zostaje dotknięciem) i modali. */
  var drag = null;
  var SUPPRESS_CLICK_UNTIL = 0;

  var LIST_CLASSES = ['.contacts-list', '.messages-list', '.directory-list'];

  function inList(el) {
    var d = doc();
    if (!d || !el || !el.closest) return false;
    if (el.closest('input,textarea,select,[contenteditable="true"],[role="slider"]')) return false;
    if (el.closest('.modal-content,.rs-sheet,.rs-community-modal,.chat-window,.rs-progress,.rm-progress,.tab-bar')) return false;
    for (var i = 0; i < LIST_CLASSES.length; i++) if (el.closest(LIST_CLASSES[i])) return true;
    return false;
  }

  /* Element, który naprawdę przewija: najbliższy przodek z przewijaniem w pionie,
     a jeśli żaden nie ma czego przewijać — sama lista (dostanie własne przewijanie). */
  function scrollerFor(el) {
    var d = doc();
    if (!d || !el) return null;
    for (var n = el; n && n.nodeType === 1 && n !== d.body; n = n.parentElement) {
      var s = null;
      try { s = root.getComputedStyle(n); } catch (e) { s = null; }
      if (!s) continue;
      if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    for (var i = 0; i < LIST_CLASSES.length; i++) {
      var hit = el.closest ? el.closest(LIST_CLASSES[i]) : null;
      if (hit) return hit;
    }
    return null;
  }

  function onTouchStart(ev) {
    drag = null;
    touchDown = true;
    if (!ev.touches || ev.touches.length !== 1) return;
    var el = ev.target;
    if (!inList(el)) return;
    var box = scrollerFor(el);
    if (!box) return;
    var t = ev.touches[0];
    drag = { x: t.clientX, y: t.clientY, top: box.scrollTop, box: box, engaged: false, moved: 0 };
  }

  function onTouchMove(ev) {
    if (!drag || !ev.touches || ev.touches.length !== 1) return;
    var t = ev.touches[0];
    var dy = t.clientY - drag.y, dx = t.clientX - drag.x;
    drag.moved = Math.max(drag.moved, Math.abs(dy) + Math.abs(dx));
    if (!drag.engaged) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) drag.engaged = true;
      else if (Math.abs(dx) > 8) { drag = null; return; }      /* poziomo — nie nasza sprawa */
      else return;
    }
    if (ev.cancelable) ev.preventDefault();
    drag.box.scrollTop = drag.top - dy;
  }

  function onTouchEnd() {
    if (drag && drag.engaged && drag.moved > 10) SUPPRESS_CLICK_UNTIL = Date.now() + 200;
    drag = null;
    touchDown = false;
    schedule();
  }

  /* Po przeciągnięciu przeglądarka potrafi jeszcze wysłać kliknięcie we wiersz —
     wtedy zamiast przewijać, otworzylibyśmy rozmowę. Tłumimy tylko ten jeden. */
  function onClickCapture(e) {
    if (Date.now() < SUPPRESS_CLICK_UNTIL) {
      SUPPRESS_CLICK_UNTIL = 0;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  var touchDown = false;

  function sweep() {
    if (touchDown) return;             /* palec na ekranie: nie ruszamy układu */
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
      d.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
      d.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
      d.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
      d.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
      d.addEventListener('click', onClickCapture, true);
    }
  }

  root.RISE_SCROLL = {
    boot: boot,
    sweep: sweep,
    /* do testów: ile razy palec prowadził przewijanie */
    dragged: function () { return SUPPRESS_CLICK_UNTIL > 0; },
    lists: function () { return scrollableLists().length; },
    isTouch: isTouch
  };

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
