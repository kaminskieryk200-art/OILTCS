# OILTCS

**Off-Internet Long-Term Communication Service** is an experimental project for passing messages over a chain of cooperating devices without requiring an Internet connection for each hop.

> **Status: research prototype, not a standard.** Do not use it for private or safety-critical communications. The reference router does not provide authentication, encryption, persistent forwarding, voice calls, billing, or delivery guarantees. The code has not been audited.
>
> As of 2026-11-02, the Rises Android app (v3.35.0) contains a BLE link (advertising, scanning, GATT server and client, no pairing required) and a “charging station” relay model. That is an implementation, **not** a field result: no physical device, radio or emulator was used to test it. See [integration notes](docs/integration/rise-app-integration.md).

## What it is — and is not

OILTCS is intended to be a transport-independent **overlay**: implementations can carry its packets over compatible local links, potentially including Bluetooth LE, Wi-Fi-based links, or other transports. It does not create radio range, replace Bluetooth or Wi-Fi, or automatically work with arbitrary devices. Each hop needs a working compatible link and a participating device. Bluetooth and Wi-Fi are independent technologies with their own specifications, licensing requirements, and trademarks; this project is not affiliated with or certified by their organizations.

A Rises build now selects the local path automatically when Internet connectivity is unavailable, without a separate OILTCS button (v3.35.0). The disabling switch is hidden in Options → Advanced and warns that offline messaging stops working without it. **The app does not speak the `OILT` router packet format** described here; it uses its own prototype frame, and converging the two is unresolved. Continuous relay participation and reliable background operation are subject to permissions, operating-system restrictions, battery, and available peers. Never rely on the prototype for emergencies.

## Repository

- [Protocol draft](docs/PROTOCOL-v0.md) — exact experimental router packet format and behavior implemented here.
- [Security and identity](docs/SECURITY-AND-IDENTITY.md) — threat model and proposed, incomplete account-key verification.
- [Architecture and roadmap](docs/ARCHITECTURE.md) — layers, lifecycle, limitations, and remaining work.
- [Integration notes: Rises v3.35.0](docs/integration/rise-app-integration.md) — what the app implements, what was verified, and what is untested.
- `tools/` — station model, relay envelope and BLE JavaScript layer copied from the app, with `node tools/stations-selftest.mjs`.
- `src/main/java` — standalone experimental router, framing, and identity-verification components.
- `experiments/identity/issuer-lab.mjs` — a dependency-injected example issuer, **not a deployed service**.
- `test-vectors/` — a synthetic packet vector, not encrypted content.
- `src/test/java` — JVM tests with synthetic keys and data, not real devices.

## Run the reference tests

Requires JDK 17 or newer and Bash. Node.js is optional for a syntax check of the experimental issuer.

```sh
bash ./run-tests.sh
```

These tests check serialization, a simulated router, framing, and a synthetic certificate policy. They do not prove interoperability, safety, Android behavior, physical radio operation, or production readiness.

## Licensing

Source code, scripts, and tests are licensed under [Apache License 2.0](LICENSE). Documentation and the synthetic test vector are licensed under [CC BY 4.0](LICENSES/CC-BY-4.0.txt); see [LICENSES.md](LICENSES.md). These licenses do not convey rights in third-party brands or guarantee freedom from third-party patents.
