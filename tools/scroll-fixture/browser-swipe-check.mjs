// Sprawdzenie PRAWDZIWEGO przeciągnięcia palcem (v3.43.4).
//
// Historia: trzy wydania z rzędu twierdziły, że przewijanie działa, a użytkownik
// odpowiadał „dalej nie mogę" / „działa, ale tylko jak od paska". Ten test
// odtwarza dokładnie to, co robi palec: naciska NA WIERSZU listy i jedzie w górę.
// Zdarzenia dotyku idą przez CDP (prawdziwy dotyk WebView), nie syntetycznie.
//
// Wymaga: npm i playwright && npx playwright install chromium
// Uruchomienie: node tools/scroll-fixture/browser-swipe-check.mjs
import { chromium, devices } from 'playwright';
const b = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });

async function drag(page, cdp, x, y0, dy, steps = 14) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / steps }] });
    await page.waitForTimeout(14);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
}

const ctx = await b.newContext({ ...devices['Pixel 5'], hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const HERE = process.cwd();
await p.goto('file://' + HERE + '/tools/scroll-fixture/chats-tab-preview.html');
await p.waitForTimeout(700);
const cdp = await ctx.newCDPSession(p);

// 1) palec na WIDOCZNYM wierszu
const row = await p.locator('.contact-item').nth(2).boundingBox();
await drag(p, cdp, row.x + row.width * 0.55, row.y + row.height * 0.5, -280);
const afterDrag = await p.evaluate(() => ({
  tab: Math.round(document.querySelector('.chats-tab').scrollTop),
  list: Math.round(document.querySelector('.contacts-list').scrollTop),
  opened: window.__opened || 0,
  headerTop: Math.round(document.querySelector('.tab-header').getBoundingClientRect().top)
}));
console.log('palec na wierszu ->', JSON.stringify(afterDrag));

// 2) dotknięcie bez ruchu ma NADAL otwierać rozmowę
await p.evaluate(() => { window.__opened = 0; document.querySelector('.contacts-list').scrollTop = 0; });
await p.waitForTimeout(500);            // okno tłumienia kliknięcia po przeciągnięciu mija
const row2 = await p.locator('.contact-item').nth(1).boundingBox();
await p.touchscreen.tap(row2.x + row2.width * 0.5, row2.y + row2.height * 0.5);
await p.waitForTimeout(500);
const openedByTap = await p.evaluate(() => window.__opened || 0);
console.log('dotknięcie bez ruchu -> otwarte rozmowy:', openedByTap);

// 3) przewijanie w drugą stronę (palec w dół)
await drag(p, cdp, row.x + row.width * 0.55, row.y + row.height * 0.3, 200);
const back = await p.evaluate(() => Math.round(document.querySelector('.contacts-list').scrollTop));
console.log('palec w dół -> lista scrollTop:', back);

const ok = {
  'palec na wierszu przewija listę': afterDrag.list > 100,
  'nagłówek zostaje na ekranie': afterDrag.headerTop === 0,
  'przeciągnięcie nie otwiera rozmowy': afterDrag.opened === 0,
  'zwykłe dotknięcie nadal otwiera rozmowę': openedByTap === 1,
  'przewijanie w drugą stronę działa': back < afterDrag.list
};
console.log('');
for (const [k, v] of Object.entries(ok)) console.log((v ? 'OK   ' : 'FAIL ') + k);
await b.close();
process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
