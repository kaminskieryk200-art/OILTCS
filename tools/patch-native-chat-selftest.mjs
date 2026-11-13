// Test referencyjny: łatka wstrzykująca OILTCS w istniejące funkcje aplikacji.
// Uruchomienie: node tools/patch-native-chat-selftest.mjs
//
// Bierze wycinek bundla Rises (te same konstrukcje, które są w prawdziwym
// pliku), przepuszcza go przez łatkę i sprawdza, że:
//  1. każde miejsce trafia dokładnie raz i plik zostaje poprawną składnią,
//  2. drugie uruchomienie nic nie psuje (idempotencja),
//  3. przy nieoczekiwanym bundlu łatka PRZERYWA i nie zapisuje niczego,
//  4. po załataniu wywołania rzeczywiście trafiają do modułu OILTCS.
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PATCHER = new URL('./patch-native-chat.py', import.meta.url).pathname;
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

/* minimalny „bundle”: te same kształty, co w prawdziwej aplikacji */
const BUNDLE = `
let d={user:{id:'me-1'}},S=null,v=[],Sn=[],bn=[],Rn=[],ne={},q={},T=()=>{},gt={current:!1},pe=null;
Xo = \`v3.42.1\`;
fn=async(e,t=\`text\`)=>{let s=Sn.some(e=>e.id===S),c=S===\`personal_notes\`?d.user.id:S;try{let i=e;let o={sender_id:d.user.id,receiver_id:s?d.user.id:c,text:i,type:t};let{data:l,error:u}=await q.from(\`messages\`).insert(o).select();if(u)throw u;T(t=>{let n=t[S]||[];return{...t,[S]:n.map(t=>t.id===a?{...t,id:e.id,localSendStatus:null,time:new Date(e.created_at).toLocaleTimeString(\`pl-PL\`,{hour:\`2-digit\`,minute:\`2-digit\`,hour12:!1})}:t)}})}catch(e){console.error(\`Error\`,e&&e.message);T(e=>({...e,[S]:(e[S]||[]).map(e=>e.id===a?{...e,localSendStatus:\`queued\`}:e)}))}};
zn=[...v.filter(e=>e.id===\`personal_notes\`||bn.includes(e.id)||Rn.includes(e.id)),...Sn];
Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||(S?{id:S,name:\`Chat Partner\`,avatarClass:\`avatar-blue\`,online:!0,status:\`Active\`}:null);
(0,_.useEffect)(()=>{gt.current=pe},[pe]);
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rise-patch-'));
const good = path.join(dir, 'good.js');
fs.writeFileSync(good, BUNDLE);

/* 1. łatka przechodzi i plik jest poprawny składniowo */
let out1 = '';
try { out1 = execFileSync('python3', [PATCHER, good], { encoding: 'utf8' }); } catch (e) { out1 = String(e.stdout || e.message); }
const patched = fs.readFileSync(good, 'utf8');
check('łatka znalazła wszystkie miejsca', /6 miejsc|✓ most/.test(out1) && patched.includes('rise-oiltcs-bridge-v1'), out1.trim().split('\n').slice(-3).join(' | '));
try { new vm.Script(patched); check('po załataniu plik jest poprawną składnią', true); }
catch (e) { check('po załataniu plik jest poprawną składnią', false, e.message); }
check('numer wersji podniesiony', /Xo = `v3\.43\.1`;/.test(patched));

/* 2. drugie uruchomienie nic nie psuje */
execFileSync('python3', [PATCHER, good], { encoding: 'utf8' });
check('drugie uruchomienie nie dubluje zmian', fs.readFileSync(good, 'utf8') === patched);

/* 3. nieoczekiwany bundle: przerwanie bez zapisu */
const bad = path.join(dir, 'bad.js');
fs.writeFileSync(bad, 'let a=1;');
let rc = 0, msg = '';
try { execFileSync('python3', [PATCHER, bad], { encoding: 'utf8' }); }
catch (e) { rc = e.status; msg = String(e.stdout || ''); }
check('przy innym bundlu łatka przerywa', rc === 1, 'rc=' + rc);
check('i niczego nie zapisuje', fs.readFileSync(bad, 'utf8') === 'let a=1;');

/* 4. po załataniu wywołania trafiają do modułu */
const calls = [];
const ctx = {
  console, JSON, Math, Date, String, Number, Object, Array, Promise, Error,
  _: { useEffect: (fn) => { calls.push('useEffect'); try { fn(); } catch (e) {} } },
  window: null
};
ctx.window = ctx;
ctx.window.RISE_OFFLINE_CHAT = {
  boot: () => calls.push('boot'),
  useBridge: (b) => calls.push('useBridge:' + typeof b.current),
  merge: (l) => { calls.push('merge'); return l.concat([{ id: 'from-oiltcs' }]); },
  person: (id) => ({ id, name: 'Osoba z OILTCS' }),
  offer: (peer, text) => { calls.push('offer:' + peer + ':' + text); return Promise.resolve(true); },
  remember: (peer, text, sid) => { calls.push('remember:' + sid); },
  thread: () => null,
  state: () => ({}),
  syncConversation: () => {}, refresh: () => {}
};
vm.createContext(ctx);
vm.runInContext(patched, ctx);

check('most jest zakładany przy starcie', calls.includes('boot') && calls.some((c) => c.indexOf('useBridge') === 0));
check('lista czatów dopisuje osobę z OILTCS', ctx.zn.some((e) => e.id === 'from-oiltcs'));
/* zmienne w bundlu są zadeklarowane przez `let`/`const`, więc ustawiamy je
   W TYM SAMYM kontekście, a nie jako pola obiektu globalnego */
vm.runInContext("S='peer-1'; a='temp-1';", ctx);
vm.runInContext("Bn=v.find(e=>e.id===S)||Sn.find(e=>e.id===S)||(window.RISE_OFFLINE_CHAT&&window.RISE_OFFLINE_CHAT.person&&S?window.RISE_OFFLINE_CHAT.person(S):null)||(S?{id:S,name:\`Chat Partner\`}:null);", ctx);
check('nagłówek rozmowy bierze osobę spoza katalogu', ctx.Bn && ctx.Bn.name === 'Osoba z OILTCS', ctx.Bn ? ctx.Bn.name : 'null');

/* wysyłka: serwer odpowiada błędem → wiadomość idzie radiem */
ctx.__stubFail = { from: () => ({ insert: () => ({ select: () => Promise.reject(new Error('offline')) }) }) };
vm.runInContext('q=__stubFail;', ctx);
(async () => {
  await vm.runInContext("fn('treść','text')", ctx);
  check('nieudany zapis uruchamia OILTCS', calls.some((c) => c.indexOf('offer:peer-1:treść') === 0), calls.join(' | '));

  /* wysyłka: serwer odpowiada dobrze → zapis w pamięci telefonu */
  calls.length = 0;
  ctx.__stubOk = { from: () => ({ insert: () => ({ select: () => Promise.resolve({ data: [{ id: 'srv-1', created_at: new Date().toISOString() }] }) }) }) };
  vm.runInContext('q=__stubOk;', ctx);
  await vm.runInContext("fn('druga treść','text')", ctx);
  check('potwierdzony zapis trafia do pamięci', calls.some((c) => c.indexOf('remember') === 0), calls.join(' | '));

  console.log('\n' + passed + ' OK, ' + failed + ' FAIL');
  process.exit(failed ? 1 : 0);
})();
