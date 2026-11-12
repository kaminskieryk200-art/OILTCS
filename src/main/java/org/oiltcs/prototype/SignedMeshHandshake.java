// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Arrays;
import java.util.UUID;

/** EXPERIMENTAL, UNREVIEWED authenticated key offer, not a complete handshake.
 * The caller must obtain both identity keys from a trusted account directory,
 * agree a fresh session nonce, reject replay, and verify revocation policy.
 * No network, account login, key directory, persistence or billing here. */
public final class SignedMeshHandshake {
 private static final byte[] DOMAIN="RISES-MESH-AUTH-OFFER-V1\0".getBytes(StandardCharsets.US_ASCII);
 private static final int NONCE=32,FINGERPRINT=32,SIGNATURE=64,MIN_KEY=70,MAX_KEY=200;
 public enum Role { INITIATOR(0), RESPONDER(1);final int code;Role(int code){this.code=code;} }
 public interface Signer { byte[] sign(byte[] transcript) throws GeneralSecurityException; }
 public interface ReplayStore { boolean claim(UUID localAccount,UUID remoteAccount,byte[] nonce) throws GeneralSecurityException; }
 private SignedMeshHandshake(){}
 public static byte[] freshSession(SecureRandom random){if(random==null)throw new IllegalArgumentException();byte[] b=new byte[NONCE];random.nextBytes(b);return b;}
 /** Returns fixed-length IEEE P1363 signature from an Android Keystore or JCA signer. */
 public static byte[] create(UUID from,UUID to,Role role,byte[] session,byte[] fromIdentity,byte[] toIdentity,byte[] ephemeral,Signer signer)throws GeneralSecurityException {
  checkFields(from,to,role,session,fromIdentity,toIdentity,ephemeral);if(signer==null)throw new GeneralSecurityException("missing signer");
  byte[] transcript=transcript(from,to,role,session,fromIdentity,toIdentity,ephemeral);
  byte[] signature=signer.sign(transcript.clone());
  if(signature==null||signature.length!=SIGNATURE||!verifySignature(fromIdentity,transcript,signature))throw new GeneralSecurityException("signer does not match identity");
  byte[] wire=Arrays.copyOf(transcript,transcript.length+SIGNATURE);System.arraycopy(signature,0,wire,transcript.length,SIGNATURE);return wire;
 }
 /** Verify against pre-trusted keys and the session nonce expected by the caller.
  * Result is only the validated remote ephemeral SPKI, not an authorized account.
  * Callers MUST reject reused session IDs and only confirm E2EE after both roles verify. */
 public static byte[] verify(byte[] wire,UUID from,UUID to,Role role,byte[] expectedSession,byte[] trustedFrom,byte[] trustedTo)throws GeneralSecurityException {
  if(wire==null||wire.length<DOMAIN.length+1+32+NONCE+2*FINGERPRINT+2+MIN_KEY+SIGNATURE||wire.length>DOMAIN.length+1+32+NONCE+2*FINGERPRINT+2+MAX_KEY+SIGNATURE)throw new GeneralSecurityException("invalid size");
  if(from==null||to==null||role==null||expectedSession==null||expectedSession.length!=NONCE)throw new GeneralSecurityException("invalid expected fields");
  p256(trustedFrom);p256(trustedTo);
  try{
   ByteBuffer b=ByteBuffer.wrap(wire);byte[] domain=new byte[DOMAIN.length];b.get(domain);if(!MessageDigest.isEqual(domain,DOMAIN))throw new GeneralSecurityException("wrong protocol");
   int claimedRole=b.get()&255;UUID claimedFrom=new UUID(b.getLong(),b.getLong()),claimedTo=new UUID(b.getLong(),b.getLong());
   byte[] nonce=new byte[NONCE],fromHash=new byte[FINGERPRINT],toHash=new byte[FINGERPRINT];b.get(nonce);b.get(fromHash);b.get(toHash);
   int size=b.getShort()&65535;if(size<MIN_KEY||size>MAX_KEY||b.remaining()!=size+SIGNATURE)throw new GeneralSecurityException("wrong size");
   byte[] eph=new byte[size],signature=new byte[SIGNATURE];b.get(eph);b.get(signature);
   if(claimedRole!=role.code||!from.equals(claimedFrom)||!to.equals(claimedTo)||!MessageDigest.isEqual(nonce,expectedSession)||
      !MessageDigest.isEqual(fromHash,sha(trustedFrom))||!MessageDigest.isEqual(toHash,sha(trustedTo)))throw new GeneralSecurityException("wrong peer/session");
   checkFields(from,to,role,expectedSession,trustedFrom,trustedTo,eph);
   if(!verifySignature(trustedFrom,Arrays.copyOf(wire,wire.length-SIGNATURE),signature))throw new GeneralSecurityException("bad signature");
   return eph;
  }catch(java.nio.BufferUnderflowException|IllegalArgumentException e){throw new GeneralSecurityException("malformed offer",e);}
 }
 /** Atomically consume this signed peer/session after authentication. A persistent,
  * account-scoped replay store is required for protection across process restarts.
  * Storage failure is fail-closed; this is still not a complete contact directory. */
 public static byte[] verifyOnce(byte[] wire,UUID from,UUID to,Role role,byte[] expectedSession,byte[] trustedFrom,byte[] trustedTo,ReplayStore store)throws GeneralSecurityException {
  if(store==null)throw new GeneralSecurityException("replay store required");
  byte[] eph=verify(wire,from,to,role,expectedSession,trustedFrom,trustedTo);
  try{if(!store.claim(to,from,expectedSession.clone()))throw new GeneralSecurityException("replayed session");}
  catch(RuntimeException e){throw new GeneralSecurityException("replay storage unavailable",e);}
  return eph;
 }
 private static boolean verifySignature(byte[] publicKey,byte[] transcript,byte[] signature)throws GeneralSecurityException {
  Signature v=Signature.getInstance("SHA256withECDSA");v.initVerify(p256(publicKey));v.update(transcript);return v.verify(SignatureFormat.rawToDer(signature));
 }
 private static byte[] transcript(UUID from,UUID to,Role role,byte[] session,byte[] fromIdentity,byte[] toIdentity,byte[] eph)throws GeneralSecurityException {
  ByteBuffer b=ByteBuffer.allocate(DOMAIN.length+1+32+NONCE+2*FINGERPRINT+2+eph.length);
  b.put(DOMAIN).put((byte)role.code).putLong(from.getMostSignificantBits()).putLong(from.getLeastSignificantBits())
   .putLong(to.getMostSignificantBits()).putLong(to.getLeastSignificantBits()).put(session).put(sha(fromIdentity)).put(sha(toIdentity)).putShort((short)eph.length).put(eph);
  return b.array();
 }
 private static void checkFields(UUID from,UUID to,Role role,byte[] session,byte[] fromKey,byte[] toKey,byte[] eph)throws GeneralSecurityException {
  if(from==null||to==null||from.equals(to)||role==null||session==null||session.length!=NONCE||allZero(session))throw new GeneralSecurityException("invalid context");
  p256(fromKey);p256(toKey);p256(eph);
  if(MessageDigest.isEqual(sha(fromKey),sha(toKey)))throw new GeneralSecurityException("same device identity");
  if(MessageDigest.isEqual(sha(eph),sha(fromKey))||MessageDigest.isEqual(sha(eph),sha(toKey)))throw new GeneralSecurityException("ephemeral key reused as identity");
 }
 private static boolean allZero(byte[] b){int x=0;for(byte v:b)x|=v;return x==0;}
 private static byte[] sha(byte[] b)throws GeneralSecurityException{return MessageDigest.getInstance("SHA-256").digest(b);}
 /** Validates SPKI format, curve and point only; does not establish identity or trust. */
 public static void validateIdentity(byte[] encoded)throws GeneralSecurityException {p256(encoded);}
 private static ECPublicKey p256(byte[] encoded)throws GeneralSecurityException {
  if(encoded==null||encoded.length<MIN_KEY||encoded.length>MAX_KEY)throw new GeneralSecurityException("invalid public key");
  java.security.PublicKey k=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
  if(!(k instanceof ECPublicKey))throw new GeneralSecurityException("wrong type");
  ECPublicKey key=(ECPublicKey)k;
  AlgorithmParameters p=AlgorithmParameters.getInstance("EC");p.init(new ECGenParameterSpec("secp256r1"));ECParameterSpec a=key.getParams(),b=p.getParameterSpec(ECParameterSpec.class);
  if(a==null||!a.getCurve().equals(b.getCurve())||!a.getGenerator().equals(b.getGenerator())||!a.getOrder().equals(b.getOrder())||a.getCofactor()!=b.getCofactor())throw new GeneralSecurityException("wrong curve");
  // Validate point independently of provider-specific X.509 parsing behavior.
  java.security.spec.ECPoint w=key.getW();
  if(w==null||java.security.spec.ECPoint.POINT_INFINITY.equals(w)||!(a.getCurve().getField() instanceof java.security.spec.ECFieldFp))throw new GeneralSecurityException("invalid point");
  java.math.BigInteger mod=((java.security.spec.ECFieldFp)a.getCurve().getField()).getP(),x=w.getAffineX(),y=w.getAffineY();
  if(x==null||y==null||x.signum()<0||y.signum()<0||x.compareTo(mod)>=0||y.compareTo(mod)>=0||
      !y.multiply(y).mod(mod).equals(x.multiply(x).multiply(x).add(a.getCurve().getA().multiply(x)).add(a.getCurve().getB()).mod(mod)))throw new GeneralSecurityException("invalid point");
  return key;
 }
}
