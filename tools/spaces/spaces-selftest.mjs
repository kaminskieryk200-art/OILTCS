// Test Rises Spaces (v3.44.0) — kanały publiczne.
// Uruchomienie: node tools/spaces/spaces-selftest.mjs
//
// Sprawdza to, co użytkownik zobaczy na telefonie:
//  1. kanał publiczny pojawia się na liście czatów, ale tylko raz i tylko
//     ten, do którego nie należysz,
//  2. wejście w kanał dopisuje Cię do niego (raz, nie w kółko),
//  3. kanał nie jest szyfrowany — inaczej historia byłaby „🔒",
//  4. historia kanału trafia do tego samego okna czatu, bez duplikatów,
//  5. nagłówek rozmowy pokazuje nazwę kanału,
//  6. moduł nie tworzy żadnego elementu na ekranie.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('./rise-spaces.js', import.meta.url), 'utf8');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const ME = 'me-1';
const CH = 'chan-1';

function phone({ channels = [], messages = [] } = {}) {
  const calls = { inserts: [], selects: [] };
  const store = { 'rise-spaces-v1': JSON.stringify(channels) };

  const q = {
    from(table) {
      const st = { table, filters: [] };
      const api = {
        select() { return api; },
        eq(col, val) { st.filters.push([col, val]); return api; },
        in() { return api; },
        limit() { return api; },
        order() { return api; },
        insert(row) {
          calls.inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        then(res) {
          return api.__run(res);
        },
        __run(res) {
          if (table === 'spaces_channels') {
            calls.selects.push('spaces');
            return Promise.resolve(res({ data: channels.map((c) => ({ group_id: c.id, slug: c.slug, topic: c.topic, is_public: true })) }));
          }
          if (table === 'groups') {
            return Promise.resolve(res({ data: channels.map((c) => ({ id: c.id, name: c.name, description: c.topic, avatar_class: 'avatar-blue' })) }));
          }
          if (table === 'messages') {
            const want = st.filters.filter((f) => f[0] === 'group_id').map((f) => f[1])[0];
            return Promise.resolve(res({ data: messages.filter((m) => !want || m.group_id === want) }));
          }
          if (table === 'profiles') return Promise.resolve(res({ data: [{ id: 'peer-1', username: 'Eryk' }] }));
          return Promise.resolve(res({ data: [] }));
        }
      };
      return api;
    }
  };

  const ctx = {
    console, setTimeout, clearTimeout, setInterval, Date, JSON, String, Math, Object, Array, Promise, Error,
    localStorage: {
      length: 2,
      key: (i) => ['sb-test-auth-token', 'rise-spaces-v1'][i],
      getItem: (k) => (k === 'sb-test-auth-token' ? JSON.stringify({ user: { id: ME } }) : store[k] || null),
      setItem: (k, v) => { store[k] = v; }
    },
    addEventListener() {},
    __riseSupabase: q,
    document: null
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const api = ctx.RISE_SPACES;
  api.boot();
  return { ctx, api, calls, store };
}

const CHANNELS = [{ id: CH, slug: 'ogolny', name: 'ogólny', topic: 'Kanał publiczny Rises' }];

/* --- 1. kanał na liście czatów --- */
{
  const p = phone({ channels: CHANNELS });
  await p.api.sync();
  const list = [{ id: 'personal_notes', name: 'My Notepad' }, { id: 'peer-1', name: 'Eryk' }];
  const merged = p.api.merge(list);
  check('kanał publiczny dopisany do listy czatów', merged.some((e) => e.id === CH));
  check('nazwa kanału z #', merged.find((e) => e.id === CH).name === '#ogólny', merged.find((e) => e.id === CH).name);
  check('istniejące czaty nietknięte', merged[0].id === 'personal_notes' && merged[1].id === 'peer-1');
  check('drugie scalenie nic nie dubluje', p.api.merge(merged).length === merged.length);
  check('katalog kanałów z serwera', p.api.channels().length === 1);
}

/* --- 2. wejście dopisuje, ale tylko raz --- */
{
  const p = phone({ channels: CHANNELS });
  await p.api.sync();
  p.api.onOpen(CH);
  p.api.onOpen(CH);
  await new Promise((r) => setTimeout(r, 60));
  const joins = p.calls.inserts.filter((i) => i.table === 'group_members');
  check('wejście w kanał dopisuje do członków', joins.length === 1, joins.length + ' wpisów');
  check('jako zwykły członek', joins[0] && joins[0].row.role === 'member', joins[0] && joins[0].row.role);
  check('dla właściwego kanału', joins[0] && joins[0].row.group_id === CH);
  check('wejście poza kanałem nic nie robi', (p.api.onOpen('peer-1'), p.calls.inserts.length === 1));
}

/* --- 3. kanał nie jest szyfrowany --- */
{
  const p = phone({ channels: CHANNELS });
  await p.api.sync();
  check('kanał publiczny bez szyfrowania', p.api.plain(CH) === true);
  check('zwykła rozmowa nadal szyfrowana', p.api.plain('peer-1') === false);
  check('My Notepad nietknięty', p.api.plain('personal_notes') === false);
}

/* --- 4. historia kanału w tym samym oknie --- */
{
  const rows = [
    { id: 11, sender_id: 'peer-1', receiver_id: ME, text: 'cześć w kanale', type: 'text', created_at: '2026-11-02T10:00:00Z', group_id: CH },
    { id: 12, sender_id: ME, receiver_id: ME, text: 'hej', type: 'text', created_at: '2026-11-02T10:01:00Z', group_id: CH },
    { id: 13, sender_id: 'peer-1', receiver_id: ME, text: JSON.stringify({ version: 'ecdh-v1', ciphertext: 'xx' }), type: 'text', created_at: '2026-11-02T10:02:00Z', group_id: CH }
  ];
  const p = phone({ channels: CHANNELS, messages: rows });
  await p.api.sync();

  let state = { [CH]: [] };
  p.api.useBridge({
    current: () => CH,
    setMessages: (fn) => { Object.assign(state, fn(state)); },
    renderList: () => {}
  });

  const n = await p.api.loadHistory(CH);
  check('historia kanału wczytana', n === 3, 'wczytano ' + n);
  check('wiadomości w TEJ SAMEJ rozmowie', state[CH].length === 3, state[CH].length);
  check('własna wiadomość po prawej (me)', state[CH].some((m) => m.id === 12 && m.sender === 'me'));
  check('cudza wiadomość po lewej (them)', state[CH].some((m) => m.id === 11 && m.sender === 'them'));
  check('szyfrogram w kanale nie straszy „🔒"', state[CH].some((m) => m.id === 13 && m.text.indexOf('zaszyfrowana') >= 0));
  const again = await p.api.loadHistory(CH);
  check('drugie wczytanie nic nie dubluje', state[CH].length === 3, state[CH].length + ' po ' + again);
}

/* --- 5. nagłówek kanału --- */
{
  const p = phone({ channels: CHANNELS });
  await p.api.sync();
  const person = p.api.person(CH);
  check('nagłówek pokazuje nazwę kanału', person && person.name === '#ogólny', person && person.name);
  check('temat kanału jako status', person && person.status.indexOf('Kanał publiczny') === 0, person && person.status);
  check('nie-kanał nie dostaje fałszywego nagłówka', p.api.person('peer-1') === null);
}

/* --- 6. bez własnego UI --- */
{
  check('moduł nie tworzy żadnego elementu na ekranie', SRC.indexOf('createElement') === -1);
  check('moduł nie dotyka listy w DOM', SRC.indexOf('.appendChild') === -1 && SRC.indexOf('innerHTML') === -1);
}

console.log('\n' + passed + ' OK, ' + failed + ' FAIL');
process.exit(failed ? 1 : 0);
