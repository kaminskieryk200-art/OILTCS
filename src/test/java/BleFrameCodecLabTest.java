// SPDX-License-Identifier: Apache-2.0
import org.oiltcs.prototype.BleFrameCodecLab;import java.util.*;
public class BleFrameCodecLabTest {
 static void ok(boolean b){if(!b)throw new AssertionError();}
 interface Run{void run();}static void fail(Run r){try{r.run();throw new AssertionError("must fail");}catch(IllegalArgumentException expected){}}
 public static void main(String[] args){
  Random random=new Random(5517);int total=0;
  for(int mtu:new int[]{20,23,64,185,247,512})for(int size:new int[]{1,2,8,9,20,64,500,1000,4096}){
   byte[] src=new byte[size];random.nextBytes(src);List<byte[]> packets=BleFrameCodecLab.fragment(42,src,mtu);BleFrameCodecLab.Receiver receiver=new BleFrameCodecLab.Receiver();byte[] result=null;long now=0;
   for(byte[] p:packets){ok(p.length<=mtu);result=receiver.accept(p,mtu,now++);}
   ok(Arrays.equals(result,src));total++;
  }
  byte[] msg=new byte[50];random.nextBytes(msg);List<byte[]> p=BleFrameCodecLab.fragment(3,msg,20);
  BleFrameCodecLab.Receiver r=new BleFrameCodecLab.Receiver();fail(()->r.accept(p.get(1),20,0));ok(r.accept(p.get(0),20,1)==null);fail(()->r.accept(p.get(0),20,2));
  r.accept(p.get(0),20,3);fail(()->r.accept(p.get(2),20,4));r.accept(p.get(0),20,5);fail(()->r.accept(p.get(1),20,10005));
  r.accept(p.get(0),20,10006);byte[] corrupt=p.get(1).clone();corrupt[0]=0;fail(()->r.accept(corrupt,20,10007));
  byte[] changed=p.get(1).clone();changed[7]^=1;r.accept(p.get(0),20,10008);fail(()->r.accept(changed,20,10009));
  byte[] oversized=Arrays.copyOf(p.get(0),21);fail(()->r.accept(oversized,20,10010));fail(()->BleFrameCodecLab.fragment(1,new byte[4097],20));fail(()->BleFrameCodecLab.fragment(1,new byte[1],19));fail(()->r.accept(new byte[12],20,10011));
  r.accept(p.get(0),20,10012);r.reset();fail(()->r.accept(p.get(1),20,10013));
  // At low MTU a good frame may take more than ten seconds overall: each
  // healthy chunk advances the idle timeout, but not the hard assembly cap.
  byte[] slow=new byte[64];List<byte[]> slowParts=BleFrameCodecLab.fragment(5,slow,20);BleFrameCodecLab.Receiver rr=new BleFrameCodecLab.Receiver();byte[] got=null;
  for(int i=0;i<slowParts.size();i++)got=rr.accept(slowParts.get(i),20,i*2000);ok(Arrays.equals(slow,got));
  byte[] longFrame=new byte[200];List<byte[]> many=BleFrameCodecLab.fragment(6,longFrame,20);BleFrameCodecLab.Receiver capped=new BleFrameCodecLab.Receiver();
  for(int i=0;i<24;i++)capped.accept(many.get(i),20,i*5000);fail(()->capped.accept(many.get(24),20,120000));
  System.out.println("PASS "+total+" BLE frame sizes/MTUs, malformed and out-of-order fragments, timeout, reset and bounds; no BLE/GATT or Android");
 }
}
