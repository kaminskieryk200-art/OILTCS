// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.UUID;

/**
 * Unreleased building block, NOT account authentication or a full key directory.
 * Two people must independently compare the entire displayed fingerprint over a
 * trusted channel before confirming. Server-provided keys are not trusted merely
 * because they parse. This gate does not prove a person owns a Rises account,
 * prevent compromise of the device/storage, check revocation offline, provide
 * key transparency, or close a live session if trust is later withdrawn.
 *
 * Store must implement durable, cross-process atomic compare-and-set and protect
 * integrity. In-memory stores are ONLY for tests. Callers must recheck trust and
 * revocation immediately before use and close sessions on change. Without a
 * genuine verified revocation source, revoked status must default to UNKNOWN.
 */
public final class PeerTrustGateLab {
 public interface Store {
  byte[] read(UUID local, UUID peer) throws GeneralSecurityException;
  boolean compareAndSet(UUID local, UUID peer, byte[] expected, byte[] replacement) throws GeneralSecurityException;
 }
 public enum Status { UNVERIFIED, VERIFIED, CHANGED, REVOCATION_UNKNOWN, REVOKED }
 public enum Revocation { ACTIVE, UNKNOWN, REVOKED }
 private static final byte[] DOMAIN="RISES-PEER-VERIFY-V1\0".getBytes(StandardCharsets.US_ASCII);
 private static final char[] HEX="0123456789abcdef".toCharArray();
 private final Store store;
 public PeerTrustGateLab(Store store){if(store==null)throw new IllegalArgumentException("store");this.store=store;}
 /** The same fingerprint on both devices; IDs and the corresponding keys are
  * ordered by unsigned UUID bytes, so it is bound to both accounts and keys. */
 public static byte[] fingerprint(UUID local,UUID peer,byte[] localKey,byte[] peerKey)throws GeneralSecurityException{
  if(local==null||peer==null||local.equals(peer))throw new GeneralSecurityException("invalid accounts");
  SignedMeshHandshake.validateIdentity(localKey);SignedMeshHandshake.validateIdentity(peerKey);
  if(MessageDigest.isEqual(localKey,peerKey))throw new GeneralSecurityException("same key");
  byte[] a=id(local),b=id(peer);boolean order=compare(a,b)<0;
  byte[] first=order?a:b,second=order?b:a,fk=order?localKey:peerKey,sk=order?peerKey:localKey;
  MessageDigest d=MessageDigest.getInstance("SHA-256");d.update(DOMAIN);d.update(first);d.update(second);
  d.update(ByteBuffer.allocate(4).putInt(fk.length).array());d.update(fk);
  d.update(ByteBuffer.allocate(4).putInt(sk.length).array());d.update(sk);return d.digest();
 }
 public static String display(byte[] f)throws GeneralSecurityException{
  if(f==null||f.length!=32)throw new GeneralSecurityException("invalid fingerprint");
  char[] out=new char[64];for(int i=0;i<32;i++){out[2*i]=HEX[(f[i]>>>4)&15];out[2*i+1]=HEX[f[i]&15];}return new String(out);
 }
 public Status status(UUID local,UUID peer,byte[] localKey,byte[] peerKey,Revocation revocation)throws GeneralSecurityException{
  if(revocation==null)throw new GeneralSecurityException("revocation state required");
  byte[] now=fingerprint(local,peer,localKey,peerKey),old=read(local,peer);
  if(revocation==Revocation.REVOKED)return Status.REVOKED;
  if(old!=null&&!MessageDigest.isEqual(now,old))return Status.CHANGED;
  if(revocation==Revocation.UNKNOWN)return Status.REVOCATION_UNKNOWN;
  return old==null?Status.UNVERIFIED:Status.VERIFIED;
 }
 /** Caller must get affirmative human confirmation AFTER independent comparison
  * of the displayed complete fingerprint and authenticated peer account. Never
  * accept a confirmation supplied by a remote WebView, server or contact. A
  * changed key requires explicit withdrawal and fresh independent verification;
  * this method will not silently overwrite an existing binding. */
 public boolean confirmFirst(UUID local,UUID peer,byte[] localKey,byte[] peerKey,byte[] independentlyCompared,Revocation revocation)throws GeneralSecurityException{
  if(revocation!=Revocation.ACTIVE)throw new GeneralSecurityException("revocation not verified active");
  byte[] f=fingerprint(local,peer,localKey,peerKey);
  if(independentlyCompared==null||!MessageDigest.isEqual(f,independentlyCompared))throw new GeneralSecurityException("fingerprint mismatch");
  try{return store.compareAndSet(local,peer,null,f.clone());}
  catch(RuntimeException e){throw new GeneralSecurityException("store unavailable",e);}
 }
 /** Explicit withdrawal: compare-and-set prevents deleting a newer binding. */
 public boolean withdraw(UUID local,UUID peer,byte[] oldFingerprint)throws GeneralSecurityException{
  if(local==null||peer==null||local.equals(peer)||oldFingerprint==null||oldFingerprint.length!=32)throw new GeneralSecurityException("invalid context");
  try{return store.compareAndSet(local,peer,oldFingerprint.clone(),null);}
  catch(RuntimeException e){throw new GeneralSecurityException("store unavailable",e);}
 }
 private byte[] read(UUID local,UUID peer)throws GeneralSecurityException{
  try{byte[] v=store.read(local,peer);if(v!=null&&v.length!=32)throw new GeneralSecurityException("invalid stored fingerprint");return v==null?null:v.clone();}
  catch(RuntimeException e){throw new GeneralSecurityException("store unavailable",e);}
 }
 private static byte[] id(UUID u){return ByteBuffer.allocate(16).putLong(u.getMostSignificantBits()).putLong(u.getLeastSignificantBits()).array();}
 private static int compare(byte[] a,byte[] b){for(int i=0;i<a.length;i++){int x=(a[i]&255)-(b[i]&255);if(x!=0)return x;}return 0;}
}
