// Sprawdzenie w prawdziwej przeglądarce (v3.43.3).
//
// Po co: dwa wydania z rzędu twierdziły, że przewijanie jest naprawione,
// a użytkownik dalej nie mógł przewinąć listy czatów. Ten test uruchamia
// Chromium w rozmiarze telefonu, na prawdziwym arkuszu stylów aplikacji,
// i sprawdza, czy treść naprawdę się przesuwa — a nie tylko, czy w CSS jest
// „ładna" właściwość.
//
// Wymaga: npm i playwright && npx playwright install chromium
// Uruchomienie: node tools/scroll-fixture/browser-check.mjs
import { chromium, devices } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = 'file://' + path.join(HERE, 'chats-tab-preview.html');
const b = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });

async function probe(withModule) {
  const ctx = await b.newContext({ ...devices['Pixel 5'] });
  const p = await ctx.newPage();
  if (!withModule) await p.route('**/rise-scroll-guard.js', (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await p.goto(URL);
  await p.waitForTimeout(600);
  const res = await p.evaluate(() => {
    // który element pod palcem naprawdę się przewija?
    const list = document.querySelector('.contacts-list');
    const chain = [];
    for (let n = list; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      chain.push({ sel: n.className || n.tagName, sh: n.scrollHeight, ch: n.clientHeight,
                   overflowY: cs.overflowY, hidden: cs.overflow === 'hidden' });
    }
    const scroller = chain.find((c) => c.sh > c.ch + 4 && /auto|scroll/.test(c.overflowY));
    const clipped = chain.filter((c) => c.hidden && c.sh > c.ch + 4).map((c) => c.sel);
    const bar = getComputedStyle(list, '::-webkit-scrollbar');
    return { scroller: scroller || null, clipped, barWidth: bar.width, barDisplay: bar.display,
             headerPos: getComputedStyle(document.querySelector('.tab-header')).position };
  });
  // czy kółko/przewinięcie faktycznie rusza treść
  const box = await p.locator('.contacts-list').boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + 200);
  await p.mouse.wheel(0, 600);
  await p.waitForTimeout(300);
  res.scrolledBy = await p.evaluate(() => {
    const list = document.querySelector('.contacts-list');
    for (let n = list; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return n.className + ':' + Math.round(n.scrollTop);
    return 'brak ruchu';
  });
  res.headerAfter = await p.evaluate(() => Math.round(document.querySelector('.tab-header').getBoundingClientRect().top));
  await p.screenshot({ path: path.join(HERE, (withModule ? 'po' : 'przed') + '.png') });
  await ctx.close();
  return res;
}

const before = await probe(false);
const after = await probe(true);
console.log('PRZED :', JSON.stringify(before));
console.log('PO    :', JSON.stringify(after));
const ok = {
  'przed: brak jakiegokolwiek przewijania': before.scroller === null,
  'przed: treść obcięta przez overflow:hidden': before.clipped.length > 0,
  'po: lista ma czym się przewijać': after.scroller !== null,
  'po: nic nie jest obcięte': after.clipped.length === 0,
  'po: kółko/palec rusza treść': after.scrolledBy !== 'brak ruchu',
  'po: nagłówek nie jest przyklejany (przewija się z listą)': after.headerPos === 'static',
  'po: brak paska przewijania': after.barDisplay === 'none' || after.barWidth === '0px'
};
for (const [k, v] of Object.entries(ok)) console.log((v ? 'OK   ' : 'FAIL ') + k);
await b.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
