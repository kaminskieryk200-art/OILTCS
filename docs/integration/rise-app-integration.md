# Integration notes — what Rises actually implements today (v3.35.0)

Status: **implementation report for the prototype document.** This describes code that exists and has been built into a signed Android package, and it separates clearly what was tested and where. It is not a standard, not an audit, and not a claim of production readiness.

Written against Rises `v3.36.0` (versionCode 208), published 2026-11-02.

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

**Not solved:** trust on first use. If the attacker is the *first* party to claim a sender id, they are accepted. Real authentication requires exchanging keys out of band — for example a QR code shown at the first in-person meeting. Voice calls and delivery receipts are still unauthenticated.

**One bug this work exposed and fixed:** the verification cache was keyed by `key|signature` without the body, so a tampered body carrying the same signature was treated as already verified and accepted. The cache key now includes a cheap hash of the body. It is worth recording because it shows how a security check can be defeated by its own optimisation.

## Honest summary

The transport gap that this repository listed as unsolved (“the repository does not provide a tested BLE application”) is now *implemented* but still **untested on hardware**. Radio range, discovery, real pairing prompts and power consumption on an actual phone remain unknown. Nothing here should be read as delivery guarantees.
