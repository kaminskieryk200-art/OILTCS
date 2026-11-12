# Security and identity

**No production security claim is made.** The router forwards opaque bytes but does not encrypt or authenticate them. Radio observers and relays can learn metadata; active peers can inject, drop, replay, alter routing headers, poison the duplicate cache, or exhaust resources. Endpoint encryption and authentication are essential but are not integrated into this reference router.

## Experimental verification work

The repository contains components for:

1. checking P-256 signatures over a short-lived issuer certificate binding a public key to an owner and an intended viewer;
2. comparing the local identity key to a key obtained independently from a native device provider;
3. requiring a separately verified, stored contact fingerprint;
4. checking a signed ephemeral handshake against previously trusted keys.

The certificate issuer is only an injected sample: no issuer service, production signing key, current-account provider, verified directory, trusted pin store, or Android integration is supplied. A key sent by a nearby peer, an untrusted WebView, or an unverified directory is not itself evidence of who owns it. The handshake cannot repair an incorrect trust decision. The tests use synthetic keys and in-memory trust, not real users.

A short-lived certificate is a **snapshot**, not live revocation: it may remain usable after a key has been revoked and before expiry. Wall-clock rollback can also undermine expiry. Certificate rotation, issuer-key compromise, local storage rollback, concurrency, revocation distribution, recovery, transparency, and reliable account switching remain open problems. Connecting code to these interfaces without independently solving those problems would be unsafe.

## Reporting

Please avoid posting exploit details, real user information, keys, or credentials in public issues. This local project has no established private security contact yet. A repository owner should create and publish a private reporting process before inviting external deployment.
