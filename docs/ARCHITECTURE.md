# Architecture and roadmap

## Layers

1. **Local link:** a compatible transport provides bounded packet delivery between nearby peers. BLE fragmentation is included as a codec only; this repository still provides no BLE application of its own. A BLE link (advertising, scanning, GATT server/client, chunking, peer RSSI) now exists in the separate Rises app and is described in [integration notes](integration/rise-app-integration.md) — implemented, **not tested on hardware**, and not interoperable with the `OILT` router packet in this repository.
2. **Router:** an experimental flooding router forwards opaque packets through currently connected peers. It has no durable store-and-forward, route discovery, congestion control, or authenticated routing.
3. **Identity and cryptography:** research components validate experimental credentials and signed handshakes. They do not provide real account enrollment, trusted identity distribution, offline revocation, or an audited secure protocol. The app layer now signs messages with a per-device ECDSA key and pins the first key of each sender (TOFU); that blocks impersonation after first contact and detects tampering, but it is not enrolled identity.
4. **Application:** a messenger would need persistent encrypted inbox/outbox storage, normal chat integration, authenticated acknowledgments, retry and cross-transport deduplication, device permissions, lifecycle management, and user-facing error states. No such application integration is included here.

## Proposed milestones — not completed

- Define a stable threat model and interoperable version negotiation; get independent cryptographic and privacy review.
- Specify account/key enrollment, key continuity and rotation, peer discovery, and offline revocation limitations; implement secure device storage and safe logout.
- Add Android and other link adapters, permission flows, battery limits, and lifecycle/background behavior; test multiple physical devices and real signal conditions. *Partly done in the Rises app v3.35.0 (classic Bluetooth RFCOMM + BLE, runtime permissions, automatic enable prompt); background behaviour, battery cost and all radio behaviour remain untested.*
- Design persistent forwarding, acknowledgments, retries, abuse resistance and duplicate handling across both online and offline transports. *Duplicate handling and “charging station” relay selection are implemented in the app layer and unit-tested in `tools/stations-selftest.mjs`; acknowledgments, retries and durable storage are not.*
- Integrate and test ordinary messages in Rises without a separate OILTCS screen or button; clearly report pending vs delivered. *Integration without a button exists in v3.35.0; delivery states are still coarse, and nothing was tested over a real link.*
- Research whether real-time voice is feasible on target links. Neither call setup nor reliable audio is implemented.
- Design an independently auditable reward mechanism if wanted; no payment or Orbs settlement is implemented. A reward pool bounded by caller fees does not by itself stop fake calls or Sybil abuse.
- Seek external implementer feedback, interoperability tests, governance and publication before describing OILTCS as a standard.

A device with Internet could potentially relay for a nearby offline peer in a future implementation, if permitted by its user and platform. This repository does not implement or test that behavior. There is no guarantee of range, delivery, background participation or availability.
