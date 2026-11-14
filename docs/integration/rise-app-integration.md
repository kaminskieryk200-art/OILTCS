# Integration notes — what Rises actually implements today (v3.43.4)

Status: **implementation report for the prototype document.** This describes code that exists and has been built into a signed Android package, and it separates clearly what was tested and where. It is not a standard, not an audit, and not a claim of production readiness.

Written against Rises `v3.41.0` (versionCode 213), published 2026-11-02.

## What changed in the reference implementation

| Area | Before | Now |
|---|---|---|
| Local link | classic Bluetooth only, requires a **previously paired** phone | BLE: advertising, scanning, GATT server and client — **no pairing needed** |
| Incoming data path | one `accept()` call, one read, never returned | native loop: accept → read to end → close → repeat, buffer behind a lock |
| Route survivability | hop counter only | “charging station” model: TTL is restored to full at every station |
| Loop protection | none in the app layer | duplicate ID cache (500) plus sent-frame cache plus “never relay back to the sender” |
| Relay selection | manual MAC entry | paired devices discovered automatically, plus BLE peers ranked by RSSI |
| User-visible switch | a toggle in the main view | removed; disabling lives only in Options → Advanced, with a warning |

## BLE link (new in v3.35.0)

Service UUID `7a1e5c30-9b24-4a53-9d21-3f0c5e77a001`, characteristic `…a002` with `WRITE` / `WRITE_NO_RESPONSE` and `PERMISSION_WRITE`.

- **Advertising:** `AdvertiseSettings` `LOW_LATENCY`, `TX_POWER_HIGH`, `setConnectable(true)`, no timeout; service data payload `RS 01` + 4-byte node hash. Device name is not advertised.
- **Scanning:** `BluetoothLeScanner` with `SCAN_MODE_LOW_LATENCY`, no filters (every advertiser is inspected and payloads without the `RS` magic are ignored). Self is filtered out by comparing node hashes. RSSI is recorded per peer.
- **Receiving:** `BluetoothGattServer` with one service and one writable characteristic. Chunks are reassembled per sender.
- **Sending:** `connectGatt(..., autoConnect=false)` → `discoverServices` → `writeCharacteristic` for each chunk, 40 ms apart, then `disconnect`.
- **Chunk format (8-byte header):** `R` `S` | id (2) | index (1) | total (1) | length (2) | UTF-8 body, max 180 bytes of body per chunk.
- **Peer window:** a peer counts as “nearby” for 120 s after its last advertisement.

Permission behaviour: `BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` are requested at runtime; when `SDK_INT < 31`, `ACCESS_FINE_LOCATION` is requested too (legacy BLE scanning requirement).

### Verified and unverified

Verified in this environment:

- the Java sources compile against `android.jar` (API 35), convert with `d8 --min-api 24`, disassemble and reassemble into the app’s `classes14.dex`;
- the assembled package contains `BluetoothLeAdvertiser` (6 references), `BluetoothLeScanner` (6), `openGattServer`, `connectGatt`, and two `addJavascriptInterface` bridges (`RisesRadio`, `RisesBle`);
- the JavaScript layer passes an end-to-end simulation in which two “foreign” phones exchange a message with no pairing (see below).

**Not verified** — and this is the important part:

- **no physical BLE device was used.** No radio, no second phone, no emulator. Every claim about range, throughput, discovery latency and real reassembly is untested;
- `isMultipleAdvertisementSupported()` is the only capability gate; phones that cannot advertise fall back to classic Bluetooth with no user-visible explanation;
- ~~advertising payload size~~ — **fixed in v3.36.0**: the advertisement now carries 7 bytes of manufacturer data (11 bytes in the AD structure, 20 bytes of headroom) instead of 25 bytes of service data with a 128-bit UUID. The scanner also still accepts the old service-data format, and `onStartFailure` with `ADVERTISE_FAILED_DATA_TOO_LARGE` retries with a 4-byte payload. **Still untested on hardware**, because no device that rejects advertisements was available;
- GATT write throughput with `WRITE_TYPE_DEFAULT` and a 40 ms delay between chunks gives roughly 10 chunks/s ≈ 1.8 kB/s of payload. A 2 kB message therefore takes about a second per hop. This is an estimate from the code, not a measurement;
- `connectGatt` to a non-paired peer may trigger an OS pairing prompt on some Android builds. Untested.

## Station model (“charging to full”)

`tools/rise-stations.js` (copied from the app; self-test in `tools/stations-selftest.mjs`):

- `accept(env)` rejects expired envelopes and IDs already seen (in-memory set, 500 entries). Rejection is not silent: it increments `dropped`.
- `charge(env)` returns a copy with TTL restored to `FULL_CHARGE = 16`, `hops + 1`, a refreshed `expires` (72 h) and `chargedBy`. The signal therefore does not decay with distance; what decays is the number of devices that are actually present.
- `createRegistry()` ranks known stations by reliability, then recency, and refuses entries without a syntactically valid MAC address.
- `routeLength(distanceM, rangeM)` reports how many stations a distance needs at a given per-hop range.

Run it with `node tools/stations-selftest.mjs` → 14 checks, all passing, no radio involved.

## Loop and duplicate protection in the app layer

- `packFrame` produces `R1|from|to|hops|via|body`; `body` may itself contain the separator, because only the first five fields are positional.
- The last station a frame came from is carried in `via` and is excluded from the next hop selection, so two phones cannot bounce a message between themselves.
- Frames this device sent are remembered (`sentFrames`, 80 entries) and dropped on return.
- A frame whose `from` equals the local node ID is dropped.
- Duplicate IDs are dropped by the station layer, independently of the above.

## Simulation result (not a field test)

Three phones in one `vm` context with a stubbed radio: A → C through B arrives with identical text; the duplicate is dropped; a returning message does not create a loop; a body containing `|` round-trips; a disabled station does not relay; a phone without BLE degrades to classic Bluetooth. All of this exercises only the JavaScript logic — the native bridge was stubbed.

## Remaining work, in the order I would do it

1. **Fix the advertising payload** (move the service UUID to the scan response, or advertise a 16-bit alias) and test on two real phones.
2. Replace the fixed 40 ms inter-chunk delay with a write-completion callback and MTU negotiation; measure real throughput.
3. Persist the duplicate cache so a restart does not re-accept old traffic.
4. ~~Add an authenticated source field~~ — **done in v3.36.0**: every frame is `R2|from|to|hops|via|key|signature|body`, signed with the sender’s ECDSA P-256 key over `from\u0001to\u0001hops\u0001via\u0001body`. The receiver verifies, learns the sender’s public key from the frame, and pins the first key seen for that sender (TOFU); a changed key is rejected. Legacy `R1` frames are still accepted and counted as unsigned. **TOFU is not authentication of identity** — see the new section below.
5. Background behaviour: a foreground service with `FOREGROUND_SERVICE_CONNECTED_DEVICE`, battery budget, and behaviour when the screen is off — currently untested entirely.
6. Interoperability with the JVM reference router in this repository. The app frame (`R1|…`) is a prototype format and is **not** the `OILT` router packet described in `PROTOCOL-v0.md`; converging them is unresolved.

## Message signing (v3.36.0) — and what it does not solve

`tools/rise-sign.js` / `tools/signing-selftest.mjs` (10 checks):

- a device generates one ECDSA P-256 key pair and keeps it in app storage;
- each frame carries the sender's public key and a signature over the routing fields and the body;
- the receiver verifies the signature, learns the key, and pins the first key seen per sender;
- a body changed after signing is rejected (the signature covers it);
- an attacker signing with their own key while claiming another sender is rejected after the first pin;
- identity survives an app restart.

**Now solved for verified contacts (v3.37.0):** two phones show each other a QR code containing `RVS1|<node id>|<public key>`. The scanned key is stored as *verified* and cannot be silently overwritten; a message from a verified sender carrying a different key is rejected. Until a contact is verified, the first-contact rule still applies.

**Verification without meeting (v3.38.0).** A QR code is useless when the other person is far away, which a reviewer pointed out. Two remote paths were added:

- **Safety code.** 12 characters derived from the sender's public key (SHA-256, base32 alphabet without `0/O/1/I`, grouped `XXXX-XXXX-XXXX`). It can be read aloud over any voice channel — a phone call, a radio, a walkie-talkie — or sent by SMS, and the recipient types it in. 60 bits, so guessing is not practical. `node tools/distance-verify-selftest.mjs` covers it.
- **Vouching.** A contact *you* have already verified can vouch for a third person. The vouch is `V1|voucher|POREKA|target|target key|signature|hops`, signed with the voucher's key, and travels through the mesh like an ordinary message. Vouches from unverified senders are rejected, conflicting vouches about the same person are rejected, and a vouch never overrides an identity confirmed in person.

Every delivered message now carries a trust level: `potwierdzony` (confirmed), `poręczony` (vouched), `nieznany` (unknown) or `sprzeczny` (conflicting).

**Still not solved:** verification confirms a *phone*, not a *person*; vouching propagates trust, so a mistaken or deceived voucher spreads the error; and a safety code read aloud can be overheard. Anyone holding an unlocked app can show someone else's code. And an unverified first contact remains accepted on trust. Voice calls and delivery receipts are still unauthenticated.

**One bug this work exposed and fixed:** the verification cache was keyed by `key|signature` without the body, so a tampered body carrying the same signature was treated as already verified and accepted. The cache key now includes a cheap hash of the body. It is worth recording because it shows how a security check can be defeated by its own optimisation.

## Settings placement bug (found by the user, fixed in v3.37.0)

The in-app settings card was inserted by clicking a text label “Zaawansowane” (Advanced). A check of the app bundle shows that label **does not exist** — the app has an “Opcje” (Options) tab only. The card therefore never appeared, while the release notes told the user to open Options → Advanced. The card is now inserted into the real Options screen, located by labels it actually contains (`Blokada PIN`, `Status konta`).

This is worth recording as a testing lesson: the JavaScript-level tests passed because they never exercised the UI, and no test asserted that the settings entry point existed.

## Message encryption without a password (v3.40.0)

Requested: encrypt and protect the message, but not with a password — with a watermark built into the text, bound to one specific recipient.

- **Key agreement.** Each device keeps a second key pair (ECDH P-256) beside its signing key. A sender combines its own private key with the recipient's public key; HKDF produces an AES-256-GCM key. The same key is derived independently by the recipient. **No secret is typed by any user.**
- **Key distribution.** The QR code is now `RVS2|node|signing key|encryption key`; vouches carry the target's encryption key; and every `R3` frame carries the sender's encryption key, so two parties can encrypt after the first message. `R2`/`R1` frames are still accepted.
- **Watermark.** `serial|recipient tag|sender tag|sequence`, inserted as invisible `U+2063` characters at the end of the text **before** encryption and stripped **before** the text is shown. `check()` rejects a mark that does not match the specific sender/recipient pair, so a mark lifted from one conversation does not validate in another.
- **Relays** see only `RSX1:<iv>:<ciphertext>` and cannot read it.

`node tools/encryption-selftest.mjs` → 13 checks: separate keys per device, both keys exchanged by QR, ciphertext on the wire with no plaintext, recipient reads, bystander does not, watermark round-trips without changing what a human sees, watermark valid only for its own pair, missing key = plaintext.

**Limits.** The private key sits in app storage, so an unlocked phone is a compromised phone. If the sender has no public key for the recipient, the message travels **in plaintext (still signed)** and is counted as such. The watermark identifies a leak; it does not prevent one. The key exchange has no forward secrecy: one long-lived key pair per device, no ratcheting, no key rotation.

## OILTCS under the normal interface (v3.43.0)

Two earlier answers were rejected by the user, in this order:

1. v3.41.0 — a separate offline chat view (own screen, floating “Czaty offline (N)” button). Rejected: *“make it all work properly, without other views.”*
2. v3.42.0 — rows and a conversation panel injected next to the app's list. Rejected again, with a screenshot: *“it must be the same chat window, not another one; when the internet goes away I have the normal interface, but calls and messages go through OILTCS.”*

v3.43.0 takes that literally: **the module draws nothing at all.** `tools/rise-native-chat.js` registers `RISE_OFFLINE_CHAT`, and `tools/patch-native-chat.py` wires it into six places inside the app bundle, so the app's own screens are the only screens:

| Where | What the patch does |
| --- | --- |
| chat send (`fn`) | keeps the normal server write; the same text also goes to `RISE_OFFLINE_CHAT.offer(peer, text)` — the radio path, which queues when nothing is audible |
| failed/queued write | calls `offer()` too, so a message that the server did not accept still leaves over OILTCS |
| confirmed write | `remember()` — the message is kept on the device, so it survives a restart and appears in the same thread later |
| chat list (`zn`) | `merge()` appends only the people the app does not already have, with the name and avatar from `profiles` and the last message as the preview |
| conversation header (`Bn`) | `person(id)` supplies the header for someone who is not in the server directory, instead of the generic “Chat Partner” |
| bridge effect | `useBridge({current, setMessages, renderList, myId})` gives the module read access to the open conversation and the ability to append, so an incoming radio message lands in the very same thread |

The patch is strict: each anchor must occur exactly once, otherwise it prints what it could not find and writes nothing. It is idempotent (a guard comment stops a second pass), and `tools/patch-native-chat-selftest.mjs` runs it on a fixture bundle, checks the patched output parses, checks the refusal path, and then executes the patched code against a stub module to confirm the send path really calls `offer()`/`remember()` and the list really calls `merge()`.

`node tools/native-chat-selftest.mjs` → 29 checks, including “the module creates no element on the screen” and “it appends an incoming radio message to the open conversation”. `node tools/patch-native-chat-selftest.mjs` → 11 checks.

**Limits, stated plainly.** The bundle is minified application code that I do not have the sources for; the patch targets exact strings, so any rebuild of the app can move them — the patch then refuses to run instead of corrupting the file, and the six strings have to be re-derived. Radio delivery is still unverified on hardware, and nothing here has been run on a physical phone. Local history is a mirror of the last 300 server messages plus everything that went through OILTCS; it is not a full archive. Ciphertext in the app's own `ecdh-v1` format is shown as “🔒 Wiadomość zaszyfrowana”, not decrypted, because the plaintext is not on the server by design.

## Scrolling on a phone (v3.43.1)

Reported from a screenshot: *“you broke the interface again, it does not scroll”* and *“if you have any other menu that scrolls, you only have a scrollbar like on a laptop — I am on a phone”*.

What the app ships, found by reading the files inside the APK:

| Where | What it does | Why the list would not scroll |
| --- | --- | --- |
| `assets/index-*.css` | `html,body{touch-action:none;overflow:hidden}` | fine on its own — the screen must not move — but `touch-action` is inherited by everything inside, so lists had no permission to move vertically |
| `assets/index-*.css` | `.contacts-list{flex:1;padding:4px 8px;overflow-y:auto}` | no `min-height:0`; a flex child never shrinks below its content, so as rows are added the list grows downwards instead of scrolling, and the rows below are cut off |
| `assets/index-*.css` | `::-webkit-scrollbar{width:4px;height:4px}` | a 4 px bar drawn on the phone — the “laptop scrollbar” |
| `rise-ui-fix.js` (v3.39.0) | `pullIntoView()` calls `scrollIntoView()` on whatever sticks out past the right edge | the only mechanism that could move a scroller — and it can also jump the list while a finger is down |
| `rise-native-chat.js` (v3.43.0) | `refresh(true)` after every radio packet, plus `renderList` on each bridge attach | React re-renders the whole list; a re-render while a finger is dragging cancels the scroll |

v3.43.1 changes exactly those five things and nothing about the layout:

- new `rise-scroll-guard.js` — on a touch screen only, gives the lists `min-height:0`, `touch-action:pan-y`, `overscroll-behavior:contain`, hides the scrollbar (`scrollbar-width:none` and `::-webkit-scrollbar{display:none}`), and keeps `html,body` movable vertically. On a computer it does nothing at all, so the normal scrollbar stays.
- `rise-ui-fix.js` no longer touches anything inside a scrolling list, no longer calls `scrollIntoView` from inside one, and does nothing while a finger is on the screen.
- `rise-native-chat.js` re-renders the chat list only when its content really changed (new person or new preview), at most every 1,5 s.

`node tools/scroll-guard-selftest.mjs` → 12 checks (long list becomes scrollable, short list untouched, scrollbar hidden on touch only, nothing moves while a finger is down, computer unchanged). `node tools/native-chat-selftest.mjs` → 31, `node tools/patch-native-chat-selftest.mjs` → 11.

**Not verified on a real phone** — I have no device here, so this is derived from the shipped files, not from watching it scroll. If it still sticks, the next thing to suspect is the app's own scrolling code inside the bundle (`touchmove`, `scrollTop`, `deltaY` appear there).

## The chat list would not scroll — the real cause (v3.43.2)

v3.43.1 guessed. It added `min-height:0` and `touch-action:pan-y` to the obvious lists, and the list still would not move. So I stopped guessing and measured: a headless Chromium in a phone viewport, loading the app's real stylesheet, on a copy of the chats screen.

What came out of the measurement (`tools/scroll-fixture/browser-check.mjs`, screenshots `przed.png` / `po.png`):

1. **The app switches scrolling off on purpose.** `PhoneApp` registers a document-wide `touchmove` listener that calls `preventDefault()` unless the target is inside one of a dozen allowed lists — `messages-list`, `contacts-list`, `directory-list`, `profile-content`, `settings-content`, … **`chats-tab` is not on that list.** On the chat list the target is the list's container, so every drag was cancelled.
2. **`html,body{touch-action:none}`** — on top of that, nothing inside could claim vertical movement.
3. **The CSS already solves this for two other tabs.** There is a rule that makes Settings and Profile and Contacts scroll as a whole tab (`overflow-y:auto; touch-action:pan-y`) and flattens their inner lists. **Chats was left out of that rule.**
4. **The list cannot do it alone:** `.contacts-list` is a block children of the tab, and with the browser's default alignment it stretches to the height of its content (2658 px measured) inside a 663 px tab. The tab must be the scroller.

Measured, before → after:

| | before (3.43.1) | after (3.43.2) |
| --- | --- | --- |
| element that actually scrolls | none | `.tab-view.chats-tab` (2851 px inside 663 px) |
| content clipped by `overflow:hidden` | `.screen-content.chats-content` | none |
| scrollbar on the list | 8 px, visible | hidden |
| header “Czaty” | static | static (scrolls away with the list — see 3.43.3) |
| drag/wheel moves the content | no | yes |

v3.43.2 additionally pinned the header with `position:sticky`, and the screenshot of the result showed the semi-transparent header sitting over the row underneath, with rows showing through it. v3.43.3 drops the pin: the header scrolls away with the list, exactly as it already does in Settings and Profile. Nothing is pinned and nothing is recoloured.

The fix is three small things: the patch adds `chats-tab` to the app's own allow-list in the bundle, `rise-scroll-guard.js` pulls Chats into the same “whole tab scrolls” treatment Settings and Profile already get (and pins the header), and the earlier over-eager rules are kept so `min-height:0` applies to every list regardless of how tall it currently is.

`node tools/scroll-guard-selftest.mjs` → 17 checks. `node tools/scroll-fixture/browser-check.mjs` → 7 checks in real Chromium. `native-chat-selftest` → 31, `patch-native-chat-selftest` → 12.

**Still not a phone.** This is Chromium in a phone viewport on the app's own CSS, which is much closer than reading CSS by eye, but the Android WebView is a different build. If anything still sticks there, the next suspect is the same allow-list logic in the packed bundle.

## “It works, but only from the bar” (v3.43.4)

v3.43.3 made the Chats *tab* the scroller. The user's reply was precise and destroyed that answer: *“it works, but only from the bar”* — dragging from an empty strip near the bottom scrolled, dragging on a row did nothing.

Measured again, this time with **real touch events** (CDP `Input.dispatchTouchEvent`, a finger pressed on a row and moved up):

| start of the gesture | 3.43.3 | 3.43.4 |
| --- | --- | --- |
| on an empty strip inside the list | scrolls | scrolls |
| **on a chat row** | **does not move** | scrolls (row → `scrollTop`) |
| header | scrolls off the screen | stays |
| tap on a row | opens the chat | opens the chat |

The gesture that starts on a row is eaten before any scroller sees it. Rather than keep hunting through the CSS of a bundle I cannot rebuild, v3.43.4 stops depending on the browser for this one screen: `rise-scroll-guard.js` now drives the drag itself.

- a finger pressed inside the chat list (or the message list) and moved vertically moves the list's `scrollTop` by exactly the distance travelled, with `preventDefault()` so the browser does not do it twice;
- horizontal gestures, text fields and buttons are left alone — a tap with no movement still opens the chat;
- the click a browser synthesises after a drag is suppressed for 200 ms, so a swipe never opens a conversation by accident;
- on a computer none of this runs, and nothing at all is drawn: the module still creates no element on screen.

Verified with real touch: row-drag → list scrolls 280 px, header stays at the top, drag does not open a chat, tap does open one, reverse drag works. `node tools/scroll-guard-selftest.mjs` → 21 checks (including “horizontal gesture is not taken over”, “text field keeps its own movement”, “nothing moves while a finger is down”).

**The honest limit:** this is Chromium's touch pipeline, not an Android WebView on the user's phone. It is the closest thing to a phone I have here, and it now reproduces and fixes the exact symptom the user reported — but the last word is still theirs.

## Honest summary

The transport gap that this repository listed as unsolved (“the repository does not provide a tested BLE application”) is now *implemented* but still **untested on hardware**. Radio range, discovery, real pairing prompts and power consumption on an actual phone remain unknown. Nothing here should be read as delivery guarantees.
