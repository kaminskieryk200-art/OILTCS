// SPDX-License-Identifier: Apache-2.0
package org.oiltcs.prototype;
import java.io.ByteArrayOutputStream;
import java.security.GeneralSecurityException;
import java.util.Arrays;
/** Strict ECDSA P-256 DER <-> IEEE P1363 conversion. Lab only. */
public final class SignatureFormat {
 private SignatureFormat(){}
 private static byte[] integer(byte[] raw,int off){
  int p=off;while(p<off+31&&raw[p]==0)p++;int len=off+32-p;boolean pad=(raw[p]&128)!=0;
  byte[] out=new byte[2+len+(pad?1:0)];out[0]=2;out[1]=(byte)(len+(pad?1:0));System.arraycopy(raw,p,out,2+(pad?1:0),len);return out;
 }
 public static byte[] rawToDer(byte[] raw)throws GeneralSecurityException{
  if(raw==null||raw.length!=64)throw new GeneralSecurityException("bad size");
  byte[] r=integer(raw,0),s=integer(raw,32);ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(0x30);out.write(r.length+s.length);out.write(r,0,r.length);out.write(s,0,s.length);return out.toByteArray();
 }
 private static int decode(byte[] d,int p,byte[] out,int off)throws GeneralSecurityException{
  if(p+2>d.length||d[p++]!=2)throw new GeneralSecurityException("bad integer");int len=d[p++]&255;
  if(len<1||len>33||p+len>d.length||(d[p]&128)!=0)throw new GeneralSecurityException("bad integer length/sign");
  if(len>1&&d[p]==0&&(d[p+1]&128)==0)throw new GeneralSecurityException("non-minimal integer");
  if(len==33){if(d[p]!=0)throw new GeneralSecurityException("integer too long");p++;len--;}
  if(len>32)throw new GeneralSecurityException("integer too long");System.arraycopy(d,p,out,off+32-len,len);return p+len;
 }
 public static byte[] derToRaw(byte[] der)throws GeneralSecurityException{
  if(der==null||der.length<8||der.length>72||der[0]!=0x30||(der[1]&255)!=der.length-2)throw new GeneralSecurityException("bad sequence");
  byte[] out=new byte[64];int p=decode(der,2,out,0);p=decode(der,p,out,32);if(p!=der.length)throw new GeneralSecurityException("trailing bytes");return out;
 }
}
