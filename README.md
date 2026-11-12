# OILTCS

**Off-Internet Long-Term Communication Service** is an experimental project for passing messages over a chain of cooperating devices without requiring an Internet connection for each hop.

> **Status: research prototype, not a standard or a working Rises feature.** Do not use it for private or safety-critical communications. The current reference router does not provide authentication, encryption, persistent forwarding, voice calls, billing, or delivery guarantees. The code has not been audited or tested over real radios.

## What it is — and is not

OILTCS is intended to be a transport-independent **overlay**: implementations can carry its packets over compatible local links, potentially including Bluetooth LE, Wi-Fi-based links, or other transports. It does not create radio range, replace Bluetooth or Wi-Fi, or automatically work with arbitrary devices. Each hop needs a working compatible link and a participating device. Bluetooth and Wi-Fi are independent technologies with their own specifications, licensing requirements, and trademarks; this project is not affiliated with or certified by their organizations.

In the future, a Rises app could select OILTCS automatically when Internet connectivity is unavailable, without a separate OILTCS button. **That integration does not exist today.** Continuous relay participation and reliable background operation are subject to permissions, operating-system restrictions, battery, and available peers. Never rely on the prototype for emergencies.

## Repository

- [Protocol draft](docs/PROTOCOL-v0.md) — exact experimental router packet format and behavior implemented here.
- [Security and identity](docs/SECURITY-AND-IDENTITY.md) — threat model and proposed, incomplete account-key verification.
- [Architecture and roadmap](docs/ARCHITECTURE.md) — layers, lifecycle, limitations, and remaining work.
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
