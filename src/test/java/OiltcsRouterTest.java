// SPDX-License-Identifier: Apache-2.0
import org.oiltcs.prototype.*;import java.util.*;import java.util.concurrent.atomic.*;
public class OiltcsRouterTest {
 static void ok(boolean v){if(!v)throw new AssertionError();}
 static byte[] id(int n){byte[] b=new byte[16];b[12]=(byte)(n>>>24);b[13]=(byte)(n>>>16);b[14]=(byte)(n>>>8);b[15]=(byte)n;return b;}
 public static void main(String[] args){
  AtomicLong clock=new AtomicLong();List<byte[]> wire=new ArrayList<>(),received=new ArrayList<>();OiltcsRouter source=new OiltcsRouter(id(1),p->{},clock::get),dst=new OiltcsRouter(id(2),received::add,clock::get);source.enable();dst.enable();source.addPeer("to",p->wire.add(p));dst.addPeer("from",p->{});
  byte[] msg={42};source.send(id(2),id(1),msg,64);byte[] first=wire.get(0);dst.receive("unknown",first);ok(received.isEmpty());
  for(int pos:new int[]{0,1,2,3,4,5,38,39}){byte[] bad=first.clone();bad[pos]=(byte)(pos==5?0:255);dst.receive("from",bad);ok(received.isEmpty());}
  dst.receive("from",Arrays.copyOf(first,first.length-1));ok(received.isEmpty());dst.receive("from",first);ok(received.size()==1);dst.receive("from",first);ok(received.size()==1);
  for(int n=2;n<205;n++)source.send(id(2),id(n),msg,64);
  for(int n=1;n<wire.size();n++)dst.receive("from",wire.get(n));
  // First accepted and duplicate both consume rate tokens. Malformed and unknown source do not.
  ok(received.size()==199);clock.addAndGet(10_000_000L);dst.receive("from",wire.get(200));ok(received.size()==200);
  dst.disable();dst.receive("from",wire.get(201));ok(received.size()==200);
  try{source.send(id(2),id(999),msg,65);throw new AssertionError();}catch(IllegalArgumentException expected){}
  try{source.send(id(2),id(999),new byte[4057],64);throw new AssertionError();}catch(IllegalArgumentException expected){}
  source.send(id(2),id(999),new byte[4056],64);ok(wire.get(wire.size()-1).length==4096);
  System.out.println("PASS OILTCS framing, malformed/duplicate, opt-out, max size/hops, token bucket; JVM only");
 }
}
