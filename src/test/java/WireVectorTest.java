// SPDX-License-Identifier: Apache-2.0
import org.oiltcs.prototype.*;import java.util.*;
public class WireVectorTest {
 public static void main(String[] args){
  byte[] self=new byte[16],destination=new byte[16],message=new byte[16];
  for(int i=0;i<16;i++){message[i]=(byte)i;destination[i]=(byte)(i+16);}
  List<byte[]> out=new ArrayList<>();OiltcsRouter r=new OiltcsRouter(self,p->{});r.enable();r.addPeer("test",out::add);
  r.send(destination,message,new byte[]{(byte)0xde,(byte)0xad,(byte)0xbe},3);
  byte[] actual=out.get(0);StringBuilder h=new StringBuilder();for(byte x:actual)h.append(String.format("%02x",x&255));
  String expected="4f494c540003000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0003deadbe";
  if(!expected.equals(h.toString()))throw new AssertionError(h.toString());
  System.out.println("PASS routing packet golden vector");
 }
}
