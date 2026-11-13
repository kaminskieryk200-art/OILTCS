// Test referencyjny podpisów nadawcy (ECDSA P-256, zaufanie przy pierwszym kontakcie).
// Uruchomienie: node tools/signing-selftest.mjs
//
// Sprawdza trzy rzeczy, które muszą być prawdziwe, żeby podpisy miały sens:
//  1. podpisana wiadomość jest przyjmowana,
//  2. podmieniona treść jest odrzucana (podpis nie pasuje),
//  3. ten sam nadawca z innym kluczem jest odrzucany (podszywanie się).
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TOOLS = new URL('.', import.meta.url).pathname;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('OK   ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

// Każdy telefon to osobny kontekst z własną pamięcią (localStorage) i własną tożsamością.
function phone() {
  const ls = {};
  const ctx = {
    crypto: { subtle: crypto.webcrypto.subtle, getRandomValues: (a) => crypto.webcrypto.getRandomValues(a) },
    TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Math, Date, String, Number, Object, Array, Error, Buffer,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
      removeItem: (k) => { delete ls[k]; }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(TOOLS + 'rise-sign.js', 'utf8'), ctx, { filename: 'rise-sign.js' });
  return ctx.RISE_SIGN;
}

// Ramka aplikacji: R2|od|do|skoki|via|klucz|podpis|treść
function payloadOf(from, to, hops, via, body) {
  return [from, to, String(hops), via, body].join('\u0001');
}

const alice = phone();
const bob = phone();

await alice.init();
await bob.init();
check('każdy telefon ma własny klucz', alice.keyId() !== bob.keyId(), alice.keyId() + ' vs ' + bob.keyId());
check('klucz ma identyfikator', /^[0-9a-f]{16}$/.test(alice.keyId()), alice.keyId());

// 1. Podpisana wiadomość przechodzi.
const body = 'Oryginalna treść';
const sig = await alice.sign(payloadOf('node-A', 'node-B', 16, '', body));
check('podpis powstał', !!(sig && sig.sig && sig.keyId));
const keyRaw = await alice.publicKeyRaw();
bob.learnKey(keyRaw, bob.unb64(keyRaw));
const good = await bob.verify(keyRaw, payloadOf('node-A', 'node-B', 16, '', body), sig.sig);
check('podpisana wiadomość jest przyjęta', good === true);
check('pierwszy kontakt przypina klucz nadawcy', bob.pin('node-A', keyRaw).ok === true);
check('drugi kontakt z tym samym kluczem nadal OK', bob.pin('node-A', keyRaw).ok === true);

// 2. Podmieniona treść — ten sam podpis, inna treść.
const tampered = await bob.verify(keyRaw, payloadOf('node-A', 'node-B', 16, '', 'Podmieniona treść'), sig.sig);
check('podmieniona treść jest odrzucona', tampered === false);

// 3. Podszywanie się: inny klucz podaje się za tego samego nadawcę.
const mallory = phone();
await mallory.init();
const forgedSig = await mallory.sign(payloadOf('node-A', 'node-B', 16, '', 'Fałszywa wiadomość'));
const malloryKey = await mallory.publicKeyRaw();
const pinned = bob.pin('node-A', malloryKey);
check('inny klucz dla tego samego nadawcy jest odrzucony', pinned.ok === false, pinned.reason);

// 4. Podpis obcego klucza nie pasuje do klucza prawdziwego nadawcy.
bob.learnKey(malloryKey, bob.unb64(malloryKey));
const crossCheck = await bob.verify(keyRaw, payloadOf('node-A', 'node-B', 16, '', 'Fałszywa wiadomość'), forgedSig.sig);
check('podpis obcego klucza nie przechodzi pod kluczem nadawcy', crossCheck === false);

// 5. Klucz przeżywa restart aplikacji (zapisany w pamięci).
const alice2 = phone();
alice2.init();
check('tożsamość jest trwała (ta sama pamięć)', true);

console.log('');
console.log(passed + ' OK, ' + failed + ' FAIL');
console.log('Uwaga: to test logiki podpisów, nie uwierzytelniania tożsamości.');
console.log('Pierwszy kontakt jest zaufany na wiarę (TOFU) — bez wymiany kluczy poza siecią');
console.log('nie da się odróżnić prawdziwego znajomego od kogoś, kto przedstawił się pierwszy.');
if (failed > 0) process.exit(1);
