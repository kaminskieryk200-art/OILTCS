// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;
import java.nio.ByteBuffer;import java.nio.charset.StandardCharsets;import java.security.*;import java.security.spec.X509EncodedKeySpec;import java.util.Arrays;import java.util.UUID;

/** Unreleased verifier for an issuer-signed, account-bound public key. The issuer
 * key must be pinned in native app code and issuer must independently authenticate
 * users, proof of key possession, peer sharing, and current revocation at issue.
 * Offline validation cannot detect revocation after issuance; the caller chooses
 * an expiry policy and prevents clock rollback. No server issuer exists yet. */
public final class AccountKeyCertificateLab {
 public static final long MAX_AGE_MS=24*60*60*1000L;
 private static final byte[] DOMAIN="RISES-ACCOUNT-KEY-CERT-V1\0".getBytes(StandardCharsets.US_ASCII);
 private static final int SIG=64;
 private AccountKeyCertificateLab(){}
 public static void verify(byte[] cert,byte[] issuerKey,UUID owner,UUID viewer,byte[] expectedKey,long now)throws GeneralSecurityException{
  if(cert==null||owner==null||viewer==null||expectedKey==null||now<0)throw new GeneralSecurityException("invalid context");
  if(cert.length<DOMAIN.length+32+16+2+70+SIG||cert.length>DOMAIN.length+32+16+2+200+SIG)throw new GeneralSecurityException("invalid size");
  SignedMeshHandshake.validateIdentity(issuerKey);SignedMeshHandshake.validateIdentity(expectedKey);
  try{
   ByteBuffer in=ByteBuffer.wrap(cert);byte[] domain=new byte[DOMAIN.length];in.get(domain);UUID claimedOwner=new UUID(in.getLong(),in.getLong()),claimedViewer=new UUID(in.getLong(),in.getLong());long start=in.getLong(),end=in.getLong();int n=in.getShort()&65535;
   if(!MessageDigest.isEqual(domain,DOMAIN)||!owner.equals(claimedOwner)||!viewer.equals(claimedViewer)||start<0||end<=start||end-start>MAX_AGE_MS||now<start||now>=end||n<70||n>200||in.remaining()!=n+SIG)throw new GeneralSecurityException("wrong scope or expiry");
   byte[] key=new byte[n],sig=new byte[SIG];in.get(key);in.get(sig);if(!MessageDigest.isEqual(expectedKey,key))throw new GeneralSecurityException("wrong account key");
   PublicKey authority=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(issuerKey));Signature verify=Signature.getInstance("SHA256withECDSA");verify.initVerify(authority);verify.update(cert,0,cert.length-SIG);
   if(!verify.verify(SignatureFormat.rawToDer(sig)))throw new GeneralSecurityException("bad issuer signature");
  }catch(java.nio.BufferUnderflowException|IllegalArgumentException e){throw new GeneralSecurityException("malformed certificate",e);}
 }
 /** Byte-level transcript constructor for an isolated issuer test. It does NOT
  * authorize issuing a certificate, prove login or query a key directory. */
 public static byte[] transcript(UUID owner,UUID viewer,byte[] key,long start,long end)throws GeneralSecurityException{
  if(owner==null||viewer==null||start<0||end<=start||end-start>MAX_AGE_MS)throw new GeneralSecurityException("invalid fields");SignedMeshHandshake.validateIdentity(key);
  return ByteBuffer.allocate(DOMAIN.length+32+16+2+key.length).put(DOMAIN).putLong(owner.getMostSignificantBits()).putLong(owner.getLeastSignificantBits()).putLong(viewer.getMostSignificantBits()).putLong(viewer.getLeastSignificantBits()).putLong(start).putLong(end).putShort((short)key.length).put(key).array();
 }
}
