#!/usr/bin/env python3
"""Wstrzykuje OILTCS w istniejące funkcje aplikacji Rises (v3.43.2).

Zasada: nie powstaje żaden nowy widok. Patch podmienia pięć miejsc w bundlu
tak, żeby natywny interfejs korzystał z `tools/rise-native-chat.js`:

1. wysyłka w czacie (`fn`) — nieudany zapis na serwer (także „czeka w kolejce")
   dorzuca tę samą wiadomość radiem: `offer(odbiorca, treść)`,
2. wysłana wiadomość jest od razu widoczna w pamięci telefonu (`push`),
3. lista czatów (`zn`) — dopisuje osoby, do których pisaliśmy przez OILTCS,
4. nagłówek rozmowy (`Bn`) — bierze osobę także spoza katalogu z serwera,
5. rejestracja mostu (`useBridge`) — moduł dostaje dostęp do stanu aplikacji
   (bieżąca rozmowa, doklejanie wiadomości, odświeżenie listy) i sam nie rysuje.

Każdy punkt musi wystąpić dokładnie raz; inaczej skrypt przerywa i nic nie
zapisuje. Użycie:
  python3 tools/patch-native-chat.py <index-*.js> [--check]
"""
import sys
import re

GUARD = '/* rise-oiltcs-bridge-v1 */'
O = 'window.RISE_OFFLINE_CHAT'

# --- 1/2: wysyłka ---------------------------------------------------------
SEND_OLD = (
    'let o={sender_id:d.user.id,receiver_id:s?d.user.id:c,text:i,type:t};'
)
SEND_NEW = (
    'let o={sender_id:d.user.id,receiver_id:s?d.user.id:c,text:i,type:t};'
    'try{if(' + O + '&&' + O + '.offer){' + O + '.offer(c,String(e));}}catch(_o){}'
)

SEND_FAIL_OLD = (
    'T(e=>({...e,[S]:(e[S]||[]).map(e=>e.id===a?{...e,localSendStatus:`queued`}:e)}))'
)
SEND_FAIL_NEW = (
    'T(e=>({...e,[S]:(e[S]||[]).map(e=>e.id===a?{...e,localSendStatus:`queued`}:e)}));'
    'try{if(' + O + '&&' + O + '.offer)' + O + '.offer(c,String(e));}catch(_o){}'
)

SEND_OK_OLD = (
    'T(t=>{let n=t[S]||[];return{...t,[S]:n.map(t=>t.id===a?{...t,id:e.id,localSendStatus:null,'
    'time:new Date(e.created_at).toLocaleTimeString(`pl-PL`,{hour:`2-digit`,minute:`2-digit`,hour12:!1})}:t)}})'
)
SEND_OK_NEW = (
    'T(t=>{let n=t[S]||[];return{...t,[S]:n.map(t=>t.id===a?{...t,id:e.id,localSendStatus:null,'
    'time:new Date(e.created_at).toLocaleTimeString(`pl-PL`,{hour:`2-digit`,minute:`2-digit`,hour12:!1})}:t)}});'
    'try{if(' + O + '&&' + O + '.remember)' + O + '.remember(c,String(e),e.id);}catch(_o){}'
)

# --- 3: lista czatów ------------------------------------------------------
LIST_OLD = 'zn=[...v.filter(e=>e.id===`personal_notes`||bn.includes(e.id)||Rn.includes(e.id)),...Sn]'
LIST_NEW = (
    'zn=((_l)=>' + O + '&&' + O + '.merge?' + O + '.merge(_l,v):_l)'
    '([...v.filter(e=>e.id===`personal_notes`||bn.includes(e.id)||Rn.includes(e.id)),...Sn])'
)

# --- 4: nagłówek rozmowy --------------------------------------------------
HEAD_OLD = 'Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||'
HEAD_NEW = (
    'Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||(' + O + '&&' + O + '.person&&S?'
    + O + '.person(S):null)||'
)

# --- 5: most --------------------------------------------------------------
BRIDGE_OLD = '(0,_.useEffect)(()=>{gt.current=pe},[pe])'
# Kolejność ładowania skryptów bywa różna (moduł aplikacji vs. pliki `defer`),
# więc most próbuje podłączyć się od razu, a jeśli modułu jeszcze nie ma —
# ponawia przez kilka sekund. Bez tego przy innej kolejności most nie wstaje.
BRIDGE_NEW = (
    BRIDGE_OLD + ',' + GUARD + '(0,_.useEffect)(()=>{'
    'let _b=()=>{try{if(!' + O + ')return!1;'
    + O + '.boot();'
    + O + '.useBridge({current:()=>S,setMessages:T,renderList:()=>{try{T(e=>({...e}))}catch(_p){}},'
    'myId:()=>d&&d.user&&d.user.id});'
    'return!0}catch(_e){return!1}};'
    'if(!_b()){let _n=0,_i=setInterval(()=>{if(_b()||++_n>40)clearInterval(_i)},250)}'
    '},[S])'
)

PATCHES = [
    ('wysyłka: OILTCS obok serwera', SEND_OLD, SEND_NEW),
    ('wysyłka: nieudany zapis idzie radiem', SEND_FAIL_OLD, SEND_FAIL_NEW),
    ('wysyłka: potwierdzony zapis w pamięci telefonu', SEND_OK_OLD, SEND_OK_NEW),
    ('lista czatów: osoby z OILTCS', LIST_OLD, LIST_NEW),
    ('rozmowa: osoba spoza katalogu', HEAD_OLD, HEAD_NEW),
    ('most: moduł widzi stan aplikacji', BRIDGE_OLD, BRIDGE_NEW),
]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check_only = '--check' in sys.argv
    if len(args) != 1:
        print('użycie: patch-native-chat.py <index-*.js> [--check]')
        return 2
    path = args[0]
    with open(path, encoding='utf-8') as fh:
        src = fh.read()

    if GUARD in src:
        print('  już załatane — pomijam (idempotentnie)')
        return 0

    problems = []
    for name, old, new in PATCHES:
        n = src.count(old)
        if n != 1:
            problems.append('%s: znaleziono %d wystąpień (musi być 1)' % (name, n))
    if problems:
        print('  PRZERWANO — nic nie zapisano:')
        for p in problems:
            print('   - ' + p)
        return 1

    for name, old, new in PATCHES:
        src = src.replace(old, new, 1)
        print('  ✓ ' + name)

    # wersja aplikacji widoczna dla użytkownika
    m = re.search(r'Xo = `v(\d+)\.(\d+)\.(\d+)`;', src)
    if m:
        cur = tuple(int(x) for x in m.groups())
        want = (3, 43, 2)
        if cur < want:
            src = src.replace(m.group(0), 'Xo = `v%d.%d.%d`;' % want, 1)
            print('  ✓ wersja: v%s -> v%d.%d.%d' % ('.'.join(m.groups()), *want))
    else:
        print('  ! nie znaleziono numeru wersji (Xo) — sprawdź ręcznie')

    # --- 7. wbudowana blokada przewijania (v3.43.2) -----------------------
    # Aplikacja ma nasłuch, który na każdym `touchmove` poza kilkoma listami
    # woła `preventDefault()` — a listy czatów nie ma na jego liście wyjątków.
    # Efekt: „nie da się przewijać" dokładnie na tym jednym ekranie.
    # Zmiana: dopisujemy `chats-tab` do listy wyjątków, nic więcej.
    anchor = "for(;t&&t!==document.body;){if(t.classList&&(t.classList.contains("
    n = src.count(anchor)
    if n != 1:
        problems.append('blokada przewijania: znaleziono %d wystąpień (musi być 1)' % n)
        print('  PRZERWANO — nic nie zapisano:')
        for p_ in problems:
            print('   - ' + p_)
        return 1
    src = src.replace(anchor, anchor + "`chats-tab`)||t.classList.contains(", 1)
    print('  ✓ przewijanie: ekran Czatów dopuszczony (blokada touchmove)')

    if check_only:
        print('  (--check: bez zapisu)')
        return 0

    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(src)
    print('  zapisano')
    return 0


if __name__ == '__main__':
    sys.exit(main())
