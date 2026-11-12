// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;
import java.security.GeneralSecurityException;import java.security.MessageDigest;import java.util.UUID;

/** Unreleased fail-closed policy for an independently authenticated local account,
 * a native Keystore key, a pinned issuer, short-lived issuer certificates and a
 * manually verified peer fingerprint. Neither input providers nor trust store are
 * implemented here. Revocation status is only as recent as certificate issuance;
 * a locally changed wall clock or rollbackable storage undermines the policy. */
public final class CertifiedContactAuthorizationLab {
 public interface NativeAccount {UUID authenticatedAccount()throws Exception;byte[] localKeystorePublicKey(UUID account)throws Exception;}
 public interface Clock {long wallMs();}
 private final NativeAccount nativeAccount;private final Clock clock;private final PeerTrustGateLab pins;
 private final byte[] issuer,ownCertificate,peerCertificate;
 public CertifiedContactAuthorizationLab(NativeAccount account,Clock clock,PeerTrustGateLab pins,byte[] issuer,byte[] ownCertificate,byte[] peerCertificate){
  if(account==null||clock==null||pins==null||issuer==null||ownCertificate==null||peerCertificate==null)throw new IllegalArgumentException();
  nativeAccount=account;this.clock=clock;this.pins=pins;this.issuer=issuer.clone();this.ownCertificate=ownCertificate.clone();this.peerCertificate=peerCertificate.clone();
 }
 public boolean authorized(UUID local,UUID peer,byte[] localKey,byte[] peerKey){
  try{
   if(local==null||peer==null||local.equals(peer)||!local.equals(nativeAccount.authenticatedAccount()))return false;
   byte[] actual=nativeAccount.localKeystorePublicKey(local);if(actual==null||localKey==null||!MessageDigest.isEqual(actual,localKey))return false;
   long now=clock.wallMs();AccountKeyCertificateLab.verify(ownCertificate,issuer,local,local,localKey,now);AccountKeyCertificateLab.verify(peerCertificate,issuer,peer,local,peerKey,now);
   // ACTIVE is a signed snapshot, not a promise of live revocation while offline.
   return pins.status(local,peer,localKey,peerKey,PeerTrustGateLab.Revocation.ACTIVE)==PeerTrustGateLab.Status.VERIFIED;
  }catch(Exception e){return false;}
 }
}
