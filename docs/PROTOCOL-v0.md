# OILTCS router v0 — experimental draft

Status: **not a standard; incompatible changes are expected**. This describes the included JVM reference router, not a complete messaging, radio, encryption, or call protocol. All integers below are unsigned and big-endian unless stated otherwise. The router frame is at most 4096 bytes.

## Routing packet

| Offset | Bytes | Field | Reference behavior |
|---:|---:|---|---|
| 0 | 4 | Magic | ASCII `OILT` (`4f 49 4c 54`) |
| 4 | 1 | Version | `00` |
| 5 | 1 | Remaining hops | 1–64 |
| 6 | 16 | Packet ID | Fresh unpredictable bytes for each transmission, including retries |
| 22 | 16 | Destination | 16-byte routing identifier; it is **not** an authenticated account identity |
| 38 | 2 | Payload length | 1–4056, exactly equal to remaining bytes |
| 40 | 1–4056 | Payload | Opaque to router; encryption/authentication must be supplied separately |

Example and exact bytes: [`../test-vectors/router-v0.json`](../test-vectors/router-v0.json). The test payload is intentionally unencrypted and contains no actual message.

A router checks format, registered incoming neighbor, and its per-neighbor rate limit. It maintains an in-memory cache of at most 8192 packet IDs. A seen ID is dropped, regardless of source; therefore a malicious peer can poison this cache. If destination equals the local routing ID, the opaque payload is delivered to the local sink and is not forwarded. Otherwise, an originating router sends to all neighbors. A forwarding router sends to every neighbor except the input only if remaining hops exceed 1, after decrementing the field. This is bounded flooding, **not** route discovery. Failed sends are ignored; no delivery is inferred.

The reference supports at most 16 neighbors and uses a per-neighbor token bucket (200 packets/second, burst 200). Limits and timeouts are implementation choices, not network-wide guarantees. Disabling clears peer and duplicate state. State is not durable; an evicted or post-restart ID can be accepted again. This format provides no authenticated source, confidentiality, integrity, privacy of metadata, congestion control, resistance to flooding, or proof of actual forwarding.

## Optional stream framing

The included `FrameIO` wraps a frame in a four-byte **signed** big-endian length, accepted range 1–4096, followed by exactly that many bytes. A stream implementation needs its own connection management, authentication and timeouts. This framing is separate from the routing packet.

## Experimental BLE fragmentation

`BleFrameCodecLab` fragments one frame at a time into ATT values. Each value has a 12-byte header followed by data:

| Bytes | Field |
|---:|---|
| 2 | ASCII `RB` |
| 1 | Fragment format version `01` |
| 1 | Reserved `00` |
| 4 | Sequence number (32-bit bit pattern, big-endian) |
| 2 | Total frame length, 1–4096 |
| 2 | Offset, starting at zero |
| remaining | Fragment bytes |

Characteristic-value size in the reference is 20–512 bytes. Fragments must arrive contiguously in order with the same sequence and total length. An invalid fragment, gap, overlap, mismatched sequence, 10-second idle timeout, or 120-second total assembly time discards partial state. These headers are **not authenticated**. This codec alone does not define GATT service discovery, pairing, network permissions or end-to-end security; interoperability of actual BLE links is unverified.

## Not the format the Rises app uses

The Rises app (v3.35.0) uses its own prototype frame — `R1|from|to|hops|via|body` in UTF-8, carried inside BLE chunks with an 8-byte header (`R` `S` | id | index | total | length). It is deliberately simple, has no authentication, and is **not compatible** with the `OILT` packet above. Unifying them, and deciding which one is authoritative, is an open task; see [integration notes](integration/rise-app-integration.md).

## What v0 does not specify

Contact discovery, secure address-to-account mapping, key enrollment and revocation, an authenticated application message, persistent relay storage, reliable multi-hop ACKs, audio encoding, congestion control, relay rewards, and interoperability profiles are not standardized. Identity and issuer classes here are experiments, not a normative extension of this packet format.
