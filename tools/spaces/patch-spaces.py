"""Wstrzykuje Rises Spaces (kanały publiczne) w istniejące funkcje aplikacji (v3.44.0).

Uruchamia się PO tools/patch-native-chat.py — dokłada pięć zmian, każda musi
wystąpić dokładnie raz, inaczej przerywa i nic nie zapisuje.

    python3 tools/spaces/patch-spaces.py <plik index-*.js> [--check]
"""
import sys, re


# ======================================================================
# Rises Spaces — kanały publiczne (v3.44.0)
# ======================================================================
# Kanał publiczny jest zwykłą grupą, więc okno czatu zostaje TO SAMO.
# Łatka robi pięć rzeczy i nic więcej:
#   1. lista czatów dopisuje kanały publiczne (RISE_SPACES.merge),
#   2. wejście w kanał dopisuje użytkownika i wczytuje historię od nowa,
#   3. w kanale nie szyfrujemy (RISE_SPACES.plain),
#   4. nagłówek rozmowy pokazuje nazwę kanału (RISE_SPACES.person),
#   5. w bąbelku w kanale widać autora wiadomości.
SPACES_PATCHES = [
    (
        'spaces: kanały publiczne na liście czatów',
        'contacts-list`,children:zn.filter(',
        'contacts-list`,children:(window.RISE_SPACES&&window.RISE_SPACES.merge?window.RISE_SPACES.merge(zn):zn).filter(',
    ),
    (
        'spaces: wejście w kanał dopisuje i wczytuje historię',
        'onClick:()=>C(e.id)',
        'onClick:()=>{try{if(window.RISE_SPACES&&window.RISE_SPACES.onOpen)window.RISE_SPACES.onOpen(e.id);}catch(_s){}C(e.id)}',
    ),
    (
        'spaces: kanał publiczny bez szyfrowania',
        'if(n&&a){let t=await ko(n,a);t&&(i=await Ao(e,t))}',
        'if(n&&a&&!(window.RISE_SPACES&&window.RISE_SPACES.plain&&window.RISE_SPACES.plain(S))){let t=await ko(n,a);t&&(i=await Ao(e,t))}',
    ),
    (
        'spaces: nazwa kanału w nagłówku rozmowy',
        'Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||',
        'Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||(window.RISE_SPACES&&window.RISE_SPACES.person&&S?window.RISE_SPACES.person(S):null)||',
    ),
    (
        'spaces: autor wiadomości w kanale',
        'onClick:()=>le(ce===e.id?null:e.id),style:{cursor:`pointer`},children:[',
        'onClick:()=>le(ce===e.id?null:e.id),style:{cursor:`pointer`},children:[(()=>{try{if(window.RISE_SPACES&&window.RISE_SPACES.isSpace&&window.RISE_SPACES.isSpace(S)&&!n){let _a=window.RISE_SPACES.senderOf(e);if(_a)return (0,b.jsx)(`div`,{style:{fontSize:`0.68rem`,fontWeight:800,color:`#8B5CF6`,marginBottom:`2px`},children:_a},`a`);}}catch(_s){}return null})(),',
    ),
]

# Most Spacji zakładany obok mostu OILTCS: ten sam punkt zaczepienia.
SPACES_BRIDGE_ANCHOR = "window.RISE_OFFLINE_CHAT.useBridge("
SPACES_BRIDGE_NEW = (
    "try{if(window.RISE_SPACES){window.RISE_SPACES.boot();window.RISE_SPACES.useBridge({"
    "current:()=>S,setMessages:T,renderList:()=>{try{T(e=>({...e}))}catch(_p){}},"
    "reloadMessages:(_id)=>{try{T(e=>({...e}))}catch(_p){}},"
    "myId:()=>d&&d.user&&d.user.id});}}catch(_sp){}"
    "window.RISE_OFFLINE_CHAT.useBridge("
)


def main():
    args = [a for a in sys.argv[1:] if a != '--check']
    check_only = '--check' in sys.argv
    if not args:
        print('użycie: patch-spaces.py <index-*.js> [--check]')
        return 2
    path = args[0]
    src = open(path, encoding='utf-8').read()

    if 'rise-spaces-bridge-v1' in src:
        print('  już załatane — pomijam (idempotentnie)')
        return 0

    problems = []
    for name, old, new in SPACES_PATCHES:
        n = src.count(old)
        if n != 1:
            problems.append('%s: znaleziono %d wystąpień (musi być 1)' % (name, n))

    bridge = src.count(SPACES_BRIDGE_ANCHOR)
    if bridge != 1:
        problems.append('most Spacji: znaleziono %d wystąpień (musi być 1)' % bridge)

    if problems:
        print('  PRZERWANO — nic nie zapisano:')
        for p in problems:
            print('   - ' + p)
        return 1

    for name, old, new in SPACES_PATCHES:
        src = src.replace(old, new, 1)
        print('  ✓ ' + name)

    src = src.replace(SPACES_BRIDGE_ANCHOR, SPACES_BRIDGE_NEW, 1)

    # numer wersji widoczny dla użytkownika: v3.44.0
    m = re.search(r'Xo = `v(\d+)\.(\d+)\.(\d+)`;', src)
    if m:
        cur = tuple(int(x) for x in m.groups())
        want = (3, 44, 0)
        if cur < want:
            src = src.replace(m.group(0), 'Xo = `v%d.%d.%d`;' % want, 1)
            print('  ✓ wersja: v%s -> v%d.%d.%d' % ('.'.join(m.groups()), *want))
    src = src.replace('window.RISE_OFFLINE_CHAT.useBridge(', '/* rise-spaces-bridge-v1 */window.RISE_OFFLINE_CHAT.useBridge(', 1)
    print('  ✓ spaces: most do aplikacji')

    if check_only:
        print('  (--check: bez zapisu)')
        return 0

    open(path, 'w', encoding='utf-8').write(src)
    print('  zapisano')
    return 0


if __name__ == '__main__':
    sys.exit(main())
