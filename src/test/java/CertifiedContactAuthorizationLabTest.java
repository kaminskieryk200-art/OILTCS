// SPDX-License-Identifier: Apache-2.0
import org.oiltcs.prototype.*;import java.security.*;import java.security.spec.ECGenParameterSpec;import java.util.*;import java.io.*;
public class CertifiedContactAuthorizationLabTest{
 static void ok(boolean v){if(!v)throw new AssertionError();}
 static KeyPair key()throws Exception{KeyPairGenerator g=KeyPairGenerator.getInstance("EC");g.initialize(new ECGenParameterSpec("secp256r1"));return g.generateKeyPair();}
 static byte[] cert(KeyPair issuer,UUID owner,UUID viewer,byte[] key,long start,long end)throws Exception{byte[] t=AccountKeyCertificateLab.transcript(owner,viewer,key,start,end);Signature s=Signature.getInstance("SHA256withECDSA");s.initSign(issuer.getPrivate());s.update(t);byte[] sig=SignatureFormat.derToRaw(s.sign()),o=Arrays.copyOf(t,t.length+sig.length);System.arraycopy(sig,0,o,t.length,sig.length);return o;}
 static class Store implements PeerTrustGateLab.Store{byte[] f;public byte[] read(UUID a,UUID b){return f==null?null:f.clone();}public boolean compareAndSet(UUID a,UUID b,byte[] old,byte[] val){if(!Arrays.equals(old,f))return false;f=val==null?null:val.clone();return true;}}
 public static void main(String[] z)throws Exception{
  UUID a=UUID.randomUUID(),b=UUID.randomUUID(),c=UUID.randomUUID();KeyPair root=key(),ak=key(),bk=key(),wrong=key();byte[] r=root.getPublic().getEncoded(),aa=ak.getPublic().getEncoded(),bb=bk.getPublic().getEncoded();long[] time={10000};UUID[] logged={a};byte[][] nativeKey={aa};
  byte[] local=cert(root,a,a,aa,9000,20000),peer=cert(root,b,a,bb,9000,20000);
  Store store=new Store();PeerTrustGateLab gate=new PeerTrustGateLab(store);
  CertifiedContactAuthorizationLab.NativeAccount nativeAccount=new CertifiedContactAuthorizationLab.NativeAccount(){public UUID authenticatedAccount(){return logged[0];}public byte[] localKeystorePublicKey(UUID a){return nativeKey[0];}};
  CertifiedContactAuthorizationLab auth=new CertifiedContactAuthorizationLab(nativeAccount,()->time[0],gate,r,local,peer);
  ok(!auth.authorized(a,b,aa,bb));byte[] fp=PeerTrustGateLab.fingerprint(a,b,aa,bb);ok(gate.confirmFirst(a,b,aa,bb,fp,PeerTrustGateLab.Revocation.ACTIVE));ok(auth.authorized(a,b,aa,bb));
  ok(!auth.authorized(a,c,aa,bb));ok(!auth.authorized(a,b,aa,wrong.getPublic().getEncoded()));logged[0]=c;ok(!auth.authorized(a,b,aa,bb));logged[0]=a;nativeKey[0]=wrong.getPublic().getEncoded();ok(!auth.authorized(a,b,aa,bb));nativeKey[0]=aa;
  time[0]=20000;ok(!auth.authorized(a,b,aa,bb));time[0]=10000;
  byte[] modified=peer.clone();modified[modified.length-1]^=1;CertifiedContactAuthorizationLab corrupted=new CertifiedContactAuthorizationLab(nativeAccount,()->time[0],gate,r,local,modified);ok(!corrupted.authorized(a,b,aa,bb));
  CertifiedContactAuthorizationLab otherRoot=new CertifiedContactAuthorizationLab(nativeAccount,()->time[0],gate,wrong.getPublic().getEncoded(),local,peer);ok(!otherRoot.authorized(a,b,aa,bb));
  byte[] wrongViewer=cert(root,b,c,bb,9000,20000);ok(!new CertifiedContactAuthorizationLab(nativeAccount,()->time[0],gate,r,local,wrongViewer).authorized(a,b,aa,bb));
  try{AccountKeyCertificateLab.transcript(a,b,bb,0,AccountKeyCertificateLab.MAX_AGE_MS+1);throw new AssertionError();}catch(GeneralSecurityException expected){}
  ok(gate.withdraw(a,b,fp));ok(!auth.authorized(a,b,aa,bb));
  System.out.println("PASS synthetic signed account/key certificates, viewer binding, identity pin, expiry, forged cert, account change and trust withdrawal; NO real issuer/accounts/Android");
 }
}
